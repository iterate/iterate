"""Rig normalization: registered canvas-space art from segmented cells.

Every portrait lands on the same authoring canvas with a shared baseline and
horizontal centering, which is what makes expression banks register against
each other. Mouth cels are normalized into the rig's replaceable mouth box.
Baked-in mouths are erased in place, and blink lids are synthesized from the
neutral portrait's own colors so the atlas can blink without authored lid
art.
"""

from __future__ import annotations

from .png_io import Image
from .spec import RigSpec

ERASE_TOLERANCE = 24


def trim(image: Image) -> tuple[Image, int, int]:
    """Crop to the opaque bounding box; returns (cropped, off_x, off_y)."""
    min_x, min_y = image.width, image.height
    max_x = max_y = -1
    for y in range(image.height):
        for x in range(image.width):
            if image.opaque(x, y):
                if x < min_x:
                    min_x = x
                if x > max_x:
                    max_x = x
                if y < min_y:
                    min_y = y
                if y > max_y:
                    max_y = y
    if max_x < 0:
        return Image.blank(1, 1), 0, 0
    return (
        image.crop(min_x, min_y, max_x - min_x + 1, max_y - min_y + 1),
        min_x,
        min_y,
    )


def nn_scale(image: Image, dst_w: int, dst_h: int) -> Image:
    if dst_w == image.width and dst_h == image.height:
        return image
    out = Image.blank(dst_w, dst_h)
    for y in range(dst_h):
        sy = y * image.height // dst_h
        for x in range(dst_w):
            sx = x * image.width // dst_w
            si = (sy * image.width + sx) * 4
            di = (y * dst_w + x) * 4
            out.rgba[di : di + 4] = image.rgba[si : si + 4]
    return out


def fit_size(w: int, h: int, max_w: int, max_h: int) -> tuple[int, int]:
    """Downscale-only uniform fit; identity when the art already fits."""
    if w <= max_w and h <= max_h:
        return w, h
    if w * max_h >= h * max_w:
        dst_w = max_w
        dst_h = max(1, h * max_w // w)
    else:
        dst_h = max_h
        dst_w = max(1, w * max_h // h)
    return dst_w, dst_h


def _main_component_bbox(image: Image) -> tuple[int, int, int, int]:
    """Bounding box of the largest 4-connected opaque component.

    Detached decorations (sparkles, sweat drops, zzz marks) must not shift
    the body anchor, so scaling and placement key off the dominant blob
    while the decorations ride along at their relative offsets.
    """
    width, height = image.width, image.height
    seen = bytearray(width * height)
    best = None
    best_count = 0
    for start_y in range(height):
        for start_x in range(width):
            index = start_y * width + start_x
            if seen[index] or not image.opaque(start_x, start_y):
                continue
            stack = [index]
            seen[index] = 1
            count = 0
            min_x, min_y, max_x, max_y = start_x, start_y, start_x, start_y
            while stack:
                i = stack.pop()
                count += 1
                x, y = i % width, i // width
                min_x = min(min_x, x)
                max_x = max(max_x, x)
                min_y = min(min_y, y)
                max_y = max(max_y, y)
                for j in (
                    i - 1 if x > 0 else -1,
                    i + 1 if x + 1 < width else -1,
                    i - width if y > 0 else -1,
                    i + width if y + 1 < height else -1,
                ):
                    if j >= 0 and not seen[j] and image.opaque(
                        j % width, j // width
                    ):
                        seen[j] = 1
                        stack.append(j)
            if count > best_count:
                best_count = count
                best = (min_x, min_y, max_x, max_y)
    if best is None:
        return (0, 0, width - 1, height - 1)
    return best


def _median(values: list[int]) -> int:
    ordered = sorted(values)
    return ordered[len(ordered) // 2]


def shared_scale(
    portraits: dict[str, Image], rig: RigSpec
) -> tuple[int, int, dict]:
    """One rational source-to-canvas scale for the whole sheet.

    The median dominant-component size across all portraits is scaled to
    fill rig.max_body. Using a single shared factor (rather than per-cell
    fitting) keeps every cell at the scale it was authored at relative to
    the others, and makes the spec's canvas-space anchor boxes meaningful
    no matter what pixel pitch the snap stage detected.
    """
    widths: list[int] = []
    heights: list[int] = []
    for _, image in sorted(portraits.items()):
        art, _, _ = trim(image)
        if rig.composition_mode == "features_only":
            # A feature-only face is intentionally several disconnected
            # components: two eyes, two brows, and a mouth. Treating one eye
            # as the "body" magnifies it to the entire screen and clips all
            # of the other authored features.
            widths.append(art.width)
            heights.append(art.height)
        else:
            mx0, my0, mx1, my1 = _main_component_bbox(art)
            widths.append(mx1 - mx0 + 1)
            heights.append(my1 - my0 + 1)
    body_w = max(1, _median(widths))
    body_h = max(1, _median(heights))
    if body_w * rig.max_body[1] >= body_h * rig.max_body[0]:
        num, den = rig.max_body[0], body_w
    else:
        num, den = rig.max_body[1], body_h
    evidence = {
        "median_body": [body_w, body_h],
        "scale": [num, den],
        "body_widths": widths,
        "body_heights": heights,
    }
    return num, den, evidence


def _paste(canvas: Image, art: Image, x0: int, y0: int) -> None:
    for y in range(art.height):
        for x in range(art.width):
            color = art.get(x, y)
            if color[3] >= 128:
                canvas.put(x0 + x, y0 + y, color)


def isolate_features(
    image: Image,
    rig: RigSpec,
    origin_x: int = 0,
    origin_y: int = 0,
    constrain_regions: bool = True,
) -> Image:
    """Return sparse feature art for a display that physically is the head.

    The declared regions are *seeds*, never crop or erase rectangles. After
    shell/background colours are keyed, every complete connected component
    touched by a seed survives. This lets a seed identify an eye or eyebrow
    without cutting off artwork that extends beyond the seed boundary.

    ``origin_x/y`` place a part-sized image back in rig-canvas coordinates.
    Set ``constrain_regions`` false for an already isolated part cel such as
    a mouth; its complete box survives, with only shell/skin colours keyed.
    """
    if rig.composition_mode != "features_only":
        return image

    tolerance = rig.transparent_tolerance
    keyed = bytearray(image.width * image.height)
    for y in range(image.height):
        for x in range(image.width):
            color = image.get(x, y)
            transparent_color = any(
                abs(color[0] - key[0]) <= tolerance
                and abs(color[1] - key[1]) <= tolerance
                and abs(color[2] - key[2]) <= tolerance
                for key in rig.transparent_colors
            )
            if color[3] >= 128 and not transparent_color:
                keyed[y * image.width + x] = 1

    output = Image.blank(image.width, image.height)
    if not constrain_regions:
        for y in range(image.height):
            for x in range(image.width):
                if keyed[y * image.width + x]:
                    output.put(x, y, image.get(x, y))
        return output

    visited = bytearray(image.width * image.height)
    for start in range(image.width * image.height):
        if not keyed[start] or visited[start]:
            continue

        component: list[int] = []
        stack = [start]
        visited[start] = 1
        seeded = False
        while stack:
            index = stack.pop()
            component.append(index)
            x = index % image.width
            y = index // image.width
            canvas_x = x + origin_x
            canvas_y = y + origin_y
            if any(
                region_x <= canvas_x < region_x + width
                and region_y <= canvas_y < region_y + height
                for region_x, region_y, width, height in rig.feature_regions
            ):
                seeded = True

            # Eight-way connectivity preserves diagonal pixel-art strokes.
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    if not dx and not dy:
                        continue
                    nx = x + dx
                    ny = y + dy
                    if not (0 <= nx < image.width and 0 <= ny < image.height):
                        continue
                    neighbour = ny * image.width + nx
                    if keyed[neighbour] and not visited[neighbour]:
                        visited[neighbour] = 1
                        stack.append(neighbour)

        if seeded:
            for index in component:
                x = index % image.width
                y = index // image.width
                output.put(x, y, image.get(x, y))
    return output


def _draw_line(
    image: Image,
    line: tuple[int, int, int, int],
    color: tuple[int, int, int],
    thickness: int,
) -> None:
    """Draw a hard-edged integer line suitable for authored pixel brows."""
    x0, y0, x1, y1 = line
    dx = abs(x1 - x0)
    sx = 1 if x0 < x1 else -1
    dy = -abs(y1 - y0)
    sy = 1 if y0 < y1 else -1
    error = dx + dy
    while True:
        for offset in range(thickness):
            y = y0 + offset
            if 0 <= x0 < image.width and 0 <= y < image.height:
                image.put(x0, y, (*color, 255))
        if x0 == x1 and y0 == y1:
            return
        doubled = error * 2
        if doubled >= dy:
            error += dy
            x0 += sx
        if doubled <= dx:
            error += dx
            y0 += sy


def apply_expression_brows(
    image: Image,
    rig: RigSpec,
    expression: str,
) -> Image:
    """Bake an optional expression-specific brow pose into a sprite base.

    Poses live in the avatar spec, so the result remains ordinary indexed
    sprite art on ESP32 and in WASM. Expressions not listed keep their
    artist-authored eyebrows untouched.
    """
    if rig.brow_color is None:
        return image
    pose = next(
        (
            candidate
            for slug, candidate in rig.brow_poses
            if slug == expression
        ),
        None,
    )
    if pose is None:
        return image
    output = Image(image.width, image.height, bytearray(image.rgba))
    _draw_line(output, pose.left, rig.brow_color, rig.brow_thickness)
    _draw_line(output, pose.right, rig.brow_color, rig.brow_thickness)
    return output


def normalize_portrait(
    image: Image, rig: RigSpec, num: int, den: int
) -> Image:
    """Register art on the canvas at the shared scale: the dominant
    component is centered horizontally with its bottom on the baseline.
    Feature-only faces instead register the complete feature group because
    their eyes, brows, and mouth are deliberately disconnected."""
    art, _, _ = trim(image)
    if rig.composition_mode == "features_only":
        mx0, my0, mx1, my1 = (0, 0, art.width - 1, art.height - 1)
    else:
        mx0, my0, mx1, my1 = _main_component_bbox(art)
    full_w = max(1, art.width * num // den)
    full_h = max(1, art.height * num // den)
    scaled = nn_scale(art, full_w, full_h)
    smx0 = mx0 * num // den
    smx1 = (mx1 + 1) * num // den
    smy1 = (my1 + 1) * num // den
    canvas = Image.blank(rig.canvas[0], rig.canvas[1])
    x0 = rig.canvas[0] // 2 - (smx0 + smx1) // 2
    y0 = rig.baseline_y - smy1
    _paste(canvas, scaled, x0, y0)
    return canvas


def normalize_mouth(
    image: Image, rig: RigSpec, num: int, den: int
) -> Image:
    """Center a mouth cel in the rig's mouth box at the shared scale.

    Cels keep their authored size relative to the face; a cel larger than
    the box is downscaled to fit as a last resort (recorded by the caller
    via the returned size check)."""
    art, _, _ = trim(image)
    box_w, box_h = rig.mouth_box[2], rig.mouth_box[3]
    dst_w = max(1, art.width * num // den)
    dst_h = max(1, art.height * num // den)
    if dst_w > box_w or dst_h > box_h:
        dst_w, dst_h = fit_size(dst_w, dst_h, box_w, box_h)
    scaled = nn_scale(art, dst_w, dst_h)
    cell = Image.blank(box_w, box_h)
    _paste(cell, scaled, (box_w - dst_w) // 2, (box_h - dst_h) // 2)
    return cell


def _ring_skin(
    image: Image, box: tuple[int, int, int, int], thickness: int = 2
) -> tuple[int, int, int] | None:
    """Representative skin color from a ring around the box.

    The ring mixes face color with dark outline strokes (chins, paws,
    brows). Among 16-level buckets holding at least 15% of the ring, the
    brightest one is the face; a plain mode would happily pick an outline
    and flood the erase box dark.
    """
    x0, y0, w, h = box
    counts: dict[tuple[int, int, int], int] = {}
    sums: dict[tuple[int, int, int], list[int]] = {}
    ring_total = 0
    for y in range(y0 - thickness, y0 + h + thickness):
        for x in range(x0 - thickness, x0 + w + thickness):
            inside = x0 <= x < x0 + w and y0 <= y < y0 + h
            if inside or not (
                0 <= x < image.width and 0 <= y < image.height
            ):
                continue
            r, g, b, a = image.get(x, y)
            if a < 128:
                continue
            ring_total += 1
            key = (r >> 4, g >> 4, b >> 4)
            counts[key] = counts.get(key, 0) + 1
            total = sums.setdefault(key, [0, 0, 0])
            total[0] += r
            total[1] += g
            total[2] += b
    if not counts:
        return None
    floor = max(1, ring_total * 3 // 20)
    candidates = [k for k, count in counts.items() if count >= floor]
    if not candidates:
        candidates = list(counts)
    best = max(
        candidates,
        key=lambda k: (299 * k[0] + 587 * k[1] + 114 * k[2], counts[k], k),
    )
    total = sums[best]
    n = counts[best]
    return (total[0] // n, total[1] // n, total[2] // n)


def erase_mouth(canvas: Image, rig: RigSpec) -> bool:
    """Paint out the baked mouth with the surrounding skin color.

    Only pixels that differ clearly from the surround are replaced, so
    shading inside the box survives; returns False when no surround color
    could be sampled.
    """
    if rig.composition_mode == "features_only":
        x0, y0, w, h = rig.mouth_erase_box
        changed = False
        for y in range(y0, min(canvas.height, y0 + h)):
            for x in range(x0, min(canvas.width, x0 + w)):
                if canvas.get(x, y)[3]:
                    changed = True
                canvas.put(x, y, (0, 0, 0, 0))
        return changed
    surround = _ring_skin(canvas, rig.mouth_erase_box)
    if surround is None:
        return False
    x0, y0, w, h = rig.mouth_erase_box
    for y in range(y0, y0 + h):
        for x in range(x0, x0 + w):
            if not (0 <= x < canvas.width and 0 <= y < canvas.height):
                continue
            r, g, b, a = canvas.get(x, y)
            if a < 128:
                continue
            if (
                max(
                    abs(r - surround[0]),
                    abs(g - surround[1]),
                    abs(b - surround[2]),
                )
                > ERASE_TOLERANCE
            ):
                canvas.put(x, y, (*surround, 255))
    return True


def _shade(color: tuple[int, int, int], percent: int) -> tuple[int, int, int]:
    return tuple(min(255, channel * percent // 100) for channel in color)


def synth_lids(
    neutral: Image, box: tuple[int, int, int, int]
) -> tuple[Image, Image]:
    """(half, closed) lid cells sized to the eye box.

    The lid uses the modal color surrounding the eye on the neutral portrait
    so it reads as skin/fur, with a slightly darker lash edge.
    """
    skin = _ring_skin(neutral, box) or (128, 128, 128)
    lash = _shade(skin, 62)
    w, h = box[2], box[3]
    # Integer ellipse test in doubled coordinates, expanded ~4% so the lid
    # fully covers the eye art it replaces.
    limit = w * w * h * h * 27 // 25

    def inside(x: int, y: int) -> bool:
        dx = 2 * x - (w - 1)
        dy = 2 * y - (h - 1)
        return dx * dx * h * h + dy * dy * w * w <= limit

    half = Image.blank(w, h)
    closed = Image.blank(w, h)
    half_rows = (h + 1) // 2
    for y in range(h):
        for x in range(w):
            if not inside(x, y):
                continue
            closed.put(x, y, (*skin, 255))
            if y < half_rows:
                half.put(x, y, (*skin, 255))
    for x in range(w):
        lash_half = half_rows - 1
        if inside(x, lash_half):
            half.put(x, lash_half, (*lash, 255))
        for y in range(h - 1, -1, -1):
            if inside(x, y):
                closed.put(x, y, (*lash, 255))
                break
    return half, closed
