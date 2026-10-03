from __future__ import annotations

from datetime import datetime, timezone
import re
from typing import Any

from services.account_service import account_service
from services.config import DEFAULT_IMAGE_MODELS, config
from services.openai_backend_api import OpenAIBackendAPI


_MAINLINE_MODEL_RE = re.compile(r"^gpt-(?P<major>\d+)(?:[-.].*)?$")
_EXCLUDED_MAINLINE_MARKERS = {
    "audio",
    "codex",
    "image",
    "mini",
    "nano",
    "realtime",
    "search",
    "transcribe",
    "tts",
}


def _is_image_capable_model(model: object) -> bool:
    slug = str(model or "").strip().lower()
    if slug.startswith(("gpt-image-", "chatgpt-image-")):
        return True
    match = _MAINLINE_MODEL_RE.match(slug)
    if not match or int(match.group("major")) < 5:
        return False
    parts = set(slug.replace(".", "-").split("-"))
    return not bool(parts & _EXCLUDED_MAINLINE_MARKERS)


def _merge_models(discovered: list[str]) -> list[str]:
    models: list[str] = []
    for item in [*DEFAULT_IMAGE_MODELS, *discovered]:
        model = str(item or "").strip().lower()
        if model and _is_image_capable_model(model) and model not in models:
            models.append(model)
    return models


def get_image_model_catalog() -> dict[str, Any]:
    from services.image_provider_service import provider_models  # local import: avoids an import cycle

    return {
        "models": list(dict.fromkeys([*config.image_models, *provider_models()])),
        "default_image_model": config.default_image_model,
        "retry_target_percent": config.image_retry_target_percent,  # shown on the composer's auto-retry toggle
        "grid_prompt_template": config.image_grid_prompt_template,  # grid mode builds each cell's prompt
        "source": config.image_models_source,
        "updated_at": config.image_models_updated_at,
    }


def refresh_image_model_catalog() -> dict[str, Any]:
    """从 ChatGPT 官方上游模型目录刷新，失败时保留最近成功列表。"""
    backend: OpenAIBackendAPI | None = None
    try:
        access_token = account_service.get_text_access_token()
        backend = OpenAIBackendAPI(access_token=access_token)
        result = backend.list_models()
        data = result.get("data") if isinstance(result, dict) else None
        discovered = [
            str(item.get("id") or "").strip().lower()
            for item in data or []
            if isinstance(item, dict) and _is_image_capable_model(item.get("id"))
        ]
        if not discovered:
            raise RuntimeError("上游模型目录未返回可用的生图模型")
        models = _merge_models(discovered)
        updated_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        saved = config.update({
            "image_models_cache": models,
            "image_models_source": "upstream",
            "image_models_updated_at": updated_at,
        })
        return {
            "refreshed": True,
            "models": saved["image_models"],
            "default_image_model": saved["default_image_model"],
            "source": saved["image_models_source"],
            "updated_at": saved["image_models_updated_at"],
            "error": "",
        }
    except Exception as exc:
        catalog = get_image_model_catalog()
        return {
            "refreshed": False,
            **catalog,
            "error": str(exc) or "拉取上游模型目录失败",
        }
    finally:
        if backend is not None:
            backend.close()
