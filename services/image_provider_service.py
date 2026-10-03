"""Image providers (Settings → 生图渠道): external OpenAI-compatible image APIs, tried in the admin's ranking
order together with the built-in ChatGPT account pool. A provider that fails, is out of balance or doesn't
offer the requested model falls through to the next one. Provider results are saved locally like pool
images, so they are kept (see image_retention_days) and show up in the gallery."""

from __future__ import annotations

import base64
import json
import re
import threading
import time
import uuid
from datetime import datetime
from typing import Any, Callable
from urllib.parse import urlparse

from curl_cffi import CurlMime, requests

from services.config import DATA_DIR, config
from services.protocol import openai_v1_image_edit, openai_v1_image_generations
from services.protocol.conversation import save_image_bytes
from utils.helper import is_supported_image_model
from utils.log import logger

CHATGPT_POOL = "chatgpt"
# Failures a re-run can't fix (quota, balance, empty pool); timeouts keep their 继续等待 resume flow.
NO_AUTO_RETRY_ERRORS = re.compile(r"quota|额度|限流|号池中没有可用账号|超时|balance|余额|积分|credit", re.IGNORECASE)
REQUEST_TIMEOUT_SECS = 600  # sync providers hold the request until the image is ready
POLL_TIMEOUT_SECS = 1800
POLL_INTERVAL_SECS = 5.0

Handler = Callable[[dict[str, Any]], Any]

# Recent outcomes per provider id (CHATGPT_POOL included), shown as a success rate in Settings → 生图渠道
STATS_FILE = DATA_DIR / "image_provider_stats.json"
STATS_WINDOW = 50
_stats_lock = threading.Lock()
_stats: dict[str, list[dict[str, Any]]] | None = None  # loaded lazily, oldest outcome first


# ---------------------------------------------------------------- configuration


def _normalize_provider(raw: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(raw.get("id") or uuid.uuid4().hex[:8]),
        "name": str(raw.get("name") or "").strip() or "未命名渠道",
        "base_url": str(raw.get("base_url") or "").strip().rstrip("/"),
        "api_key": str(raw.get("api_key") or "").strip(),
        # one entry per model: "gpt-image-2.5" or "界面模型=渠道模型" (e.g. "gpt-image-2.5-sunburst=gpt-image-2.5")
        "models": [str(m).strip() for m in raw.get("models") or [] if str(m).strip()],
        # chatgpt2api-style sites (async-example): submit async and poll, avoiding Cloudflare's 100s cut-off
        "async_poll": bool(raw.get("async_poll")),
        "enabled": raw.get("enabled", True) is not False,
    }


def list_providers() -> list[dict[str, Any]]:
    return [_normalize_provider(p) for p in config.data.get("image_providers") or [] if isinstance(p, dict)]


def chatgpt_pool_enabled() -> bool:
    return config.data.get("image_chatgpt_pool_enabled", True) is not False


def ranking() -> list[str]:
    """Provider ids in try-order, including CHATGPT_POOL; providers never placed go last."""
    ids = [p["id"] for p in list_providers()]
    known = {*ids, CHATGPT_POOL}
    order = list(dict.fromkeys(i for i in config.data.get("image_provider_order") or [] if i in known))
    return order + [i for i in [*ids, CHATGPT_POOL] if i not in order]


def model_map(provider: dict[str, Any]) -> dict[str, str]:
    """UI model name -> the provider's own model name."""
    mapping: dict[str, str] = {}
    for entry in provider["models"]:
        ui, _, remote = entry.partition("=")
        if ui.strip():
            mapping[ui.strip()] = (remote or ui).strip()
    return mapping


def provider_models() -> list[str]:
    """UI model names offered by usable providers (enabled, with a key), e.g. "gpt-image-2.5"."""
    return list(dict.fromkeys(
        name for p in list_providers() if p["enabled"] and p["api_key"] for name in model_map(p)
    ))


def admin_view() -> dict[str, Any]:
    providers = {p["id"]: p for p in list_providers()}
    items = []
    for pid in ranking():
        if pid in providers:
            p = providers[pid]
            key = p["api_key"]
            items.append({**p, "api_key": "", "has_api_key": bool(key), "api_key_hint": key[-4:] if key else ""})
    return {
        "providers": items,
        "order": ranking(),
        "chatgpt_pool_enabled": chatgpt_pool_enabled(),
        "pool_models": config.image_models,  # what the pool can be tested with
        "stats": provider_stats(),
    }


def _validated(body: dict[str, Any], existing: dict[str, Any] | None) -> dict[str, Any]:
    merged = {**(existing or {}), **body}
    if not str(body.get("api_key") or "").strip() and existing:
        merged["api_key"] = existing["api_key"]  # blank key on edit = keep the saved one
    provider = _normalize_provider(merged)
    if not re.match(r"^https?://", provider["base_url"]):
        raise ValueError("API 地址需以 http:// 或 https:// 开头，例如 https://example.com/v1")
    if not provider["models"]:
        raise ValueError("至少填写一个模型")
    return provider


def save_provider(provider_id: str | None, body: dict[str, Any]) -> dict[str, Any]:
    providers = list_providers()
    existing = next((p for p in providers if p["id"] == provider_id), None)
    if provider_id and existing is None:
        raise KeyError(provider_id)
    provider = _validated({k: v for k, v in body.items() if k != "id"}, existing)
    if existing:
        provider["id"] = existing["id"]
        providers = [provider if p["id"] == existing["id"] else p for p in providers]
    else:
        providers.append(provider)
    config.update({"image_providers": providers, "image_provider_order": ranking() + [provider["id"]]})
    return admin_view()


def delete_provider(provider_id: str) -> dict[str, Any]:
    providers = list_providers()
    if not any(p["id"] == provider_id for p in providers):
        raise KeyError(provider_id)
    config.update({
        "image_providers": [p for p in providers if p["id"] != provider_id],
        "image_provider_order": [i for i in ranking() if i != provider_id],
    })
    return admin_view()


def set_order(order: list[str], chatgpt_pool_enabled_value: bool | None = None) -> dict[str, Any]:
    updates: dict[str, Any] = {"image_provider_order": [str(i) for i in order]}
    if chatgpt_pool_enabled_value is not None:
        updates["image_chatgpt_pool_enabled"] = bool(chatgpt_pool_enabled_value)
    config.update(updates)
    return admin_view()


# ---------------------------------------------------------------- recent success rate


def _load_stats() -> dict[str, list[dict[str, Any]]]:
    global _stats
    if _stats is None:
        try:
            loaded = json.loads(STATS_FILE.read_text(encoding="utf-8"))
            _stats = loaded if isinstance(loaded, dict) else {}
        except (OSError, ValueError):
            _stats = {}
    return _stats


def record_outcome(provider_id: str, model: str, ok: bool, error: str, started: float) -> None:
    entry: dict[str, Any] = {
        "at": datetime.now().isoformat(timespec="seconds"),
        "model": model,
        "ok": ok,
        "ms": int((time.monotonic() - started) * 1000),
    }
    if error:
        entry["error"] = error[:200]
    with _stats_lock:
        stats = _load_stats()
        stats[provider_id] = (stats.get(provider_id, []) + [entry])[-STATS_WINDOW:]
        try:
            STATS_FILE.parent.mkdir(parents=True, exist_ok=True)
            STATS_FILE.write_text(json.dumps(stats, ensure_ascii=False), encoding="utf-8")
        except OSError:
            pass  # stats are best-effort; never fail an image over them


def provider_stats() -> dict[str, dict[str, Any]]:
    with _stats_lock:
        summary: dict[str, dict[str, Any]] = {}
        for provider_id, entries in _load_stats().items():
            successes = [e for e in entries if e.get("ok")]
            failures = [e for e in entries if not e.get("ok")]
            summary[provider_id] = {
                "total": len(entries),
                "success": len(successes),
                "rate": round(len(successes) * 100 / len(entries)) if entries else None,
                "avg_ms": round(sum(e.get("ms", 0) for e in successes) / len(successes)) if successes else None,
                "last_error": failures[-1].get("error", "") if failures else "",
                "last_at": entries[-1].get("at", "") if entries else "",
            }
        return summary


def test_provider(provider_id: str, model: str, prompt: str, base_url: str = "") -> dict[str, Any]:
    """Settings → 生图渠道 → 测试: one real generation through only this provider (the ranking is skipped)."""
    payload: dict[str, Any] = {"prompt": prompt, "model": model, "n": 1, "response_format": "url", "base_url": base_url}
    if provider_id == CHATGPT_POOL:
        call: Callable[[], Any] = lambda: openai_v1_image_generations.handle(payload)
    else:
        provider = next((p for p in list_providers() if p["id"] == provider_id), None)
        if provider is None:
            raise KeyError(provider_id)
        if not provider["api_key"]:
            raise ValueError("这个渠道还没有设置 API Key")
        remote_model = model_map(provider).get(model)
        if not remote_model:
            raise ValueError(f"这个渠道没有配置模型 {model}")
        call = lambda: _call_provider(provider, "generate", payload, remote_model)
    started = time.monotonic()
    try:
        result = call()
    except Exception as exc:
        record_outcome(provider_id, model, False, str(exc), started)
        return {"ok": False, "error": str(exc)[:500], "duration_ms": int((time.monotonic() - started) * 1000)}
    record_outcome(provider_id, model, True, "", started)
    url = next((d.get("url") for d in (result or {}).get("data") or [] if isinstance(d, dict) and d.get("url")), "")
    return {"ok": True, "url": url, "duration_ms": int((time.monotonic() - started) * 1000)}


# ---------------------------------------------------------------- routing


def generate(payload: dict[str, Any]) -> Any:
    return route("generate", payload, openai_v1_image_generations.handle)


def edit(payload: dict[str, Any]) -> Any:
    return route("edit", payload, openai_v1_image_edit.handle)


def route(mode: str, payload: dict[str, Any], pool_handler: Handler) -> Any:
    if payload.get("stream"):
        return pool_handler(payload)  # streaming responses are only supported by the ChatGPT pool
    model = str(payload.get("model") or config.default_image_model)
    providers = {p["id"]: p for p in list_providers()}
    failures: list[Exception] = []
    provider_order = ranking()
    # CPA supplies ChatGPT accounts; keep the original web-chat image path as
    # the primary route instead of silently spending requests at an external
    # provider that happens to be ranked first.
    if chatgpt_pool_enabled() and is_supported_image_model(model):
        from services.cpa_service import cpa_account_source_enabled
        if cpa_account_source_enabled():
            provider_order = [CHATGPT_POOL, *[pid for pid in provider_order if pid != CHATGPT_POOL]]
    for pid in provider_order:
        if pid == CHATGPT_POOL:
            if not chatgpt_pool_enabled() or not is_supported_image_model(model):
                continue
            name, call = "ChatGPT 号池", (lambda: pool_handler(payload))
        else:
            provider = providers[pid]
            remote_model = model_map(provider).get(model)
            if not (provider["enabled"] and provider["api_key"] and remote_model):
                continue
            name = provider["name"]
            call = (lambda p=provider, m=remote_model: _call_provider(p, mode, payload, m))
        started = time.monotonic()
        try:
            result = call()
            record_outcome(pid, model, True, "", started)
            if failures:
                logger.info({"event": "image_provider_fallback_success", "provider": name, "model": model})
            return result
        except Exception as exc:
            record_outcome(pid, model, False, str(exc), started)
            logger.warning({"event": "image_provider_failed", "provider": name, "model": model, "error": str(exc)[:300]})
            failures.append(exc)
    if not failures:
        raise RuntimeError(f"没有可用的生图渠道提供模型 {model}，请检查 设置 → 生图渠道")
    # prefer a failure a retry could fix (e.g. a content refusal) over balance/quota errors, so the
    # batch auto-retry still kicks in when only some providers are exhausted
    retryable = [e for e in failures if not NO_AUTO_RETRY_ERRORS.search(str(e))]
    raise retryable[0] if retryable else failures[-1]


def _error_text(body: Any) -> str:
    if isinstance(body, dict):
        err = body.get("error") or body.get("detail") or body
        if isinstance(err, dict):
            return str(err.get("message") or err.get("error") or err.get("code") or json.dumps(err, ensure_ascii=False))[:300]
        return str(err)[:300]
    return str(body)[:300]


def _json(response: Any) -> Any:
    try:
        return response.json()
    except Exception:
        return {"error": {"message": (response.text or "")[:300]}}


def _call_provider(provider: dict[str, Any], mode: str, payload: dict[str, Any], remote_model: str) -> dict[str, Any]:
    name = provider["name"]
    progress = payload.get("progress_callback")
    if callable(progress):
        progress("image_stream_resolve_start")  # starts the web UI's elapsed timer
    fields: dict[str, Any] = {"model": remote_model, "prompt": str(payload.get("prompt") or ""), "n": 1}
    if payload.get("size"):
        fields["size"] = str(payload["size"])
    if payload.get("quality"):
        fields["quality"] = str(payload["quality"])
    headers = {"Authorization": f"Bearer {provider['api_key']}"}
    if provider["async_poll"]:
        fields.update({"async": True, "response_format": "url"})
        headers["Idempotency-Key"] = uuid.uuid4().hex  # a resent submit returns the same task, never a 2nd charge

    url = f"{provider['base_url']}/images/{'edits' if mode == 'edit' else 'generations'}"
    session = requests.Session(impersonate="chrome")
    try:
        if mode == "edit":
            mime = CurlMime()
            try:
                for key, value in fields.items():
                    mime.addpart(name=key, data=str(value).lower().encode() if isinstance(value, bool) else str(value).encode())
                for part, entries in (("image", payload.get("images")), ("mask", payload.get("mask"))):
                    for data, filename, content_type in entries or []:
                        mime.addpart(name=part, filename=filename or f"{part}.png", content_type=content_type or "image/png", data=data)
                response = session.post(url, headers=headers, multipart=mime, timeout=REQUEST_TIMEOUT_SECS)
            finally:
                mime.close()
        else:
            response = session.post(url, headers=headers, json=fields, timeout=REQUEST_TIMEOUT_SECS)
        body = _json(response)
        if response.status_code == 202 and provider["async_poll"] and isinstance(body, dict) and body.get("task_id"):
            body = _poll(session, provider, str(body["task_id"]))
        elif response.status_code >= 400:
            raise RuntimeError(f"{name}: HTTP {response.status_code} {_error_text(body)}")
        items = [d for d in (body.get("data") if isinstance(body, dict) else None) or [] if isinstance(d, dict) and (d.get("b64_json") or d.get("url"))]
        if not items:
            raise RuntimeError(f"{name}: {_error_text(body) or '没有返回图片'}")
        image = base64.b64decode(items[0]["b64_json"]) if items[0].get("b64_json") else _download(session, provider, items[0]["url"])
    finally:
        session.close()

    item = {
        "url": save_image_bytes(image, payload.get("base_url") or None),
        "revised_prompt": items[0].get("revised_prompt") or payload.get("prompt"),
    }
    if str(payload.get("response_format") or "b64_json") == "b64_json":
        item["b64_json"] = base64.b64encode(image).decode()
    return {"created": int(time.time()), "data": [item]}


def _download(session: Any, provider: dict[str, Any], url: str) -> bytes:
    same_host = urlparse(url).netloc == urlparse(provider["base_url"]).netloc
    headers = {"Authorization": f"Bearer {provider['api_key']}"} if same_host else {}  # never leak the key elsewhere
    for attempt in range(3):  # retry the download, not the (paid) generation
        try:
            response = session.get(url, headers=headers, timeout=120)
            if response.status_code < 400 and response.content:
                return response.content
        except Exception:
            if attempt == 2:
                raise
        time.sleep(2)
    raise RuntimeError(f"{provider['name']}: 图片已生成但下载失败 {url[:120]}")


def _poll(session: Any, provider: dict[str, Any], task_id: str) -> dict[str, Any]:
    root = re.sub(r"/v1$", "", provider["base_url"])
    headers = {"Authorization": f"Bearer {provider['api_key']}"}
    deadline = time.time() + POLL_TIMEOUT_SECS
    while time.time() < deadline:
        time.sleep(POLL_INTERVAL_SECS)
        try:
            task = session.get(f"{root}/api/image-tasks", params={"ids": task_id}, headers=headers, timeout=30).json()["items"][0]
        except Exception:
            continue
        status = str(task.get("status") or "")
        if task.get("terminal") or status in {"success", "error", "cancelled", "text_review"}:
            if status == "success":
                return {"data": task.get("results") or task.get("data") or []}
            raise RuntimeError(f"{provider['name']}: {task.get('public_error') or task.get('error') or status}")
    # ponytail: giving up means a later retry may pay again if this task still finishes upstream
    raise RuntimeError(f"{provider['name']}: 任务 {task_id} 在 {POLL_TIMEOUT_SECS // 60} 分钟内未完成")
