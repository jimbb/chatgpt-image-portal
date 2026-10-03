from __future__ import annotations

import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from services import config as config_module
from services.image_task_service import ImageTaskService


class KeepForeverTests(unittest.TestCase):
    def test_retention_zero_keeps_old_images(self):
        cfg = config_module.config
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(config_module, "DATA_DIR", Path(tmp)):
            old = cfg.images_dir / "2000" / "01" / "01" / "old.png"
            old.parent.mkdir(parents=True)
            old.write_bytes(b"x")
            os.utime(old, (0, 0))
            with mock.patch.dict(cfg.data, {"image_retention_days": 0}):
                self.assertEqual(cfg.cleanup_old_images(), 0)
                self.assertTrue(old.exists())
            with mock.patch.dict(cfg.data, {"image_retention_days": 1}):
                self.assertEqual(cfg.cleanup_old_images(), 1)

    def test_retention_zero_keeps_task_records(self):
        with tempfile.TemporaryDirectory() as tmp:
            days = {"value": 0}
            service = ImageTaskService(
                Path(tmp) / "tasks.json",
                generation_handler=lambda _payload: {"data": []},
                edit_handler=lambda _payload: {"data": []},
                retention_days_getter=lambda: days["value"],
            )
            service._tasks["old"] = {"status": "success", "updated_at": "2000-01-01 00:00:00"}
            self.assertFalse(service._cleanup_locked())
            self.assertIn("old", service._tasks)
            days["value"] = 1
            self.assertTrue(service._cleanup_locked())

    def test_retry_settings_clamp(self):
        cfg = config_module.config
        with mock.patch.dict(cfg.data, {"image_retry_target_percent": 150, "image_retry_max_rounds": -3}):
            self.assertEqual(cfg.image_retry_target_percent, 100)
            self.assertEqual(cfg.image_retry_max_rounds, 0)
        with mock.patch.dict(cfg.data, {"image_retry_target_percent": "junk", "image_retry_max_rounds": "junk"}):
            self.assertEqual(cfg.image_retry_target_percent, 0)
            self.assertEqual(cfg.image_retry_max_rounds, 20)


OWNER = {"id": "owner-1", "name": "Owner", "role": "admin"}
REFUSAL = "非常抱歉，该提示可能违反了我们的内容政策"


def wait_status(service: ImageTaskService, task_id: str, status: str, timeout: float = 3.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        task = service.list_tasks(OWNER, [task_id])["items"][0]
        if task["status"] == status:
            return task
        time.sleep(0.02)
    raise AssertionError(f"{task_id} never reached {status}: {task}")


class ServerAutoRetryTests(unittest.TestCase):
    def make_service(self, handler, settings):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        patch = mock.patch.dict(config_module.config.data, settings)
        patch.start()
        self.addCleanup(patch.stop)
        service = ImageTaskService(Path(tmp.name) / "tasks.json", generation_handler=handler, edit_handler=handler,
                                   retention_days_getter=lambda: 30)
        service.auto_retry_delay_secs = 0
        return service

    def submit(self, service, task_id, prompt="p", batch_id="b", batch_size=2):
        service.submit_generation(OWNER, client_task_id=task_id, prompt=prompt, model="gpt-image-2", size=None,
                                  batch_id=batch_id, batch_size=batch_size)

    def test_reruns_failed_image_until_batch_reaches_target(self):
        calls = []

        def handler(_payload):
            calls.append(1)
            if len(calls) < 3:
                raise RuntimeError(REFUSAL)
            return {"data": [{"url": "http://x/1.png"}]}

        service = self.make_service(handler, {"image_retry_target_percent": 50, "image_retry_max_rounds": 5})
        self.submit(service, "b-0")
        self.assertEqual(wait_status(service, "b-0", "success")["attempts"], 3)

    def test_no_retry_once_batch_already_met_target(self):
        def handler(payload):
            if payload["prompt"] == "ok":
                return {"data": [{"url": "http://x/1.png"}]}
            raise RuntimeError(REFUSAL)

        service = self.make_service(handler, {"image_retry_target_percent": 50, "image_retry_max_rounds": 5})
        self.submit(service, "b-0", prompt="ok")
        wait_status(service, "b-0", "success")
        self.submit(service, "b-1", prompt="bad")
        self.assertNotIn("attempts", wait_status(service, "b-1", "error"))

    def test_no_retry_without_batch_or_on_quota_errors(self):
        calls = []

        def handler(payload):
            calls.append(payload["prompt"])
            raise RuntimeError("no available image quota" if payload["prompt"] == "quota" else REFUSAL)

        service = self.make_service(handler, {"image_retry_target_percent": 100, "image_retry_max_rounds": 5})
        self.submit(service, "solo", batch_id="", batch_size=0)  # gen.py / API callers send no batch
        self.submit(service, "q-0", prompt="quota")
        wait_status(service, "solo", "error")
        wait_status(service, "q-0", "error")
        self.assertEqual(sorted(calls), ["p", "quota"])

    def test_chat_override_beats_global_target(self):
        calls = []

        def refuse_once(_payload):
            calls.append(1)
            if len(calls) == 1:
                raise RuntimeError(REFUSAL)
            return {"data": [{"url": "http://x/1.png"}]}

        service = self.make_service(refuse_once, {"image_retry_target_percent": 0, "image_retry_max_rounds": 5})
        service.submit_generation(OWNER, client_task_id="o-0", prompt="p", model="gpt-image-2", size=None,
                                  batch_id="o", batch_size=1, batch_target_percent=50)
        self.assertEqual(wait_status(service, "o-0", "success")["attempts"], 2)  # global off, chat 50%: retried

        calls.clear()
        service = self.make_service(refuse_once, {"image_retry_target_percent": 100, "image_retry_max_rounds": 5})
        service.submit_generation(OWNER, client_task_id="z-0", prompt="p", model="gpt-image-2", size=None,
                                  batch_id="z", batch_size=1, batch_target_percent=0)
        wait_status(service, "z-0", "error")  # global 100%, chat 0%: not retried
        self.assertEqual(len(calls), 1)

    def test_batch_runs_at_most_n_images_at_once(self):
        lock, active, peak = threading.Lock(), [0], [0]

        def slow(_payload):
            with lock:
                active[0] += 1
                peak[0] = max(peak[0], active[0])
            time.sleep(0.15)
            with lock:
                active[0] -= 1
            return {"data": [{"url": "http://x/1.png"}]}

        service = self.make_service(slow, {"image_batch_concurrency": 2, "image_retry_target_percent": 0})
        for i in range(5):
            self.submit(service, f"g-{i}", batch_id="g", batch_size=5)
        for i in range(5):
            wait_status(service, f"g-{i}", "success", timeout=5)
        self.assertEqual(peak[0], 2)

    def test_max_retries_per_image(self):
        def always_refuse(_payload):
            raise RuntimeError(REFUSAL)

        service = self.make_service(always_refuse, {"image_retry_target_percent": 100, "image_retry_max_rounds": 2})
        self.submit(service, "b-0")
        task = wait_status(service, "b-0", "error")
        self.assertEqual(task["attempts"], 3)  # first try + 2 retries


if __name__ == "__main__":
    unittest.main()


class ImageManagerCleanupTests(unittest.TestCase):
    """The image manager's list used to run both retention cleanups inline on every request (~12s)."""

    def list_with_retention(self, days):
        from services import image_service

        with (
            mock.patch.dict(config_module.config.data, {"image_retention_days": days}),
            mock.patch.object(config_module.config, "cleanup_old_images") as old_images,
            mock.patch.object(image_service, "cleanup_image_thumbnails") as thumbnails,
            mock.patch.object(image_service.image_storage_service, "list_items", return_value=[]),
            mock.patch.object(image_service, "_last_cleanup", 0.0),
        ):
            image_service.list_images("http://x")
            image_service.list_images("http://x")  # a second page load right after
            time.sleep(0.2)  # the cleanup runs in a background thread
            return old_images.call_count, thumbnails.call_count

    def test_keep_forever_never_cleans_up(self):
        self.assertEqual(self.list_with_retention(0), (0, 0))

    def test_retention_cleans_up_in_the_background_at_most_every_10_minutes(self):
        self.assertEqual(self.list_with_retention(30), (1, 1))
