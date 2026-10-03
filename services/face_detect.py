"""Grid mode: which cells of an album screenshot show a face, so the composer can preselect them.

YuNet face detector from OpenCV Zoo (MIT), face_detection_yunet_2023mar.onnx next to this file.
"""

from __future__ import annotations

import threading
from io import BytesIO
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

MODEL = Path(__file__).with_name("face_detection_yunet_2023mar.onnx")
MAX_CELLS = 500
# Each cell on its own, not the whole screenshot: cropped, a sideways sleeping face scored 0.64 where the
# whole screenshot gave it 0.39 (and a coffee cup 0.30). On two real 6- and 4-column screenshots every face
# cell scored at least 0.64 and every other cell (dogs, food, city) at most 0.41.
FACE_SCORE = 0.55

_lock = threading.Lock()  # one detector, and a cv2 net isn't safe to share across threads
_detector = None


def cells_with_faces(image: bytes, boxes: dict[str, list[float]]) -> list[str]:
    """The names of the boxes (cell name → [x, y, width, height] in the image's pixels) that show a face."""
    if len(boxes) > MAX_CELLS:
        raise ValueError(f"at most {MAX_CELLS} cells")
    pixels = cv2.cvtColor(np.asarray(Image.open(BytesIO(image)).convert("RGB")), cv2.COLOR_RGB2BGR)
    height, width = pixels.shape[:2]
    found = []
    global _detector
    with _lock:
        if _detector is None:
            _detector = cv2.FaceDetectorYN.create(str(MODEL), "", (320, 320), FACE_SCORE, 0.3, 50)
        for name, box in boxes.items():
            x, y, w, h = (float(value) for value in box)
            left, top = max(0, int(x)), max(0, int(y))
            right, bottom = min(width, int(x + w)), min(height, int(y + h))
            if right - left < 16 or bottom - top < 16:
                continue
            _detector.setInputSize((right - left, bottom - top))
            _, faces = _detector.detect(np.ascontiguousarray(pixels[top:bottom, left:right]))
            if faces is not None and len(faces) > 0:
                found.append(name)
    return found
