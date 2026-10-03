from __future__ import annotations

import base64
import binascii

from fastapi import APIRouter, Header, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from api.image_inputs import parse_image_edit_request, read_image_sources
from api.support import require_identity, resolve_image_base_url
from services.content_filter import check_request
from services import face_detect
from services import grid_check as grid_check_service
from services.config import config
from services.image_task_service import image_task_service
from services.log_service import LoggedCall


class ImageGenerationTaskRequest(BaseModel):
    client_task_id: str = Field(..., min_length=1)
    prompt: str = Field(..., min_length=1)
    model: str | None = None
    size: str | None = None
    quality: str = "auto"
    batch_id: str = ""
    batch_size: int = Field(default=0, ge=0, le=1000)
    batch_target_percent: int | None = Field(default=None, ge=0, le=100)


class GridFacesRequest(BaseModel):
    image: str = Field(..., min_length=1)  # the screenshot, a data URL or bare base64
    boxes: dict[str, list[float]]  # cell name → [x, y, width, height] in the screenshot's pixels


class ResumePollRequest(BaseModel):
    extra_timeout_secs: float = Field(default=30.0, ge=5.0, le=120.0)


def _parse_task_ids(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


async def filter_or_log(call: LoggedCall, text: str) -> None:
    try:
        await run_in_threadpool(check_request, text)
    except HTTPException as exc:
        call.log("调用失败", status="failed", error=str(exc.detail))
        raise


def create_router() -> APIRouter:
    router = APIRouter()

    @router.get("/api/image-tasks")
    async def list_image_tasks(
        ids: str = Query(default=""),
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        return await run_in_threadpool(image_task_service.list_tasks, identity, _parse_task_ids(ids))

    @router.get("/api/prompts")
    async def list_prompt_library(authorization: str | None = Header(default=None)):
        identity = require_identity(authorization)
        tasks = (await run_in_threadpool(image_task_service.list_tasks, identity, []))["items"]
        grouped: dict[str, dict] = {}
        for task in tasks:
            prompt = str(task.get("prompt") or "").strip()
            if not prompt or task.get("status") != "success":
                continue
            key = f"{task.get('model') or ''}\n{prompt}"
            entry = grouped.setdefault(key, {"key": key, "prompt": prompt, "model": task.get("model") or "", "latest": task.get("updated_at") or task.get("created_at") or "", "images": []})
            entry["latest"] = max(str(entry["latest"]), str(task.get("updated_at") or task.get("created_at") or ""))
            for index, item in enumerate(task.get("data") or []):
                if isinstance(item, dict) and item.get("url"):
                    entry["images"].append({"id": f"{task.get('id')}-{index}", "src": item["url"], "task_id": task.get("id")})
        return {"items": sorted(grouped.values(), key=lambda item: str(item.get("latest") or ""), reverse=True)}

    @router.post("/api/image-tasks/generations")
    async def create_generation_task(
        body: ImageGenerationTaskRequest,
        request: Request,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        model = str(body.model or config.default_image_model)
        await filter_or_log(LoggedCall(identity, "/api/image-tasks/generations", model, "文生图任务", request_text=body.prompt), body.prompt)
        try:
            return await run_in_threadpool(
                image_task_service.submit_generation,
                identity,
                client_task_id=body.client_task_id,
                prompt=body.prompt,
                model=model,
                size=body.size,
                quality=body.quality,
                base_url=resolve_image_base_url(request),
                batch_id=body.batch_id,
                batch_size=body.batch_size,
                batch_target_percent=body.batch_target_percent,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc

    @router.post("/api/image-tasks/edits")
    async def create_edit_task(
        request: Request,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        payload, image_sources, mask_sources = await parse_image_edit_request(request)
        client_task_id = str(payload.get("client_task_id") or "").strip()
        if not client_task_id:
            raise HTTPException(status_code=400, detail={"error": "client_task_id is required"})
        prompt = str(payload["prompt"])
        model = str(payload["model"])
        await filter_or_log(LoggedCall(identity, "/api/image-tasks/edits", model, "图生图任务", request_text=prompt), prompt)
        images = await read_image_sources(image_sources)
        masks = await read_image_sources(mask_sources) if mask_sources else None
        try:
            return await run_in_threadpool(
                image_task_service.submit_edit,
                identity,
                client_task_id=client_task_id,
                prompt=prompt,
                model=model,
                size=payload["size"],
                quality=payload["quality"],
                base_url=resolve_image_base_url(request),
                images=images,
                masks=masks,
                batch_id=str(payload.get("batch_id") or ""),
                batch_size=int(payload.get("batch_size") or 0),
                batch_target_percent=payload.get("batch_target_percent"),
                grid_check=grid_check_service.parse(payload.get("grid_check")),
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc

    @router.post("/api/grid/faces")
    async def grid_faces(body: GridFacesRequest, authorization: str | None = Header(default=None)):
        require_identity(authorization)
        try:
            image = base64.b64decode(body.image.split(",", 1)[-1], validate=True)
            return {"cells": await run_in_threadpool(face_detect.cells_with_faces, image, body.boxes)}
        except (ValueError, OSError, binascii.Error) as exc:  # bad base64, not an image, malformed box
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc

    @router.post("/api/image-tasks/{task_id}/resume-poll")
    async def resume_image_poll(
        task_id: str,
        body: ResumePollRequest,
        request: Request,
        authorization: str | None = Header(default=None),
    ):
        identity = require_identity(authorization)
        try:
            return await run_in_threadpool(
                image_task_service.resume_poll,
                identity,
                task_id,
                body.extra_timeout_secs,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc

    return router
