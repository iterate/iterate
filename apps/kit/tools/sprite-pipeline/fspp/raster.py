"""Background detection and keying.

Image-model sheets arrive on a nominally flat but slightly noisy background.
The keyer finds the border's modal color, then flood-fills every
border-connected pixel within a tolerance, so interior pixels that merely
resemble the background (highlights, pale markings) stay foreground.
"""

from __future__ import annotations

from collections import deque

from .png_io import Image
from .util import parse_hex_color


def detect_background(image: Image) -> tuple[int, int, int]:
    """Modal border color using 8-level-per-channel buckets."""
    buckets: dict[tuple[int, int, int], list[int]] = {}
    width, height = image.width, image.height
    border: list[int] = []
    border.extend(range(width))  # top row indices
    border.extend(range((height - 1) * width, height * width))
    for y in range(1, height - 1):
        border.append(y * width)
        border.append(y * width + width - 1)
    rgba = image.rgba
    counts: dict[tuple[int, int, int], int] = {}
    sums: dict[tuple[int, int, int], list[int]] = {}
    for index in border:
        base = index * 4
        r, g, b = rgba[base], rgba[base + 1], rgba[base + 2]
        key = (r >> 5, g >> 5, b >> 5)
        counts[key] = counts.get(key, 0) + 1
        total = sums.setdefault(key, [0, 0, 0])
        total[0] += r
        total[1] += g
        total[2] += b
    best = min(counts, key=lambda k: (-counts[k], k))
    total = sums[best]
    n = counts[best]
    return (total[0] // n, total[1] // n, total[2] // n)


def key_background(
    image: Image,
    background: str,
    tolerance: int,
) -> tuple[bytearray, tuple[int, int, int]]:
    """Return (mask, background_color); mask[i] is 1 for foreground."""
    if background == "auto":
        bg = detect_background(image)
    else:
        bg = parse_hex_color(background)
    width, height = image.width, image.height
    rgba = image.rgba
    n = width * height
    br, bgc, bb = bg

    similar = bytearray(n)
    for i in range(n):
        base = i * 4
        if rgba[base + 3] < 128:
            similar[i] = 1
            continue
        dr = rgba[base] - br
        dg = rgba[base + 1] - bgc
        db = rgba[base + 2] - bb
        if dr < 0:
            dr = -dr
        if dg < 0:
            dg = -dg
        if db < 0:
            db = -db
        if dr <= tolerance and dg <= tolerance and db <= tolerance:
            similar[i] = 1

    mask = bytearray(b"\x01" * n)
    queue: deque[int] = deque()
    for x in range(width):
        for i in (x, (height - 1) * width + x):
            if similar[i] and mask[i]:
                mask[i] = 0
                queue.append(i)
    for y in range(height):
        for i in (y * width, y * width + width - 1):
            if similar[i] and mask[i]:
                mask[i] = 0
                queue.append(i)
    while queue:
        i = queue.popleft()
        x = i % width
        if x > 0:
            j = i - 1
            if similar[j] and mask[j]:
                mask[j] = 0
                queue.append(j)
        if x + 1 < width:
            j = i + 1
            if similar[j] and mask[j]:
                mask[j] = 0
                queue.append(j)
        j = i - width
        if j >= 0 and similar[j] and mask[j]:
            mask[j] = 0
            queue.append(j)
        j = i + width
        if j < n and similar[j] and mask[j]:
            mask[j] = 0
            queue.append(j)

    # Fully transparent source pixels are never foreground.
    for i in range(n):
        if rgba[i * 4 + 3] < 128:
            mask[i] = 0
    return mask, bg


def apply_mask(image: Image, mask: bytearray) -> Image:
    """Copy with background pixels forced fully transparent."""
    out = Image(image.width, image.height, bytearray(image.rgba))
    for i in range(image.width * image.height):
        base = i * 4
        if mask[i]:
            out.rgba[base + 3] = 255
        else:
            out.rgba[base : base + 4] = b"\x00\x00\x00\x00"
    return out
