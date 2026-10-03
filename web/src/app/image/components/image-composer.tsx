"use client";
import { ArrowUp, Brush, ChevronDown, Grid3x3, ImagePlus, Info, LoaderCircle, RectangleHorizontal, RectangleVertical, RefreshCw, ScanFace, ScanSearch, Square, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type Dispatch, type DragEvent, type RefObject, type SetStateAction } from "react";

import { ImageLightbox } from "@/components/image-lightbox";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { GridPreview } from "@/app/image/components/grid-preview";
import { ReferenceSetsMenu } from "@/app/image/components/reference-sets-menu";
import { parseGridCells } from "@/lib/grid-detect";
import type { ImageModel } from "@/lib/api";
import type { StoredReferenceImage } from "@/store/image-conversations";
import { cn } from "@/lib/utils";

// This chat's auto-retry: on/off and its own target %; null = follow Settings' global %
export type RetrySettings = { autoRetry: boolean; retryPercent: number | null };
// What to do with reference images: all in one job, split a grid screenshot per cell, or one job per reference
export type ReferenceMode = "combined" | "grid" | "perReference";

const REFERENCE_MODES: Array<{ value: ReferenceMode; label: string; hint: string }> = [
  { value: "combined", label: "合并参考", hint: "所有参考图一起发送，每张结果都参考全部图片" },
  { value: "grid", label: "网格拆分", hint: "第 1 张是网格截图（如相册截图），逐格还原成完整的单张图片；其余图片作为参考照片随每一格发送" },
  { value: "perReference", label: "逐张参考", hint: "同一提示词对每张参考图分别生成，方便对比效果" },
];

type ImageComposerProps = {
  prompt: string;
  imageCount: string;
  imageRatio: string;
  imageTier: string;
  imageWidth: string;
  imageHeight: string;
  imageQuality: string;
  imageModel: ImageModel;
  imageModels: ImageModel[];
  availableQuota: string;
  activeTaskCount: number;
  retry: RetrySettings;
  globalRetryPercent: number;
  referenceMode: ReferenceMode;
  onToggleReferenceContext: (index: number) => void; // 逐张参考: switch a photo between 主图 and 参考
  pairReferences: boolean; // 逐张参考: 参考逐张搭配 (each 主图 × each 参考) instead of 参考一起
  onPairReferencesChange: (value: boolean) => void;
  gridRows: string;
  gridCols: string;
  gridCells: string; // 范围: picked cells, e.g. "R1C2, R3C1–R3C3" (blank = the whole grid)
  isDetectingGrid: boolean;
  referenceImages: StoredReferenceImage[];
  maskImages: Array<{ name: string; dataUrl: string }>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onPromptChange: (value: string) => void;
  onImageCountChange: (value: string) => void;
  onImageRatioChange: (value: string) => void;
  onImageTierChange: (value: string) => void;
  onImageWidthChange: (value: string) => void;
  onImageHeightChange: (value: string) => void;
  onImageQualityChange: (value: string) => void;
  onImageModelChange: (value: ImageModel) => void;
  onSubmit: () => void | Promise<void>;
  onPickReferenceImage: () => void;
  onReferenceImageChange: (files: File[]) => void | Promise<void>;
  onRemoveReferenceImage: (index: number) => void;
  onOpenSketch: () => void;
  onRetryChange: (value: RetrySettings) => void;
  onReferenceModeChange: (mode: ReferenceMode) => void;
  onGridRowsChange: (value: string) => void;
  onGridColsChange: (value: string) => void;
  onGridCellsChange: Dispatch<SetStateAction<string>>;
  onDetectGrid: () => void;
  preselectFaces: boolean; // 只选有人脸的格子 (remembered in this browser)
  onPreselectFacesChange: (on: boolean) => void;
  isFindingFaces: boolean;
  onStartGrid: () => void; // toolbar 网格: switch to grid mode, asking for the screenshot if none yet
  onLoadReferenceSet: (images: StoredReferenceImage[]) => void;
};

const imageFileNamePattern = /\.(avif|bmp|gif|heic|heif|ico|jpe?g|png|svg|tiff?|webp)$/i;

function isImageFile(file: File) {
  return file.type.startsWith("image/") || (!file.type && imageFileNamePattern.test(file.name));
}

function hasDraggedImages(dataTransfer: DataTransfer) {
  const items = Array.from(dataTransfer.items || []);
  if (items.length > 0) {
    return items.some((item) => item.kind === "file" && (item.type.startsWith("image/") || !item.type));
  }
  return Array.from(dataTransfer.files || []).some(isImageFile);
}

function getDraggedImageFiles(dataTransfer: DataTransfer) {
  return Array.from(dataTransfer.files || []).filter(isImageFile);
}

const qualityOptions = [
  { value: "auto", label: "自动" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "xhigh", label: "超高" },
  { value: "max", label: "最高" },
];
const aspectOptions = [
  { ratio: "1:1", tier: "1k", width: "1024", height: "1024", label: "1:1", icon: Square },
  { ratio: "2:3", tier: "1k", width: "1024", height: "1536", label: "2:3", icon: RectangleVertical },
  { ratio: "3:2", tier: "1k", width: "1536", height: "1024", label: "3:2", icon: RectangleHorizontal },
  { ratio: "3:4", tier: "1k", width: "1024", height: "1365", label: "3:4", icon: RectangleVertical },
  { ratio: "4:3", tier: "1k", width: "1365", height: "1024", label: "4:3", icon: RectangleHorizontal },
  { ratio: "9:16", tier: "1k", width: "1088", height: "1920", label: "9:16", icon: RectangleVertical },
  { ratio: "16:9", tier: "1k", width: "1920", height: "1088", label: "16:9", icon: RectangleHorizontal },
  { ratio: "1:1", tier: "2k", width: "2048", height: "2048", label: "1:1(2k)", icon: Square },
  { ratio: "16:9", tier: "2k", width: "2560", height: "1440", label: "16:9(2k)", icon: RectangleHorizontal },
  { ratio: "9:16", tier: "2k", width: "1440", height: "2560", label: "9:16(2k)", icon: RectangleVertical },
  { ratio: "16:9", tier: "4k", width: "3840", height: "2160", label: "16:9(4k)", icon: RectangleHorizontal },
  { ratio: "9:16", tier: "4k", width: "2160", height: "3840", label: "9:16(4k)", icon: RectangleVertical },
  { ratio: "auto", tier: "auto", width: "1024", height: "1024", label: "auto", icon: null },
];
const countOptions = Array.from({ length: 10 }, (_, index) => String(index + 1));

export function ImageComposer({
  prompt,
  imageCount,
  imageRatio,
  imageTier,
  imageWidth,
  imageHeight,
  imageQuality,
  imageModel,
  imageModels,
  availableQuota,
  activeTaskCount,
  referenceImages,
  maskImages,
  textareaRef,
  fileInputRef,
  onPromptChange,
  onImageCountChange,
  onImageRatioChange,
  onImageTierChange,
  onImageWidthChange,
  onImageHeightChange,
  onImageQualityChange,
  onImageModelChange,
  onSubmit,
  onPickReferenceImage,
  onReferenceImageChange,
  onRemoveReferenceImage,
  onOpenSketch,
  retry,
  globalRetryPercent,
  onRetryChange,
  referenceMode,
  onToggleReferenceContext,
  pairReferences,
  onPairReferencesChange,
  onReferenceModeChange,
  gridRows,
  gridCols,
  gridCells,
  onGridRowsChange,
  onGridColsChange,
  onGridCellsChange,
  onDetectGrid,
  preselectFaces,
  onPreselectFacesChange,
  isFindingFaces,
  onStartGrid,
  onLoadReferenceSet,
  isDetectingGrid,
}: ImageComposerProps) {
  const effectiveRetryPercent = retry.retryPercent ?? globalRetryPercent;
  const isGridMode = referenceMode === "grid" && referenceImages.length >= 1;
  const isPerReferenceMode = referenceMode === "perReference" && referenceImages.length >= 2;
  const perReferenceContextCount = referenceImages.filter((image) => image.context).length;
  const perReferenceMains = referenceImages.length - perReferenceContextCount;
  const gridCellCount = (Number(gridRows) || 0) * (Number(gridCols) || 0);
  const gridPicked = gridCellCount > 0 ? parseGridCells(gridCells, { rows: Number(gridRows), cols: Number(gridCols) }) : null;
  const gridSelectedCount = gridPicked ? gridPicked.length || gridCellCount : 0;
  // how many images one send makes: shown by the send button, so it's clear before sending
  const perSendCount = Number(imageCount) || 1;
  const totalImages = isGridMode
    ? gridSelectedCount * perSendCount
    : isPerReferenceMode
      ? perReferenceMains * (pairReferences && perReferenceContextCount > 0 ? perReferenceContextCount : 1) * perSendCount
      : perSendCount;
  const gridStartIndex = gridPicked?.[0] ?? 0;
  const gridStartCell = gridPicked ? `R${Math.floor(gridStartIndex / Number(gridCols)) + 1}C${(gridStartIndex % Number(gridCols)) + 1}` : "";
  // a grid, or 逐张参考 with 参考 photos, already tells the model what to do: the text is optional there
  const promptOptional = isGridMode || (isPerReferenceMode && perReferenceContextCount > 0);
  const canSubmit = Boolean(prompt.trim()) || promptOptional;
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [isSizeMenuOpen, setIsSizeMenuOpen] = useState(false);
  const [isDraggingImage, setIsDraggingImage] = useState(false);
  const [sizeMenuPos, setSizeMenuPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const sizeMenuRef = useRef<HTMLDivElement>(null);
  const sizeMenuBtnRef = useRef<HTMLButtonElement>(null);
  const lightboxImages = useMemo(
    () => [
      ...referenceImages.map((image, index) => ({ id: `${image.name}-${index}`, src: image.dataUrl })),
      ...maskImages.map((image, index) => ({ id: `mask-${image.name}-${index}`, src: image.dataUrl })),
    ],
    [referenceImages, maskImages],
  );
  const modelOptions = useMemo(
    () => imageModels.map((model) => ({ value: model, label: model })),
    [imageModels],
  );
  const qualityLabel = qualityOptions.find((option) => option.value === imageQuality)?.label || "自动";
  const ratioLabel = imageRatio === "auto" ? "auto" : `${imageRatio}(${imageTier})`;
  const imageSizeLabel = `${qualityLabel} · ${ratioLabel} · ${imageCount || 1} 张`;
  const selectedModelLabel = modelOptions.find((option) => option.value === imageModel)?.label || imageModel;
  const isCodexModel = imageModel.toLowerCase().includes("codex");
  const supportsExtendedQuality = imageModel.toLowerCase().includes("image-2.5");
  const visibleQualityOptions = supportsExtendedQuality
    ? qualityOptions
    : qualityOptions.filter((option) => option.value !== "xhigh" && option.value !== "max");

  useEffect(() => {
    if (!supportsExtendedQuality && (imageQuality === "xhigh" || imageQuality === "max")) {
      onImageQualityChange("auto");
    }
  }, [imageQuality, onImageQualityChange, supportsExtendedQuality]);

  useEffect(() => {
    if (!isSizeMenuOpen) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest('[data-slot="select-content"], [data-slot="select-trigger"]')
      ) {
        return;
      }
      if (!sizeMenuRef.current?.contains(target as Node)) {
        setIsSizeMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", handlePointerDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
    };
  }, [isSizeMenuOpen]);

  const handleTextareaPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const imageFiles = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length === 0) {
      return;
    }

    event.preventDefault();
    void onReferenceImageChange(imageFiles);
  };

  const handleComposerDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!hasDraggedImages(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsSizeMenuOpen(false);
    setIsDraggingImage(true);
  };

  const handleComposerDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!hasDraggedImages(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsDraggingImage(true);
  };

  const handleComposerDragLeave = (event: DragEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
      return;
    }
    setIsDraggingImage(false);
  };

  const handleComposerDrop = (event: DragEvent<HTMLDivElement>) => {
    const imageFiles = getDraggedImageFiles(event.dataTransfer);
    if (event.dataTransfer.files.length > 0 || imageFiles.length > 0) {
      event.preventDefault();
      event.stopPropagation();
    }

    setIsDraggingImage(false);
    if (imageFiles.length === 0) {
      return;
    }

    void onReferenceImageChange(imageFiles);
  };

  return (
    <div className="shrink-0 flex justify-center px-1 sm:px-0">
      <div style={{ width: "min(980px, 100%)" }}>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(event) => {
            void onReferenceImageChange(Array.from(event.target.files || []));
          }}
        />

        {referenceImages.length > 0 ? (
          <div className="mb-2 flex gap-2 overflow-x-auto px-1 pb-1 sm:mb-3 sm:flex-wrap sm:overflow-visible sm:pb-0">
            {referenceImages.map((image, index) => (
              <div key={`${image.name}-${index}`} className="relative size-14 shrink-0 sm:size-16">
                <button
                  type="button"
                  onClick={() => {
                    setLightboxIndex(index);
                    setLightboxOpen(true);
                  }}
                  className="group relative size-14 overflow-hidden rounded-2xl border border-stone-200 bg-stone-50 transition hover:border-stone-300 sm:size-16"
                  aria-label={`预览参考图 ${image.name || index + 1}`}
                >
                  <img
                    src={image.dataUrl}
                    alt={image.name || `参考图 ${index + 1}`}
                    className="h-full w-full object-cover"
                  />
                  {isGridMode ? (
                    <span className="absolute inset-x-0 bottom-0 bg-stone-900/70 py-0.5 text-center text-[10px] text-white">
                      {index === 0 ? "网格截图" : "参考照片"}
                    </span>
                  ) : null}
                </button>
                {isPerReferenceMode ? (
                  <button
                    type="button"
                    onClick={() => onToggleReferenceContext(index)}
                    title={image.context ? "参考：随每张主图一起发送，不单独生成。点击改为主图" : "主图：会生成结果。点击改为参考"}
                    className={cn(
                      "absolute inset-x-0 bottom-0 rounded-b-2xl py-0.5 text-center text-[10px] font-medium text-white",
                      image.context ? "bg-stone-500/80" : "bg-violet-600/85",
                    )}
                  >
                    {image.context ? "参考" : "主图"}
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onRemoveReferenceImage(index);
                  }}
                  className="absolute -right-1 -top-1 inline-flex size-5 items-center justify-center rounded-full border border-stone-200 bg-white text-stone-500 transition hover:border-stone-300 hover:text-stone-800"
                  aria-label={`移除参考图 ${image.name || index + 1}`}
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
            {maskImages.map((mask, index) => (
              <button
                key={`mask-${mask.name}-${index}`}
                type="button"
                onClick={() => {
                  setLightboxIndex(referenceImages.length + index);
                  setLightboxOpen(true);
                }}
                className="relative size-14 shrink-0 overflow-hidden rounded-2xl border border-stone-300 bg-stone-300 sm:size-16"
                aria-label={`预览标注遮罩 ${index + 1}（透明区域将重绘）`}
                title="标注遮罩：透明区域将重绘"
              >
                <img src={mask.dataUrl} alt={`标注遮罩 ${index + 1}`} className="h-full w-full object-contain" />
                <span className="absolute inset-x-0 bottom-0 bg-stone-900/75 py-0.5 text-center text-[10px] text-white">遮罩</span>
              </button>
            ))}
          </div>
        ) : null}

        {referenceMode === "grid" && referenceImages.length === 0 ? (
          <div className="mb-2 flex items-center gap-1.5 px-1 text-xs text-sky-700 sm:mb-3">
            <Grid3x3 className="size-3.5" />
            网格拆分：先上传或粘贴一张相册截图（如 iPhone 照片网格），会自动识别行列并逐格还原成完整的单张图片；之后再加的图片（或参考集）作为参考照片。
          </div>
        ) : null}

        {referenceImages.length > 0 ? (
          <div className="mb-2 flex flex-wrap items-center gap-2 px-1 text-xs sm:mb-3">
            <div className="inline-flex rounded-full bg-stone-100 p-0.5 dark:bg-white/10">
              {REFERENCE_MODES.map((mode) => {
                const available =
                  mode.value === "combined" ||
                  (mode.value === "grid" && referenceImages.length >= 1) ||
                  (mode.value === "perReference" && referenceImages.length >= 2);
                return (
                  <button
                    key={mode.value}
                    type="button"
                    title={available ? mode.hint : `${mode.hint}（当前参考图数量不适用）`}
                    disabled={!available}
                    onClick={() => onReferenceModeChange(mode.value)}
                    className={cn(
                      "rounded-full px-3 py-1 font-medium transition disabled:cursor-not-allowed disabled:opacity-40",
                      referenceMode === mode.value && available
                        ? "bg-white text-stone-900 shadow-sm dark:bg-stone-800 dark:text-white"
                        : "text-stone-500 hover:text-stone-800 dark:text-stone-400",
                    )}
                  >
                    {mode.label}
                  </button>
                );
              })}
            </div>
            {isGridMode ? (
              <div className="flex flex-wrap items-center gap-1.5 text-stone-600 dark:text-stone-300">
                <Grid3x3 className="size-3.5" />
                <Input
                  value={gridRows}
                  onChange={(event) => onGridRowsChange(event.target.value.replace(/\D/g, ""))}
                  placeholder="行"
                  aria-label="网格行数"
                  className="h-7 w-12 rounded-lg px-2 text-center text-xs"
                />
                <span>行 ×</span>
                <Input
                  value={gridCols}
                  onChange={(event) => onGridColsChange(event.target.value.replace(/\D/g, ""))}
                  placeholder="列"
                  aria-label="网格列数"
                  className="h-7 w-12 rounded-lg px-2 text-center text-xs"
                />
                <span>列</span>
                <button
                  type="button"
                  onClick={onDetectGrid}
                  disabled={isDetectingGrid}
                  className="inline-flex items-center gap-1 rounded-full bg-stone-100 px-2.5 py-1 font-medium text-stone-700 transition hover:bg-stone-200 disabled:opacity-50 dark:bg-white/10 dark:text-stone-200"
                >
                  {isDetectingGrid ? <LoaderCircle className="size-3 animate-spin" /> : <ScanSearch className="size-3" />}
                  自动识别
                </button>
                <button
                  type="button"
                  aria-pressed={preselectFaces}
                  onClick={() => onPreselectFacesChange(!preselectFaces)}
                  title="开着：贴上截图后只选有人脸的格子；关掉：选全部格子"
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full px-2.5 py-1 font-medium transition",
                    preselectFaces
                      ? "bg-sky-100 text-sky-800 hover:bg-sky-200 dark:bg-sky-500/20 dark:text-sky-200"
                      : "bg-stone-100 text-stone-500 hover:bg-stone-200 dark:bg-white/10 dark:text-stone-400",
                  )}
                >
                  {isFindingFaces ? <LoaderCircle className="size-3 animate-spin" /> : <ScanFace className="size-3" />}
                  只选有人脸
                </button>
                {referenceImages.length > 1 ? (
                  <span className="text-stone-500">另外 {referenceImages.length - 1} 张参考照片会随每一格一起发送</span>
                ) : null}
                <span className="ml-1">范围</span>
                <Input
                  value={gridCells}
                  onChange={(event) => onGridCellsChange(event.target.value.toUpperCase())}
                  placeholder="全部（例：R1C2, R3C1-R3C3）"
                  aria-label="要生成的格子"
                  title="留空生成全部格子；也可以在下面的预览里点选"
                  className="h-7 w-52 rounded-lg px-2 text-xs"
                />
                {gridCellCount > 0 && !gridPicked ? (
                  <span className="text-amber-600">范围写法：R1C2, R3C1-R3C3，而且都要在网格内</span>
                ) : gridSelectedCount > 0 ? (
                  <span className="text-stone-500">
                    共 {gridSelectedCount} 格 × 每格 {imageCount || 1} 张 = {gridSelectedCount * (Number(imageCount) || 1)} 张，从 {gridStartCell} 逐格生成，失败会一直重试到全部完成
                  </span>
                ) : null}
              </div>
            ) : referenceMode === "perReference" && referenceImages.length >= 2 ? (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-stone-500">
                {perReferenceContextCount > 0 ? (
                  <div className="inline-flex rounded-full bg-stone-100 p-0.5 dark:bg-white/10">
                    {[
                      { value: false, label: "参考一起", hint: "每张主图带上全部参考，一起生成" },
                      { value: true, label: "参考逐张搭配", hint: "每张主图分别搭配每一张参考，各自生成" },
                    ].map((option) => (
                      <button
                        key={option.label}
                        type="button"
                        title={option.hint}
                        onClick={() => onPairReferencesChange(option.value)}
                        className={cn(
                          "rounded-full px-2.5 py-0.5 font-medium transition",
                          pairReferences === option.value
                            ? "bg-white text-stone-900 shadow-sm dark:bg-stone-800 dark:text-white"
                            : "text-stone-500 hover:text-stone-800 dark:text-stone-400",
                        )}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                ) : null}
                <span>
                  {perReferenceContextCount === 0
                    ? `${perReferenceMains} 张主图各生成 ${imageCount || 1} 张`
                    : pairReferences
                      ? `${perReferenceMains} 张主图 × ${perReferenceContextCount} 张参考逐一搭配，各生成 ${imageCount || 1} 张，共 ${perReferenceMains * perReferenceContextCount * (Number(imageCount) || 1)} 张`
                      : `${perReferenceMains} 张主图各带上 ${perReferenceContextCount} 张参考生成 ${imageCount || 1} 张，共 ${perReferenceMains * (Number(imageCount) || 1)} 张`}
                  。点缩略图下方的标签切换主图 / 参考
                </span>
              </div>
            ) : null}
          </div>
        ) : null}

        {isGridMode ? (
          <GridPreview
            screenshot={referenceImages[0].dataUrl}
            rows={Number(gridRows) || 0}
            cols={Number(gridCols) || 0}
            cells={gridCells}
            onCellsChange={onGridCellsChange}
          />
        ) : null}

        <div
          className={cn(
            "overflow-hidden rounded-[24px] border border-stone-200 bg-white shadow-[0_14px_60px_-42px_rgba(15,23,42,0.45)] transition dark:border-white/10 dark:bg-stone-950/80 sm:rounded-[32px] sm:shadow-none",
            isDraggingImage && "border-stone-900 bg-stone-50",
          )}
        >
          <div
            className="relative cursor-text"
            onDragEnter={handleComposerDragEnter}
            onDragOver={handleComposerDragOver}
            onDragLeave={handleComposerDragLeave}
            onDrop={handleComposerDrop}
            onClick={() => {
              textareaRef.current?.focus();
            }}
          >
            <ImageLightbox
              images={lightboxImages}
              currentIndex={lightboxIndex}
              open={lightboxOpen}
              onOpenChange={setLightboxOpen}
              onIndexChange={setLightboxIndex}
            />
            <Textarea
              ref={textareaRef}
              value={prompt}
              onChange={(event) => onPromptChange(event.target.value)}
              onPaste={handleTextareaPaste}
              placeholder={
                promptOptional
                  ? "可选：补充要求（例如：保持原图色调、写实风格），留空也可以直接生成"
                  : referenceImages.length > 0
                    ? "描述你希望如何修改参考图"
                    : "输入你想要生成的画面，也可直接粘贴图片"
              }
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void onSubmit();
                }
              }}
              className="min-h-[82px] resize-none rounded-[24px] border-0 bg-transparent px-4 pt-4 pb-2 text-[15px] leading-6 text-stone-900 shadow-none placeholder:text-stone-400 focus-visible:ring-0 dark:text-stone-100 dark:placeholder:text-stone-500 sm:min-h-[96px] sm:rounded-[32px] sm:px-6 sm:pt-6 sm:pb-2 sm:leading-7"
            />
            {isDraggingImage ? (
              <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-[24px] border-2 border-dashed border-stone-900 bg-white/85 text-sm font-medium text-stone-900 backdrop-blur-[1px] sm:rounded-[32px]">
                <div className="flex items-center gap-2 rounded-full bg-stone-950 px-4 py-2 text-white shadow-lg">
                  <ImagePlus className="size-4" />
                  <span>松开以上传参考图</span>
                </div>
              </div>
            ) : null}

            <div className="rounded-b-[24px] border-t border-stone-100 bg-white px-3 pb-3 pt-2 dark:border-white/10 dark:bg-stone-950/95 sm:rounded-b-[32px] sm:px-6 sm:pb-4 sm:pt-3" onClick={(event) => event.stopPropagation()}>
              <div className="flex items-end justify-between gap-2 sm:gap-3">
                <div className="hide-scrollbar flex min-w-0 flex-1 flex-nowrap items-center gap-1.5 overflow-x-auto pb-0.5 sm:flex-wrap sm:gap-3 sm:overflow-visible sm:pb-0">
                  <Button
                    type="button"
                    variant="outline"
                    className="h-9 shrink-0 rounded-full border-stone-200 bg-white px-3 text-xs font-medium text-stone-700 shadow-none sm:h-10 sm:px-4 sm:text-sm"
                    onClick={onPickReferenceImage}
                    aria-label={referenceImages.length > 0 ? "添加参考图" : "上传"}
                  >
                    <ImagePlus className="size-3.5 sm:size-4" />
                    <span className="hidden sm:inline">{referenceImages.length > 0 ? "添加参考图" : "上传"}</span>
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-9 shrink-0 rounded-full border-stone-200 bg-white px-3 text-xs font-medium text-stone-700 shadow-none sm:h-10 sm:px-4 sm:text-sm"
                    onClick={onOpenSketch}
                    aria-label="绘制草图"
                  >
                    <Brush className="size-3.5 sm:size-4" />
                    <span className="hidden sm:inline">草图</span>
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    aria-pressed={referenceMode === "grid"}
                    title="网格拆分：把一张相册截图逐格生成完整的单张图片"
                    className={cn(
                      "h-9 shrink-0 rounded-full border-stone-200 bg-white px-3 text-xs font-medium text-stone-700 shadow-none sm:h-10 sm:px-4 sm:text-sm",
                      referenceMode === "grid" && "border-sky-300 bg-sky-50 text-sky-700",
                    )}
                    onClick={() => (referenceMode === "grid" ? onReferenceModeChange("combined") : onStartGrid())}
                  >
                    <Grid3x3 className="size-3.5 sm:size-4" />
                    <span className="hidden sm:inline">网格</span>
                  </Button>
                  <ReferenceSetsMenu referenceImages={referenceImages} onLoad={onLoadReferenceSet} />
                  <Popover>
                    <PopoverTrigger asChild>
                      <button
                        type="button"
                        title="失败自动重试：服务器在后台重试，关闭网页也会继续"
                        className={cn(
                          "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition sm:h-10 sm:px-4 sm:text-sm",
                          retry.autoRetry && effectiveRetryPercent > 0
                            ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/30"
                            : "bg-stone-100 text-stone-500 dark:bg-white/10 dark:text-stone-400",
                        )}
                      >
                        <RefreshCw className="size-3.5 sm:size-4" />
                        <span className="hidden sm:inline">自动重试</span>
                        <span>
                          {!retry.autoRetry
                            ? "关"
                            : effectiveRetryPercent > 0
                              ? `${effectiveRetryPercent}%${retry.retryPercent != null ? " · 本对话" : ""}`
                              : "未设目标"}
                        </span>
                      </button>
                    </PopoverTrigger>
                    <PopoverContent align="start" className="w-72 space-y-3 rounded-2xl p-4 text-sm">
                      <label className="flex items-center gap-2 font-medium text-stone-800 dark:text-stone-100">
                        <Checkbox
                          checked={retry.autoRetry}
                          onCheckedChange={(checked) => onRetryChange({ ...retry, autoRetry: Boolean(checked) })}
                        />
                        失败自动重试
                      </label>
                      <div className="space-y-1.5">
                        <div className="text-xs text-stone-600 dark:text-stone-300">本对话目标成功比例</div>
                        <div className="flex items-center gap-2">
                          <Input
                            value={retry.retryPercent ?? ""}
                            onChange={(event) => {
                              const digits = event.target.value.replace(/\D/g, "");
                              onRetryChange({ ...retry, retryPercent: digits === "" ? null : Math.min(100, Number(digits)) });
                            }}
                            placeholder={`跟随全局 ${globalRetryPercent}%`}
                            disabled={!retry.autoRetry}
                            className="h-9 rounded-xl"
                          />
                          <span className="text-stone-500">%</span>
                        </div>
                      </div>
                      <p className="text-xs leading-5 text-stone-500">
                        留空跟随设置里的全局值（当前 {globalRetryPercent}%）。例如 30：生成 10 张至少要成功 3 张，失败的会自动重试。只对当前对话生效；网格拆分固定为 100%。
                      </p>
                    </PopoverContent>
                  </Popover>
                  <div className="shrink-0 rounded-full bg-stone-100 px-2 py-1 text-[10px] font-medium text-stone-600 sm:px-3 sm:py-2 sm:text-xs">
                    <span className="hidden sm:inline">剩余额度 </span>{availableQuota}
                  </div>
                  {activeTaskCount > 0 && (
                    <div className="flex shrink-0 items-center gap-1 rounded-full bg-amber-50 px-2 py-1 text-[10px] font-medium text-amber-700 sm:gap-1.5 sm:px-3 sm:py-2 sm:text-xs">
                      <LoaderCircle className="size-3 animate-spin" />
                      {activeTaskCount}<span className="hidden sm:inline"> 个任务处理中</span>
                    </div>
                  )}
                  <div className="relative flex h-9 min-w-0 shrink items-center rounded-full bg-transparent text-[11px] sm:h-auto sm:shrink-0 sm:text-[13px]">
                    <button
                      ref={sizeMenuBtnRef}
                      type="button"
                      className="inline-flex h-9 w-fit max-w-[calc(100vw-12rem)] items-center justify-between gap-2 rounded-full bg-stone-100 px-4 text-left text-xs font-semibold text-stone-900 sm:h-10 sm:max-w-none sm:text-sm"
                      onClick={() => {
                        if (!isSizeMenuOpen && sizeMenuBtnRef.current) {
                          const rect = sizeMenuBtnRef.current.getBoundingClientRect();
                          const menuWidth = Math.min(460, window.innerWidth - 32);
                          setSizeMenuPos({ top: rect.top - 8, left: Math.max(16, Math.min(rect.left, window.innerWidth - menuWidth - 16)) });
                        }
                        setIsSizeMenuOpen((open) => !open);
                      }}
                    >
                      <span className="truncate">{imageSizeLabel}</span>
                      <ChevronDown className={cn("size-4 shrink-0 opacity-60 transition", isSizeMenuOpen && "rotate-180")} />
                    </button>
                    {isSizeMenuOpen ? (
                      <div
                        ref={sizeMenuRef}
                        className="fixed z-[80] max-h-[62dvh] overflow-y-auto rounded-[24px] border border-stone-200/70 bg-white p-4 shadow-[0_30px_90px_-34px_rgba(15,23,42,0.42)] sm:max-h-none sm:overflow-visible"
                        style={{
                          top: sizeMenuPos.top,
                          left: sizeMenuPos.left,
                          transform: "translateY(-100%)",
                          width: "min(460px, calc(100vw - 2rem))",
                        }}
                      >
                        <h3 className="mb-3 text-base font-semibold text-stone-950">图像设置</h3>
                        <div className="mb-3">
                          <div className="mb-2 text-sm font-medium text-stone-900">模型</div>
                          <Select
                            value={imageModel}
                            onValueChange={(value) => {
                              onImageModelChange(value as ImageModel);
                            }}
                          >
                            <SelectTrigger className="h-10 rounded-xl border-stone-200 bg-white text-sm shadow-none">
                              <div className="flex min-w-0 items-center gap-2">
                                <img
                                  src="/openai.svg"
                                  alt=""
                                  aria-hidden="true"
                                  className="size-4 shrink-0 text-stone-700"
                                />
                                <span className="truncate">{selectedModelLabel}</span>
                              </div>
                            </SelectTrigger>
                            <SelectContent className="z-[120]">
                              {modelOptions.map((option) => (
                                <SelectItem
                                  key={option.value}
                                  value={option.value}
                                  className="pl-10"
                                  style={{
                                    backgroundImage: "url('/openai.svg')",
                                    backgroundRepeat: "no-repeat",
                                    backgroundPosition: "12px center",
                                    backgroundSize: "16px 16px",
                                  }}
                                >
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="mb-3">
                          <div className="mb-2 text-sm font-medium text-stone-900">质量</div>
                          <div className={cn("grid gap-2", supportsExtendedQuality ? "grid-cols-3 sm:grid-cols-6" : "grid-cols-4")}>
                            {visibleQualityOptions.map((option) => {
                              const active = option.value === imageQuality;
                              return (
                                <button
                                  key={option.value}
                                  type="button"
                                  className={cn(
                                    "h-9 cursor-pointer rounded-full border border-stone-200 bg-white text-sm text-stone-800 transition hover:border-stone-300 hover:bg-stone-50",
                                    active && "border-stone-950 bg-white font-medium text-stone-950",
                                  )}
                                  onClick={() => onImageQualityChange(option.value)}
                                >
                                  {option.label}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                        <div className="mb-3">
                          <div className="mb-2 flex items-center gap-1.5 text-sm font-medium text-stone-900">
                            尺寸 <Info className="size-3.5 text-stone-400" />
                          </div>
                          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                            <div className="flex items-center rounded-lg bg-stone-100 px-3 py-1.5 text-sm text-stone-700">
                              <span className="mr-2 text-stone-500">W</span>
                              <Input
                                type="number"
                                inputMode="numeric"
                                min="1"
                                value={imageWidth}
                                onChange={(event) => onImageWidthChange(event.target.value)}
                                className="h-7 border-0 bg-transparent px-0 text-sm font-medium text-stone-800 shadow-none focus-visible:ring-0"
                              />
                            </div>
                            <span className="text-stone-400">×</span>
                            <div className="flex items-center rounded-lg bg-stone-100 px-3 py-1.5 text-sm text-stone-700">
                              <span className="mr-2 text-stone-500">H</span>
                              <Input
                                type="number"
                                inputMode="numeric"
                                min="1"
                                value={imageHeight}
                                onChange={(event) => onImageHeightChange(event.target.value)}
                                className="h-7 border-0 bg-transparent px-0 text-sm font-medium text-stone-800 shadow-none focus-visible:ring-0"
                              />
                            </div>
                          </div>
                        </div>
                        <div className="mb-3">
                          <div className="mb-2 flex items-center gap-1.5 text-sm font-medium text-stone-900">
                            宽高比 <Info className="size-3.5 text-stone-400" />
                          </div>
                          <div className="grid grid-cols-4 gap-2 sm:grid-cols-5">
                            {aspectOptions.map((option) => {
                              const active = option.ratio === imageRatio && option.tier === imageTier && option.width === imageWidth && option.height === imageHeight;
                              const Icon = option.icon;
                              const disabled = !isCodexModel && (option.tier === "2k" || option.tier === "4k");
                              return (
                                <button
                                  key={`${option.ratio}-${option.tier}-${option.label}`}
                                  type="button"
                                  disabled={disabled}
                                  className={cn(
                                    "flex h-[64px] cursor-pointer flex-col items-center justify-center gap-1 rounded-2xl border border-stone-200 bg-white text-sm text-stone-800 transition hover:border-stone-300 hover:bg-stone-50",
                                    active && "border-stone-950",
                                    disabled && "cursor-not-allowed border-stone-100 bg-stone-50 text-stone-300 hover:border-stone-100 hover:bg-stone-50",
                                  )}
                                  onClick={() => {
                                    if (disabled) {
                                      return;
                                    }
                                    onImageRatioChange(option.ratio);
                                    onImageTierChange(option.tier);
                                    onImageWidthChange(option.width);
                                    onImageHeightChange(option.height);
                                  }}
                                >
                                  {Icon ? (
                                    <>
                                      <Icon className="size-3.5 stroke-[1.8]" />
                                      <span>{option.label}</span>
                                    </>
                                  ) : (
                                    <span>{option.label}</span>
                                  )}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                        <div className="border-t border-stone-100 pt-3">
                          <div className="mb-2 text-sm font-medium text-stone-900">生成数量</div>
                          <div className="grid grid-cols-4 gap-2 sm:grid-cols-5">
                            {countOptions.map((option) => {
                              const active = imageCount === option;
                              return (
                                <button
                                  key={option}
                                  type="button"
                                  className={cn(
                                    "h-9 cursor-pointer rounded-full border border-stone-200 bg-white text-sm text-stone-800 transition hover:border-stone-300 hover:bg-stone-50",
                                    active && "border-stone-950 bg-white font-medium text-stone-950",
                                  )}
                                  onClick={() => onImageCountChange(option)}
                                >
                                  {option} 张
                                </button>
                              );
                            })}
                            <Input
                              type="number"
                              inputMode="numeric"
                              min="1"
                              max="100"
                              step="1"
                              value={imageCount}
                              onChange={(event) => onImageCountChange(event.target.value)}
                              className="h-9 rounded-full border-stone-200 bg-white px-3 text-center text-sm font-medium text-stone-800 shadow-none focus-visible:ring-0"
                            />
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </div>

                </div>

                <span
                  className={cn(
                    "shrink-0 self-center whitespace-nowrap text-xs text-stone-500 dark:text-stone-400",
                    totalImages >= 20 && "font-medium text-amber-600 dark:text-amber-400",
                  )}
                  title="按下发送后会生成的图片总数"
                >
                  共 {totalImages} 张
                </span>
                <button
                  type="button"
                  onClick={() => void onSubmit()}
                  disabled={!canSubmit}
                  title={canSubmit ? undefined : "请先输入提示词"}
                  className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-stone-950 text-white transition hover:bg-stone-800 disabled:cursor-not-allowed disabled:bg-stone-300 sm:size-11"
                  aria-label={`${referenceImages.length > 0 ? "编辑图片" : "生成图片"}（共 ${totalImages} 张）`}
                >
                  <ArrowUp className="size-3.5 sm:size-4" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
