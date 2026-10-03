from __future__ import annotations

import unittest
from unittest import mock

from services.account_service import AccountService
from test.test_account_export import MemoryStorage
from utils.helper import UpstreamHTTPError


class FakeBackend:
    """OpenAIBackendAPI for probes: answers each conversation read with the next of `answers`."""

    answers: list[Exception | None] = []

    def __init__(self, access_token: str = "") -> None:
        self.access_token = access_token

    def _get_conversation(self, conversation_id, timeout_secs=60.0):
        answer = FakeBackend.answers.pop(0)
        if answer:
            raise answer
        return {"mapping": {}}


class AccountThrottleTests(unittest.TestCase):
    def setUp(self):
        self.service = AccountService(MemoryStorage())
        self.service.add_account_items([{"access_token": "tok-a", "email": "a@x.com", "type": "plus", "quota": 5}])
        self.service._throttle_prober_running = True  # the test drives the probes itself, no background thread
        self.recovered: list[str] = []
        self.service.add_image_recovery_listener(self.recovered.append)
        patcher = mock.patch("services.openai_backend_api.OpenAIBackendAPI", FakeBackend)
        patcher.start()
        self.addCleanup(patcher.stop)

    def available(self):
        return self.service._list_available_candidate_tokens()

    def test_throttled_account_sits_out_until_a_probe_gets_through(self):
        self.assertIn("tok-a", self.available())
        self.service.mark_image_throttled("tok-a", "conv-1")
        self.assertNotIn("tok-a", self.available())
        self.assertIn("image_throttled", self.service.list_accounts()[0])

        FakeBackend.answers = [UpstreamHTTPError("conversation", 429, "slow down")]
        self.assertFalse(self.service._probe_throttled("tok-a", "conv-1"))
        self.assertEqual(self.service._image_throttled["tok-a"]["interval"], 600.0)  # probes back off
        self.assertNotIn("tok-a", self.available())

        FakeBackend.answers = [None]
        self.assertTrue(self.service._probe_throttled("tok-a", "conv-1"))
        self.assertIn("tok-a", self.available())
        self.assertNotIn("image_throttled", self.service.list_accounts()[0])
        self.assertEqual(self.recovered, ["a@x.com"])

    def test_network_trouble_is_not_a_verdict(self):
        self.service.mark_image_throttled("tok-a", "conv-1")
        FakeBackend.answers = [ConnectionError("offline")]
        self.assertFalse(self.service._probe_throttled("tok-a", "conv-1"))
        self.assertEqual(self.service._image_throttled["tok-a"]["interval"], 300.0)  # no back-off
        self.assertEqual(self.recovered, [])


if __name__ == "__main__":
    unittest.main()
