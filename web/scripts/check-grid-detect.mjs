// node --experimental-strip-types scripts/check-grid-detect.mjs
// Synthetic versions of the iPhone Photos layouts grid mode has to handle.
import assert from "node:assert/strict";

import { detectGridFromLuma, detectGridLayoutFromLuma, formatGridCells, judgeGridImage, parseGridCells, resolveGridLayout } from "../src/lib/grid-detect.ts";

let seed = 7;
const noise = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 255;

/** Builds a screenshot from horizontal bands. Kinds:
 *  blank (white), title (dark text in column 1 only), icons (marks across the width),
 *  cells (noise photos with white vertical separators), sep (white line), blur (noise everywhere),
 *  specks (a white line with ~6% dark compression specks). `dim`: this vertical separator is grey (232). */
function screenshot(cols, cellWidth, bands, detect = detectGridFromLuma, sep = 3, dim = -1) {
  const width = cols * cellWidth + (cols - 1) * sep;
  const height = bands.reduce((a, b) => a + b.h, 0);
  const luma = new Float32Array(width * height);
  let y = 0;
  for (const band of bands) {
    for (let dy = 0; dy < band.h; dy += 1, y += 1) {
      for (let x = 0; x < width; x += 1) {
        const inSeparator = x % (cellWidth + sep) >= cellWidth;
        luma[y * width + x] =
          band.kind === "cells" ? (inSeparator ? (Math.floor(x / (cellWidth + sep)) === dim ? 232 : 255) : noise()) :
          band.kind === "specks" ? (noise() < 15 ? 215 : 255) :
          band.kind === "title" ? (x < cellWidth * 0.8 && x % 7 < 3 ? 20 : 255) :
          band.kind === "icons" ? (x % 60 < 20 ? 90 : 255) :
          band.kind === "blur" ? noise() :
          255;
      }
    }
  }
  return detect(luma, width, height);
}

const rowsOf = (n, cell) => Array.from({ length: n }, (_, i) => [...(i ? [{ kind: "sep", h: 3 }] : []), { kind: "cells", h: cell }]).flat();

// Opaque white header ("Today / Mar 8, 2025" title lines just above the grid), 6 full rows, tab bar icons.
assert.deepEqual(
  screenshot(4, 95, [
    { kind: "blank", h: 40 }, { kind: "title", h: 18 }, { kind: "blank", h: 8 }, { kind: "title", h: 10 }, { kind: "blank", h: 6 },
    ...rowsOf(6, 95),
    { kind: "blank", h: 25 }, { kind: "icons", h: 30 }, { kind: "blank", h: 30 },
  ]),
  { rows: 6, cols: 4 },
);

// Blurred header running straight into row 1, a half-visible last row under a blurred tab bar (6 columns).
assert.deepEqual(
  screenshot(6, 64, [
    { kind: "blur", h: 120 },
    ...rowsOf(6, 92),
    { kind: "sep", h: 3 }, { kind: "cells", h: 45 }, // cut off: about half a row
    { kind: "blur", h: 90 },
  ]),
  { rows: 7, cols: 6 },
);

// Same, with only a third of the last row visible (4 columns).
assert.deepEqual(
  screenshot(4, 95, [{ kind: "blur", h: 110 }, ...rowsOf(6, 95), { kind: "sep", h: 3 }, { kind: "cells", h: 32 }, { kind: "blur", h: 80 }]),
  { rows: 7, cols: 4 },
);

// Downscaled screenshot: 1px column separators, and one row separator blurred away (rows 1 and 2 merged)
assert.deepEqual(
  screenshot(3, 90, [
    { kind: "blank", h: 60 },
    { kind: "cells", h: 220 }, { kind: "sep", h: 1 }, ...rowsOf(2, 110).map((b) => (b.kind === "sep" ? { ...b, h: 1 } : b)),
    { kind: "blank", h: 60 },
  ], detectGridFromLuma, 1),
  { rows: 4, cols: 3 },
);

// Compressed screenshot: the row separators speckled (std-dev over 6, so no line counted as flat and all
// rows merged into one) and one column separator grey, as when it falls between two pixels
assert.deepEqual(
  screenshot(6, 64, [
    { kind: "blur", h: 120 },
    ...rowsOf(6, 92).map((b) => (b.kind === "sep" ? { ...b, kind: "specks" } : b)),
    { kind: "specks", h: 3 }, { kind: "cells", h: 45 },
    { kind: "blur", h: 90 },
  ], detectGridFromLuma, 3, 2),
  { rows: 7, cols: 6 },
);

// Not a grid: one big noisy photo
const w = 300;
const h = 400;
assert.equal(detectGridFromLuma(Float32Array.from({ length: w * h }, noise), w, h), null);

// Cell positions for the grid check: 6 full 92px rows, then the cut-off one flagged partial.
const layout = screenshot(6, 64, [
  { kind: "blur", h: 120 }, ...rowsOf(6, 92), { kind: "sep", h: 3 }, { kind: "cells", h: 45 }, { kind: "blur", h: 90 },
], detectGridLayoutFromLuma);
assert.deepEqual(layout.rowSpans.map((r) => [r.end - r.start, r.partial]), [...Array(6).fill([92, false]), [45, true]]);
assert.ok(layout.colSpans.every((c) => c.end - c.start === 64));

// Grid check verdicts on synthetic signatures
const signature = () => Float32Array.from({ length: 768 }, () => noise() - 127.5);
const near = (v, amount) => v.map((x) => x + (noise() - 127.5) * amount);
const [a, b, c] = [signature(), signature(), signature()];
const cells = new Map([["R1C1", a], ["R1C2", b], ["R1C3", c]]);
assert.deepEqual(judgeGridImage(near(a, 0.3), cells, "R1C1"), { mismatch: false, bestCell: "R1C1" });
assert.deepEqual(judgeGridImage(near(a, 0.3), cells, "R1C2"), { mismatch: true, bestCell: "R1C1" });
// near-identical cells (burst shots): too close to call, never flagged
assert.equal(judgeGridImage(near(a, 0.3), new Map([["R1C1", a], ["R1C2", near(a, 0.05)]]), "R1C2").mismatch, false);
assert.equal(judgeGridImage(a, cells, "R7C1"), null); // cut-off row: not checked

// Rows × cols typed by hand: detected cells when they agree, else the detected area split evenly (estimated)
const detected = { rows: 3, cols: 3, colSpans: [{ start: 0, end: 100 }, { start: 101, end: 200 }, { start: 201, end: 300 }],
  rowSpans: [{ start: 50, end: 250, partial: false }, { start: 251, end: 350, partial: false }, { start: 351, end: 450, partial: false }] };
assert.equal(resolveGridLayout(detected, { rows: 3, cols: 3 }).estimated, false);
assert.equal(resolveGridLayout(detected, { rows: 3, cols: 3 }).rowSpans, detected.rowSpans);
const typed = resolveGridLayout(detected, { rows: 4, cols: 3 }); // e.g. rows 1+2 merged by detection
assert.equal(typed.estimated, true);
assert.deepEqual(typed.rowSpans.map((r) => [r.start, r.end]), [[50, 150], [150, 250], [250, 350], [350, 450]]);
assert.equal(typed.colSpans, detected.colSpans); // columns agreed: kept exact
assert.equal(resolveGridLayout(null, { rows: 4, cols: 3 }), null); // no grid found: nothing to crop

// 范围: picked cells (indexes in reading order) on a 6×3 grid
const grid6x3 = { rows: 6, cols: 3 };
assert.deepEqual(parseGridCells("", grid6x3), []); // blank = whole grid
assert.deepEqual(parseGridCells("r1c2, R3C1-R3C3", grid6x3), [1, 6, 7, 8]); // cells and ranges, any case
assert.deepEqual(parseGridCells("R4C3 到 R4C1、R2C2", grid6x3), [4, 9, 10, 11]); // reversed range, 、 and spaces
assert.equal(parseGridCells("R7C1", grid6x3), null); // outside the grid
assert.equal(parseGridCells("R1C1-R1C2-R1C3", grid6x3), null);
assert.equal(parseGridCells("4-1", grid6x3), null);
assert.equal(formatGridCells([8, 1, 6, 7, 1], grid6x3), "R1C2, R3C1–R3C3"); // runs become ranges
assert.equal(formatGridCells(Array.from({ length: 18 }, (_, i) => i), grid6x3), ""); // every cell = whole grid
assert.deepEqual(parseGridCells(formatGridCells([0, 2, 3, 4, 17], grid6x3), grid6x3), [0, 2, 3, 4, 17]); // round trip

console.log("grid-detect ok");
