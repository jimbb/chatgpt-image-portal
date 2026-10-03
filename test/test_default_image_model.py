from __future__ import annotations

import unittest
from unittest import mock

from services.config import config
from services.protocol import openai_v1_image_edit, openai_v1_image_generations


class DefaultImageModelTests(unittest.TestCase):
    def test_generation_uses_configured_default_when_model_is_omitted(self) -> None:
        captured = []

        def fake_stream(request):
            captured.append(request)
            return iter([])

        with (
            mock.patch.dict(config.data, {
                "custom_image_models": ["custom-image-v1"],
                "default_image_model": "custom-image-v1",
            }),
            mock.patch.object(openai_v1_image_generations, "stream_image_outputs_with_pool", side_effect=fake_stream),
        ):
            openai_v1_image_generations.handle({"prompt": "draw"})

        self.assertEqual(captured[0].model, "custom-image-v1")

    def test_edit_uses_configured_default_when_model_is_omitted(self) -> None:
        captured = []

        def fake_stream(request):
            captured.append(request)
            return iter([])

        with (
            mock.patch.dict(config.data, {
                "custom_image_models": ["custom-image-v1"],
                "default_image_model": "custom-image-v1",
            }),
            mock.patch.object(openai_v1_image_edit, "encode_images", return_value=["image"]),
            mock.patch.object(openai_v1_image_edit, "stream_image_outputs_with_pool", side_effect=fake_stream),
        ):
            openai_v1_image_edit.handle({"prompt": "edit", "images": [(b"image", "image.png", "image/png")]})

        self.assertEqual(captured[0].model, "custom-image-v1")

    def test_explicit_model_overrides_configured_default(self) -> None:
        captured = []

        def fake_stream(request):
            captured.append(request)
            return iter([])

        with (
            mock.patch.dict(config.data, {
                "custom_image_models": ["custom-image-v1"],
                "default_image_model": "custom-image-v1",
            }),
            mock.patch.object(openai_v1_image_generations, "stream_image_outputs_with_pool", side_effect=fake_stream),
        ):
            openai_v1_image_generations.handle({"prompt": "draw", "model": "gpt-image-2"})

        self.assertEqual(captured[0].model, "gpt-image-2")


if __name__ == "__main__":
    unittest.main()
