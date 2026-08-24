"""Catalog and target assembly: canvas-space parts -> per-target atlases.

The canvas-space catalog (portrait per expression, mouth cel per authored
slot, synthesized lids, transparent overlay) is target-neutral. Each device
target derives its own raster cells by nearest-neighbour transforming the
indexed art and anchors with one shared rational scale, so registration is
preserved exactly and the palette never changes across targets.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .quantize import IndexedCell, Palette, TRANSPARENT
from .spec import CharacterSpec, TargetSpec
from .util import packbits
from .vocab import (
    CANONICAL_BY_SLUG,
    CELL_NONE,
    MOUTH_SLOT_NAMES,
    ExpressionTarget,
    build_viseme_map,
    fill_mouth_slots,
    resolve_fallback_slots,
)


@dataclass
class CanvasCatalog:
    """Target-neutral indexed art in rig-canvas coordinates."""

    spec: CharacterSpec
    palette: Palette
    portraits: dict[str, IndexedCell]  # expression slug -> canvas-size cell
    mouths: dict[int, IndexedCell]  # slot index -> mouth-box-size cell
    expression_mouths: dict[str, IndexedCell]  # authored rest pose per bank
    lids: dict[str, IndexedCell]  # "half_left" etc -> eye-box-size cell
    notes: list[str] = field(default_factory=list)


@dataclass
class AtlasCell:
    width: int
    height: int
    offset_x: int
    offset_y: int
    raw: bytes  # trimmed palette indices, row-major
    data: bytes  # encoded payload placed in the blob
    encoding: int  # 0 raw, 1 packbits
    names: list[str]


@dataclass
class EyeLayer:
    x: int
    y: int
    cells: list[int]  # ordered fully open -> fully closed; may be empty


@dataclass
class Bank:
    slug: str
    target: ExpressionTarget
    base_cell: int
    overlay_cell: int
    mouth_x: int
    mouth_y: int
    mouth_array: int  # index into TargetAtlas.mouth_arrays
    eye_left: EyeLayer
    eye_right: EyeLayer


@dataclass
class TargetAtlas:
    spec: CharacterSpec
    target: TargetSpec
    prefix: str
    symbol: str
    palette: Palette
    cells: list[AtlasCell]
    blob: bytes
    cell_offsets: list[int]
    mouth_arrays: list[list[int]]  # each exactly len(MOUTH_SLOT_NAMES)
    mouth_sources: list[int]  # authored slot borrowed per slot
    banks: list[Bank]
    viseme_map: list[tuple[int, int, int, int]]
    fallback_slots: list[int]
    flags: list[str]
    canvas: tuple[int, int]
    notes: list[str]

    @property
    def flash_bytes(self) -> int:
        """Portable payload: blob + palette + cells + mouth maps + visemes."""
        shared = (
            len(self.blob)
            + len(self.palette.entries()) * 2
            + len(self.cells) * 20
            + len(self.mouth_arrays) * len(MOUTH_SLOT_NAMES) * 2
            + len(self.viseme_map) * 4
        )
        # Variants share every byte of geometry and animation data. Each adds
        # only an RGB565 palette and a small flash-resident atlas descriptor.
        variants = len(self.spec.palette.variants) * (
            len(self.palette.entries()) * 2 + 128
        )
        return shared + variants


class _CellTable:
    def __init__(self) -> None:
        self.cells: list[AtlasCell] = []
        self.lookup: dict[tuple[int, int, int, int, bytes], int] = {}

    def add(self, name: str, cell: IndexedCell) -> int:
        """Trim to visible bounds, dedupe, and encode."""
        width, height = cell.width, cell.height
        indices = cell.indices
        min_x, min_y = width, height
        max_x = max_y = -1
        for y in range(height):
            row = y * width
            for x in range(width):
                if indices[row + x] != TRANSPARENT:
                    if x < min_x:
                        min_x = x
                    if x > max_x:
                        max_x = x
                    if y < min_y:
                        min_y = y
                    if y > max_y:
                        max_y = y
        if max_x < 0:
            trimmed = bytes((TRANSPARENT,))
            box = (1, 1, 0, 0)
        else:
            w = max_x - min_x + 1
            h = max_y - min_y + 1
            trimmed = b"".join(
                bytes(indices[row * width + min_x : row * width + min_x + w])
                for row in range(min_y, max_y + 1)
            )
            box = (w, h, min_x, min_y)
        key = (*box, trimmed)
        existing = self.lookup.get(key)
        if existing is not None:
            self.cells[existing].names.append(name)
            return existing
        encoded = packbits(trimmed)
        encoding = 1
        if len(encoded) >= len(trimmed):
            encoded = trimmed
            encoding = 0
        index = len(self.cells)
        self.cells.append(
            AtlasCell(
                width=box[0],
                height=box[1],
                offset_x=box[2],
                offset_y=box[3],
                raw=trimmed,
                data=encoded,
                encoding=encoding,
                names=[name],
            )
        )
        self.lookup[key] = index
        return index


def _transform_point(
    value: int, num: int, den: int, offset: int
) -> int:
    return value * num // den + offset


def _transform_box(
    box: tuple[int, int, int, int],
    num: int,
    den: int,
    off_x: int,
    off_y: int,
) -> tuple[int, int, int, int]:
    x0 = _transform_point(box[0], num, den, off_x)
    y0 = _transform_point(box[1], num, den, off_y)
    x1 = _transform_point(box[0] + box[2], num, den, off_x)
    y1 = _transform_point(box[1] + box[3], num, den, off_y)
    return (x0, y0, max(1, x1 - x0), max(1, y1 - y0))


def _scale_indexed(
    cell: IndexedCell, dst_w: int, dst_h: int
) -> IndexedCell:
    if dst_w == cell.width and dst_h == cell.height:
        return cell
    out = bytearray(dst_w * dst_h)
    for y in range(dst_h):
        sy = y * cell.height // dst_h
        row = sy * cell.width
        drow = y * dst_w
        for x in range(dst_w):
            out[drow + x] = cell.indices[row + x * cell.width // dst_w]
    return IndexedCell(cell.name, dst_w, dst_h, out)


def _target_geometry(
    spec: CharacterSpec, target: TargetSpec
) -> tuple[int, int, int, int]:
    """(num, den, off_x, off_y) mapping rig canvas -> target canvas."""
    rig_w, rig_h = spec.rig.canvas
    inner_w = target.canvas[0] - 2 * target.margin
    inner_h = target.canvas[1] - 2 * target.margin
    if inner_w * rig_h <= inner_h * rig_w:
        num, den = inner_w, rig_w
    else:
        num, den = inner_h, rig_h
    if target.framing == "face_fill" and num > den:
        # face_fill never upscales the rig; scale=2 handles enlargement.
        num, den = 1, 1
    scaled_w = rig_w * num // den
    scaled_h = rig_h * num // den
    off_x = target.margin + (inner_w - scaled_w) // 2
    off_y = target.margin + (inner_h - scaled_h) // 2
    return num, den, max(0, off_x), max(0, off_y)


def _identifier(text: str) -> str:
    return "".join(c if c.isalnum() else "_" for c in text)


def assemble_target(
    catalog: CanvasCatalog, target: TargetSpec
) -> TargetAtlas:
    spec = catalog.spec
    num, den, off_x, off_y = _target_geometry(spec, target)
    notes = list(catalog.notes)
    if (num, den) != (1, 1):
        notes.append(
            f"target {target.id}: rig scaled by {num}/{den} "
            f"with offset ({off_x}, {off_y})"
        )

    table = _CellTable()
    transparent_cell = table.add(
        "transparent",
        IndexedCell("transparent", 1, 1, bytearray(1)),
    )

    # Portraits occupy the full rig canvas at (0, 0); paste each scaled
    # portrait into a target-canvas-sized cell so trim offsets come out in
    # target coordinates and deduplication stays safe.
    canvas_box = (0, 0, *spec.rig.canvas)
    dst_canvas = _transform_box(canvas_box, num, den, off_x, off_y)
    base_cells: dict[str, int] = {}
    for slug, portrait in catalog.portraits.items():
        scaled = _scale_indexed(portrait, dst_canvas[2], dst_canvas[3])
        placed = IndexedCell(
            portrait.name,
            target.canvas[0],
            target.canvas[1],
            bytearray(target.canvas[0] * target.canvas[1]),
        )
        for y in range(scaled.height):
            src_row = y * scaled.width
            dst_row = (y + dst_canvas[1]) * placed.width + dst_canvas[0]
            placed.indices[dst_row : dst_row + scaled.width] = (
                scaled.indices[src_row : src_row + scaled.width]
            )
        base_cells[slug] = table.add(f"base_{slug}", placed)

    mouth_box = _transform_box(spec.rig.mouth_box, num, den, off_x, off_y)
    authored_slots: dict[int, int] = {}
    for slot, mouth in sorted(catalog.mouths.items()):
        scaled = _scale_indexed(mouth, mouth_box[2], mouth_box[3])
        authored_slots[slot] = table.add(
            f"mouth_{MOUTH_SLOT_NAMES[slot]}", scaled
        )

    slot_cells, slot_sources = fill_mouth_slots(authored_slots)
    fallback = resolve_fallback_slots(set(authored_slots))
    mouth_arrays: list[list[int]] = []
    mouth_array_lookup: dict[tuple[int, ...], int] = {}

    def mouth_array_for(slug: str) -> int:
        slots = list(slot_cells)
        authored_rest = catalog.expression_mouths.get(slug)
        if authored_rest is not None:
            scaled = _scale_indexed(
                authored_rest, mouth_box[2], mouth_box[3]
            )
            slots[0] = table.add(f"mouth_rest_{slug}", scaled)
        key = tuple(slots)
        existing = mouth_array_lookup.get(key)
        if existing is not None:
            return existing
        index = len(mouth_arrays)
        mouth_arrays.append(slots)
        mouth_array_lookup[key] = index
        return index

    def eye_layer(side: str) -> EyeLayer:
        box = spec.rig.eye_left if side == "left" else spec.rig.eye_right
        if box is None or spec.rig.blink != "synth":
            return EyeLayer(0, 0, [])
        dst_box = _transform_box(box, num, den, off_x, off_y)
        half = catalog.lids[f"half_{side}"]
        closed = catalog.lids[f"closed_{side}"]
        half_cell = table.add(
            f"lid_half_{side}",
            _scale_indexed(half, dst_box[2], dst_box[3]),
        )
        closed_cell = table.add(
            f"lid_closed_{side}",
            _scale_indexed(closed, dst_box[2], dst_box[3]),
        )
        return EyeLayer(
            dst_box[0], dst_box[1], [transparent_cell, half_cell, closed_cell]
        )

    eye_left = eye_layer("left")
    eye_right = eye_layer("right")

    banks: list[Bank] = []
    for slug in spec.expressions:
        if slug not in base_cells:
            continue
        banks.append(
            Bank(
                slug=slug,
                target=CANONICAL_BY_SLUG[slug],
                base_cell=base_cells[slug],
                overlay_cell=transparent_cell,
                mouth_x=mouth_box[0],
                mouth_y=mouth_box[1],
                mouth_array=mouth_array_for(slug),
                eye_left=eye_left,
                eye_right=eye_right,
            )
        )
    if not banks:
        raise ValueError("no expression banks were authored")
    if banks[0].slug != "neutral" and "neutral" in base_cells:
        # Bank zero is the neutral fallback in the player.
        neutral = next(b for b in banks if b.slug == "neutral")
        banks.remove(neutral)
        banks.insert(0, neutral)

    blob = bytearray()
    offsets: list[int] = []
    for cell in table.cells:
        offsets.append(len(blob))
        blob.extend(cell.data)

    flags = list(spec.flags)
    if "idle_saccades" in flags:
        # No pupil layers are authored, so saccades would be invisible.
        flags.remove("idle_saccades")
        notes.append("idle_saccades flag dropped: atlas has no pupil layers")
    if spec.rig.blink == "synth":
        # Lid cells were just authored above, so the player's deterministic
        # idle blink is real motion. Default it on: a character that pays for
        # a blink rig should not also have to request the flag that shows it.
        if "auto_blink" not in flags:
            flags.append("auto_blink")
    elif "auto_blink" in flags:
        flags.remove("auto_blink")
        notes.append("auto_blink flag dropped: no lid cells authored")

    prefix = _identifier(f"fspp_{spec.id}_{target.id}")
    return TargetAtlas(
        spec=spec,
        target=target,
        prefix=prefix,
        symbol=f"face_sprite_{prefix}_atlas",
        palette=catalog.palette,
        cells=table.cells,
        blob=bytes(blob),
        cell_offsets=offsets,
        mouth_arrays=mouth_arrays,
        mouth_sources=slot_sources,
        banks=banks,
        viseme_map=build_viseme_map(),
        fallback_slots=fallback,
        flags=flags,
        canvas=target.canvas,
        notes=notes,
    )
