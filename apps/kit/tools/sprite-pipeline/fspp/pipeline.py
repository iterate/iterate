"""Assembly-line orchestration.

compute() is a pure function from (spec, sheet bytes) to a flat artifact
dictionary; build() writes those artifacts to disk. Determinism is proven by
running compute() twice and comparing every artifact hash, which the CLI and
tests both do.

Stage order: ingest -> key background -> segment -> snap (global pitch,
per-cell phase) -> normalize onto the rig -> quantize -> catalog ->
per-target assembly -> emit C + manifest + previews -> validate.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

from . import PIPELINE_NAME, PIPELINE_VERSION
from .catalog import CanvasCatalog, assemble_target
from .emit_c import emit_atlas_c, emit_atlas_h
from .manifest import target_manifest
from .png_io import Image, decode, encode_rgba, hash_rgba
from .previews import blink_sheet, expression_sheet, mouth_sheet
from .quantize import IndexedCell, build_palette, despeckle, map_cell
from .raster import apply_mask, key_background
from .rig import (
    apply_expression_brows,
    erase_mouth,
    isolate_features,
    normalize_mouth,
    normalize_portrait,
    shared_scale,
    synth_lids,
    trim,
)
from .segment import CellBox, segment
from .snap import Axis, detect_grid, phase_for_pitch, snap
from .spec import CharacterSpec, load_spec
from .util import canonical_json, rgb565, sha256_bytes
from .validate import Gate, PASS, WARN, FAIL, validate_target, worst
from .vocab import MOUTH_SLOT_NAMES

PREVIEW_TARGET_HEIGHT = 240


@dataclass
class BuildOutput:
    spec: CharacterSpec
    artifacts: dict[str, bytes]
    debug: dict[str, bytes]
    report: dict
    status: str
    notes: list[str] = field(default_factory=list)

    def artifact_hashes(self) -> dict[str, str]:
        return {
            name: sha256_bytes(data)
            for name, data in sorted(self.artifacts.items())
        }


def _median(values: list[int]) -> int:
    ordered = sorted(values)
    return ordered[len(ordered) // 2]


def _resolve_global_pitch(
    crops: dict[str, Image], spec: CharacterSpec
) -> tuple[int, dict]:
    """One sheet-wide pitch from per-cell estimates (phase stays local)."""
    grid = spec.source.pixel_grid
    if grid == "none":
        return 1, {"mode": "disabled"}
    if isinstance(grid, int):
        return grid, {"mode": "explicit", "pitch": grid}
    votes: list[int] = []
    evidence = {}
    for name, crop in sorted(crops.items()):
        x_axis, y_axis = detect_grid(crop)
        evidence[name] = {
            "x": [x_axis.pitch, x_axis.phase, x_axis.confidence],
            "y": [y_axis.pitch, y_axis.phase, y_axis.confidence],
        }
        for axis in (x_axis, y_axis):
            if axis.pitch > 1:
                votes.append(axis.pitch)
    pitch = _median(votes) if votes else 1
    return pitch, {
        "mode": "auto",
        "pitch": pitch,
        "votes": len(votes),
        "cells": evidence,
    }


def _resolve_mouth_mode(
    spec: CharacterSpec, raw_mouths: dict[str, Image], scale_evidence: dict
) -> str:
    """Decide whether mouth cells are isolated cels or full-face studies.

    Image models often draw mouth variants on complete heads; a cel whose
    art is a sizeable fraction of the portrait body must be a face, and its
    mouth region is cropped after portrait-style registration.
    """
    if spec.rig.mouth_source != "auto":
        return spec.rig.mouth_source
    if not raw_mouths:
        return "isolated"
    body_w, body_h = scale_evidence["median_body"]
    sizes = []
    for _, art in sorted(raw_mouths.items()):
        trimmed, _, _ = trim(art)
        sizes.append(trimmed.width * trimmed.height)
    median_size = sorted(sizes)[len(sizes) // 2]
    if median_size * 5 >= body_w * body_h * 2:
        return "face_crop"
    return "isolated"


def _snap_cell(crop: Image, pitch: int) -> Image:
    if pitch <= 1:
        return crop
    x_axis = phase_for_pitch(crop, 0, pitch)
    y_axis = phase_for_pitch(crop, 1, pitch)
    return snap(crop, x_axis, y_axis)


def _segmentation_overlay(
    keyed: Image, boxes: list[CellBox]
) -> Image:
    overlay = Image(keyed.width, keyed.height, bytearray(keyed.rgba))
    accent = (255, 64, 192, 255)
    for box in boxes:
        for x in range(box.x, box.x + box.w):
            overlay.put(x, box.y, accent)
            overlay.put(x, box.y + box.h - 1, accent)
        for y in range(box.y, box.y + box.h):
            overlay.put(box.x, y, accent)
            overlay.put(box.x + box.w - 1, y, accent)
    return overlay


def compute(
    spec: CharacterSpec, sheet_bytes: bytes, sheet_label: str
) -> BuildOutput:
    notes: list[str] = []
    debug: dict[str, bytes] = {}
    artifacts: dict[str, bytes] = {}
    gates: list[Gate] = []

    image = decode(sheet_bytes)
    mask, background = key_background(
        image, spec.source.background, spec.source.background_tolerance
    )
    foreground = sum(mask)
    gates.append(
        Gate(
            "background_key",
            PASS if 0 < foreground < image.width * image.height else FAIL,
            {
                "background_rgb": list(background),
                "foreground_pixels": foreground,
                "total_pixels": image.width * image.height,
            },
        )
    )
    keyed = apply_mask(image, mask)

    boxes = segment(mask, image.width, image.height, spec.layout)
    gates.append(
        Gate(
            "segmentation",
            PASS,
            {
                "cells": {
                    box.name: [box.x, box.y, box.w, box.h] for box in boxes
                }
            },
        )
    )
    debug["segmentation.png"] = encode_rgba(
        _segmentation_overlay(keyed, boxes)
    )

    crops = {
        box.name: keyed.crop(box.x, box.y, box.w, box.h) for box in boxes
    }
    pitch, grid_evidence = _resolve_global_pitch(crops, spec)
    gates.append(
        Gate(
            "grid_snap",
            PASS if pitch >= 1 else FAIL,
            {"pitch": pitch, "evidence": grid_evidence},
        )
    )
    snapped = {
        name: _snap_cell(crop, pitch) for name, crop in sorted(crops.items())
    }
    if pitch > 1:
        for name, cell in sorted(snapped.items()):
            debug[f"snapped/{name}.png"] = encode_rgba(cell)

    roles = {box.name: box.role for box in boxes}
    raw_portraits = {
        name: art
        for name, art in snapped.items()
        if roles[name] == "expression"
    }
    raw_mouths = {
        name: art
        for name, art in snapped.items()
        if roles[name] == "mouth"
    }
    num, den, scale_evidence = shared_scale(raw_portraits, spec.rig)
    gates.append(
        Gate(
            "shared_scale",
            PASS,
            {"scale": [num, den], "evidence": scale_evidence},
        )
    )
    mouth_mode = _resolve_mouth_mode(spec, raw_mouths, scale_evidence)
    gates.append(Gate("mouth_source", PASS, {"mode": mouth_mode}))

    portraits_rgba: dict[str, Image] = {}
    mouths_rgba: dict[str, Image] = {}
    for name, art in sorted(raw_portraits.items()):
        portraits_rgba[name] = normalize_portrait(art, spec.rig, num, den)
    box = spec.rig.mouth_box
    for name, art in sorted(raw_mouths.items()):
        if mouth_mode == "face_crop":
            # Mouth-study cells are whole faces; register them exactly
            # like portraits, then lift the rig's mouth box out of them.
            face = normalize_portrait(art, spec.rig, num, den)
            mouths_rgba[name] = face.crop(box[0], box[1], box[2], box[3])
        else:
            mouths_rgba[name] = normalize_mouth(art, spec.rig, num, den)

    # Preserve each full-portrait expression's authored resting mouth before
    # the replaceable region is erased. Feature-only rigs deliberately keep
    # the expression sheet and mouth sheet independent: their disconnected
    # features do not share a reliable portrait-relative crop, and the
    # explicit `sil` cel is the clean, visible resting mouth for every bank.
    expression_mouths_rgba: dict[str, Image] = {}
    if (
        spec.rig.mouth_erase
        and mouths_rgba
        and spec.rig.composition_mode != "features_only"
    ):
        expression_mouths_rgba = {
            name: canvas.crop(box[0], box[1], box[2], box[3])
            for name, canvas in sorted(portraits_rgba.items())
        }

    erased = []
    if spec.rig.mouth_erase and mouths_rgba:
        for name, canvas in sorted(portraits_rgba.items()):
            if erase_mouth(canvas, spec.rig):
                erased.append(name)
    if spec.rig.mouth_erase and not mouths_rgba:
        notes.append("mouth erase skipped: no replaceable mouth cels")

    if spec.rig.composition_mode == "features_only":
        portraits_rgba = {
            name: isolate_features(canvas, spec.rig)
            for name, canvas in sorted(portraits_rgba.items())
        }
        mouths_rgba = {
            name: isolate_features(
                art,
                spec.rig,
                spec.rig.mouth_box[0],
                spec.rig.mouth_box[1],
                constrain_regions=False,
            )
            for name, art in sorted(mouths_rgba.items())
        }
        expression_mouths_rgba = {
            name: isolate_features(
                art,
                spec.rig,
                spec.rig.mouth_box[0],
                spec.rig.mouth_box[1],
                constrain_regions=False,
            )
            for name, art in sorted(expression_mouths_rgba.items())
        }
        visible = {
            name: sum(
                1
                for index in range(canvas.width * canvas.height)
                if canvas.rgba[index * 4 + 3] >= 128
            )
            for name, canvas in sorted(portraits_rgba.items())
        }
        gates.append(
            Gate(
                "feature_composition",
                PASS if visible and min(visible.values()) > 0 else FAIL,
                {
                    "mode": "features_only",
                    "regions": [
                        list(region) for region in spec.rig.feature_regions
                    ],
                    "visible_portrait_pixels": visible,
                },
            )
        )
        notes.append(
            "feature-only composition: no portrait shell/body base layer"
        )

    if spec.rig.brow_poses:
        portraits_rgba = {
            name: apply_expression_brows(canvas, spec.rig, name)
            for name, canvas in sorted(portraits_rgba.items())
        }
        notes.append(
            "expression-specific pixel eyebrows baked into portrait sprites"
        )

    lids_rgba: dict[str, Image] = {}
    if spec.rig.blink == "synth":
        neutral = portraits_rgba.get("neutral") or next(
            iter(sorted(portraits_rgba.items()))
        )[1]
        for side, box in (
            ("left", spec.rig.eye_left),
            ("right", spec.rig.eye_right),
        ):
            half, closed = synth_lids(neutral, box)
            lids_rgba[f"half_{side}"] = half
            lids_rgba[f"closed_{side}"] = closed

    for name, canvas in sorted(portraits_rgba.items()):
        debug[f"normalized/{name}.png"] = encode_rgba(canvas)

    all_rgba = (
        [portraits_rgba[n] for n in sorted(portraits_rgba)]
        + [mouths_rgba[n] for n in sorted(mouths_rgba)]
        + [
            expression_mouths_rgba[n]
            for n in sorted(expression_mouths_rgba)
        ]
        + [lids_rgba[n] for n in sorted(lids_rgba)]
    )
    palette = build_palette(
        all_rgba, spec.palette.max_colors, spec.palette.locked
    )

    def indexed(name: str, art: Image) -> IndexedCell:
        cell = map_cell(art, name, palette)
        if spec.palette.despeckle:
            despeckle(cell)
        return cell

    portraits = {
        name: indexed(name, art)
        for name, art in sorted(portraits_rgba.items())
    }
    slot_by_name = {name: i for i, name in enumerate(MOUTH_SLOT_NAMES)}
    mouths = {
        slot_by_name[name]: indexed(name, art)
        for name, art in sorted(mouths_rgba.items())
    }
    expression_mouths = {
        name: indexed(f"rest_{name}", art)
        for name, art in sorted(expression_mouths_rgba.items())
    }
    lids = {
        name: indexed(name, art) for name, art in sorted(lids_rgba.items())
    }

    catalog = CanvasCatalog(
        spec=spec,
        palette=palette,
        portraits=portraits,
        mouths=mouths,
        expression_mouths=expression_mouths,
        lids=lids,
        notes=notes,
    )

    background_565 = rgb565(background)
    provenance = {
        "generator": {"name": PIPELINE_NAME, "version": PIPELINE_VERSION},
        "spec_sha256": sha256_bytes(
            canonical_json(spec.raw).encode("ascii")
        ),
        "sheet": sheet_label,
        "sheet_sha256": sha256_bytes(sheet_bytes),
        "sheet_pixels_sha256": hash_rgba(image),
        "pixel_grid_pitch": pitch,
        "background_rgb": list(background),
        "erased_baked_mouths": erased,
        "mouth_source_mode": mouth_mode,
    }

    target_reports: dict[str, dict] = {}
    for target in spec.targets:
        atlas = assemble_target(catalog, target)
        target_gates = validate_target(atlas)
        prefix = target.id
        if target.emit_c:
            artifacts[f"{prefix}/{atlas.prefix}_atlas.c"] = emit_atlas_c(
                atlas, background_565
            ).encode("utf-8")
            artifacts[f"{prefix}/{atlas.prefix}_atlas.h"] = emit_atlas_h(
                atlas
            ).encode("utf-8")
        manifest = target_manifest(atlas, background_565, provenance)
        manifest["validation"] = {
            "status": worst(target_gates),
            "gates": [gate.as_json() for gate in target_gates],
        }
        artifacts[f"{prefix}/manifest.json"] = (
            json.dumps(manifest, sort_keys=True, indent=2) + "\n"
        ).encode("utf-8")

        native_h = atlas.canvas[1]
        scale = max(1, PREVIEW_TARGET_HEIGHT // max(1, native_h))
        artifacts[f"{prefix}/previews/expressions_x{scale}.png"] = (
            encode_rgba(expression_sheet(atlas, background, scale))
        )
        artifacts[f"{prefix}/previews/mouths_x{scale}.png"] = encode_rgba(
            mouth_sheet(atlas, background, scale)
        )
        if atlas.banks[0].eye_left.cells:
            artifacts[f"{prefix}/previews/blink_x{scale}.png"] = (
                encode_rgba(blink_sheet(atlas, background, scale))
            )
        for variant in spec.palette.variants:
            variant_prefix = (
                f"{prefix}/previews/themes/{variant.id}"
            )
            variant_palette = [(0, 0, 0)] + list(variant.colors)
            artifacts[
                f"{variant_prefix}/expressions_x{scale}.png"
            ] = encode_rgba(
                expression_sheet(
                    atlas,
                    variant.background,
                    scale,
                    palette_rgb=variant_palette,
                )
            )
            artifacts[
                f"{variant_prefix}/mouths_x{scale}.png"
            ] = encode_rgba(
                mouth_sheet(
                    atlas,
                    variant.background,
                    scale,
                    palette_rgb=variant_palette,
                )
            )
            if atlas.banks[0].eye_left.cells:
                artifacts[
                    f"{variant_prefix}/blink_x{scale}.png"
                ] = encode_rgba(
                    blink_sheet(
                        atlas,
                        variant.background,
                        scale,
                        palette_rgb=variant_palette,
                    )
                )
        target_reports[target.id] = {
            "status": worst(target_gates),
            "gates": [gate.as_json() for gate in target_gates],
            "flash_bytes": atlas.flash_bytes,
            "cells": len(atlas.cells),
            "banks": len(atlas.banks),
            "notes": atlas.notes,
        }

    statuses = [gate.status for gate in gates] + [
        report["status"] for report in target_reports.values()
    ]
    overall = FAIL if FAIL in statuses else WARN if WARN in statuses else PASS
    report = {
        "pipeline": {"name": PIPELINE_NAME, "version": PIPELINE_VERSION},
        "id": spec.id,
        "status": overall,
        "gates": [gate.as_json() for gate in gates],
        "targets": target_reports,
        "notes": notes,
        "provenance": provenance,
    }
    return BuildOutput(
        spec=spec,
        artifacts=artifacts,
        debug=debug,
        report=report,
        status=overall,
        notes=notes,
    )


def check_determinism(
    spec: CharacterSpec, sheet_bytes: bytes, sheet_label: str
) -> tuple[Gate, BuildOutput]:
    """Run compute() twice; every artifact byte must match."""
    first = compute(spec, sheet_bytes, sheet_label)
    second = compute(spec, sheet_bytes, sheet_label)
    first_hashes = first.artifact_hashes()
    second_hashes = second.artifact_hashes()
    mismatched = sorted(
        name
        for name in set(first_hashes) | set(second_hashes)
        if first_hashes.get(name) != second_hashes.get(name)
    )
    report_match = canonical_json(first.report) == canonical_json(
        second.report
    )
    if mismatched or not report_match:
        gate = Gate(
            "determinism",
            FAIL,
            {"mismatched_artifacts": mismatched, "report_match": report_match},
        )
    else:
        gate = Gate(
            "determinism",
            PASS,
            {"artifacts": len(first_hashes)},
        )
    return gate, first


def build(
    spec_path,
    out_dir,
    debug_dir=None,
    sheet_override=None,
    verify_determinism: bool = True,
) -> BuildOutput:
    spec = load_spec(spec_path)
    if spec.source.kind != "sheet" and sheet_override is None:
        raise ValueError(
            f"source.kind is {spec.source.kind!r}: generate a sheet from "
            "the authoring brief first (spritepipe.py brief), then pass "
            "--sheet"
        )
    sheet_path = (
        Path(sheet_override)
        if sheet_override
        else spec.resolve_path(spec.source.sheet)
    )
    sheet_bytes = sheet_path.read_bytes()
    label = str(sheet_path)

    if verify_determinism:
        determinism_gate, output = check_determinism(
            spec, sheet_bytes, label
        )
    else:
        output = compute(spec, sheet_bytes, label)
        determinism_gate = Gate(
            "determinism", WARN, {"skipped": True}
        )
    output.report["gates"].append(determinism_gate.as_json())
    if determinism_gate.status == FAIL:
        output.status = FAIL
        output.report["status"] = FAIL

    out_root = Path(out_dir)
    out_root.mkdir(parents=True, exist_ok=True)
    for name, data in sorted(output.artifacts.items()):
        path = out_root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    report_bytes = (
        json.dumps(output.report, sort_keys=True, indent=2) + "\n"
    ).encode("utf-8")
    (out_root / "report.json").write_bytes(report_bytes)
    index = {
        "id": spec.id,
        "display_name": spec.display_name,
        "status": output.status,
        "targets": {
            target.id: {
                "status": output.report["targets"][target.id]["status"],
                "manifest": f"{target.id}/manifest.json",
            }
            for target in spec.targets
        },
        "artifact_sha256": output.artifact_hashes(),
    }
    (out_root / "index.json").write_bytes(
        (json.dumps(index, sort_keys=True, indent=2) + "\n").encode("utf-8")
    )
    if debug_dir is not None:
        debug_root = Path(debug_dir)
        debug_root.mkdir(parents=True, exist_ok=True)
        for name, data in sorted(output.debug.items()):
            path = debug_root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
    return output


AUTHORING_CONTRACT = """\
# Authoring brief: {display_name}

Generate ONE sprite sheet image that this deterministic pipeline can compile.
The image model's output is source material only; the compiler owns the
final resolution, palette, transparency, and validation.

## Character

{prompt}

## Hard sheet contract

- Flat, uniform background across the whole sheet ({background_text});
  no gradients behind the character, no drop shadows, no vignette.
- Chunky retro pixel-art look with a consistent fake-pixel size everywhere.
- {row_count} horizontal rows, generously separated by empty background:
{row_lines}
- Identical framing and scale for every cell in a row; portraits share the
  same baseline and camera.
- Expression portraits must keep the face layout identical (eye and mouth
  positions move only as far as the expression demands).
- Mouth cels are isolated mouths only, on the same flat background,
  without chin or nose fragments.
- Palette: at most {max_colors} distinct colors plus the background.
- No text, labels, watermarks, or grid lines anywhere on the sheet.

## What happens next

`spritepipe.py build --spec {spec_name} --sheet <generated.png>` keys the
background, segments the rows, snaps the fake pixel grid, quantizes the
palette, erases baked mouths, synthesizes blink lids, and emits validated
C flash tables plus manifests for these targets: {targets}.
"""


def authoring_brief(spec: CharacterSpec) -> tuple[str, dict]:
    """Markdown brief + machine-readable layout contract for image models."""
    row_lines = []
    for index, row in enumerate(spec.layout.rows, start=1):
        row_lines.append(
            f"  {index}. {row.role} row: "
            + ", ".join(row.names)
            + f" ({len(row.names)} cells)"
        )
    background_text = (
        "any single light color"
        if spec.source.background == "auto"
        else spec.source.background
    )
    prompt = spec.source.prompt or (
        f"Recreate the character from the reference image "
        f"{spec.source.reference!r} faithfully."
    )
    text = AUTHORING_CONTRACT.format(
        display_name=spec.display_name,
        prompt=prompt.strip(),
        background_text=background_text,
        row_count=len(spec.layout.rows),
        row_lines="\n".join(row_lines),
        max_colors=spec.palette.max_colors,
        spec_name=spec.spec_path.name,
        targets=", ".join(t.id for t in spec.targets),
    )
    contract = {
        "schema_version": 1,
        "id": spec.id,
        "rows": [
            {"role": row.role, "names": list(row.names)}
            for row in spec.layout.rows
        ],
        "background": spec.source.background,
        "max_colors": spec.palette.max_colors,
        "rig": {
            "canvas": list(spec.rig.canvas),
            "mouth_box": list(spec.rig.mouth_box),
            "mouth_erase_box": list(spec.rig.mouth_erase_box),
            "composition": spec.rig.composition_mode,
        },
        "targets": [t.id for t in spec.targets],
    }
    return text, contract
