"""CLIProxyAPI integration for browsing remote auth files and importing selected tokens."""

from __future__ import annotations

import hashlib
import json
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from urllib.parse import parse_qs, urlparse

from curl_cffi.requests import Session

from services.account_service import account_service
from services.config import DATA_DIR
from services.proxy_service import proxy_settings


CPA_CONFIG_FILE = DATA_DIR / "cpa_config.json"


def _new_id() -> str:
    return uuid.uuid4().hex[:12]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalize_import_job(raw: object, *, fail_unfinished: bool) -> dict | None:
    if not isinstance(raw, dict):
        return None
    status = str(raw.get("status") or "failed").strip() or "failed"
    if fail_unfinished and status in {"pending", "running"}:
        status = "failed"
    return {
        "job_id": str(raw.get("job_id") or uuid.uuid4().hex).strip(),
        "status": status,
        "created_at": str(raw.get("created_at") or _now_iso()).strip() or _now_iso(),
        "updated_at": str(raw.get("updated_at") or raw.get("created_at") or _now_iso()).strip() or _now_iso(),
        "total": int(raw.get("total") or 0),
        "completed": int(raw.get("completed") or 0),
        "added": int(raw.get("added") or 0),
        "skipped": int(raw.get("skipped") or 0),
        "refreshed": int(raw.get("refreshed") or 0),
        "failed": int(raw.get("failed") or 0),
        "errors": raw.get("errors") if isinstance(raw.get("errors"), list) else [],
    }


def _normalize_pool(raw: dict) -> dict:
    return {
        "id": str(raw.get("id") or _new_id()).strip(),
        "name": str(raw.get("name") or "").strip(),
        "base_url": str(raw.get("base_url") or "").strip(),
        "secret_key": str(raw.get("secret_key") or "").strip(),
        "import_job": _normalize_import_job(raw.get("import_job"), fail_unfinished=True),
    }


def _management_headers(secret_key: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {secret_key}",
        "Accept": "application/json",
    }


def _cpa_source_pool() -> dict | None:
    """Use the first configured CPA connection as the account source."""
    pools = cpa_config.list_pools() if "cpa_config" in globals() else []
    return next((pool for pool in pools if str(pool.get("base_url") or "").strip() and str(pool.get("secret_key") or "").strip()), None)


def cpa_account_source_enabled() -> bool:
    return _cpa_source_pool() is not None


def _cpa_request(pool: dict, method: str, path: str, **kwargs):
    base_url = str(pool.get("base_url") or "").strip().rstrip("/")
    secret_key = str(pool.get("secret_key") or "").strip()
    if not base_url or not secret_key:
        raise RuntimeError("CPA connection is incomplete")
    session = Session(**proxy_settings.build_session_kwargs(verify=True))
    try:
        response = session.request(
            method,
            f"{base_url}{path}",
            headers={**_management_headers(secret_key), **(kwargs.pop("headers", {}) or {})},
            timeout=30,
            **kwargs,
        )
        if not response.ok:
            raise RuntimeError(f"CPA request failed: HTTP {response.status_code}")
        return response
    finally:
        session.close()


def _cpa_auth_files(pool: dict) -> list[dict]:
    payload = _cpa_request(pool, "GET", "/v8/management/credentials").json()
    files = payload.get("files") if isinstance(payload, dict) else None
    if not isinstance(files, list):
        raise RuntimeError("CPA credential list is invalid")
    return [item for item in files if isinstance(item, dict) and str(item.get("name") or "").strip()]


def _cpa_download(pool: dict, name: str) -> dict:
    response = _cpa_request(pool, "GET", "/v8/management/credentials/download", params={"name": name})
    payload = response.json()
    if not isinstance(payload, dict):
        raise RuntimeError("CPA credential payload is invalid")
    return payload


def _cpa_status(file: dict) -> str:
    raw = str(file.get("status") or "").strip().lower()
    if file.get("disabled") or raw in {"disabled", "disable"}:
        return "禁用"
    if file.get("cooldowns") or raw in {"cooling", "cooldown", "limited", "rate_limited"}:
        return "限流"
    if bool(file.get("unavailable")) or raw in {"error", "failed", "invalid", "unavailable"}:
        return "异常"
    return "正常"


def _cpa_account(file: dict, payload: dict) -> dict | None:
    if str(payload.get("type") or file.get("provider") or "codex").lower() != "codex":
        return None
    access_token = str(payload.get("access_token") or payload.get("accessToken") or "").strip()
    if not access_token:
        return None
    status = _cpa_status(file)
    quota = payload.get("quota")
    try:
        quota_value = max(0, int(quota))
    except (TypeError, ValueError):
        quota_value = 0
    account_type = str(payload.get("plan_type") or file.get("account_type") or file.get("provider") or "codex").strip()
    try:
        success = int(file.get("success") or 0)
    except (TypeError, ValueError):
        success = 0
    try:
        failed = int(file.get("failed") or file.get("fail") or 0)
    except (TypeError, ValueError):
        failed = 0
    return {
        "access_token": access_token,
        "type": account_type,
        "source_type": "codex",
        "status": status,
        "quota": quota_value,
        "cpa_quota_unknown": not isinstance(quota, (int, float)),
        "email": str(file.get("email") or payload.get("email") or "").strip(),
        "success": success,
        "fail": failed,
        "restore_at": file.get("next_retry_after"),
        "cpa_file_name": str(file.get("name") or "").strip(),
        "proxy": str(payload.get("proxy_url") or "").strip(),
    }


def list_cpa_accounts() -> list[dict]:
    pool = _cpa_source_pool()
    if pool is None:
        return []
    files = [item for item in _cpa_auth_files(pool) if str(item.get("provider") or item.get("type") or "").lower() == "codex" and not item.get("runtime_only")]
    accounts: list[dict] = []
    with ThreadPoolExecutor(max_workers=min(16, max(1, len(files)))) as executor:
        futures = {executor.submit(_cpa_download, pool, str(item["name"])): item for item in files}
        for future in as_completed(futures):
            file = futures[future]
            account = _cpa_account(file, future.result())
            if account is not None:
                accounts.append(account)
    return sorted(accounts, key=lambda item: str(item.get("email") or item.get("cpa_file_name") or "").lower())


def _cpa_find_by_token(access_token: str) -> tuple[dict, dict]:
    token = str(access_token or "").strip()
    pool = _cpa_source_pool()
    if pool is None:
        raise RuntimeError("CPA account source is not configured")
    for account in list_cpa_accounts():
        if account.get("access_token") == token:
            return pool, account
    raise KeyError("account not found")


def delete_cpa_accounts(access_tokens: list[str]) -> dict:
    pool = _cpa_source_pool()
    if pool is None:
        raise RuntimeError("CPA account source is not configured")
    names = []
    for token in dict.fromkeys(str(item or "").strip() for item in access_tokens if str(item or "").strip()):
        try:
            _, account = _cpa_find_by_token(token)
        except KeyError:
            continue
        name = str(account.get("cpa_file_name") or "").strip()
        if name:
            names.append(("name", name))
    if names:
        _cpa_request(pool, "DELETE", "/v8/management/credentials", params=names)
    return {"removed": len(names), "items": list_cpa_accounts()}


def update_cpa_account(access_token: str, updates: dict) -> dict | None:
    pool, account = _cpa_find_by_token(access_token)
    unsupported = set(updates) - {"status", "proxy"}
    if unsupported:
        raise ValueError("CPA only supports changing account status")
    if "status" in updates:
        status = str(updates["status"] or "").strip()
        if status not in {"正常", "禁用"}:
            raise ValueError("CPA status can only be 正常 or 禁用")
        _cpa_request(
            pool,
            "PATCH",
            "/v8/management/credentials/status",
            json={"name": account["cpa_file_name"], "disabled": status == "禁用"},
        )
    if "proxy" in updates:
        _cpa_request(
            pool,
            "PATCH",
            "/v8/management/credentials/fields",
            json={"name": account["cpa_file_name"], "proxy_url": str(updates["proxy"] or "")},
        )
    return next((item for item in list_cpa_accounts() if item.get("access_token") == access_token), None)


def refresh_cpa_accounts(access_tokens: list[str] | None = None) -> dict:
    pool = _cpa_source_pool()
    if pool is None:
        raise RuntimeError("CPA account source is not configured")
    tokens = [str(item or "").strip() for item in (access_tokens or []) if str(item or "").strip()]
    if tokens:
        for token in tokens:
            try:
                _, account = _cpa_find_by_token(token)
            except KeyError:
                continue
            _cpa_request(pool, "POST", "/v8/management/credentials/refresh", json={"name": account["cpa_file_name"]})
    else:
        _cpa_request(pool, "POST", "/v8/management/credentials/refresh", json={"all": True})
    items = list_cpa_accounts()
    return {"refreshed": len(tokens) or len(items), "errors": [], "items": items, "relogined": 0}


def add_cpa_account_items(items: list[dict]) -> dict:
    pool = _cpa_source_pool()
    if pool is None:
        raise RuntimeError("CPA account source is not configured")
    added = 0
    errors = []
    for item in items:
        if not isinstance(item, dict) or not str(item.get("access_token") or item.get("accessToken") or "").strip():
            continue
        payload = dict(item)
        payload["access_token"] = str(payload.pop("accessToken", payload.get("access_token")) or "").strip()
        payload["type"] = "codex"
        payload.pop("source_type", None)
        payload.pop("export_type", None)
        email = str(payload.get("email") or "").strip()
        suffix = hashlib.sha256(payload["access_token"].encode()).hexdigest()[:12]
        name = f"codex-{suffix}.json"
        if email:
            safe_email = "".join(char if char.isalnum() or char in ".@_-" else "-" for char in email)
            name = f"codex-{safe_email[:80]}-{suffix}.json"
        try:
            _cpa_request(
                pool,
                "POST",
                "/v8/management/credentials",
                params={"name": name},
                data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                headers={"Content-Type": "application/json"},
            )
            added += 1
        except Exception as exc:
            errors.append({"access_token": payload["access_token"], "error": str(exc)})
    return {"added": added, "skipped": 0, "errors": errors, "items": list_cpa_accounts()}


def start_cpa_oauth(email_hint: str = "") -> dict:
    pool = _cpa_source_pool()
    if pool is None:
        raise RuntimeError("CPA account source is not configured")
    params = {"provider": "codex"}
    if str(email_hint or "").strip():
        params["email_hint"] = str(email_hint).strip()
    payload = _cpa_request(pool, "GET", "/v8/management/oauth/auth-url", params=params).json()
    if not isinstance(payload, dict):
        raise RuntimeError("CPA OAuth response is invalid")
    authorize_url = str(payload.get("authorize_url") or payload.get("auth_url") or payload.get("url") or "").strip()
    state = str(payload.get("state") or "").strip()
    if not authorize_url or not state:
        raise RuntimeError("CPA OAuth response is missing authorize URL or state")
    return {"authorize_url": authorize_url, "session_id": state}


def finish_cpa_oauth(state: str, callback: str) -> dict:
    pool = _cpa_source_pool()
    if pool is None:
        raise RuntimeError("CPA account source is not configured")
    callback_value = str(callback or "").strip()
    query = parse_qs(urlparse(callback_value).query) if "://" in callback_value else {"code": [callback_value]}
    body = {"provider": "codex", "state": str(state or "").strip()}
    for key in ("code", "error", "error_description"):
        if query.get(key):
            body[key] = query[key][0]
    if "://" in callback_value:
        body["redirect_url"] = callback_value
    _cpa_request(pool, "POST", "/v8/management/oauth/callback", json=body)
    for _ in range(60):
        status_payload = _cpa_request(pool, "GET", "/v8/management/oauth/status", params={"state": body["state"]}).json()
        status = str(status_payload.get("status") or "").strip().lower() if isinstance(status_payload, dict) else ""
        if status == "ok":
            break
        if status == "error":
            raise RuntimeError(str(status_payload.get("error") or "CPA OAuth failed"))
        time.sleep(0.5)
    else:
        raise RuntimeError("CPA OAuth timed out")
    return {"items": list_cpa_accounts(), "added": 1, "skipped": 0, "refreshed": 0, "errors": []}


def export_cpa_accounts(access_tokens: list[str]) -> list[dict]:
    pool = _cpa_source_pool()
    if pool is None:
        return []
    wanted = set(str(item or "").strip() for item in access_tokens if str(item or "").strip())
    result: list[dict] = []
    for file in _cpa_auth_files(pool):
        payload = _cpa_download(pool, str(file["name"]))
        token = str(payload.get("access_token") or payload.get("accessToken") or "").strip()
        if token and (not wanted or token in wanted):
            result.append(payload)
    return result


def sync_cpa_accounts_to_local(accounts: list[dict] | None = None) -> list[dict]:
    """Keep the local execution cache aligned with the CPA source of truth."""
    items = list_cpa_accounts() if accounts is None else list(accounts)
    next_accounts = {
        str(item.get("access_token") or ""): item
        for item in items
        if isinstance(item, dict) and str(item.get("access_token") or "").strip()
    }
    previous = {item.get("cpa_file_name"): item for item in account_service.list_accounts() if item.get("cpa_file_name")}
    for token, item in next_accounts.items():
        old = previous.get(item.get("cpa_file_name"))
        if old and old.get("access_token") != token:
            account_service._apply_refreshed_tokens(old["access_token"], {"access_token": token}, "cpa_sync")
        if old and item.get("cpa_quota_unknown") and not old.get("cpa_quota_unknown"):
            item.update({"quota": old["quota"], "cpa_quota_unknown": False})
    with account_service._lock:
        account_service._accounts = {
            token: normalized
            for token, item in next_accounts.items()
            if (normalized := account_service._normalize_account(item)) is not None
        }
        account_service._index = 0
    return items


class CPAConfig:
    def __init__(self, store_file: Path):
        self._store_file = store_file
        self._lock = Lock()
        self._pools: list[dict] = self._load()

    def _load(self) -> list[dict]:
        if not self._store_file.exists():
            return []
        try:
            raw = json.loads(self._store_file.read_text(encoding="utf-8"))
            if isinstance(raw, dict) and "base_url" in raw:
                pool = _normalize_pool(raw)
                return [pool] if pool["base_url"] else []
            if isinstance(raw, list):
                return [_normalize_pool(item) for item in raw if isinstance(item, dict)]
        except Exception:
            pass
        return []

    def _save(self) -> None:
        self._store_file.parent.mkdir(parents=True, exist_ok=True)
        self._store_file.write_text(json.dumps(self._pools, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    def list_pools(self) -> list[dict]:
        with self._lock:
            return [dict(pool) for pool in self._pools]

    def get_pool(self, pool_id: str) -> dict | None:
        with self._lock:
            for pool in self._pools:
                if pool["id"] == pool_id:
                    return dict(pool)
        return None

    def add_pool(self, name: str, base_url: str, secret_key: str) -> dict:
        pool = _normalize_pool({"id": _new_id(), "name": name, "base_url": base_url, "secret_key": secret_key})
        with self._lock:
            self._pools.append(pool)
            self._save()
        return dict(pool)

    def update_pool(self, pool_id: str, updates: dict) -> dict | None:
        with self._lock:
            for index, pool in enumerate(self._pools):
                if pool["id"] != pool_id:
                    continue
                merged = {**pool, **{key: value for key, value in updates.items() if value is not None}, "id": pool_id}
                self._pools[index] = _normalize_pool(merged)
                self._save()
                return dict(self._pools[index])
        return None

    def delete_pool(self, pool_id: str) -> bool:
        with self._lock:
            before = len(self._pools)
            self._pools = [pool for pool in self._pools if pool["id"] != pool_id]
            if len(self._pools) < before:
                self._save()
                return True
        return False

    def set_import_job(self, pool_id: str, import_job: dict | None) -> dict | None:
        with self._lock:
            for index, pool in enumerate(self._pools):
                if pool["id"] != pool_id:
                    continue
                next_pool = dict(pool)
                next_pool["import_job"] = _normalize_import_job(import_job, fail_unfinished=False)
                self._pools[index] = next_pool
                self._save()
                return dict(next_pool)
        return None

    def get_import_job(self, pool_id: str) -> dict | None:
        with self._lock:
            for pool in self._pools:
                if pool["id"] == pool_id:
                    job = pool.get("import_job")
                    return dict(job) if isinstance(job, dict) else None
        return None


def list_remote_files(pool: dict) -> list[dict]:
    base_url = str(pool.get("base_url") or "").strip()
    secret_key = str(pool.get("secret_key") or "").strip()
    if not base_url or not secret_key:
        return []

    url = f"{base_url.rstrip('/')}/v0/management/auth-files"
    session = Session(**proxy_settings.build_session_kwargs(verify=True))
    try:
        response = session.get(url, headers=_management_headers(secret_key), timeout=30)
        if not response.ok:
            raise RuntimeError(f"remote list failed: HTTP {response.status_code}")
        payload = response.json()
    finally:
        session.close()

    files = payload.get("files") if isinstance(payload, dict) else None
    if not isinstance(files, list):
        raise RuntimeError("remote list payload is invalid")

    items: list[dict] = []
    for item in files:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        email = str(item.get("email") or item.get("account") or "").strip()
        if not name:
            continue
        items.append({"name": name, "email": email})
    return items


def fetch_remote_access_token(pool: dict, file_name: str) -> tuple[str | None, str | None]:
    base_url = str(pool.get("base_url") or "").strip()
    secret_key = str(pool.get("secret_key") or "").strip()
    file_name = str(file_name or "").strip()
    if not base_url or not secret_key or not file_name:
        return None, "invalid request"

    url = f"{base_url.rstrip('/')}/v0/management/auth-files/download"
    session = Session(**proxy_settings.build_session_kwargs(verify=True))
    try:
        response = session.get(url, headers=_management_headers(secret_key), params={"name": file_name}, timeout=30)
        if not response.ok:
            return None, f"HTTP {response.status_code}"
        payload = response.json()
    except Exception as exc:
        return None, str(exc)
    finally:
        session.close()

    if not isinstance(payload, dict):
        return None, "invalid payload"

    access_token = str(payload.get("access_token") or "").strip()
    if not access_token:
        return None, "missing access_token"
    return access_token, None


class CPAImportService:
    def __init__(self, cpa_config: CPAConfig):
        self._config = cpa_config

    def start_import(self, pool: dict, selected_files: list[str]) -> dict:
        names = [str(name or "").strip() for name in selected_files if str(name or "").strip()]
        if not names:
            raise ValueError("selected files is required")

        pool_id = str(pool.get("id") or "").strip()
        job = {
            "job_id": uuid.uuid4().hex,
            "status": "pending",
            "created_at": _now_iso(),
            "updated_at": _now_iso(),
            "total": len(names),
            "completed": 0,
            "added": 0,
            "skipped": 0,
            "refreshed": 0,
            "failed": 0,
            "errors": [],
        }
        saved_pool = self._config.set_import_job(pool_id, job)
        if saved_pool is None:
            raise ValueError("pool not found")

        thread = threading.Thread(
            target=self._run_import,
            args=(pool_id, pool, names),
            name=f"cpa-import-{pool_id}",
            daemon=True,
        )
        thread.start()
        return dict(saved_pool.get("import_job") or job)

    def _update_job(self, pool_id: str, **updates) -> dict | None:
        current = self._config.get_import_job(pool_id)
        if current is None:
            return None
        next_job = {**current, **updates, "updated_at": _now_iso()}
        pool = self._config.set_import_job(pool_id, next_job)
        if pool is None:
            return None
        job = pool.get("import_job")
        return dict(job) if isinstance(job, dict) else None

    def _append_error(self, pool_id: str, file_name: str, message: str) -> None:
        current = self._config.get_import_job(pool_id)
        if current is None:
            return
        errors = list(current.get("errors") or [])
        errors.append({"name": file_name, "error": message})
        self._update_job(pool_id, errors=errors, failed=len(errors))

    def _run_import(self, pool_id: str, pool: dict, names: list[str]) -> None:
        self._update_job(pool_id, status="running")

        tokens: list[str] = []
        max_workers = min(16, max(1, len(names)))
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            future_map = {executor.submit(fetch_remote_access_token, pool, name): name for name in names}
            for future in as_completed(future_map):
                file_name = future_map[future]
                try:
                    token, error = future.result()
                except Exception as exc:
                    token, error = None, str(exc)

                if token:
                    tokens.append(token)
                else:
                    self._append_error(pool_id, file_name, error or "unknown error")

                current = self._config.get_import_job(pool_id) or {}
                failed = len(current.get("errors") or [])
                self._update_job(pool_id, completed=int(current.get("completed") or 0) + 1, failed=failed)

        if not tokens:
            current = self._config.get_import_job(pool_id) or {}
            self._update_job(
                pool_id,
                status="failed",
                completed=int(current.get("total") or 0),
                failed=len(current.get("errors") or []),
            )
            return

        add_result = account_service.add_accounts(tokens, source_type="codex")
        refresh_result = account_service.refresh_accounts(tokens)
        current = self._config.get_import_job(pool_id) or {}
        self._update_job(
            pool_id,
            status="completed",
            completed=len(names),
            added=int(add_result.get("added") or 0),
            skipped=int(add_result.get("skipped") or 0),
            refreshed=int(refresh_result.get("refreshed") or 0),
            failed=len(current.get("errors") or []),
        )


cpa_config = CPAConfig(CPA_CONFIG_FILE)
cpa_import_service = CPAImportService(cpa_config)
