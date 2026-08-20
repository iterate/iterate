"""Reference compositor and preview sheets.

A small Python mirror of face_sprite_render()'s painter order (background,
base, lids, mouth, overlay) used for three things: human-reviewable contact
sheets at native and enlarged scales, clipping analysis, and pixel evidence
in the validation report. It intentionally performs no idle motion; poses
are explicit.
"""

from __future__ import annotations

from .catalog import Bank, TargetAtlas
from .png_io import Image
from .util import unpackbits


def _cell_indices(atlas: TargetAtlas, cell_index: int) -> bytes:
    cell = atlas.cells[cell_index]
    if cell.encoding == 1:
        return unpackbits(cell.data, cell.width * cell.height)
    return cell.data


def _blit(
    frame: Image,
    atlas: TargetAtlas,
    cell_index: int,
    origin_x: int,
    origin_y: int,
    palette_rgb: list[tuple[int, int, int]],
) -> None:
    cell = atlas.cells[cell_index]
    indices = _cell_indices(atlas, cell_index)
    for y in range(cell.height):
        for x in range(cell.width):
            value = indices[y * cell.width + x]
            if value == 0:
                continue
            frame.put(
                origin_x + cell.offset_x + x,
                origin_y + cell.offset_y + y,
                (*palette_rgb[value], 255),
            )


def render_pose(
    atlas: TargetAtlas,
    bank: Bank,
    mouth_slot: int,
    lid_stage: int,
    background: tuple[int, int, int] | None = None,
    palette_rgb: list[tuple[int, int, int]] | None = None,
) -> Image:
    """One deterministic frame at the atlas's native (unscaled) canvas."""
    width, height = atlas.canvas
    frame = Image.blank(width, height)
    if background is not None:
        for i in range(width * height):
            frame.rgba[i * 4 : i * 4 + 4] = bytes((*background, 255))
    if palette_rgb is None:
        palette_rgb = atlas.palette.entries()
    _blit(frame, atlas, bank.base_cell, 0, 0, palette_rgb)
    for eye in (bank.eye_left, bank.eye_right):
        if eye.cells:
            stage = min(lid_stage, len(eye.cells) - 1)
            _blit(frame, atlas, eye.cells[stage], eye.x, eye.y, palette_rgb)
    mouth_cell = atlas.mouth_arrays[bank.mouth_array][mouth_slot]
    _blit(frame, atlas, mouth_cell, bank.mouth_x, bank.mouth_y, palette_rgb)
    _blit(frame, atlas, bank.overlay_cell, 0, 0, palette_rgb)
    return frame


def upscale(image: Image, factor: int) -> Image:
    out = Image.blank(image.width * factor, image.height * factor)
    for y in range(out.height):
        sy = y // factor
        for x in range(out.width):
            si = (sy * image.width + x // factor) * 4
            di = (y * out.width + x) * 4
            out.rgba[di : di + 4] = image.rgba[si : si + 4]
    return out


def sheet(
    frames: list[Image], columns: int, padding: int = 2
) -> Image:
    if not frames:
        raise ValueError("no frames to sheet")
    cell_w = max(f.width for f in frames)
    cell_h = max(f.height for f in frames)
    rows = (len(frames) + columns - 1) // columns
    out = Image.blank(
        columns * (cell_w + padding) + padding,
        rows * (cell_h + padding) + padding,
        (24, 24, 24, 255),
    )
    for index, frame in enumerate(frames):
        gx = padding + (index % columns) * (cell_w + padding)
        gy = padding + (index // columns) * (cell_h + padding)
        for y in range(frame.height):
            for x in range(frame.width):
                out.put(gx + x, gy + y, frame.get(x, y))
    return out


def expression_sheet(
    atlas: TargetAtlas,
    background: tuple[int, int, int],
    scale: int,
    palette_rgb: list[tuple[int, int, int]] | None = None,
) -> Image:
    frames = [
        upscale(
            render_pose(atlas, bank, mouth_slot=0, lid_stage=0,
                        background=background, palette_rgb=palette_rgb),
            scale,
        )
        for bank in atlas.banks
    ]
    return sheet(frames, columns=min(6, len(frames)))


def mouth_sheet(
    atlas: TargetAtlas,
    background: tuple[int, int, int],
    scale: int,
    palette_rgb: list[tuple[int, int, int]] | None = None,
) -> Image:
    bank = atlas.banks[0]
    frames = [
        upscale(
            render_pose(atlas, bank, mouth_slot=slot, lid_stage=0,
                        background=background, palette_rgb=palette_rgb),
            scale,
        )
        for slot in range(len(atlas.mouth_arrays[bank.mouth_array]))
    ]
    return sheet(frames, columns=6)


def blink_sheet(
    atlas: TargetAtlas,
    background: tuple[int, int, int],
    scale: int,
    palette_rgb: list[tuple[int, int, int]] | None = None,
) -> Image:
    bank = atlas.banks[0]
    frames = [
        upscale(
            render_pose(atlas, bank, mouth_slot=0, lid_stage=stage,
                        background=background, palette_rgb=palette_rgb),
            scale,
        )
        for stage in (0, 1, 2)
    ]
    return sheet(frames, columns=3)
