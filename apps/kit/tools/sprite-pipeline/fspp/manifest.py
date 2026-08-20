"""Target-neutral and per-target manifests.

The manifest is the browser/WASM-facing description of the same atlas the C
tables encode: palette in both RGB888 and RGB565, the shared blob as base64,
per-cell geometry, banks, viseme maps, and fallback provenance, plus content
hashes so a consumer can prove it renders the identical asset.
"""

from __future__ import annotations

import base64

from . import PIPELINE_NAME, PIPELINE_VERSION
from .catalog import Bank, EyeLayer, TargetAtlas
from .util import rgb565, sha256_bytes
from .vocab import (
    MOUTH_ROLE_NAMES,
    MOUTH_ROLES,
    MOUTH_SLOT_NAMES,
    VISEME_SET_NAMES,
)


def _hex_color(color: tuple[int, int, int]) -> str:
    return "#{:02x}{:02x}{:02x}".format(*color)


def _identifier(text: str) -> str:
    return "".join(character if character.isalnum() else "_" for character in text)


def _eye_json(eye: EyeLayer) -> dict:
    return {"x": eye.x, "y": eye.y, "cells": list(eye.cells)}


def _bank_json(bank: Bank) -> dict:
    target = bank.target
    return {
        "slug": bank.slug,
        "target": {
            "valence": target.valence,
            "arousal": target.arousal,
            "mouth_corner": target.mouth_corner,
            "brow_inner": target.brow_inner,
            "eye_squint": target.eye_squint,
        },
        "base_cell": bank.base_cell,
        "overlay_cell": bank.overlay_cell,
        "mouth": {
            "x": bank.mouth_x,
            "y": bank.mouth_y,
            "array": bank.mouth_array,
        },
        "eye_left": _eye_json(bank.eye_left),
        "eye_right": _eye_json(bank.eye_right),
    }


def target_manifest(
    atlas: TargetAtlas,
    background_565: int,
    provenance: dict,
) -> dict:
    palette = atlas.palette
    slot_json = []
    for slot, name in enumerate(MOUTH_SLOT_NAMES):
        source = atlas.mouth_sources[slot]
        slot_json.append(
            {
                "slot": slot,
                "name": name,
                "role": MOUTH_ROLE_NAMES[MOUTH_ROLES[slot]],
                "authored": source == slot,
                "borrowed_from": (
                    None if source == slot else MOUTH_SLOT_NAMES[source]
                ),
            }
        )
    return {
        "schema_version": 1,
        "generator": {"name": PIPELINE_NAME, "version": PIPELINE_VERSION},
        "id": atlas.spec.id,
        "display_name": atlas.spec.display_name,
        "license": atlas.spec.license,
        "target": {
            "id": atlas.target.id,
            "framing": atlas.target.framing,
            "canvas": list(atlas.canvas),
            "scale": atlas.target.scale,
            "frame": list(atlas.target.frame),
            "margin": atlas.target.margin,
            "display_pixels": [
                atlas.canvas[0] * atlas.target.scale,
                atlas.canvas[1] * atlas.target.scale,
            ],
            "max_flash_bytes": atlas.target.max_flash_bytes,
        },
        "format": {
            "container": "face_sprite_atlas_t",
            "magic": "FSPR",
            "version": 2,
            "pixel_format": "indexed8+RGB565-palette",
            "transparent_index": 0,
            "encodings": ["raw", "packbits"],
        },
        "ir": {
            "keyframe_bytes": 12,
            "render_key_bytes": 40,
            "render_key_schema_version": 2,
            "sample_clock_hz": 16000,
            "viseme_sets": {
                name: value
                for value, name in sorted(
                    (v, n) for v, n in VISEME_SET_NAMES.items()
                )
            },
        },
        "background_565": background_565,
        "palette": {
            "transparent_index": 0,
            "rgb888": [_hex_color(c) for c in palette.entries()],
            "rgb565": palette.entries_565(),
            "merged_after_565": palette.merged_565,
            "variants": [
                {
                    "id": variant.id,
                    "display_name": variant.display_name,
                    "background_rgb888": _hex_color(variant.background),
                    "background_rgb565": rgb565(variant.background),
                    "rgb888": ["#000000"]
                    + [_hex_color(color) for color in variant.colors],
                    "rgb565": [0]
                    + [rgb565(color) for color in variant.colors],
                    "c_symbol": (
                        f"{atlas.symbol}_{_identifier(variant.id)}"
                    ),
                }
                for variant in atlas.spec.palette.variants
            ],
        },
        "cells": [
            {
                "index": index,
                "names": cell.names,
                "width": cell.width,
                "height": cell.height,
                "offset_x": cell.offset_x,
                "offset_y": cell.offset_y,
                "encoding": "packbits" if cell.encoding else "raw",
                "blob_offset": offset,
                "blob_length": len(cell.data),
                "raw_sha256": sha256_bytes(cell.raw),
            }
            for index, (cell, offset) in enumerate(
                zip(atlas.cells, atlas.cell_offsets)
            )
        ],
        "blob_base64": base64.b64encode(atlas.blob).decode("ascii"),
        "blob_sha256": sha256_bytes(atlas.blob),
        "mouth_slots": slot_json,
        "mouth_arrays": [list(a) for a in atlas.mouth_arrays],
        "fallback_slots": list(atlas.fallback_slots),
        "banks": [_bank_json(bank) for bank in atlas.banks],
        "viseme_map": [
            {
                "set": VISEME_SET_NAMES.get(viseme_set, str(viseme_set)),
                "set_id": viseme_set,
                "viseme": viseme,
                "slot": slot,
                "role": MOUTH_ROLE_NAMES[role],
            }
            for viseme_set, viseme, slot, role in atlas.viseme_map
        ],
        "flags": list(atlas.flags),
        "c_symbol": atlas.symbol,
        "stats": {
            "cell_count": len(atlas.cells),
            "palette_count": len(palette.entries()),
            "bank_count": len(atlas.banks),
            "blob_bytes": len(atlas.blob),
            "flash_bytes": atlas.flash_bytes,
        },
        "notes": list(atlas.notes),
        "provenance": provenance,
    }
