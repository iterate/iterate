# Sprite pipeline

Compiles the StackChan avatar atlases in
`apps/kit/firmware/components/avatar/` from original art scans. Stdlib-only
Python (no venv, no dependencies); vendored from the StackChan prototype at
`~/src/github.com/iterate/stackchan/experiments/02-minimal-realtime-aec/tools/sprite-pipeline`.

The multi-megabyte scans under `characters/*/source/` are NOT committed —
fetch them from the prototype repo above (or redraw against the committed
`avatar.json` spec) before running `build`/`publish`. For everyday firmware
work you never need this pipeline: the committed per-pack sprite-map PNG +
JSON under `apps/kit/firmware/components/avatar/assets/` regenerate the C
atlases byte-identically via
`python3 apps/kit/firmware/tools/generate-atlases.py`. This pipeline is for
CHANGING the art; that one is for building what already exists.
The `fspp/` modules do the actual work (keying, segmentation, pixel-grid
snapping, quantisation, validation, C emission); `avatar_pipeline.py` is the
front door.

## Commands

Run from this directory:

```bash
# emit the prompt/contract an image model needs to draw a compilable sheet
python3 avatar_pipeline.py brief --spec fixtures/sproutling_prompt_spec.json --out /tmp/sproutling

# build one character into characters/<id>/generated/ (untracked)
python3 avatar_pipeline.py build --character characters/starbyte/avatar.json

# rebuild every character and install atlases + catalogue into the firmware component
python3 avatar_pipeline.py publish

# same rebuild, but verify the committed firmware files byte-match; writes nothing
python3 avatar_pipeline.py publish --check
```

Builds verify their own determinism (each atlas is built twice and hash
compared); `--skip-determinism` halves the runtime when iterating.

## Character folder contract

```
characters/<id>/
  avatar.json      # grids, names, rig, palette, targets — the whole recipe
  source/*.png     # regular AI-generated grids (expressions, mouths)
  generated/       # derived; gitignored; recreated by build/publish
```

`avatar.json` lists one or more source grids with per-cell names, then the
rig, palette, and device targets. Atlas bytes are reproducible from the JSON
plus the PNG bytes alone.

`publish` installs, for every target whose id starts with `cores3-`:

- `fspp_<id>_<target>_atlas.c` → `firmware/components/avatar/src/`
- `fspp_<id>_<target>_atlas.h` → `firmware/components/avatar/include/iterate/kit/avatar/`
- `face_avatar_catalog_generated.inc` → `firmware/components/avatar/src/`

Quoted includes are rewritten to the `iterate/kit/avatar/` include root on the
way in. A target's `device_themes` selects which palette variants become
catalogue entries; an empty list installs the atlas pair without cataloguing
it (gameboy-bot ships this way deliberately — the firmware registry test pins
the catalogue to the other three characters). `publish` never deletes atlas
files it did not produce; it warns about them instead.

New characters also need their atlas `.c` added to the avatar component's
`CMakeLists.txt` `SRCS`; publish does not edit that file.

## Rebuild gate

`apps/kit/src/firmware/sprite-pipeline-atlases.test.ts` (part of the normal
`pnpm test` lane in `apps/kit`) runs `publish --check`: every character is
rebuilt from tracked sources and the resulting atlas pairs and catalogue must
byte-match the committed firmware files. If you change any `avatar.json` or
source PNG, run `publish` and commit the regenerated firmware files together
with the source change, or the gate fails.
