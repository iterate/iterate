// Justified-rows mosaic for multi-photo message bubbles — the Telegram look:
// photos share rows at a common height instead of stacking full-width.
//
// Inspired by flickr/justified-layout (github.com/flickr/justified-layout,
// MIT) — the well-known greedy row-filling algorithm — simplified for this
// use: no library, fixed lookahead of one (keep-or-carry the overflowing
// item, whichever lands the row height nearer the target), every row
// justified to the container width, at most 3 photos per row, and
// single-photo rows clamped so one portrait shot can't tower.
//
// Pure geometry so it unit-tests without rendering: aspect ratios in,
// absolutely-positioned rects out.

export type MosaicRect = { x: number; y: number; width: number; height: number };

export const MOSAIC_GAP = 2;
export const MOSAIC_TARGET_ROW_HEIGHT = 160;
const MAX_PER_ROW = 3;
const SINGLE_ROW_MAX_HEIGHT = 320;
const ROW_MIN_HEIGHT = 80;

export function mosaicLayout(input: {
  /** width / height per photo; non-finite or non-positive values become 1. */
  aspectRatios: number[];
  maxWidth: number;
}): { rects: MosaicRect[]; width: number; height: number } {
  const aspects = input.aspectRatios.map((ratio) =>
    Number.isFinite(ratio) && ratio > 0 ? ratio : 1,
  );

  // A row justified to the full width has exactly one possible height.
  const justifiedHeight = (indexes: number[]) => {
    const totalAspect = indexes.reduce((sum, index) => sum + aspects[index]!, 0);
    return (input.maxWidth - MOSAIC_GAP * (indexes.length - 1)) / totalAspect;
  };

  const rows: number[][] = [];
  let current: number[] = [];
  for (let index = 0; index < aspects.length; index++) {
    current.push(index);
    const height = justifiedHeight(current);
    if (current.length > 1 && height < MOSAIC_TARGET_ROW_HEIGHT) {
      // Overflowed the target. Grouping is the whole point (stacked photos
      // are what this replaces), so keep the item whenever the shared row
      // stays tall enough to see; only a row squeezed into a sliver falls
      // back to comparing which split lands nearer the target.
      const withoutHeight = justifiedHeight(current.slice(0, -1));
      const keep =
        height >= ROW_MIN_HEIGHT ||
        Math.abs(height - MOSAIC_TARGET_ROW_HEIGHT) <=
          Math.abs(withoutHeight - MOSAIC_TARGET_ROW_HEIGHT);
      if (keep) {
        rows.push(current);
        current = [];
      } else {
        current.pop();
        rows.push(current);
        current = [index];
      }
    } else if (current.length === MAX_PER_ROW) {
      rows.push(current);
      current = [];
    }
  }
  if (current.length > 0) rows.push(current);

  const rects: MosaicRect[] = Array.from({ length: aspects.length });
  let y = 0;
  for (const row of rows) {
    let height = justifiedHeight(row);
    // A lone photo is the only case a row can get extreme (a tall portrait
    // towering, a panorama shrinking to a sliver): clamp its height and let
    // the row come out narrower than the container. Multi-photo rows keep
    // their exact justified height — anything else would overflow the width.
    if (row.length === 1) {
      height = Math.min(Math.max(height, ROW_MIN_HEIGHT), SINGLE_ROW_MAX_HEIGHT);
    }
    let x = 0;
    for (const index of row) {
      const width =
        row.length === 1
          ? Math.min(height * aspects[index]!, input.maxWidth)
          : height * aspects[index]!;
      rects[index] = { x, y, width, height };
      x += width + MOSAIC_GAP;
    }
    y += height + MOSAIC_GAP;
  }

  return {
    rects,
    width: Math.max(...rects.map((rect) => rect.x + rect.width)),
    height: y - MOSAIC_GAP,
  };
}
