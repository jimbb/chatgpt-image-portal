// Grid mode: guesses rows × columns of an album-style screenshot (e.g. iPhone Photos) from the thin
// separator lines between thumbnails. A heuristic: the UI always lets the user correct it.
// Checked by web/scripts/check-grid-detect.mjs.
//
// 1. Columns: content runs between flat vertical lines in the middle of the image (all photos there).
// 2. The grid's vertical extent: rows where those vertical separators are visible. Blurred headers and
//    tab bars hide them; a plain white header shows them but holds no photo row.
// 3. Rows: runs of about the same height between flat horizontal lines, plus a row cut off at the top
//    or bottom edge (e.g. half hidden by the tab bar) when it sits right against the grid.

export type GridSize = { rows: number; cols: number };
// Where each row / column sits, in pixels of the screenshot. Cut-off edge rows are `partial`.
export type GridLayout = GridSize & { colSpans: Segment[]; rowSpans: Array<Segment & { partial: boolean }> };

const FLAT_STD = 6; // photo content: luminance std-dev of at least twice this
const SEPARATOR_TOLERANCE = 14; // separator pixels match the separator colour within this
// a separator line is (nearly) one colour: this share of it within one band of ±SEPARATOR_TOLERANCE. Not a
// std-dev limit: compression speckles a thin white line next to photos (std 6.5 on a real screenshot)
const FLAT_SHARE = 0.9;
const MIN_COL_SHARE = 0.04; // columns narrower than 4% of the width are noise
const COL_WIDTH_SPREAD = 1.35; // real columns have (nearly) equal widths
const FULL_ROW_RANGE = [0.8, 1.25]; // full rows are within this share of the typical row height
const MIN_PARTIAL_ROW = 0.15; // a cut-off edge row counts from 15% of a row visible

type Segment = { start: number; end: number }; // [start, end)

const size = (s: Segment) => s.end - s.start;

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Runs of consecutive non-flat lines, i.e. the content between separators. */
function contentSegments(flat: boolean[], offset = 0): Segment[] {
  const segments: Segment[] = [];
  let start = -1;
  flat.forEach((isFlat, i) => {
    if (!isFlat && start < 0) {
      start = i;
    } else if (isFlat && start >= 0) {
      segments.push({ start: start + offset, end: i + offset });
      start = -1;
    }
  });
  if (start >= 0) {
    segments.push({ start: start + offset, end: flat.length + offset });
  }
  return segments;
}

function isFlatLine(luma: ArrayLike<number>, first: number, count: number, step: number) {
  const histogram = new Uint32Array(256);
  for (let i = 0, index = first; i < count; i += 1, index += step) {
    histogram[Math.min(255, Math.max(0, Math.round(luma[index])))] += 1;
  }
  const band = SEPARATOR_TOLERANCE * 2 + 1;
  let inBand = 0;
  let best = 0;
  for (let v = 0; v < 256; v += 1) {
    inBand += histogram[v] - (v >= band ? histogram[v - band] : 0);
    best = Math.max(best, inBand);
  }
  return best >= count * FLAT_SHARE;
}

/** Longest run of indices where `test` holds, tolerating dropouts of up to `gap` lines. */
function longestRun(length: number, test: (i: number) => boolean, gap: number): Segment | null {
  let best: Segment | null = null;
  let start = -1;
  let lastTrue = -1;
  // runs to length + gap: a run reaching the last line must still get closed (it never was, so a grid
  // down to the image's bottom edge found no grid at all)
  for (let i = 0; i <= length + gap; i += 1) {
    const ok = i < length && test(i);
    if (ok) {
      if (start < 0 || i - lastTrue > gap + 1) {
        start = i;
      }
      lastTrue = i;
    }
    if (start >= 0 && (!ok && i - lastTrue > gap)) {
      if (!best || lastTrue + 1 - start > size(best)) {
        best = { start, end: lastTrue + 1 };
      }
      start = -1;
    }
  }
  return best;
}

/** luma: row-major luminance (0-255), width × height. */
export function detectGridFromLuma(luma: ArrayLike<number>, width: number, height: number): GridSize | null {
  const layout = detectGridLayoutFromLuma(luma, width, height);
  return layout && { rows: layout.rows, cols: layout.cols };
}

export function detectGridLayoutFromLuma(luma: ArrayLike<number>, width: number, height: number): GridLayout | null {
  // 1. Columns, judged on the middle half of the height.
  const bandTop = Math.floor(height * 0.25);
  const bandRows = Math.max(1, Math.floor(height * 0.5));
  const flatColumns = Array.from({ length: width }, (_, x) => isFlatLine(luma, bandTop * width + x, bandRows, width));
  const columns = contentSegments(flatColumns).filter((s) => size(s) >= width * MIN_COL_SHARE);
  if (columns.length < 2) {
    return null;
  }
  const widths = columns.map(size);
  if (Math.max(...widths) / Math.min(...widths) > COL_WIDTH_SPREAD) {
    return null;
  }
  const cellWidth = widths.reduce((a, b) => a + b, 0) / widths.length;

  // 2. Where the vertical separators are visible (their colour sampled on the same band).
  // middle of each gap's flat pixels [end, start): with a 1px gap, rounding (end + start) / 2 landed on the
  // next photo's first pixel and every separator test after that failed
  const separatorXs = columns.slice(1).map((column, i) => Math.floor((columns[i].end + column.start - 1) / 2));
  let separatorSum = 0;
  for (const x of separatorXs) {
    for (let y = bandTop; y < bandTop + bandRows; y += 1) {
      separatorSum += luma[y * width + x];
    }
  }
  const separatorLuma = separatorSum / (separatorXs.length * bandRows);
  // one line may drop out when there are 3+: a separator that falls between two pixels of a downscaled
  // screenshot comes out dimmer (~235 vs ~251) and dips next to dark photos, which cut the grid into pieces
  const allowedMisses = separatorXs.length >= 3 ? 1 : 0;
  const showsSeparators = (y: number) =>
    separatorXs.filter((x) => Math.abs(luma[y * width + x] - separatorLuma) > SEPARATOR_TOLERANCE).length <= allowedMisses;
  const grid = longestRun(height, showsSeparators, 2);
  if (!grid) {
    return null;
  }

  // 3. Rows inside it.
  const left = columns[0].start;
  const span = columns[columns.length - 1].end - left;
  const flatRows = Array.from({ length: size(grid) }, (_, i) => isFlatLine(luma, (grid.start + i) * width + left, span, 1));
  const runs = contentSegments(flatRows, grid.start);
  const tall = runs.filter((s) => size(s) >= cellWidth * 0.5);
  if (tall.length === 0) {
    return null;
  }
  const rowHeight = median(tall.map(size));
  const isFull = (s: Segment) => size(s) >= rowHeight * FULL_ROW_RANGE[0] && size(s) <= rowHeight * FULL_ROW_RANGE[1];
  // a downscaled screenshot can blur a 1px row separator into the photos, merging two rows into one run:
  // a run that's a whole number of rows tall is split into them
  const segments = runs.flatMap((s) => {
    const n = Math.round(size(s) / rowHeight);
    if (n < 2 || !isFull({ start: 0, end: size(s) / n })) {
      return [s];
    }
    return Array.from({ length: n }, (_, k) => ({
      start: s.start + Math.round((size(s) * k) / n),
      end: s.start + Math.round((size(s) * (k + 1)) / n),
    }));
  });
  const firstFull = segments.findIndex(isFull);
  const lastFull = segments.length - 1 - [...segments].reverse().findIndex(isFull);
  if (firstFull < 0) {
    return null;
  }
  const fullRows = segments.slice(firstFull, lastFull + 1).filter(isFull);
  const gaps = fullRows.slice(1).map((s, i) => s.start - fullRows[i].end);
  const separatorGap = gaps.length > 0 ? median(gaps) : Math.max(2, Math.round(cellWidth * 0.02));

  // photo content in at least half the columns: tells a cut-off photo row from a title line or tab-bar icons
  const hasPhotos = (s: Segment) =>
    columns.filter((c) => {
      let sum = 0;
      let sumSq = 0;
      let n = 0;
      for (let y = s.start; y < s.end; y += 2) {
        for (let x = c.start; x < c.end; x += 2) {
          const v = luma[y * width + x];
          sum += v;
          sumSq += v * v;
          n += 1;
        }
      }
      const mean = sum / n;
      return Math.sqrt(Math.max(0, sumSq / n - mean * mean)) >= FLAT_STD * 2;
    }).length >= columns.length / 2;
  const isCutOffRow = (s: Segment | undefined, gap: number) =>
    !!s && size(s) >= rowHeight * MIN_PARTIAL_ROW && !isFull(s) && gap <= separatorGap * 2 + 2 && hasPhotos(s);

  const above = segments[firstFull - 1];
  const below = segments[lastFull + 1];
  const rowSpans = [
    ...(isCutOffRow(above, above ? segments[firstFull].start - above.end : Infinity) ? [{ ...above, partial: true }] : []),
    ...fullRows.map((s) => ({ ...s, partial: false })),
    ...(isCutOffRow(below, below ? below.start - segments[lastFull].end : Infinity) ? [{ ...below, partial: true }] : []),
  ];
  return { rows: rowSpans.length, cols: columns.length, colSpans: columns, rowSpans };
}

/** The cells to use for the rows × cols the user settled on. Detected ones where detection agrees;
 *  otherwise the detected grid area split evenly into that many rows / columns (`estimated`, shown in the
 *  composer's preview so a bad split is seen before sending). null only when no grid was found at all. */
export function resolveGridLayout(layout: GridLayout | null, grid: GridSize): (GridLayout & { estimated: boolean }) | null {
  if (!layout || grid.rows < 1 || grid.cols < 1) {
    return null;
  }
  const even = (from: number, to: number, n: number) =>
    Array.from({ length: n }, (_, k) => ({ start: from + ((to - from) * k) / n, end: from + ((to - from) * (k + 1)) / n }));
  const colsMatch = layout.cols === grid.cols;
  const rowsMatch = layout.rows === grid.rows;
  return {
    rows: grid.rows,
    cols: grid.cols,
    colSpans: colsMatch ? layout.colSpans : even(layout.colSpans[0].start, layout.colSpans[layout.colSpans.length - 1].end, grid.cols),
    rowSpans: rowsMatch
      ? layout.rowSpans
      : even(layout.rowSpans[0].start, layout.rowSpans[layout.rowSpans.length - 1].end, grid.rows).map((s) => ({ ...s, partial: false })),
    estimated: !colsMatch || !rowsMatch,
  };
}

/** Browser wrapper: decodes the image at full resolution (thin separators vanish when downscaled). */
export async function detectGrid(dataUrl: string): Promise<GridSize | null> {
  const layout = await detectGridLayout(dataUrl);
  return layout && { rows: layout.rows, cols: layout.cols };
}

/** Same, with the cell positions in the screenshot's own pixels. */
export async function detectGridLayout(dataUrl: string): Promise<GridLayout | null> {
  const image = await loadImage(dataUrl);
  const scale = Math.min(1, 4000 / Math.max(image.width, image.height));
  const width = Math.round(image.width * scale);
  const height = Math.round(image.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    return null;
  }
  context.drawImage(image, 0, 0, width, height);
  const { data } = context.getImageData(0, 0, width, height);
  const luma = new Float32Array(width * height);
  for (let i = 0; i < luma.length; i += 1) {
    luma[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }
  const layout = detectGridLayoutFromLuma(luma, width, height);
  const unscale = (s: Segment) => ({ start: s.start / scale, end: s.end / scale });
  return layout && {
    ...layout,
    colSpans: layout.colSpans.map(unscale),
    rowSpans: layout.rowSpans.map((s) => ({ ...unscale(s), partial: s.partial })),
  };
}

// Grid check: does a generated photo show its own cell? An 8×8 thumbnail of the result is compared with
// every full cell of the screenshot; it's flagged when another cell is clearly closer than its own.
// ponytail: pixel heuristic. Near-identical cells (burst shots) are too close to call so never get flagged,
// and cut-off edge rows aren't checked. Upgrade path: ask a vision model which cell the photo shows.

export type GridCheck = { mismatch: boolean; bestCell: string } | null; // null: couldn't be checked

const SIGNATURE_SIDE = 8; // coarse on purpose: a re-drawn photo is reframed a little
const SIGNATURE_WORK = 64; // drawn at 64px, then block-averaged: one big canvas downscale aliases
// another cell must be at least twice as close as the photo's own. Tried on 8 grids of look-alike photos
// from one shoot: ~1% of right images flagged, ~95% of wrong-cell images caught (0.85: 7% / 98%).
const MISMATCH_MARGIN = 0.5;

/** Mean-centred 8×8 RGB thumbnail of square RGBA pixels: brightness cancels out, colours and layout stay. */
export function signatureFromRgba(data: ArrayLike<number>, side: number): Float32Array {
  const block = side / SIGNATURE_SIDE;
  const values = new Float32Array(SIGNATURE_SIDE * SIGNATURE_SIDE * 3);
  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      const i = (y * side + x) * 4;
      const j = (Math.floor(y / block) * SIGNATURE_SIDE + Math.floor(x / block)) * 3;
      values[j] += data[i];
      values[j + 1] += data[i + 1];
      values[j + 2] += data[i + 2];
    }
  }
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return values.map((v) => v - mean);
}

/** 1 − correlation: 0 = same picture, about 1 = unrelated. */
export function signatureDistance(a: Float32Array, b: Float32Array) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return 1 - dot / (Math.sqrt(normA * normB) || 1);
}

export function judgeGridImage(result: Float32Array, cells: Map<string, Float32Array>, own: string): GridCheck {
  const ownSignature = cells.get(own);
  if (!ownSignature) {
    return null;
  }
  const ownDistance = signatureDistance(result, ownSignature);
  let bestCell = own;
  let bestDistance = ownDistance;
  for (const [cell, signature] of cells) {
    const distance = signatureDistance(result, signature);
    if (distance < bestDistance) {
      bestCell = cell;
      bestDistance = distance;
    }
  }
  return bestDistance < ownDistance * MISMATCH_MARGIN ? { mismatch: true, bestCell } : { mismatch: false, bestCell: own };
}

/** Decoded pixels of a data:, blob: or same-origin URL. createImageBitmap, not <img>.decode(): that waits
 *  until the tab is visible, so detection stalled when a screenshot was pasted and the tab left. */
async function loadImage(src: string) {
  return createImageBitmap(await (await fetch(src)).blob());
}

function drawSignature(image: CanvasImageSource, sx: number, sy: number, sw: number, sh: number) {
  const canvas = document.createElement("canvas");
  canvas.width = SIGNATURE_WORK;
  canvas.height = SIGNATURE_WORK;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("canvas unavailable");
  }
  context.imageSmoothingQuality = "high";
  context.drawImage(image, sx, sy, sw, sh, 0, 0, SIGNATURE_WORK, SIGNATURE_WORK);
  return signatureFromRgba(context.getImageData(0, 0, SIGNATURE_WORK, SIGNATURE_WORK).data, SIGNATURE_WORK);
}

type Box = { x: number; y: number; w: number; h: number; partial: boolean };
type ScreenshotGrid = { image: ImageBitmap; boxes: Map<string, Box>; signatures: Map<string, Float32Array>; aspect: number };
const screenshotGridCache = new Map<string, Promise<ScreenshotGrid | null>>();

/** Where each cell ("R1C2") sits in the screenshot (resolveGridLayout), plus the full cells' signatures;
 *  once per turn. null when no grid was found in the screenshot at all. */
export function screenshotGrid(turnId: string, screenshot: string, grid: GridSize) {
  let cached = screenshotGridCache.get(turnId);
  if (!cached) {
    cached = (async () => {
      const layout = resolveGridLayout(await detectGridLayout(screenshot), grid);
      if (!layout) {
        return null;
      }
      const image = await loadImage(screenshot);
      const boxes = new Map<string, Box>();
      const signatures = new Map<string, Float32Array>();
      const widths: number[] = [];
      const heights: number[] = [];
      layout.rowSpans.forEach((row, r) => {
        layout.colSpans.forEach((col, c) => {
          const cell = `R${r + 1}C${c + 1}`;
          boxes.set(cell, { x: col.start, y: row.start, w: size(col), h: size(row), partial: row.partial });
          if (!row.partial) {
            signatures.set(cell, drawSignature(image, col.start, row.start, size(col), size(row)));
            widths.push(size(col));
            heights.push(size(row));
          }
        });
      });
      return { image, boxes, signatures, aspect: widths.length ? median(widths) / median(heights) : 1 };
    })().catch(() => null);
    screenshotGridCache.set(turnId, cached);
  }
  return cached;
}

/** What the server needs to check a grid cell's result (services/grid_check.py): this cell's name and every
 *  full cell's fingerprint. null for cells it can't check (cut-off rows, positions unknown). */
export async function gridCheckRequest(turnId: string, screenshot: string, grid: GridSize, cell: string) {
  const found = await screenshotGrid(turnId, screenshot, grid);
  if (!found?.signatures.has(cell)) {
    return null;
  }
  const signatures: Record<string, number[]> = {};
  found.signatures.forEach((signature, name) => {
    signatures[name] = Array.from(signature, Math.round);
  });
  return { cell, aspect: found.aspect, signatures };
}

/** One cell cut out of the screenshot as a PNG file: what grid mode sends instead of the whole screenshot. */
export async function cropGridCell(turnId: string, screenshot: string, grid: GridSize, cell: string): Promise<File | null> {
  const found = await screenshotGrid(turnId, screenshot, grid);
  const box = found?.boxes.get(cell);
  if (!found || !box) {
    return null;
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(box.w);
  canvas.height = Math.round(box.h);
  canvas.getContext("2d")?.drawImage(found.image, box.x, box.y, box.w, box.h, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  return blob && new File([blob], `${cell}.png`, { type: "image/png" });
}

/** Checks one finished grid image; `imageSrc` must be same-origin or a blob/data URL (canvas reads it). */
export async function checkGridImage(turnId: string, screenshot: string, grid: GridSize, cell: string, imageSrc: string): Promise<GridCheck> {
  const cells = await screenshotGrid(turnId, screenshot, grid);
  if (!cells?.signatures.has(cell)) {
    return null;
  }
  const image = await loadImage(imageSrc);
  // the grid shows each photo centre-cropped to the cell's shape, so crop the result the same way
  const width = Math.min(image.width, image.height * cells.aspect);
  const height = width / cells.aspect;
  const signature = drawSignature(image, (image.width - width) / 2, (image.height - height) / 2, width, height);
  return judgeGridImage(signature, cells.signatures, cell);
}

/** "R4C1" → that cell's 0-based index in reading order (left to right, top to bottom); null if not in the grid. */
export function parseGridCell(value: string, grid: GridSize): number | null {
  const match = value.trim().toUpperCase().match(/^R(\d+)C(\d+)$/);
  const row = Number(match?.[1]);
  const col = Number(match?.[2]);
  return match && row >= 1 && row <= grid.rows && col >= 1 && col <= grid.cols ? (row - 1) * grid.cols + col - 1 : null;
}

/** Grid mode's 范围: the picked cells' indexes in reading order, [] = every cell. A list of cells and ranges,
 *  e.g. "R1C2, R3C1-R3C3" (also –, ~ or 到 for ranges; commas, 、 or spaces between). null when it can't be
 *  read or names a cell outside the grid. */
export function parseGridCells(text: string, grid: GridSize): number[] | null {
  const tokens = text
    .toUpperCase()
    .replace(/\s*([-–~到])\s*/g, "$1")
    .split(/[,，、;；\s]+/)
    .filter(Boolean);
  const picked = new Set<number>();
  for (const token of tokens) {
    const [from, to, extra] = token.split(/[-–~到]/);
    const first = parseGridCell(from, grid);
    const last = to === undefined ? first : parseGridCell(to, grid);
    if (extra !== undefined || first === null || last === null) {
      return null;
    }
    for (let index = Math.min(first, last); index <= Math.max(first, last); index += 1) {
      picked.add(index);
    }
  }
  return [...picked].sort((a, b) => a - b);
}

/** The picked cells as short text for the 范围 field and labels: runs in reading order become ranges
 *  ("R1C2, R3C1–R3C3"); none or every cell is "" (the whole grid). */
export function formatGridCells(indexes: number[], grid: GridSize): string {
  const sorted = [...new Set(indexes)].sort((a, b) => a - b);
  if (sorted.length === 0 || sorted.length === grid.rows * grid.cols) {
    return "";
  }
  const name = (index: number) => `R${Math.floor(index / grid.cols) + 1}C${(index % grid.cols) + 1}`;
  const parts: string[] = [];
  for (let start = 0; start < sorted.length; ) {
    let end = start;
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[end] + 1) {
      end += 1;
    }
    parts.push(end > start ? `${name(sorted[start])}–${name(sorted[end])}` : name(sorted[start]));
    start = end + 1;
  }
  return parts.join(", ");
}
