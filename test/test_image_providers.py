from __future__ import annotations

import base64
import io
import json
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

from PIL import Image

from services import config as config_module
from services import image_provider_service as providers
from services.image_provider_service import CHATGPT_POOL

config = config_module.config


def png_bytes() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (4, 4), "red").save(buf, "PNG")
    return buf.getvalue()


PNG = png_bytes()


class FakeProvider(BaseHTTPRequestHandler):
    """Minimal OpenAI-compatible image API, plus chatgpt2api-style async tasks."""

    seen: list[dict] = []

    def log_message(self, *args):
        pass

    def _send(self, status: int, body: object | bytes, content_type: str = "application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        self.seen.append({"path": self.path, "headers": dict(self.headers), "body": raw})
        base = f"http://127.0.0.1:{self.server.server_port}"
        if self.path.endswith("/images/edits"):
            return self._send(200, {"data": [{"url": f"{base}/files/out.png"}]})
        body = json.loads(raw or b"{}")
        if body.get("prompt") == "broke":
            return self._send(403, {"code": "INSUFFICIENT_BALANCE", "message": "Insufficient account balance"})
        if body.get("async"):
            return self._send(202, {"task_id": "refused" if body.get("prompt") == "refuse" else "t1"})
        return self._send(200, {"data": [{"b64_json": base64.b64encode(PNG).decode(), "revised_prompt": "rp"}]})

    def do_GET(self):
        self.seen.append({"path": self.path, "headers": dict(self.headers), "body": b""})
        base = f"http://127.0.0.1:{self.server.server_port}"
        if self.path.startswith("/files/"):
            return self._send(200, PNG, "image/png")
        if self.path.startswith("/api/image-tasks?ids=refused"):
            return self._send(200, {"items": [{"status": "text_review", "terminal": True, "public_error": "内容政策"}]})
        if self.path.startswith("/api/image-tasks"):
            return self._send(200, {"items": [{"status": "success", "terminal": True, "results": [{"url": f"{base}/files/out.png"}]}]})
        return self._send(404, {"error": "not found"})


class ProviderHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), FakeProvider)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        FakeProvider.seen = []
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        for patch in (
            mock.patch.object(config_module, "DATA_DIR", Path(tmp.name)),
            mock.patch.object(providers, "POLL_INTERVAL_SECS", 0),
        ):
            patch.start()
            self.addCleanup(patch.stop)

    def provider(self, **overrides):
        return providers._normalize_provider({
            "name": "fake", "base_url": f"{self.base}/v1", "api_key": "k-123", "models": ["gpt-image-2.5"], **overrides,
        })

    def test_sync_generation_saves_image_locally(self):
        result = providers._call_provider(self.provider(), "generate", {"prompt": "cat", "response_format": "b64_json"}, "gpt-image-2.5")
        item = result["data"][0]
        self.assertEqual(base64.b64decode(item["b64_json"]), PNG)
        self.assertIn("/images/", item["url"])
        self.assertEqual(item["revised_prompt"], "rp")
        sent = json.loads(FakeProvider.seen[0]["body"])
        self.assertEqual((sent["model"], sent["prompt"]), ("gpt-image-2.5", "cat"))
        self.assertEqual(FakeProvider.seen[0]["headers"]["Authorization"], "Bearer k-123")

    def test_edit_uploads_image_multipart_and_downloads_url(self):
        payload = {"prompt": "night", "images": [(PNG, "in.png", "image/png")], "response_format": "url"}
        result = providers._call_provider(self.provider(), "edit", payload, "gpt-image-2.5")
        post, download = FakeProvider.seen
        self.assertIn("multipart/form-data", post["headers"]["Content-Type"])
        self.assertIn(b'name="image"', post["body"])
        self.assertIn(PNG, post["body"])
        self.assertEqual(download["headers"].get("Authorization"), "Bearer k-123")  # same host only
        self.assertNotIn("b64_json", result["data"][0])

    def test_async_poll_provider(self):
        result = providers._call_provider(self.provider(async_poll=True), "generate", {"prompt": "cat"}, "gpt-image-2.5")
        self.assertEqual(base64.b64decode(result["data"][0]["b64_json"]), PNG)
        submit = FakeProvider.seen[0]
        self.assertTrue(json.loads(submit["body"])["async"])
        self.assertTrue(submit["headers"].get("Idempotency-Key"))
        with self.assertRaisesRegex(RuntimeError, "内容政策"):
            providers._call_provider(self.provider(async_poll=True), "generate", {"prompt": "refuse"}, "gpt-image-2.5")

    def test_balance_error_is_not_auto_retryable(self):
        with self.assertRaises(RuntimeError) as ctx:
            providers._call_provider(self.provider(), "generate", {"prompt": "broke"}, "gpt-image-2.5")
        self.assertIn("403", str(ctx.exception))
        self.assertTrue(providers.NO_AUTO_RETRY_ERRORS.search(str(ctx.exception)))


class RoutingTests(unittest.TestCase):
    def setUp(self):
        patch = mock.patch.dict(config.data, {
            "image_providers": [
                {"id": "async-example", "name": "async-example", "base_url": "https://m/v1", "api_key": "k",
                 "models": ["gpt-image-2.5-sunburst", "gpt-image-2"]},
                {"id": "fallback", "name": "fallback-example", "base_url": "https://l/v1", "api_key": "k",
                 "models": ["gpt-image-2.5", "gpt-image-2.5-sunburst=gpt-image-2.5"]},
                {"id": "nokey", "name": "nokey", "base_url": "https://n/v1", "api_key": "", "models": ["gpt-image-2.5"]},
            ],
            "image_provider_order": ["fallback", "async-example", CHATGPT_POOL],
            "image_chatgpt_pool_enabled": True,
        })
        patch.start()
        self.addCleanup(patch.stop)
        self.calls: list[tuple[str, str]] = []
        self.outcomes: dict[str, Exception | None] = {}

        def fake_call(provider, mode, payload, remote_model):
            self.calls.append((provider["id"], remote_model))
            if self.outcomes.get(provider["id"]):
                raise self.outcomes[provider["id"]]
            return {"data": [{"url": provider["id"]}]}

        patch_call = mock.patch.object(providers, "_call_provider", side_effect=fake_call)
        patch_call.start()
        self.addCleanup(patch_call.stop)

    def pool(self, payload):
        self.calls.append((CHATGPT_POOL, payload["model"]))
        if self.outcomes.get(CHATGPT_POOL):
            raise self.outcomes[CHATGPT_POOL]
        return {"data": [{"url": CHATGPT_POOL}]}

    def test_ranking_order_and_model_mapping(self):
        self.assertEqual(providers.ranking(), ["fallback", "async-example", CHATGPT_POOL, "nokey"])
        result = providers.route("generate", {"model": "gpt-image-2.5-sunburst"}, self.pool)
        self.assertEqual(result["data"][0]["url"], "fallback")
        self.assertEqual(self.calls, [("fallback", "gpt-image-2.5")])

    def test_falls_through_to_next_provider_then_pool(self):
        self.outcomes = {"fallback": RuntimeError("HTTP 403 Insufficient account balance"),
                         "async-example": RuntimeError("非常抱歉，该提示可能违反了我们的内容政策")}
        result = providers.route("generate", {"model": "gpt-image-2.5-sunburst"}, self.pool)
        self.assertEqual(result["data"][0]["url"], CHATGPT_POOL)
        self.assertEqual([c[0] for c in self.calls], ["fallback", "async-example", CHATGPT_POOL])

    def test_all_fail_surfaces_retryable_error_over_balance(self):
        refusal = RuntimeError("非常抱歉，该提示可能违反了我们的内容政策")
        self.outcomes = {"fallback": RuntimeError("Insufficient account balance"), "async-example": refusal,
                         CHATGPT_POOL: RuntimeError("no available image quota")}
        with self.assertRaises(RuntimeError) as ctx:
            providers.route("generate", {"model": "gpt-image-2.5-sunburst"}, self.pool)
        self.assertIs(ctx.exception, refusal)

    def test_skips_keyless_disabled_and_unsupported(self):
        # plain gpt-image-2.5: only fallback-example offers it (nokey has no key, the pool doesn't know the name)
        self.outcomes = {"fallback": RuntimeError("down")}
        with self.assertRaisesRegex(RuntimeError, "down"):
            providers.route("generate", {"model": "gpt-image-2.5"}, self.pool)
        self.assertEqual(self.calls, [("fallback", "gpt-image-2.5")])
        config.data["image_chatgpt_pool_enabled"] = False
        self.calls.clear()
        providers.route("generate", {"model": "gpt-image-2"}, self.pool)
        self.assertEqual(self.calls, [("async-example", "gpt-image-2")])

    def test_no_provider_for_model(self):
        with self.assertRaisesRegex(RuntimeError, "没有可用的生图渠道"):
            providers.route("generate", {"model": "unknown-model"}, self.pool)

    def test_stream_goes_straight_to_pool(self):
        providers.route("generate", {"model": "gpt-image-2", "stream": True}, self.pool)
        self.assertEqual(self.calls, [(CHATGPT_POOL, "gpt-image-2")])

    def test_usable_provider_models_are_listed_but_not_given_to_the_pool(self):
        from services.image_model_service import get_image_model_catalog
        from utils.helper import is_supported_image_model

        self.assertIn("gpt-image-2.5", get_image_model_catalog()["models"])  # fallback-example has a key
        self.assertNotIn("gpt-image-2.5", config.image_models)
        self.assertFalse(is_supported_image_model("gpt-image-2.5"))  # the pool must not try provider-only names
        self.assertNotIn("image_providers", config.get())  # keys never go out with /api/settings


class ProviderCrudTests(unittest.TestCase):
    def setUp(self):
        patch = mock.patch.dict(config.data, {"image_providers": [], "image_provider_order": []})
        patch.start()
        self.addCleanup(patch.stop)
        update = mock.patch.object(type(config), "update", lambda self, data: self.data.update(data) or self.data)
        update.start()
        self.addCleanup(update.stop)

    def test_create_edit_keep_key_delete_and_order(self):
        view = providers.save_provider(None, {"name": "fallback-example", "base_url": "https://fallback-example.com/v1/",
                                              "api_key": "sk-secret-1234", "models": ["gpt-image-2.5", "gpt-image-2"]})
        created = view["providers"][0]
        self.assertEqual((created["base_url"], created["api_key"], created["api_key_hint"]), ("https://fallback-example.com/v1", "", "1234"))
        pid = created["id"]
        providers.save_provider(pid, {"name": "fallback-example 2", "api_key": ""})  # blank key keeps the saved one
        stored = providers.list_providers()[0]
        self.assertEqual((stored["name"], stored["api_key"], stored["models"]), ("fallback-example 2", "sk-secret-1234", ["gpt-image-2.5", "gpt-image-2"]))
        providers.set_order([pid, CHATGPT_POOL], chatgpt_pool_enabled_value=False)
        self.assertEqual(providers.admin_view()["order"], [pid, CHATGPT_POOL])
        self.assertFalse(providers.chatgpt_pool_enabled())
        self.assertEqual(providers.delete_provider(pid)["providers"], [])
        with self.assertRaises(KeyError):
            providers.delete_provider(pid)

    def test_validation(self):
        with self.assertRaisesRegex(ValueError, "http"):
            providers.save_provider(None, {"name": "x", "base_url": "fallback-example.com", "models": ["m"]})
        with self.assertRaisesRegex(ValueError, "模型"):
            providers.save_provider(None, {"name": "x", "base_url": "https://x/v1", "models": []})


class StatsAndTestProviderTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        for patch in (
            mock.patch.object(providers, "STATS_FILE", Path(tmp.name) / "stats.json"),
            mock.patch.object(providers, "_stats", None),
            mock.patch.dict(config.data, {
                "image_providers": [
                    {"id": "m", "name": "async-example", "base_url": "https://m/v1", "api_key": "k", "models": ["gpt-image-2"]},
                    {"id": "nokey", "name": "n", "base_url": "https://n/v1", "api_key": "", "models": ["gpt-image-2"]},
                ],
                "image_provider_order": ["m", CHATGPT_POOL],
                "image_chatgpt_pool_enabled": True,
            }),
        ):
            patch.start()
            self.addCleanup(patch.stop)

    def test_route_records_outcomes_and_success_rate(self):
        with mock.patch.object(providers, "_call_provider", side_effect=RuntimeError("refused")):
            providers.route("generate", {"model": "gpt-image-2"}, lambda _p: {"data": [{"url": "u"}]})
        stats = providers.provider_stats()
        self.assertEqual((stats["m"]["total"], stats["m"]["rate"], stats["m"]["last_error"]), (1, 0, "refused"))
        self.assertEqual((stats[CHATGPT_POOL]["success"], stats[CHATGPT_POOL]["rate"]), (1, 100))
        self.assertTrue(providers.STATS_FILE.exists())  # survives restarts
        for _ in range(60):
            providers.record_outcome("m", "gpt-image-2", True, "", time.monotonic())
        self.assertEqual(providers.provider_stats()["m"]["total"], providers.STATS_WINDOW)
        self.assertIn("stats", providers.admin_view())

    def test_test_provider_uses_only_that_provider(self):
        with mock.patch.object(providers, "_call_provider", return_value={"data": [{"url": "http://local/images/x.png"}]}) as call:
            result = providers.test_provider("m", "gpt-image-2", "apple")
        self.assertEqual((result["ok"], result["url"]), (True, "http://local/images/x.png"))
        self.assertEqual(call.call_args.args[0]["id"], "m")
        with mock.patch.object(providers, "_call_provider", side_effect=RuntimeError("HTTP 403 Insufficient account balance")):
            failed = providers.test_provider("m", "gpt-image-2", "apple")
        self.assertFalse(failed["ok"])
        self.assertIn("balance", failed["error"])
        self.assertEqual(providers.provider_stats()["m"]["total"], 2)
        with self.assertRaisesRegex(ValueError, "API Key"):
            providers.test_provider("nokey", "gpt-image-2", "apple")
        with self.assertRaisesRegex(ValueError, "模型"):
            providers.test_provider("m", "other-model", "apple")
        with self.assertRaises(KeyError):
            providers.test_provider("missing", "gpt-image-2", "apple")
        with mock.patch.object(providers.openai_v1_image_generations, "handle", return_value={"data": [{"url": "pool-url"}]}):
            self.assertEqual(providers.test_provider(CHATGPT_POOL, "gpt-image-2", "apple")["url"], "pool-url")


if __name__ == "__main__":
    unittest.main()
