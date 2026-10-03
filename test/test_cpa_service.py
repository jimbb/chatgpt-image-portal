import unittest
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from tempfile import TemporaryDirectory
from pathlib import Path
from unittest.mock import patch

from services import cpa_service
from services.account_service import AccountService
from services.config import config
from services.storage.json_storage import JSONStorageBackend


class CPAServiceTest(unittest.TestCase):
    def test_image_allowlist_is_local_only_and_filters_scheduler(self):
        previous = config.data.get("image_account_allowlist")
        try:
            config.data["image_account_allowlist"] = ["codex-test.json"]
            self.assertTrue(AccountService._is_image_account_available({"cpa_file_name": "codex-test.json", "status": "正常", "quota": 1}))
            self.assertFalse(AccountService._is_image_account_available({"cpa_file_name": "other.json", "status": "正常", "quota": 1}))
        finally:
            if previous is None:
                config.data.pop("image_account_allowlist", None)
            else:
                config.data["image_account_allowlist"] = previous

    def test_list_cpa_accounts_maps_management_credentials(self):
        files = [{"name": "codex-test.json", "email": "test@example.com", "provider": "codex", "status": "active"}]
        payload = {"access_token": "access", "refresh_token": "refresh", "id_token": "id"}
        with patch.object(cpa_service, "_cpa_source_pool", return_value={"base_url": "http://cpa", "secret_key": "key"}), \
             patch.object(cpa_service, "_cpa_auth_files", return_value=files), \
             patch.object(cpa_service, "_cpa_download", return_value=payload):
            accounts = cpa_service.list_cpa_accounts()

        self.assertEqual(accounts[0]["access_token"], "access")
        self.assertEqual(accounts[0]["email"], "test@example.com")
        self.assertEqual(accounts[0]["cpa_file_name"], "codex-test.json")
        self.assertEqual(accounts[0]["status"], "正常")

    def test_http_account_source_does_not_duplicate_or_refresh_oauth_credentials(self):
        state = {"denied": False, "malformed": False, "download_failed": False, "token": "access"}

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                status = 200
                if state["denied"] or self.headers.get("Authorization") != "Bearer test-management":
                    status, payload = 401, {"error": "unauthorized"}
                elif self.path == "/v8/management/credentials":
                    payload = {} if state["malformed"] else {"files": [
                        {"name": "codex-test.json", "provider": "codex", "status": "active"},
                        {"name": "claude-test.json", "provider": "claude", "status": "active"},
                    ]}
                elif self.path == "/v8/management/credentials/download?name=codex-test.json":
                    if state["download_failed"]:
                        status, payload = 500, {"error": "failure"}
                    else:
                        payload = {"type": "codex", "access_token": state["token"], "refresh_token": "refresh-secret", "id_token": "id-secret", "plan_type": "plus"}
                else:
                    status, payload = 404, {}
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(payload).encode())

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with TemporaryDirectory() as directory:
                path = Path(directory) / "accounts.json"
                storage = JSONStorageBackend(path)
                storage.save_accounts([{"access_token": "existing-local"}])
                before = path.read_bytes()
                service = AccountService(storage)
                pool = {"base_url": f"http://127.0.0.1:{server.server_port}", "secret_key": "test-management"}
                with patch.object(cpa_service, "_cpa_source_pool", return_value=pool), patch.object(cpa_service, "account_service", service), patch.object(cpa_service.proxy_settings, "build_session_kwargs", return_value={"verify": True, "trust_env": False}):
                    accounts = cpa_service.sync_cpa_accounts_to_local()
                    self.assertEqual(len(accounts), 1)
                    self.assertTrue(accounts[0]["cpa_quota_unknown"])
                    self.assertNotIn("refresh_token", accounts[0])
                    self.assertNotIn("id_token", accounts[0])
                    self.assertTrue(service._is_image_account_available(accounts[0]))
                    with patch.object(service, "_request_access_token_refresh", side_effect=AssertionError("CPA owns OAuth")):
                        self.assertEqual(service.refresh_access_token("access"), "access")
                    service.update_account("access", {"quota": 7, "cpa_quota_unknown": False}, quiet=True)
                    self.assertEqual(path.read_bytes(), before)
                    self.assertEqual(cpa_service.sync_cpa_accounts_to_local()[0]["quota"], 7)
                    state["token"] = "rotated-access"
                    cpa_service.sync_cpa_accounts_to_local()
                    self.assertEqual(service.resolve_access_token("access"), "rotated-access")
                    self.assertEqual(path.read_bytes(), before)
                    for failure in ("denied", "malformed", "download_failed"):
                        state[failure] = True
                        with self.assertRaises(RuntimeError):
                            cpa_service.sync_cpa_accounts_to_local()
                        self.assertEqual(service.list_tokens(), ["rotated-access"])
                        state[failure] = False
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()
