from __future__ import annotations

import time
import unittest
from types import SimpleNamespace
from unittest import mock

from services import config as config_module
from services.protocol import conversation as conv


class PoolDeadlineTests(unittest.TestCase):
    def test_waiting_for_an_account_slot_does_not_eat_the_generation_budget(self):
        """With more images than pool slots, jobs queue for a slot; that wait used to count against
        image_poll_timeout_secs, so the stream got ~0 seconds ("超过硬上限 0.001 秒")."""
        seen = {}

        def slow_slot(**_kwargs):
            time.sleep(1.3)  # longer than the whole 1s budget below
            return "token"

        def fake_stream(backend, request, index, total):
            seen["remaining"] = backend.image_request_deadline - time.monotonic()
            yield conv.ImageOutput(kind="result", model=request.model, index=index, total=total,
                                   data=[{"url": "http://x/1.png"}])

        accounts = mock.Mock()
        accounts.get_available_access_token.side_effect = slow_slot
        accounts.get_account.return_value = {}
        with mock.patch.dict(config_module.config.data, {"image_poll_timeout_secs": 1}), \
                mock.patch.object(conv, "account_service", accounts), \
                mock.patch.object(conv, "OpenAIBackendAPI", lambda **_kw: SimpleNamespace(close=lambda: None)), \
                mock.patch.object(conv, "stream_image_outputs", fake_stream), \
                mock.patch.object(conv, "_remove_image_conversation_later", lambda *a, **k: None):
            request = conv.ConversationRequest(model="gpt-image-2", prompt="p")
            outputs = conv._generate_single_image(request, 1, 1)

        self.assertEqual(outputs[0].kind, "result")
        self.assertGreater(seen["remaining"], 0.5)  # the full budget is still there after the wait


if __name__ == "__main__":
    unittest.main()
