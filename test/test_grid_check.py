from __future__ import annotations

import base64
import io
import json
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance

from services import grid_check
from services.image_task_service import ImageTaskService
from test.test_keep_forever_and_retry_settings import OWNER, wait_status


def png(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    return buffer.getvalue()


def split(first: str, second: str, vertical: bool) -> Image.Image:
    image = Image.new("RGB", (120, 120), first)
    ImageDraw.Draw(image).rectangle((60, 0, 120, 120) if vertical else (0, 60, 120, 120), fill=second)
    return image


A = split("red", "blue", vertical=True)
B = split("green", "yellow", vertical=False)
SIGNATURES = {"R1C1": grid_check.signature(png(A), 1.0), "R1C2": grid_check.signature(png(B), 1.0)}
A_REDRAWN = png(ImageEnhance.Brightness(A).enhance(1.1))  # a re-draw of A: same picture, a bit brighter


class GridCheckTests(unittest.TestCase):
    def test_judge(self):
        result = grid_check.signature(A_REDRAWN, 1.0)
        self.assertEqual(grid_check.judge(result, SIGNATURES, "R1C1"), {"mismatch": False, "best_cell": "R1C1"})
        self.assertEqual(grid_check.judge(result, SIGNATURES, "R1C2"), {"mismatch": True, "best_cell": "R1C1"})

    def test_parse(self):
        field = json.dumps({"cell": "R1C2", "aspect": 1, "signatures": SIGNATURES})
        self.assertEqual(grid_check.parse(field)["cell"], "R1C2")
        self.assertIsNone(grid_check.parse(json.dumps({"cell": "R9C9", "aspect": 1, "signatures": SIGNATURES})))
        self.assertIsNone(grid_check.parse("not json"))
        self.assertIsNone(grid_check.parse(None))


class GridRedoTaskTests(unittest.TestCase):
    def run_cell(self, results: list[bytes]):
        """R1C2's task, where the model returns `results` in turn; returns (calls made, finished task)."""
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        calls = []

        def handler(_payload):
            calls.append(1)
            return {"data": [{"b64_json": base64.b64encode(results[min(len(calls), len(results)) - 1]).decode()}]}

        service = ImageTaskService(Path(tmp.name) / "tasks.json", generation_handler=handler, edit_handler=handler,
                                   retention_days_getter=lambda: 30)
        service.submit_edit(OWNER, client_task_id="cell", prompt="p", model="gpt-image-2", size=None,
                            images=[(b"crop", "R1C2.png", "image/png")],
                            grid_check={"cell": "R1C2", "aspect": 1.0, "signatures": SIGNATURES})
        return calls, wait_status(service, "cell", "success")

    def test_wrong_cell_is_redone_until_it_matches(self):
        calls, task = self.run_cell([A_REDRAWN, png(B)])
        self.assertEqual(len(calls), 2)
        self.assertEqual(task["grid_check"], {"mismatch": False, "best_cell": "R1C2", "redos": 1})

    def test_redos_stop_after_the_cap_and_keep_the_flag(self):
        calls, task = self.run_cell([A_REDRAWN])
        self.assertEqual(len(calls), 1 + grid_check.MAX_REDOS)
        self.assertEqual(task["grid_check"], {"mismatch": True, "best_cell": "R1C1", "redos": grid_check.MAX_REDOS})


if __name__ == "__main__":
    unittest.main()
