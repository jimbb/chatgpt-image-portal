from __future__ import annotations

import base64
import io
import unittest
from unittest import mock

from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

import api.image_tasks as image_tasks_module


def data_url(image: Image.Image) -> str:
    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


class GridFacesApiTests(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.object(image_tasks_module, "require_identity", return_value={"id": "test", "role": "admin"})
        patcher.start()
        self.addCleanup(patcher.stop)
        app = FastAPI()
        app.include_router(image_tasks_module.create_router())
        self.client = TestClient(app)

    def post(self, image: str, boxes: dict):
        return self.client.post("/api/grid/faces", json={"image": image, "boxes": boxes})

    def test_cells_without_faces(self):
        # plain colour blocks: no faces; a box past the edge is clipped, a sliver of one skipped
        screenshot = Image.new("RGB", (200, 100), "white")
        screenshot.paste((200, 120, 90), (100, 0, 200, 100))
        response = self.post(data_url(screenshot), {"R1C1": [0, 0, 99, 100], "R1C2": [101, 0, 150, 150], "R2C1": [0, 95, 99, 20]})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {"cells": []})

    def test_bad_input(self):
        screenshot = data_url(Image.new("RGB", (50, 50), "white"))
        self.assertEqual(self.post("data:image/png;base64,not base64!", {}).status_code, 400)
        self.assertEqual(self.post(base64.b64encode(b"not an image").decode(), {}).status_code, 400)
        self.assertEqual(self.post(screenshot, {"R1C1": [0, 0, 50]}).status_code, 400)  # box needs 4 numbers


if __name__ == "__main__":
    unittest.main()
