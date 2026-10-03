"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import { Eraser, Pencil, RotateCcw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type DrawingMode = "annotate" | "sketch";
type DrawingTool = "draw" | "erase";

type ImageDrawingDialogProps = {
  mode: DrawingMode;
  open: boolean;
  source?: string;
  onOpenChange: (open: boolean) => void;
  onApply: (file: File) => void | Promise<void>;
};

type Point = { x: number; y: number };
export const ANNOTATION_OVERLAY_COLOR = "rgba(39, 39, 42, 0.14)";

function drawAnnotationInsetOutline(
  context: CanvasRenderingContext2D,
  maskCanvas: CanvasImageSource,
  width: number,
  height: number,
) {
  const scale = Math.max(1, Math.min(width, height) / 768);
  const directions = [
    [-1, -1], [0, -1], [1, -1],
    [-1, 0], [1, 0],
    [-1, 1], [0, 1], [1, 1],
  ] as const;

  const drawExpandedMask = (radius: number, filter: string, alpha: number) => {
    context.filter = filter;
    context.globalAlpha = alpha;
    for (const [x, y] of directions) {
      context.drawImage(maskCanvas, x * radius, y * radius, width, height);
    }
  };

  // The larger dark rim and smaller light rim form a two-tone inner edge that
  // remains visible on both light and dark source images.
  drawExpandedMask(3.5 * scale, "brightness(0)", 0.76);
  drawExpandedMask(1.6 * scale, "none", 0.94);
  context.filter = "none";
  context.globalAlpha = 1;
}

export function renderAnnotationOverlay(
  visibleContext: CanvasRenderingContext2D,
  maskCanvas: CanvasImageSource,
  width: number,
  height: number,
) {
  visibleContext.save();
  visibleContext.clearRect(0, 0, width, height);
  visibleContext.globalCompositeOperation = "source-over";
  visibleContext.fillStyle = ANNOTATION_OVERLAY_COLOR;
  visibleContext.fillRect(0, 0, width, height);
  drawAnnotationInsetOutline(visibleContext, maskCanvas, width, height);
  visibleContext.globalCompositeOperation = "destination-out";
  visibleContext.drawImage(maskCanvas, 0, 0, width, height);
  visibleContext.restore();
}

function canvasBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("无法导出画布"))), "image/png");
  });
}

export function ImageDrawingDialog({ mode, open, source, onOpenChange, onApply }: ImageDrawingDialogProps) {
  const visibleCanvasRef = useRef<HTMLCanvasElement>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement>(null);
  const lastPointRef = useRef<Point | null>(null);
  const drawingRef = useRef(false);
  const [tool, setTool] = useState<DrawingTool>("draw");
  const [brushSize, setBrushSize] = useState(mode === "annotate" ? 64 : 18);
  const [dimensions, setDimensions] = useState({ width: 1024, height: 1024 });
  const [hasDrawing, setHasDrawing] = useState(false);
  const [isApplying, setIsApplying] = useState(false);

  const resetCanvas = useCallback((width = dimensions.width, height = dimensions.height) => {
    const visible = visibleCanvasRef.current;
    if (!visible) return;
    visible.width = width;
    visible.height = height;
    const visibleContext = visible.getContext("2d");
    if (!visibleContext) return;
    visibleContext.clearRect(0, 0, width, height);
    if (mode === "sketch") {
      visibleContext.fillStyle = "#ffffff";
      visibleContext.fillRect(0, 0, width, height);
    }

    const mask = maskCanvasRef.current;
    if (mask) {
      mask.width = width;
      mask.height = height;
      const maskContext = mask.getContext("2d");
      if (maskContext) {
        maskContext.globalCompositeOperation = "source-over";
        maskContext.fillStyle = "#ffffff";
        maskContext.fillRect(0, 0, width, height);
      }
      if (mode === "annotate") {
        renderAnnotationOverlay(visibleContext, mask, width, height);
      }
    }
    setHasDrawing(false);
  }, [dimensions.height, dimensions.width, mode]);

  useEffect(() => {
    if (!open) return;
    setTool("draw");
    setBrushSize(mode === "annotate" ? 64 : 18);
    if (mode === "sketch") {
      setDimensions({ width: 1024, height: 1024 });
      requestAnimationFrame(() => resetCanvas(1024, 1024));
    }
  }, [mode, open, resetCanvas]);

  const pointFromEvent = (event: PointerEvent<HTMLCanvasElement>): Point => {
    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    };
  };

  const drawSegment = (from: Point, to: Point) => {
    const visible = visibleCanvasRef.current;
    if (!visible) return;
    const visibleContext = visible.getContext("2d");
    if (!visibleContext) return;
    const effectiveSize = brushSize * (visible.width / 1024);
    if (mode === "annotate") {
      const mask = maskCanvasRef.current;
      const maskContext = mask?.getContext("2d");
      if (mask && maskContext) {
        maskContext.lineCap = "round";
        maskContext.lineJoin = "round";
        maskContext.lineWidth = effectiveSize;
        maskContext.globalCompositeOperation = tool === "erase" ? "source-over" : "destination-out";
        maskContext.strokeStyle = "#ffffff";
        maskContext.beginPath();
        maskContext.moveTo(from.x, from.y);
        maskContext.lineTo(to.x, to.y);
        maskContext.stroke();
        renderAnnotationOverlay(visibleContext, mask, visible.width, visible.height);
      }
    } else {
      visibleContext.lineCap = "round";
      visibleContext.lineJoin = "round";
      visibleContext.lineWidth = effectiveSize;
      visibleContext.globalCompositeOperation = "source-over";
      visibleContext.strokeStyle = tool === "erase" ? "#ffffff" : "#171717";
      visibleContext.beginPath();
      visibleContext.moveTo(from.x, from.y);
      visibleContext.lineTo(to.x, to.y);
      visibleContext.stroke();
    }
    setHasDrawing(true);
  };

  const handlePointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointFromEvent(event);
    drawingRef.current = true;
    lastPointRef.current = point;
    drawSegment(point, { x: point.x + 0.01, y: point.y + 0.01 });
  };

  const handlePointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current || !lastPointRef.current) return;
    const point = pointFromEvent(event);
    drawSegment(lastPointRef.current, point);
    lastPointRef.current = point;
  };

  const stopDrawing = () => {
    drawingRef.current = false;
    lastPointRef.current = null;
  };

  const handleApply = async () => {
    if (!hasDrawing) {
      toast.error(mode === "annotate" ? "请先标记需要修改的区域" : "请先画出草图");
      return;
    }
    const targetCanvas = mode === "annotate" ? maskCanvasRef.current : visibleCanvasRef.current;
    if (!targetCanvas) return;
    setIsApplying(true);
    try {
      const blob = await canvasBlob(targetCanvas);
      const file = new File([blob], mode === "annotate" ? "edit-mask.png" : "sketch.png", { type: "image/png" });
      await onApply(file);
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "导出画布失败");
    } finally {
      setIsApplying(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92dvh] w-[min(94vw,920px)] max-w-none flex-col overflow-hidden rounded-2xl p-0">
        <DialogHeader className="border-b border-stone-100 px-5 py-4">
          <DialogTitle>{mode === "annotate" ? "标注要修改的区域" : "绘制草图"}</DialogTitle>
          <DialogDescription>
            {mode === "annotate"
              ? "涂抹需要修改的位置，灰色区域会被修改；应用后在输入框描述修改内容。"
              : "画出大致布局或轮廓，应用后再描述希望生成的完整画面。"}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto bg-stone-100 p-4 sm:p-6">
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" variant={tool === "draw" ? "default" : "outline"} onClick={() => setTool("draw")}>
              <Pencil className="size-4" />
              {mode === "annotate" ? "标记" : "画笔"}
            </Button>
            <Button type="button" size="sm" variant={tool === "erase" ? "default" : "outline"} onClick={() => setTool("erase")}>
              <Eraser className="size-4" />
              橡皮
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => resetCanvas()}>
              <RotateCcw className="size-4" />
              清空
            </Button>
            <label className="ml-auto flex items-center gap-2 text-xs text-stone-600">
              笔刷
              <input
                type="range"
                min={mode === "annotate" ? 16 : 4}
                max={mode === "annotate" ? 180 : 64}
                value={brushSize}
                onChange={(event) => setBrushSize(Number(event.target.value))}
              />
            </label>
          </div>

          <div
            className={cn(
              "relative mx-auto w-full max-w-[760px] overflow-hidden border border-stone-200 bg-white shadow-sm",
              mode === "sketch" && "aspect-square",
            )}
            style={mode === "annotate" ? { aspectRatio: `${dimensions.width} / ${dimensions.height}` } : undefined}
          >
            {mode === "annotate" && source ? (
              <img
                src={source}
                alt="待编辑图片"
                className="absolute inset-0 h-full w-full object-contain"
                onLoad={(event) => {
                  const width = event.currentTarget.naturalWidth || 1024;
                  const height = event.currentTarget.naturalHeight || 1024;
                  setDimensions({ width, height });
                  resetCanvas(width, height);
                }}
              />
            ) : null}
            <canvas
              ref={visibleCanvasRef}
              className="absolute inset-0 h-full w-full touch-none cursor-crosshair"
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={stopDrawing}
              onPointerCancel={stopDrawing}
              onPointerLeave={stopDrawing}
            />
            <canvas ref={maskCanvasRef} className="hidden" />
          </div>
        </div>

        <DialogFooter className="border-t border-stone-100 px-5 py-4">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button type="button" onClick={() => void handleApply()} disabled={isApplying}>
            {isApplying ? "处理中…" : mode === "annotate" ? "应用标注" : "使用草图"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
