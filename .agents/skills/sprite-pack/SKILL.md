---
name: sprite-pack
description: Produce a new StackChan avatar character (expression + viseme sprite pack) from a concept, using an image model driven through the deterministic sprite pipeline at apps/kit/tools/sprite-pipeline/. Numeric gates reject bad sheets; only a human accepts the look. Use when asked to create, regenerate, or add an avatar character/face/sprite pack.
---

# Sprite pack: concept → compiled avatar atlas

All paths below are relative to `apps/kit/tools/sprite-pipeline/`; run
`python3` commands from that directory. The pipeline is stdlib-only Python.
Read its `README.md` once before starting. The division of labour is strict:
**the validator rejects, it never promotes — the human is the only promoter.**

## 1. Get the concept

Ask the user for whatever is missing; keep it to one round:

- **name + slug** (kebab-case, e.g. `dot-matrix-oracle`)
- **personality** (drives how expressions read)
- **visual motifs** (shapes, era, materials)
- **palette direction** — at most 4 colors, displayed on a black screen

## 2. Author `characters/<slug>/avatar.json`

Copy `characters/starbyte/avatar.json` and adjust. The constraints that
matter:

- **Canvas is 80x60.** Every rig box (`eyes`, `mouth`, `max_body`,
  `composition.regions`) lives in that space. Keep starbyte's
  `features_only` composition (big eye regions + isolated mouth) unless the
  concept demands a full body.
- **Palette: max 4 locked colors** (`palette.locked` + one `variants` entry
  with `background: "#000000"`). The magenta `#ff00ff` assembly background is
  keying/transparency, never a palette color.
- **Expression source: grid `[4,3]`**, names = the canonical 11 from
  `face_stage.h` in row-major order, 12th cell `null`:
  `neutral, warm, joy, concern, surprise, thoughtful, skeptical, determined,
sleepy, excited, embarrassed`.
- **Mouth source: grid `[5,3]`**, the 15 visemes in this exact order:
  `sil, pp, ff, th, dd, kk, ch, ss, nn, rr, aa, e, ih, oh, ou`.
- **Target**: one `cores3-fine` entry — `canvas [80,60]`, `scale 2`,
  `frame [160,120]`, `max_flash_bytes 48000`, `catalog_slug`/`catalog_name`,
  `device_themes: ["original"]`.
- **Provenance**: `notes` must record the AI-assisted origin, like the
  existing characters ("AI-assisted original … features, authored for the
  StackChan black display."). Source sheets in `source/` are immutable once
  accepted — new attempts get new version suffixes (`expressions-v2.png`),
  never overwrites of an accepted sheet.

## 3. Emit the authoring brief

`brief` takes a prompt-spec (see `fixtures/sproutling_prompt_spec.json`), not
an avatar.json. Write `fixtures/<slug>_prompt_spec.json`: copy sproutling's,
set `id`/`display_name`/`source.prompt` from the concept, mirror the
avatar.json grids row-by-row in `layout.rows` (expressions 4/4/3, mouths
5/5/5 with the viseme names above), and match `rig`/`palette` (max_colors 4).
Then:

```bash
python3 avatar_pipeline.py brief --spec fixtures/<slug>_prompt_spec.json --out /tmp/<slug>-brief
```

That writes `authoring_brief.md` (the sheet contract in prose) and
`layout_contract.json`.

## 4. Build TWO image prompts from the brief

The pipeline exists because image models are unreliable at one monolithic
atlas: **generate the two sheets as separate images, one per role grid** —
an expressions prompt (rows 1–2 of the brief) and a mouths prompt (rows 3–4).
Each prompt = the brief's character description + its hard-contract lines
scoped to that sheet, plus:

- Uniform flat **magenta `#ff00ff` background** everywhere (it gets keyed).
  **Put the background rule FIRST in the prompt and spell it out** ("RGB
  255,0,255, purple-pink, identical corner to corner, no gradient/glow/
  vignette, NOT salmon/rose/red") — background drift is the dominant failure
  mode, especially with warm palettes, which drag the whole canvas salmon.
  Also say the artwork itself does not glow: halo bloom around cells breaks
  keying too.
- A **regular grid filling the canvas** — 4 columns x 3 rows for
  expressions, 5x3 for mouths — evenly spaced, because the compiler slices
  the image proportionally. Fill the expressions' 12th cell with a repeat of
  neutral rather than leaving it empty (the `null` name discards it; a full
  grid keeps the model's spacing regular — starbyte shipped this way). For
  mouths, models default to 4-column layouts: include a literal bracket map
  (`Row 1: [SIL] [PP] [FF] [TH] [DD] …`) and say "EXACTLY 5 per row, never
  4" or you will get 4+4+4+3.
- **Expression cells are floating features only** — brows + eyes + small
  low mouth on magenta, NO head/face outline/body (say so; a character
  description like "stove face" makes the model draw a head, which
  `features_only` cropping then slices apart). The small mouth in each
  expression cell is discarded at composition but stretches the content
  bbox so the eyes land in the rig's eye regions — keep it.
- Consistent chunky fake-pixel size across all cells; at most the 4 palette
  colors as flat fills — no gradients, anti-aliasing, shadows, text, labels,
  or grid lines.
- Mouth cells are **isolated mouths only** — no chin, nose, or face
  fragments.

**Expression vividness is a product requirement.** Dull, near-identical
cells are the known failure mode of previous packs. Demand caricature-level
differentiation in the prompt: big brow-angle changes, wide vs narrow eye
apertures, strong mouth-corner shifts — each of the 11 must be readable at
80x60 in chunky pixels. Spell out per-expression instructions (sleepy = lids
almost shut; surprise = maximum eye aperture + small o-mouth; skeptical =
one brow up, flat mouth; determined = brows angled in, set mouth; …).
**Inspect the returned sheet yourself first**: if expressions look samey,
reject it and regenerate with sharpened per-cell wording BEFORE spending a
build or human attention. Also pre-gate the background numerically — keying
flood-fills from the border and accepts a pixel only when **every** RGB
channel is within `background_tolerance` (96) of `#ff00ff`:

```python
from fspp.png_io import load   # run from tools/sprite-pipeline
img = load("characters/<slug>/source/expressions-vN.png")
r, g, b, _ = img.get(8, 8)     # sample corners + edge midpoints
print(max(abs(r - 255), g, abs(b - 255)))  # > 96 anywhere on the border = reject
```

## 5. Generate the sheets

Primary backend — OpenAI `gpt-image-1` via the key in the apps/os dev
Doppler config. Write each prompt to a text file, then from `apps/os`:

```bash
doppler run --config dev -- python3 \
  ../../.agents/skills/sprite-pack/generate_sheet.py \
  --prompt-file /tmp/<slug>-brief/expressions-prompt.txt \
  --out ../kit/tools/sprite-pipeline/characters/<slug>/source/expressions-v1.png \
  --size 1536x1024
# repeat with mouths-prompt.txt → source/mouths-v1.png
```

The helper (`generate_sheet.py`, stdlib only) POSTs to
`https://api.openai.com/v1/images/generations` with
`{"model":"gpt-image-1","prompt":…,"size":"1536x1024","n":1}` and writes the
decoded `data[0].b64_json` PNG; its docstring shows the equivalent raw curl.

**Fallback when no key**: print `authoring_brief.md` plus your two prompts
and ask the human to run them in their own image tool and drop the PNGs at
`characters/<slug>/source/expressions-v1.png` and `mouths-v1.png`.

## 6. Build, and let the gates argue with the image model

```bash
python3 avatar_pipeline.py build --character characters/<slug>/avatar.json
```

(Add `--skip-determinism` while iterating; drop it for the final build.) On
failure, feed the validator's _specific_ complaint back into a regenerated
prompt — do not loosen the spec to make a bad sheet pass:

| Complaint                                                 | Prompt fix                                                                    |
| --------------------------------------------------------- | ----------------------------------------------------------------------------- |
| palette gate: too many colors                             | restate the 4-color limit; flat fills only, no anti-aliasing/gradients/dither |
| assemble error: cell larger than assembly_cell / bleeding | more empty background between cells; character smaller within each cell       |
| registration: rows misaligned, baseline drift             | identical framing, scale, and baseline for every cell in a row                |
| snap/legibility: fake-pixel pitch inconsistent            | one consistent chunky pixel size across the entire sheet                      |
| coverage/clipping: features outside rig boxes             | recheck rig boxes in avatar.json vs where the model actually drew eyes/mouth  |
| budget: over max_flash_bytes                              | simpler shapes, fewer stray speckles, larger uniform areas                    |

**Cap at 4 regeneration attempts.** Then stop and report what kept failing
with the exact gate evidence — do not keep burning image calls.

## 7. Green build → STOP for human acceptance

Show the human the previews from
`characters/<slug>/generated/build/cores3-fine/previews/` (`expressions_x4.png`,
`mouths_x4.png`, and `themes/original/`) and **stop**. Numeric gates passing
means compilable, not good. Only the human promotes.

## 8. On acceptance: publish and gate

```bash
python3 avatar_pipeline.py publish
cd ../../..   # apps/kit
pnpm vitest run src/firmware/sprite-pipeline-atlases.test.ts
```

`publish` installs `fspp_<id>_cores3_fine_atlas.c/.h` and regenerates
`face_avatar_catalog_generated.inc` in `firmware/components/avatar/`, but it
does **not** edit CMake: add the new
`fspp_<slug_with_underscores>_cores3_fine_atlas.c` to the `SRCS` lists in
**both** `apps/kit/firmware/components/avatar/CMakeLists.txt` and the atlas
list in `apps/kit/firmware/CMakeLists.txt` (grep for
`fspp_starbyte_cores3_fine_atlas.c` to find both spots). Then update
`firmware/components/avatar/tests/face_avatar_registry_test.c`, which pins
catalogue membership three ways: the exact `face_avatar_registry_count()`,
per-index golden frame hashes (the catalogue is **alphabetical by slug**, so
new characters shift indices; rebuild with
`-DFACE_AVATAR_REGISTRY_TEST_CAPTURE_HASHES` in `CMAKE_C_FLAGS`, run the
test, and copy the printed `avatar[N]` hashes in), and slug selectability
(assert new slugs select; keep the `gameboy-fine-black` exclusion). Verify
with `cmake -S apps/kit/firmware -B apps/kit/.build/host
-DCMAKE_BUILD_TYPE=MinSizeRel && cmake --build apps/kit/.build/host
--parallel && ctest --test-dir apps/kit/.build/host -R face
--output-on-failure`. Commit `avatar.json`, the prompt-spec fixture, the
`source/*.png` sheets, and the regenerated firmware files together — the
gate test rebuilds from sources and byte-compares, so a half-committed pack
fails `pnpm test`.
