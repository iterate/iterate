"""Deterministic palette quantization.

Median cut with fully specified tie-breaking, an optional locked palette,
and a majority despeckle pass. Everything is integer arithmetic; running the
same inputs always produces the same palette in the same order.

Index 0 is always the transparent slot; visible colors start at index 1,
matching the FSPR convention.
"""

from __future__ import annotations

from dataclasses import dataclass

from .png_io import Image
from .util import rgb565

TRANSPARENT = 0


@dataclass
class IndexedCell:
    """A cell as palette indices; 0 marks transparent pixels."""

    name: str
    width: int
    height: int
    indices: bytearray


@dataclass
class Palette:
    rgb: list[tuple[int, int, int]]  # visible colors; palette[0] is implicit
    merged_565: list[tuple[int, int]]  # (kept_index, dropped_index) pairs

    def entries(self) -> list[tuple[int, int, int]]:
        """Full table including the transparent slot at index 0."""
        return [(0, 0, 0)] + self.rgb

    def entries_565(self) -> list[int]:
        return [rgb565(color) for color in self.entries()]


def _luma(color: tuple[int, int, int]) -> int:
    return 299 * color[0] + 587 * color[1] + 114 * color[2]


def _median_cut(
    histogram: dict[tuple[int, int, int], int], max_colors: int
) -> list[tuple[int, int, int]]:
    boxes: list[list[tuple[tuple[int, int, int], int]]] = [
        sorted(histogram.items())
    ]
    while len(boxes) < max_colors:
        best_index = -1
        best_key = None
        for index, box in enumerate(boxes):
            if len(box) < 2:
                continue
            ranges = [
                max(color[channel] for color, _ in box)
                - min(color[channel] for color, _ in box)
                for channel in range(3)
            ]
            spread = max(ranges)
            count = sum(count for _, count in box)
            key = (spread, count, -index)
            if spread > 0 and (best_key is None or key > best_key):
                best_key = key
                best_index = index
        if best_index < 0:
            break
        box = boxes.pop(best_index)
        ranges = [
            max(color[channel] for color, _ in box)
            - min(color[channel] for color, _ in box)
            for channel in range(3)
        ]
        channel = ranges.index(max(ranges))
        box.sort(key=lambda item: (item[0][channel], item[0]))
        total = sum(count for _, count in box)
        acc = 0
        split = 1
        for index, (_, count) in enumerate(box):
            acc += count
            if acc * 2 >= total:
                split = min(max(index + 1, 1), len(box) - 1)
                break
        boxes.insert(best_index, box[:split])
        boxes.insert(best_index + 1, box[split:])
    reps = []
    for box in boxes:
        total = sum(count for _, count in box)
        rep = tuple(
            sum(color[channel] * count for color, count in box) // total
            for channel in range(3)
        )
        reps.append(rep)
    unique: list[tuple[int, int, int]] = []
    for rep in sorted(set(reps), key=lambda c: (_luma(c), c)):
        unique.append(rep)
    return unique


def build_palette(
    cells: list[Image],
    max_colors: int,
    locked: tuple[tuple[int, int, int], ...] | None,
) -> Palette:
    if locked is not None:
        rgb = list(locked)
    else:
        histogram: dict[tuple[int, int, int], int] = {}
        for cell in cells:
            rgba = cell.rgba
            for i in range(cell.width * cell.height):
                base = i * 4
                if rgba[base + 3] < 128:
                    continue
                color = (rgba[base], rgba[base + 1], rgba[base + 2])
                histogram[color] = histogram.get(color, 0) + 1
        if not histogram:
            raise ValueError("no opaque pixels to quantize")
        rgb = _median_cut(histogram, max_colors)

    # Colors that collide after RGB565 truncation merge into one entry so the
    # flash palette never holds duplicates the display cannot distinguish.
    merged: list[tuple[int, int]] = []
    seen: dict[int, int] = {}
    kept: list[tuple[int, int, int]] = []
    for index, color in enumerate(rgb):
        value = rgb565(color)
        if value in seen:
            merged.append((seen[value], index))
            continue
        seen[value] = len(kept)
        kept.append(color)
    return Palette(rgb=kept, merged_565=merged)


def map_cell(image: Image, name: str, palette: Palette) -> IndexedCell:
    """Nearest-color mapping; ties resolve to the lower palette index."""
    colors = palette.rgb
    cache: dict[tuple[int, int, int], int] = {}
    out = bytearray(image.width * image.height)
    rgba = image.rgba
    for i in range(image.width * image.height):
        base = i * 4
        if rgba[base + 3] < 128:
            continue
        color = (rgba[base], rgba[base + 1], rgba[base + 2])
        index = cache.get(color)
        if index is None:
            best = 0
            best_distance = 1 << 30
            for slot, candidate in enumerate(colors):
                dr = color[0] - candidate[0]
                dg = color[1] - candidate[1]
                db = color[2] - candidate[2]
                distance = dr * dr + dg * dg + db * db
                if distance < best_distance:
                    best_distance = distance
                    best = slot
            index = best + 1  # skip the transparent slot
            cache[color] = index
        out[i] = index
    return IndexedCell(name, image.width, image.height, out)


def despeckle(cell: IndexedCell) -> int:
    """Majority filter for isolated pixels; returns how many changed.

    A visible pixel whose index appears in none of its visible neighbours,
    while at least five neighbours agree on one other index, adopts the
    majority. One pass over a copy keeps the result order-independent.
    """
    width, height = cell.width, cell.height
    source = bytes(cell.indices)
    changed = 0
    for y in range(height):
        for x in range(width):
            i = y * width + x
            own = source[i]
            if own == TRANSPARENT:
                continue
            counts: dict[int, int] = {}
            visible = 0
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    if dx == 0 and dy == 0:
                        continue
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < width and 0 <= ny < height:
                        value = source[ny * width + nx]
                        if value != TRANSPARENT:
                            visible += 1
                            counts[value] = counts.get(value, 0) + 1
            if counts.get(own, 0) > 0 or visible < 5:
                continue
            majority = min(
                counts, key=lambda k: (-counts[k], k)
            )
            if counts[majority] >= 5:
                cell.indices[i] = majority
                changed += 1
    return changed
