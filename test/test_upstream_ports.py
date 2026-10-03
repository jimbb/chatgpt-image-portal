"""Fixes ported from basketikun/chatgpt2api PRs #397 (English refusals), #398 (download retry),
#401 (atomic JSON saves)."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from services.openai_backend_api import OpenAIBackendAPI, _is_content_policy_error
from services.storage.json_storage import JSONStorageBackend
from utils.helper import UpstreamHTTPError


class ContentPolicyKeywordTests(unittest.TestCase):
    """Unrecognised refusals used to poll until the whole time budget expired."""

    def test_matches_chinese_refusal(self):
        self.assertTrue(_is_content_policy_error("非常抱歉，该提示可能违反了我们的内容政策。"))

    def test_matches_english_refusals_with_curly_apostrophe(self):
        for text in [
            "Sorry, I can’t help create or edit an image of a real person to make them topless or nude.",
            "Sorry, I can’t help create a nude or sexually explicit image of a real person.",
            "I can’t assist with that request.",
        ]:
            with self.subTest(text=text[:40]):
                self.assertTrue(_is_content_policy_error(text))

    def test_matches_english_refusal_with_straight_apostrophe(self):
        self.assertTrue(_is_content_policy_error("Sorry, I can't help with that request."))

    def test_ignores_normal_text(self):
        self.assertFalse(_is_content_policy_error("Here is the image you asked for."))
        self.assertFalse(_is_content_policy_error(""))


class FakeResponse:
    def __init__(self, status_code: int, content: bytes = b"", text: str = ""):
        self.status_code = status_code
        self.content = content
        self.text = text
        self.headers: dict[str, str] = {}

    def json(self):
        raise ValueError("not json")


class FakeSession:
    """Returns the given outcomes in order, raising the ones that are exceptions."""

    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.calls = 0

    def get(self, url, timeout=None):
        self.calls += 1
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


class ImageDownloadRetryTests(unittest.TestCase):
    """The image is already generated and paid for; one failed GET should not lose it."""

    def setUp(self):
        patcher = mock.patch("services.openai_backend_api.time.sleep")
        self.sleep = patcher.start()
        self.addCleanup(patcher.stop)

    def backend(self, outcomes) -> OpenAIBackendAPI:
        backend = OpenAIBackendAPI.__new__(OpenAIBackendAPI)
        backend.session = FakeSession(outcomes)
        backend.image_request_deadline = None
        backend.request_deadline = None
        return backend

    def test_success_first_try(self):
        backend = self.backend([FakeResponse(200, b"img")])
        self.assertEqual(backend.download_image_bytes(["u"]), [b"img"])
        self.assertEqual(backend.session.calls, 1)
        self.sleep.assert_not_called()

    def test_retries_http_error_then_succeeds(self):
        backend = self.backend([FakeResponse(503, text="upstream connect error"), FakeResponse(200, b"img")])
        self.assertEqual(backend.download_image_bytes(["u"]), [b"img"])
        self.assertEqual(backend.session.calls, 2)
        self.sleep.assert_called_once_with(1.0)

    def test_retries_connection_error_then_succeeds(self):
        backend = self.backend([ConnectionError("curl: (7) Connection refused"), FakeResponse(200, b"img")])
        self.assertEqual(backend.download_image_bytes(["u"]), [b"img"])
        self.assertEqual(backend.session.calls, 2)

    def test_gives_up_after_two_retries_with_backoff(self):
        backend = self.backend([FakeResponse(503, text="a"), FakeResponse(502, text="b"), FakeResponse(503, text="c")])
        with self.assertRaises(UpstreamHTTPError) as ctx:
            backend.download_image_bytes(["u"])
        self.assertEqual(ctx.exception.status_code, 503)
        self.assertEqual(backend.session.calls, 3)
        self.assertEqual([c.args[0] for c in self.sleep.call_args_list], [1.0, 2.0])


class AtomicJsonStorageTests(unittest.TestCase):
    """A crash or full disk mid-save used to leave accounts.json (our ChatGPT token) empty."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        self.backend = JSONStorageBackend(root / "accounts" / "accounts.json", root / "keys" / "auth_keys.json")

    def paths(self):
        return (
            (self.backend.file_path, self.backend.save_accounts, self.backend.load_accounts),
            (self.backend.auth_keys_path, self.backend.save_auth_keys, self.backend.load_auth_keys),
        )

    def test_round_trip_and_no_leftover_temp_files(self):
        items = [{"id": "a", "access_token": "token-a", "name": "测试 😀"}]
        for path, save, load in self.paths():
            with self.subTest(path=path.name):
                save(items)
                self.assertEqual(load(), items)
                self.assertEqual(list(path.parent.iterdir()), [path])

    def test_failed_write_keeps_the_previous_file(self):
        original = [{"id": "a", "access_token": "token-a"}]
        for failure in (mock.patch("os.fsync", side_effect=OSError("disk full")),
                        mock.patch("os.replace", side_effect=PermissionError("file locked"))):
            for path, save, load in self.paths():
                with self.subTest(path=path.name, failure=failure):
                    save(original)
                    before = path.read_bytes()
                    with failure, self.assertRaises((OSError, PermissionError)):
                        save([])
                    self.assertEqual(path.read_bytes(), before)  # token survives
                    self.assertEqual(load(), original)
                    self.assertEqual(list(path.parent.iterdir()), [path])  # temp file cleaned up

    def test_load_auth_keys_still_accepts_legacy_list(self):
        items = [{"id": "key-a"}]
        self.backend.auth_keys_path.parent.mkdir(parents=True, exist_ok=True)
        self.backend.auth_keys_path.write_text(json.dumps(items), encoding="utf-8")
        self.assertEqual(self.backend.load_auth_keys(), items)


if __name__ == "__main__":
    unittest.main()
