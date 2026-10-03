"""Grid mode check, server side: does a generated photo show its own cell of the album screenshot?

The web UI sends each grid cell's task with an 8×8 colour fingerprint of every cell of the screenshot
(web/src/lib/grid-detect.ts makes them). When the image is done, the task fingerprints it the same way;
if another cell is clearly closer than its own, the task regenerates it (up to MAX_REDOS times) instead of
finishing, so this keeps working with the browser closed.
ponytail: pixel heuristic. Near-identical cells (burst shots) are too close to call so never get flagged.
Upgrade path: ask a vision model which cell the photo shows.
"""

from __future__ import annotations

import base64
import io
import json
import math
from typing import Any

from PIL import Image

SIDE = 8  # keep in step with web/src/lib/grid-detect.ts
WORK = 64
SIGNATURE_LENGTH = SIDE * SIDE * 3
# another cell must be at least twice as close as the photo's own. Tried on 8 grids of look-alike photos
# from one shoot: ~1% of right images flagged, ~95% of wrong-cell images caught.
MISMATCH_MARGIN = 0.5
MAX_REDOS = 2  # each redo is another paid generation


def parse(raw: object) -> dict[str, Any] | None:
    """The web UI's grid_check form field → {"cell", "aspect", "signatures"}; None when absent or malformed."""
    try:
        data = json.loads(raw) if isinstance(raw, str) and raw.strip() else None
        cell = str(data["cell"])
        aspect = float(data["aspect"])
        signatures = {
            str(name): [float(v) for v in values]
            for name, values in dict(data["signatures"]).items()
            if len(values) == SIGNATURE_LENGTH
        }
    except (TypeError, ValueError, KeyError):
        return None
    if cell not in signatures or not (aspect > 0 and math.isfinite(aspect)):
        return None
    return {"cell": cell, "aspect": aspect, "signatures": signatures}


def signature(image_bytes: bytes, aspect: float) -> list[float]:
    """Mean-centred 8×8 RGB fingerprint, centre-cropped to the cell's shape the way the album grid shows it."""
    with Image.open(io.BytesIO(image_bytes)) as image:
        rgb = image.convert("RGB")
    width, height = rgb.size
    crop_width = min(width, height * aspect)
    crop_height = crop_width / aspect
    left, top = (width - crop_width) / 2, (height - crop_height) / 2
    small = rgb.crop((round(left), round(top), round(left + crop_width), round(top + crop_height))).resize(
        (WORK, WORK), Image.LANCZOS
    )
    block = WORK // SIDE
    values = [0.0] * SIGNATURE_LENGTH
    for index, (r, g, b) in enumerate(small.get_flattened_data()):
        y, x = divmod(index, WORK)
        j = ((y // block) * SIDE + x // block) * 3
        values[j] += r
        values[j + 1] += g
        values[j + 2] += b
    mean = sum(values) / len(values)
    return [v - mean for v in values]


def distance(a: list[float], b: list[float]) -> float:
    """1 − correlation: 0 = same picture, about 1 = unrelated."""
    dot = sum(x * y for x, y in zip(a, b))
    norm = math.sqrt(sum(x * x for x in a) * sum(y * y for y in b))
    return 1 - dot / (norm or 1)


def judge(result: list[float], signatures: dict[str, list[float]], own: str) -> dict[str, Any]:
    own_distance = distance(result, signatures[own])
    best_cell, best_distance = min(((cell, distance(result, sig)) for cell, sig in signatures.items()), key=lambda item: item[1])
    if best_distance < own_distance * MISMATCH_MARGIN:
        return {"mismatch": True, "best_cell": best_cell}
    return {"mismatch": False, "best_cell": own}


def check_result(grid_check: dict[str, Any], data: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Verdict for a finished task's first image; None when it can't be read (then it's simply accepted)."""
    from services.image_storage_service import image_storage_service

    try:
        item = data[0]
        if item.get("b64_json"):
            image_bytes = base64.b64decode(item["b64_json"])
        else:
            rel = str(item.get("url") or "").split("/images/", 1)[1].split("?")[0]
            image_bytes = image_storage_service.get_bytes(rel)
        return judge(signature(image_bytes, grid_check["aspect"]), grid_check["signatures"], grid_check["cell"])
    except Exception:
        return None
