from __future__ import annotations

import unittest
from unittest import mock

from services import image_model_service


class _FakeBackend:
    def __init__(self, *, result=None, error: Exception | None = None):
        self.result = result
        self.error = error
        self.closed = False

    def list_models(self):
        if self.error:
            raise self.error
        return self.result

    def close(self):
        self.closed = True


class ImageModelServiceTests(unittest.TestCase):
    def test_refresh_keeps_only_image_capable_models_and_saves_cache(self):
        backend = _FakeBackend(result={
            "data": [
                {"id": "gpt-image-2.5-sunburst"},
                {"id": "gpt-5-6"},
                {"id": "gpt-5.6-mini"},
                {"id": "gpt-4o"},
            ],
        })
        saved_payload = {}

        def fake_update(payload):
            saved_payload.update(payload)
            return {
                "image_models": payload["image_models_cache"],
                "default_image_model": "gpt-image-2",
                "image_models_source": payload["image_models_source"],
                "image_models_updated_at": payload["image_models_updated_at"],
            }

        with (
            mock.patch.object(image_model_service.account_service, "get_text_access_token", return_value="token"),
            mock.patch.object(image_model_service, "OpenAIBackendAPI", return_value=backend),
            mock.patch.object(image_model_service.config, "update", side_effect=fake_update),
        ):
            result = image_model_service.refresh_image_model_catalog()

        self.assertTrue(result["refreshed"])
        self.assertIn("gpt-image-2.5-sunburst", saved_payload["image_models_cache"])
        self.assertIn("gpt-5-6", saved_payload["image_models_cache"])
        self.assertNotIn("gpt-5.6-mini", saved_payload["image_models_cache"])
        self.assertNotIn("gpt-4o", saved_payload["image_models_cache"])
        self.assertTrue(backend.closed)

    def test_refresh_failure_returns_cached_catalog_without_overwriting_it(self):
        backend = _FakeBackend(error=RuntimeError("upstream unavailable"))
        cached = {
            "models": ["gpt-image-2.5-sunburst", "gpt-image-2"],
            "default_image_model": "gpt-image-2.5-sunburst",
            "source": "upstream",
            "updated_at": "2026-09-20T12:00:00+00:00",
        }
        with (
            mock.patch.object(image_model_service.account_service, "get_text_access_token", return_value="token"),
            mock.patch.object(image_model_service, "OpenAIBackendAPI", return_value=backend),
            mock.patch.object(image_model_service, "get_image_model_catalog", return_value=cached),
            mock.patch.object(image_model_service.config, "update") as update,
        ):
            result = image_model_service.refresh_image_model_catalog()

        self.assertFalse(result["refreshed"])
        self.assertEqual(result["models"], cached["models"])
        self.assertIn("upstream unavailable", result["error"])
        update.assert_not_called()
        self.assertTrue(backend.closed)


if __name__ == "__main__":
    unittest.main()
