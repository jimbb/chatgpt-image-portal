"use client";

import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

import { detectGridLayout, formatGridCells, parseGridCells, resolveGridLayout, type GridLayout } from "@/lib/grid-detect";
import { cn } from "@/lib/utils";

type GridPreviewProps = {
  screenshot: string;
  rows: number;
  cols: number;
  cells: string; // 范围 text: picked cells, "" = all
  onCellsChange: Dispatch<SetStateAction<string>>; // an updater, so quick clicks each build on the last
};

// Grid mode: the screenshot with the boxes that will be cut out and sent, so a misread grid is seen before
// spending quota. Clicking a cell generates just that cell; Ctrl/⌘-click adds or removes cells.
export function GridPreview({ screenshot, rows, cols, cells, onCellsChange }: GridPreviewProps) {
  const [detected, setDetected] = useState<{ source: string; layout: GridLayout | null } | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void detectGridLayout(screenshot)
      .catch(() => null)
      .then((layout) => {
        if (!cancelled) {
          setDetected({ source: screenshot, layout });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [screenshot]);

  const grid = rows > 0 && cols > 0 ? { rows, cols } : null;
  const ready = detected?.source === screenshot;
  const layout = ready && grid ? resolveGridLayout(detected.layout, grid) : null;
  const picked = grid ? parseGridCells(cells, grid) : null;

  const pick = (index: number, toggle: boolean) => {
    if (!grid) {
      return;
    }
    onCellsChange((text) => {
      const current = parseGridCells(text, grid) ?? [];
      if (toggle) {
        return formatGridCells(current.includes(index) ? current.filter((item) => item !== index) : [...current, index], grid);
      }
      // clicking the only picked cell again: back to the whole grid
      return current.length === 1 && current[0] === index ? "" : formatGridCells([index], grid);
    });
  };

  return (
    <div className="mb-2 flex items-start gap-3 px-1 text-xs sm:mb-3">
      <div className="relative w-36 shrink-0 overflow-hidden rounded-lg border border-stone-200 dark:border-white/10 sm:w-44">
        <img
          src={screenshot}
          alt="网格截图"
          className="block w-full"
          onLoad={(event) => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
        />
        {layout && size
          ? layout.rowSpans.flatMap((row, r) =>
              layout.colSpans.map((col, c) => {
                const name = `R${r + 1}C${c + 1}`;
                const index = r * cols + c;
                const isPicked = picked !== null && (picked.length === 0 || picked.includes(index));
                return (
                  <button
                    key={name}
                    type="button"
                    title={`${name}：点击只生成这一格，按住 Ctrl（Mac 用 ⌘）点击可多选`}
                    onClick={(event) => pick(index, event.ctrlKey || event.metaKey)}
                    style={{
                      left: `${(col.start / size.width) * 100}%`,
                      top: `${(row.start / size.height) * 100}%`,
                      width: `${((col.end - col.start) / size.width) * 100}%`,
                      height: `${((row.end - row.start) / size.height) * 100}%`,
                    }}
                    className={cn(
                      "absolute flex items-start justify-start border p-0.5 text-[9px] font-semibold leading-none text-white transition",
                      isPicked ? "border-sky-300 bg-sky-500/30" : "border-white/70 bg-black/35 hover:bg-black/10",
                    )}
                  >
                    {name}
                  </button>
                );
              }),
            )
          : null}
      </div>
      <div className="min-w-0 space-y-1 pt-0.5 leading-5">
        {!ready ? (
          <p className="text-stone-500">正在识别格子…</p>
        ) : !layout ? (
          <p className="text-amber-600">没能在截图里找到网格：会改为发送整张截图，容易生成错的格子，也无法自动核对。</p>
        ) : layout.estimated ? (
          <p className="text-amber-600">
            识别到 {detected.layout?.rows}×{detected.layout?.cols}，已按填写的 {rows}×{cols} 平均切分。请核对每个方框是否对准一张照片。
          </p>
        ) : (
          <p className="text-stone-500">每个方框就是那一格会裁出来发送的部分。</p>
        )}
        {layout ? <p className="text-stone-400">点一格只生成那一格；按住 Ctrl（Mac 用 ⌘）点击可多选或取消；再点一次单选的格子恢复全部。</p> : null}
      </div>
    </div>
  );
}
