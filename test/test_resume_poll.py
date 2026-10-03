from __future__ import annotations

import base64
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from services.image_task_service import ImageTaskService
from test.test_keep_forever_and_retry_settings import OWNER, wait_status

TIMEOUT = "ChatGPT 生图超时（已等待 600 秒）。"


class FakeBackend:
    """Stands in for OpenAIBackendAPI: the image turned up in the conversation after all."""

    tokens: list[str] = []

    def __init__(self, access_token: str = "") -> None:
        FakeBackend.tokens.append(access_token)

    poll = staticmethod(lambda *_: (["file-1"], []))  # the image turned up; a test can swap this

    def _poll_image_results(self, conversation_id, timeout_secs):
        assert conversation_id == "conv-1"
        return FakeBackend.poll(conversation_id, timeout_secs)

    def resolve_conversation_image_urls(self, conversation_id, file_ids, sediment_ids, poll=True):
        return ["https://files.test/1.png"]

    def download_image_bytes(self, urls):
        return [b"png-bytes"]

    def close(self):
        pass


class ResumePollTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = Path(tmp.name) / "tasks.json"
        FakeBackend.tokens = []
        FakeBackend.poll = staticmethod(lambda *_: (["file-1"], []))

    def service(self, handler=lambda _payload: {"data": []}):
        return ImageTaskService(self.path, generation_handler=handler, edit_handler=handler, retention_days_getter=lambda: 30)

    def time_out(self):
        def handler(_payload):
            error = RuntimeError(TIMEOUT)
            error.conversation_id = "conv-1"
            error.account_email = "a@x.com"
            raise error

        service = self.service(handler)
        service.submit_generation(OWNER, client_task_id="t-1", prompt="p", model="gpt-image-2", size=None)
        wait_status(service, "t-1", "error")

    def test_resume_reads_the_conversation_with_its_accounts_token_after_a_restart(self):
        self.time_out()
        service = self.service()  # reloaded from disk, as after a container restart
        with (
            mock.patch("services.account_service.account_service.get_access_token_by_email",
                       side_effect=lambda email: "tok-a" if email == "a@x.com" else ""),
            mock.patch("services.openai_backend_api.OpenAIBackendAPI", FakeBackend),
        ):
            service.resume_poll(OWNER, "t-1", 5)
            task = wait_status(service, "t-1", "success")
        self.assertEqual(FakeBackend.tokens, ["tok-a"])
        self.assertEqual(base64.b64decode(task["data"][0]["b64_json"]), b"png-bytes")

    def test_account_recovery_resumes_its_timed_out_images(self):
        self.time_out()
        service = self.service()
        with (
            mock.patch("services.account_service.account_service.get_access_token_by_email",
                       side_effect=lambda email: "tok-a" if email == "a@x.com" else ""),
            mock.patch("services.openai_backend_api.OpenAIBackendAPI", FakeBackend),
        ):
            self.assertEqual(service.resume_timed_out_for_account("someone@else.com"), 0)
            self.assertEqual(service.resume_timed_out_for_account("A@x.com"), 1)
            wait_status(service, "t-1", "success")
        self.assertEqual(FakeBackend.tokens, ["tok-a"])

    def test_recovery_resumes_each_timeout_only_once(self):
        # a resume that finds nothing leaves a timeout again; the next recovery must not pick it up again
        # (every recovery re-resuming the same images kept the account refused -> recovered -> refused)
        self.time_out()
        service = self.service()
        def still_timing_out(*_args):
            raise RuntimeError(TIMEOUT)  # what a real resume records when the image never shows up

        FakeBackend.poll = still_timing_out
        with (
            mock.patch("services.account_service.account_service.get_access_token_by_email", return_value="tok-a"),
            mock.patch("services.openai_backend_api.OpenAIBackendAPI", FakeBackend),
        ):
            self.assertEqual(service.resume_timed_out_for_account("a@x.com"), 1)
            wait_status(service, "t-1", "error")
            self.assertEqual(service.resume_timed_out_for_account("a@x.com"), 0)

    def test_resume_refuses_when_the_account_is_gone(self):
        self.time_out()
        service = self.service()
        with mock.patch("services.account_service.account_service.get_access_token_by_email", return_value=""):
            with self.assertRaisesRegex(ValueError, "找不到生成这张图的账号"):
                service.resume_poll(OWNER, "t-1", 5)
        self.assertEqual(wait_status(service, "t-1", "error")["error"], TIMEOUT)  # left as it was


if __name__ == "__main__":
    unittest.main()
