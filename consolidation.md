# Consolidation

## 0. How to read this

This is the input to a planning session on 2026-08-04: one document assembled from four independent catalogues of the voice-device work, compiled the same day against live trees (not against the documents). It covers what exists, where it lives, what is at risk of being lost, what was designed and never built, where the record contradicts itself, and — in §10 — the decisions that have to be made before any consolidation code is written. §1–§8 are inventory and correction; §9–§10 are the plan's actual input. The detailed source catalogues stay in the scratchpad and should be read for any specific line-level claim: `/private/tmp/claude-501/-Users-jonastemplestein--herdr-worktrees-iterate-stream-for-audio/262b7afb-c58f-4d0b-b0fe-58acb763989b/scratchpad/cat-ccap.md` (ESP32 firmware in the `c-capabilities` worktree), `.../cat-stackchan.md` (the `iterate/stackchan` research repo), `.../cat-server.md` (server-side voice in this worktree), `.../cat-research.md` (architecture research written up and not implemented, across all environments).

---

## 1. Preservation hazards — read before touching anything

Ordered by cost of loss, not by size.

### H1. `iterate/stackchan` — 981 untracked files, no remote copy, no stashes

**Path:** `/Users/jonastemplestein/src/github.com/iterate/stackchan`
**At risk:** the entire CoreS3 firmware (`experiments/02-minimal-realtime-aec/firmware-ws/`, ~120 face C files / ~1.9 MB in `main/`), the M5StickS3 sprite proof (`firmware-sticks3/`), the whole sprite/avatar toolchain (`tools/sprite-pipeline/`, `tools/face-grid/`, `tools/face-video/`, `tools/aec_lab.py` 1,816 lines, `tools/face_simulator.py` 961, `tools/fake_grok_server.py` 459, `tools/test_face_rig.py` 580), and 7 untracked design docs. The repo has **4 commits, 18 tracked files**, `main == origin/main`, and **`git stash list` is empty**. Everything of value is _unversioned_, not merely unpushed. `git clean -fdx` here destroys the work.

**Do:** `git add` and commit `firmware-ws/`, `firmware-sticks3/`, `tools/`, the 7 untracked docs and the 4 modified tracked files, today, before anything else. Committing the modified `README.md` and `experiments/02-minimal-realtime-aec/docs/architecture.md` is the single cheapest truth-preservation act available: the _committed_ versions describe a WebRTC architecture that was never built; the _working-tree_ versions describe what actually shipped.

### H2. `iterate/stackchan/.claude/worktrees/` — three worktrees holding work that exists nowhere else

All 11 worktrees are registered on `worktree-fable-*` branches **pinned to `2a7aec9` with zero commits of their own**, and they are untracked. Eight had their output hand-copied into the main tree. Three did not:

| Worktree                                  | Unique content                                                                                                                                                                                                                                                                    |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.claude/worktrees/fable-bitmap-font-v1`  | `contrib/fable_bitmap_font_v1/` — FBF bitmap-font compiler (`tools/fbfc.py`), `src/fbf_{font,layout,draw}.c`, fonts `pico6` + `mossbyte8`, generated C. The only font-rendering / timed-transcript work anywhere, and `docs/sprite-avatar-pipeline.md` names it as a requirement. |
| `.claude/worktrees/fable-sprite-behavior` | `contrib/fable_sprite_behavior_v1/` — `sb_core.c`, `sb_mouth.c`, `sb_clips.c`, `sprite_behavior.h`: the sprite behaviour/clip layer.                                                                                                                                              |
| `.claude/worktrees/fable-cozmo-acting-2`  | A whole `firmware-ws/` slice with `face_cozmo_acting_test.c` + `face_cozmo_acting_sheet.c` and `local/face-cozmo-acting/` artefacts. No `face_cozmo_acting*` file exists in the main tree.                                                                                        |

**Do:** a `git add -A` in the main tree does **not** capture these — they are separate working directories. Copy the three `contrib/` dirs into the main tree (or into `iterate/iterate`) as part of the same commit as H1, then decide keep-or-discard explicitly rather than by attrition.

### H3. `iterate/stackchan/local/` — 9.5 GB gitignored, the only copy of the AEC measurement corpus

Holds 70+ machine-readable AEC report JSONs, 14 timestamped device-evidence bundles (LCD framebuffers, 3-channel audio, event journals), captured real-Grok PCM, four substantial research memos that exist nowhere else (`claude-memory-audit-report.md` 196 lines — the byte-accounted 169.6 KB → **583 B** internal-RAM boot timeline; `fable-renderer-integration-audit.md` 217; `claude-fable-expression-review-result.md` 748), **and the real secrets** (`local/stackchan_local_secrets.h`, `local/stackchan_xai_secret.h`).

**Do:** archive off-machine (minus the two secret headers) before any repo surgery. It stays gitignored; the point is that it is the only record and it is on one laptop. Note `local/claude-aec-fable-report.md` is a **0-byte file** — that investigation was commissioned twice and never delivered; there is nothing to preserve there.

### H4. This worktree — 20 modified + 8 untracked, and the only copy of the server-side visemes

**Path:** `/Users/jonastemplestein/.herdr/worktrees/iterate/stream-for-audio`, branch `stream-for-audio`, HEAD `6665a487f`, **2 commits unpushed** (`6665a487f`, `03dc377f6`), 55 ahead / 25 behind `origin/main`, PR **#2376 OPEN**.

Four unrelated pieces of work are tangled in one diff:

| Piece                                             | Files                                                                                                                                                                                                                                         | Why it matters                                                                                                                                                                                                                                |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) `voicelab/*` → `voice-agent/*` event rename   | ~12 files, symmetrical `n/n` diffs (pressure 61/61, sessions 17/17, bridge 13/13, client 12/12…)                                                                                                                                              | **The firmware in `c-capabilities` already emits and subscribes to `voice-agent/*`.** The two repos are consistent on disk and the rename is committed in neither. This debt accrues daily.                                                   |
| (b) Visemes                                       | `config-repo/viseme.ts` (722), `viseme-model.generated.ts` (214), `viseme.test.ts` (378), `voice-agent.viseme.test.ts` (142), `viseme-model.codegen.cjs`, `viseme-model.bin`, `HEAD_AUDIO_LICENSE.txt`, plus `deploy.ts` `runtimeImportNames` | Only copy. A runtime import that is never committed builds locally and dies at the project's cold start with `No such module`.                                                                                                                |
| (c) `voice-agent/context-added` + verbatim speech | inside `voice-agent.ts` (+708/−160)                                                                                                                                                                                                           | Confirmed absent from HEAD: no `context-added` handler, no `speechPolicy`, no `force_message`, no `takeTheFloorIfFree`, no `liveResponses`, no `background-activity`. HEAD still has `message_back_office` where the tree has `note_to_self`. |
| (d) Ops defaults + `chronology.ts` (242, new)     | `cli.ts` default env `preview_3`→`prd`; `talk.ts` `DEFAULT_PROJECT` → slug `voice-test`                                                                                                                                                       | Small, but riding on top of everything else.                                                                                                                                                                                                  |

**Do:** push the 2 commits now. Then land (a), (b), (c), (d) as **four separate commits in that order** — landing them together makes the rename unreviewable and the features un-bisectable. Delete the stray `iterate-kit-playback.wav` at repo root.

### H5. `c-capabilities` working tree — 9 modified files, +591/−82, uncommitted

**Path:** `/Users/jonastemplestein/.herdr/worktrees/iterate/c-capabilities`
Despite the HEAD commit message this is **not** AEC work. It is two coupled M5StickS3 changes: the post-capture audible cue (`M5StickS3PostCaptureCue{none,turnComplete}`, `resumeAfterCapture(cue)`, three new counters, played after `M5.Mic.end()` releases the pins because the Stick is half-duplex) and the button-model rewrite (`takeButtonBPress()` → `takeButtonBChange(bool*)`; physical buttons now enter the same `logical_input` capability remote control uses). Files: `platforms/iterate_m5unified/m5sticks3_direct_audio.cpp` (+379), `tests/m5sticks3_events_test.c` (+88), `targets/m5sticks3/main/main.cpp`, `simulator/devices/m5sticks3.cpp`, `src/device/firmware-architecture.test.ts`, three headers, one doc.
**Do:** commit as one change. It is coherent and testable. Note `git stash list` in that repo has 89 stashes, **none kit-related** — nothing is parked there.

### H6. `c-capabilities` HEAD checkpoint `cafa736f8` — not a loss hazard, a merge blocker

The branch **is pushed** (`origin/c-capabilities == local HEAD`), so nothing is at risk of loss. What is at risk is mergeability. `cafa736f8` is **10,024 files changed / 3,079,078 insertions**, committed with hooks bypassed and, per its own message, unreviewed:

- **~14,798 files / 1.1 GB now tracked under `apps/.build/`** — `apps/kit/.gitignore` covers `apps/kit/.build/` but not `apps/.build/` one level up, so the checkpoint swept in `CMakeFiles`, `esp-idf` build trees, bootloader and log trees, `.ninja_deps`, `CMakeCache.txt`, `a.out`, `.o`.
- **~1,900 evidence binaries** (`.pcm16le`, `.wav`, `.json`, `.png`), plus a doubled path bug: `apps/kit/apps/kit/evidence/stackchan-grok-uplink-incident-20260803/…`.
- **268 genuine source files** buried inside: `aec_reference_scaler.{h,c}` (new), `aec_uplink_selector.{h,c}` (new), the `aec_diagnostic_trace` capability (new, +230/+56), `pcm_high_pass.{h,c}` (new), the shared `pcm_session.c` (+241) + `esp_idf_pcm_session.h` (+112) + `pcm_transport_lifecycle.h` (+46), the entire new `platforms/iterate_stackchan_body/` component (+420), a near-rewrite of `core_s3_audio_owner.c` (+803/−582), `logical_input.{h,c}` (new), `talk_button.{h,c}` (new), a rewritten `metrics.c` (+810/−1035), and on the TS side `pcm-proxy.ts` (+760/−212) with `pcm-proxy.test.ts` (+812/−148) plus eight new modules.

**Do:** do not attempt to merge this branch as-is, and do not `git filter-repo` it casually — the 268 source files are interleaved with the artefacts in one commit. See §10 D1 for the recommended path. Separately: `apps/kit/evidence/` is **3,095 tracked files / 1.6 GB** from earlier commits — of 4,140 tracked files under `apps/kit`, only ~1,000 are source or docs.

---

## 2. Where everything lives today

| Path                                                                | Branch / HEAD                         | What it holds                                                                                                                                                                | Merged / pushed / PR                                                                                                                      |
| ------------------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `/Users/jonastemplestein/.herdr/worktrees/iterate/stream-for-audio` | `stream-for-audio` @ `6665a487f`      | All server-side voice: `apps/os/scripts/voicelab/` (21,013 lines / 43 files), incl. `config-repo/voice-agent.ts` (3,859) and 19 CLI commands                                 | **PR #2376 OPEN.** 55 ahead / 25 behind `origin/main`. 2 commits unpushed. 20 M + 8 untracked.                                            |
| `/Users/jonastemplestein/.herdr/worktrees/iterate/c-capabilities`   | `c-capabilities` @ `cafa736f8`        | All ESP32 firmware + the Lane A server (`apps/kit/`). 141 of 143 commits touch `apps/kit`. ~120k lines of C/C++ plus 115 `*.test.ts`                                         | Pushed (`origin` == local). 143 ahead / 66 behind `origin/main`, merge base `b6e46ef3a`. **No PR has ever existed.** 9 files uncommitted. |
| `/Users/jonastemplestein/src/github.com/iterate/stackchan`          | `main` @ `2a7aec9`                    | Public research sandbox: origin of the avatar/sprite engine, the only AEC measurement corpus, the on-device AEC tuning HTTP server                                           | `main == origin/main`. 18 tracked files, **981 untracked**, no stashes. Nothing to merge — it is prior art, not a fork.                   |
| `…/stackchan/.claude/worktrees/worktree-fable-*` (11)               | all pinned at `2a7aec9`, zero commits | 8 already copied into the main tree; **3 unique** (H2)                                                                                                                       | Untracked, unmergeable as-is.                                                                                                             |
| `iterate/iterate` `origin/main`                                     | —                                     | `apps/kit` is the **web installer only** (one commit `adbed0da0`, 2026-07-29). No firmware on main.                                                                          | —                                                                                                                                         |
| A project's config repo, `/repos/config`                            | —                                     | The **actually deployed** server: `voice-agent.ts` + `viseme.ts` + `viseme-model.generated.ts`, installed by `voicelab deploy`/`talk` and built by the dynamic worker loader | Deployment is a commit into a project repo, not a branch merge.                                                                           |

---

## 3. The devices

|                        | HAVPE                                                                                                                                      | StackChan                                                                                                                                                                      | M5StickS3                                                                                        | Waveshare AMOLED                                                                                                                                                                                                                                         | `host_cli`                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Board / MCU**        | HA Voice PE; ESP32-S3, 16 MB, **octal** PSRAM @80 MHz                                                                                      | M5Stack CoreS3 in StackChan body; ESP32-S3, 16 MB, quad PSRAM                                                                                                                  | M5StickS3; ESP32-S3, 8 MB, octal                                                                 | Waveshare S3 Touch AMOLED 1.8"; ESP32-S3, 16 MB, octal **held at 40 MHz** (80 broke TLS)                                                                                                                                                                 | macOS process, not silicon                                                                                                  |
| **Display**            | **none**                                                                                                                                   | ILI934x 320×240 + FT5x06, **LVGL disabled**                                                                                                                                    | ST7789 240×135, no touch                                                                         | SH8601 QSPI AMOLED 368×448 + FT3168 behind TCA9554, **LVGL 9.5**                                                                                                                                                                                         | terminal                                                                                                                    |
| **Audio codec**        | XMOS **XU316** DSP + TI **AIC3204**, two independent XMOS-clocked I2S buses (ESP is slave on both)                                         | **AW88298** amp + **ES7210** 4-ch ADC on one I2S clock, 4-slot 16-bit TDM                                                                                                      | **ES8311** both directions, single analog mic, M5PM1 PA gate                                     | **ES8311** duplex, single analog mic, AXP2101 PMIC, PA on GPIO46                                                                                                                                                                                         | CoreAudio / AudioToolbox                                                                                                    |
| **AEC**                | **hardware (XMOS)**, 5-stage; uplink tap is a build-time CMake cache var, default stage 3 = NS; ch1 = raw                                  | **software (esp-sr 2.4.7)**, now `AFE_TYPE_VC` / VOIP profile 3 — the only 2.4.7 path with a DTD. Reference = analogue divider TDM slot 1, PGA 0 dB, **saturating digital ×8** | **none** — half-duplex PTT. Structurally impossible: single analog mic, no reference channel     | **none** — manual PTT _is_ the echo story. Explicitly **denylisted as an AEC substitute**                                                                                                                                                                | n/a                                                                                                                         |
| **Avatar**             | no                                                                                                                                         | yes (`platforms/iterate_stackchan_avatar`, owns the raw panel)                                                                                                                 | yes (`platforms/iterate_m5unified`, M5GFX owns the panel)                                        | yes (`main/waveshare_avatar.c`, LVGL owns the panel)                                                                                                                                                                                                     | no                                                                                                                          |
| **Transport lane**     | **A** (`/api` + `/pcm`)                                                                                                                    | **A**                                                                                                                                                                          | **A**                                                                                            | **B** (everything on `/api`)                                                                                                                                                                                                                             | **B**                                                                                                                       |
| **Mount**              | `kit.homeAssistantVoicePreviewEdition`                                                                                                     | `kit.stackchan`                                                                                                                                                                | `kit.m5sticks3`                                                                                  | `kit.waveshare`                                                                                                                                                                                                                                          | `kit.<name>`                                                                                                                |
| **`devices/` profile** | `devices/voice_satellite` (273 ln, 5 modules)                                                                                              | `devices/stackchan` (367 ln, 10 modules)                                                                                                                                       | `devices/m5sticks3` (393 ln, 9 modules)                                                          | **none — built inline in `main.c`**                                                                                                                                                                                                                      | n/a                                                                                                                         |
| **Simulator**          | none                                                                                                                                       | `iterate-stackchan-simulator`                                                                                                                                                  | `iterate-m5sticks3-simulator`                                                                    | none                                                                                                                                                                                                                                                     | n/a                                                                                                                         |
| **Completeness**       | Full voice loop, production quality, no face. Count-to-100 gate **failed** (32-slot receive bound, `/pcm` generation vanished at ~30.68 s) | Full loop + AEC + face + body (12 LEDs on the body's PY32 at I2C `0x6f`, SCS0009 servos on a 1 Mbaud UART, GC0308 camera). AEC profile 3 **not release-accepted**              | Full loop + face + on-device menu. −18 dB DAC ceiling; the brownout fix is **still uncommitted** | **10/10 ten-session proof GREEN** (40 clean turns, 0 lost frames, first-audio median 692 ms). Only board with server visemes, SD flight recorder, screenshots, remote images, self-measurement tone loop. **Flash-denylisted** (MAC `1C:DB:D4:7A:16:C8`) | Fault/simulation rig with real Mac audio; runtime device-profile table so one process runs at another board's bounded sizes |

**HAVPE** is awkward because it is the only board where the ESP never sees a microphone. XMOS owns the mics, does AEC→IC→NS→AGC in hardware, masters both I2S clocks, and exposes **exactly three control commands** (VNR read `0x00`, ch0/ch1 stage `0x30`/`0x40`). `GET_ERLE_CH0_AEC` does not exist on FFVA 1.3.1. Firmware fails boot closed if the XMOS version/pipeline readback disagrees. Playback needs a 3:1 48 kHz expansion. It is also the only screenless board, so any "presence" abstraction has to project the same semantic frame onto a 12×WS2812 ring instead of pixels — and its one button is GPIO0, a boot strap, so restart is deferred until release.

**StackChan** is awkward because it is the only board with a software AEC, and that AEC is welded into `platforms/iterate_core_s3_audio/core_s3_audio_owner.c` (1,707 lines) rather than sitting behind a seam. It carries six selectable profiles, a priority-20 AEC task, reference scaler, uplink selector with 8-frame hangover, an explicit raw ×6 / processed ×10 gain contract, and per-descriptor IRAM-safe DMA reserve accounting. It is also the only board with a physical body (LEDs on a second MCU, servos on a UART), which means "device capabilities" here is not a display/audio question at all.

**M5StickS3** is awkward because it is the only C++ target (`cxx_std_17`, `-fno-exceptions -fno-rtti`), the only one on M5Unified/M5GFX, and **explicitly half-duplex** — playback is flushed and discarded while the mic is live. Its 12-cell status "ring" is _drawn on the LCD_ (`m5sticks3_visual_layout.hpp`: 180×135 face at x=40, 20 px rail, twelve 3 px cells in a hollow 4×4 ring mirroring HAVPE's sector order), so the same semantic frame already has two physical renderers. Device-side AEC is structurally impossible here; server-side (timestamp-echo) AEC is the only full-duplex path it could ever have.

**Waveshare** is the deliberate outlier on every axis: single-socket transport against the standing dual-socket decision, LVGL instead of direct panel ownership, no `devices/` profile (hence a 3,129-line `main.c`), its own conversation store and tools, its own copy of the light grid and 4× gain (`waveshare_display.c:534-543` says so in a comment: _"COPIED from `platforms/iterate_stackchan_avatar` on purpose and for now… Where the shared version of this lives is a later change"_). It is simultaneously the least integrated board and the only one that has passed a ten-session proof.

**`host_cli`** is awkward because it is not a device but is treated as one — it mounts a capability, holds conversations, and has a runtime device-profile table asserted against `components/core/include/iterate/kit/voice_device_profile.h`. Its real value is the adversity axis: `cli_fault_schedule.c` (529), `cli_delivery_fault.c`, `cli_virtual_clock.c` (ANCHORED/SEALED, fixed-point rate in parts-per-thousand, "reads no host clock ever"). It speaks **Lane B only**.

---

## 4. Transport: two lanes today

### Lane A — "PCM v1"

Control on `wss://<os_base_url>/api` (Cap'n Web). Audio on a **separate** `wss://<pcm_base_url>/pcm`, binary. The protocol has no strings; it is message shape (`components/core/include/iterate/kit/pcm_websocket.h`):

| Dir  | Message                               | Meaning                                               |
| ---- | ------------------------------------- | ----------------------------------------------------- |
| D→S  | 640-byte BINARY                       | one 20 ms mic frame, PCM16LE 16 kHz mono              |
| D→S  | zero-length BINARY                    | ordered end-of-capture-turn (PTT commit)              |
| D→S  | 8-byte BINARY `49 4B 41 01` + `u32le` | cumulative downlink **release receipt** (flow credit) |
| S→D  | 640-byte BINARY                       | one 20 ms speaker frame                               |
| S→D  | zero-length BINARY                    | ordered end-of-response                               |
| both | TEXT / any other opcode               | invalid, rejected at `pcm_lane.c:444`                 |

Receipt size is deliberately neither 0 nor 640 so a peer can classify it before touching the microphone path. **Flow control is credit-based and paced by the codec clock**, not a timer: `pcm_clock_playback.c` renders on hardware edges, `item_released` fires inside the highest-priority playback task and must be allocation-free. The rationale is recorded in `pcm_clock_playback.h`: _"Socket-ingress receipts were rejected because they let a remote timer, rather than the codec clock, control supply and caused physical choppiness when a Cloudflare timer woke 380 ms late."_ Server constants (`pcm-proxy.ts:44-53`): `DOWNLINK_SOURCE_STARTUP_FRAMES = 32`, `DEVICE_INITIAL_LEAD_FRAMES = 16`, `DOWNLINK_RECEIPT_TIMEOUT_MS = 1500`, `MAXIMUM_PROVIDER_RESPONSE_DURATION_MS = 180_000`.

Auth is HTTP headers on the upgrade (`Authorization: Bearer <project_api_key>`, `X-Iterate-Project-ID`, `X-Iterate-Kit-Device-ID`, `X-Iterate-Kit-Audio-Mode` ∈ `"push-to-talk" | "full-duplex-aec"`) plus subprotocol `iterate.kit.pcm.v1`. **Server lives in `c-capabilities`**: `apps/kit/src/userspace/config-worker/routes.ts` + `worker.ts:287-572` + `pcm-proxy.ts` (**2,681 lines**), with the wire decoder shared with the firmware (`device-pcm-wire.ts`). That file's comment states the split intent: _"This app intentionally does not own `/api`: devices connect Cap'n Web directly to OS, while only the binary PCM lane enters userspace."_

**Ships on:** m5sticks3, stackchan, home-assistant-voice-preview-edition. All three now go through one shared `pcm_session.c` owner (§7.5).

### Lane B — "voicelab"

Everything on the one `wss://<os_base_url>/api` Cap'n Web socket. Chain: `authenticate` → `projects.get` → `streams.get(streamPath)` → `openConnection(...)`, default stream path `"/agents/voice/device"`. Audio is base64 mu-law inside stream-event JSON, `ephemeral: true`:

| Direction | Event                                                                            | Payload                                                             |
| --------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| D→S       | `voice-agent/mic-frame`                                                          | `{callId, seq, t, enc:"u", pcm}`                                    |
| D→S       | `voice-agent/turn`                                                               | `{callId, action:"start"\|"commit", t}`                             |
| D→S       | `voice-agent/call-requested` / `call-ended` / `ping`                             | durable / durable / ephemeral                                       |
| S→D       | `voice-agent/spk-frame`                                                          | `{callId, answer, frame, seq, t, tGrok, enc:"u", pcm}`              |
| S→D       | `voice-agent/viseme`                                                             | `{callId, answer, playoutSamples, viseme 0..14, confidence 0..255}` |
| S→D       | `voice-agent/grok-event`                                                         | slim projection of 11 forwarded provider events                     |
| S→D       | `call-accepted` / `call-ended` / `pong` / `turn-committed` / `bridge-redialling` | lifecycle + telemetry                                               |

Delivery is shaped by the device: `maxDeliveryEvents: 16`, `maxDeliveryBytes: 13000`, `state: false`, recycled make-before-break every 600 batches (TS: 700). There is **no pacing** — the listener owns the clock and rejects superseded audio by comparing `(callId, answer, frame)` integers. Downlink ring is 30 s and is explicitly not a jitter cushion: _"a whole answer now leaves as fast as the wire takes it, so the ring is not a cushion any more — it IS the answer."_

**Server does not live in `c-capabilities`** — `voice-agent/*` has zero matches in any `.ts` file there. It is `config-repo/voice-agent.ts` in **this** worktree, committed into a project's config repo and run as a userspace dynamic worker. The firmware reaches it through a baked-in literal (`voicelab_stream.c:24-27`) whose comment records the cost: _"renaming the entry point or moving the config repo needs a reflash."_

**Ships on:** waveshare_s3_amoled, host_cli.

### Why this is the consolidation problem, and why it is already half-solved

Both lanes already share `/api` Cap'n Web, the identical `authenticate → projects.get → provideCapability` mount handshake, and the same frame geometry (`voice_device_profile.h`: `FRAME_MS 20`, `FRAME_SAMPLES 320`, `FRAME_BYTES 640`). `components/core` already hosts both (`pcm_*.c` and `voicelab_stream.c` are siblings). **The divergence is protocol, not portability.**

**Waveshare already proves the target architecture works.** `firmware/targets/waveshare_s3_amoled/README.md:20-22`: _"A deliberate departure from the dual-WebSocket decision in `fable-v2-plan/DECISIONS.md` — this target exists to answer whether realtime PCM survives a single control socket. It does."_ The ten-session proof backs it: 10/10, 40 clean turns, 0 lost frames, first-audio median 692 ms, calls live 7.14–7.17 s, no never-tier counter movement, thresholds never relaxed. The ESP32 sustained 50.0 fps / 8,513 frames / 0 send failures on the earlier RESULTS.md run.

Consequences to state plainly:

1. Two audio protocols with different codecs, flow control and failure models — _not_ two tunings of one design.
2. The two lanes' server halves live in **different repositories**, only one of which has an open PR.
3. `host_cli` — the entire host fault-injection rig — speaks **Lane B only**. There is no `/pcm` host client. **The protocol that three of the four boards actually ship has no host end-to-end test.**

---

## 5. The face and avatar system

### The engine

`apps/kit/firmware/components/avatar/` — 9,997 lines, `INCLUDE_DIRS "include"`, **no `REQUIRES`**: it depends on nothing but C99 and touches no ESP-IDF. It consumes PCM that has **actually completed speaker DMA**, produces a compact semantic pose, and renders a sprite atlas into **caller-owned** memory. It owns no task, queue, display, network connection or framebuffer. Governing rule: _network arrival is not playout_ — a board may **drop** visual observations and jump to the newest physical playout frame, but must **never delay audio** to preserve animation continuity. Snapshots are one-shot, non-blocking, and may fail (a seqlock spin could deadlock the writer it preempted); on a race the caller keeps its last good pose.

Sizes are contract, all `_Static_assert`ed: `face_keyframe_t` = **12 bytes**, `face_render_key_t` = **40 bytes** (schema v2), `face_stage_cue_t` = **32 bytes**, `FACE_VISEME_*` vocabulary 0..14.

```
speaker-DMA PCM ──► face_animator_push_pcm ──┐
server viseme events ─► face_viseme_queue ───┤──► face_pose_t (seqlock snapshot, may fail)
   (advanced by RELEASED samples)            ▼
                       face_render_key_from_pose → face_render_key_t (40 B)
             doze? face_doze_prepare_render_key ─┤
             stage cue? face_stage_cue_apply ────┤
                                                 ▼
                       face_avatar_registry_render
                         ├─ face_performance_apply (27 named ambient clips)
                         ├─ clamp head yaw/pitch ±32, zero roll/body lean
                         └─ face_sprite_render(player, key, sample_clock, rgb565, cap)
                                                 ▼   160×120 RGB565 in caller memory
             doze? face_doze_apply_overlay ──────┤
                                                 ▼   face_scale_rgb565_2x_rows → panel DMA
```

The renderer is a pure function of `(render_key, sample_clock)`; the only retained state is `face_sprite_player_t`'s mouth-debounce history — hence exactly one `face_sprite_render` caller per display, and a history-free `face_sprite_render_snapshot*` for the WASM gallery.

### The render key, and its one semantic trap

The 40-byte key embeds the 12-byte control prefix and adds `viseme, phoneme, viseme_weight, audio_level, viseme_set, viseme_secondary, viseme_blend, speech_phase, mouth_corner_left/right, tongue, cheek, eye_squint ×2, brow_inner, brow_outer ×2, head_roll, affect_valence, affect_arousal, head_yaw, head_pitch, body_lean_x/y, expression_weight, attention, schema_version, stage_expression`.

**`controls.expression` is conversational ACTIVITY** (`IDLE / LISTENING / THINKING / SPEAKING`). **`stage_expression` + `expression_weight` are the independent authored/AI-directed emotion.** Two contributed renderer packs (`fable_cyber_shaders`, `fable_sprite_sheet`) read `controls.expression` as emotion/bank index, so activity value 2 (thinking) renders as "sad" in one and silently selects bank 0 in the other. This is the documented root cause of "the 11 stage-direction rows do not visibly differ."

There is **no (viseme × expression × eye × frame) product table**. The effective render tuple is **`(bank, mouth_slot, lid_stage)`**, resolved as three independent lookups composited in painter order `base → brows → eyes → pupils → mouth → overlay`:

1. **Bank** — short-circuits to `banks[0]` when `expression_weight < 96`; otherwise nearest neighbour by weighted L1 over `(affect_valence, affect_arousal, mean mouth_corner, brow_inner, mean eye_squint)`. Bank 0 is always forced to `neutral`.
2. **Mouth slot (0..22)** — 52-row viseme map lookup when `viseme_weight ≥ 32`, else a role derived from continuous controls indexed into `fallback_slots[9]`.
3. **Lid stage** — `open = control_open × (255−squint) × (255−blink)` into an ordered open→closed lid-cell array.

Current atlases have `sequence_count = 0` and `cycle_count = 0` — **no animation-frame axis exists**; idle motion is a clock-derived translation (`motion.bob`, `saccade_x/y`).

### The sprite/FSPR pipeline and the folder-shaped authoring loop

Format: magic `FACE_SPRITE_MAGIC = 0x46535052` ("FSPR"), version 2. **Pixels are palette indices, index 0 always transparent** — not colour. Not a packed sheet: a flat byte blob of independently trimmed variable-size cells plus a descriptor table, with `offset_x/y` restoring position so trimming never moves anchors; identical cells deduplicated by `(w,h,off_x,off_y,bytes)`. Per-cell **PackBits** or raw, whichever is smaller. `palette.variants` are index-preserving remaps that **share every geometry byte** — a variant costs a new `uint16_t[]` palette plus a second atlas descriptor. `face_sprite_viseme_map_t` maps _any_ vocabulary (OVR15 / VRM5 / Preston9 / Microsoft22 / custom) onto atlas mouth slots; every atlas emits exactly **52** rows = 15+5+9+22+1. Timing constants are all in **16 kHz sample units**. `face_sprite_player_init()` validates every descriptor, cell reference, palette index and compressed stream before an atlas is renderable. Reference: Starbyte = 27 cells, 7,300-byte blob, 5-entry palette, **8,242 B against a 48,000 B budget**.

Three vocabularies that must not be conflated: **23 mouth slots** (`sil pp ff th dd kk ch ss nn rr aa e ih oh ou smile frown grin tongue pucker gasp lateral smirk`) are the atlas's art vocabulary; **9 mouth roles** (`rest press teeth half wide round pucker lip_bite tongue`) are the fallback taxonomy; **5 wire viseme sets** are the interchange. On device only **OVR15** is ever exercised — `face_render_key_from_pose()` hardcodes `viseme_set = OVR15`, `viseme_secondary = NONE`.

Authoring (`apps/kit/tools/sprite-pipeline/`, stdlib-only Python; front door `avatar_pipeline.py` 502 lines, engine `fspp/` 16 modules / 4,754 lines). **A character is folder-shaped and a human supplies exactly three files:**

```
characters/<slug>/
  avatar.json                  # the whole recipe
  source/expressions-v1.png    # one regular grid of expression portraits
  source/mouths-v1.png         # one regular grid of mouth cels
```

`avatar.json` names every cell (`null` marks unused), and carries assembly cell, magenta background, palette (max 4 locked colours + index-preserving variants), rig (canvas `[80,60]`, baseline, eye/mouth boxes, `composition.mode "features_only"`), and `targets[]` (`id "cores3-fine"`, scale 2, frame `[160,120]`, `catalog_slug`, `device_themes`, `max_flash_bytes 48000`). Then: `avatar_pipeline.py brief` emits `authoring_brief.md` + `layout_contract.json` (the agent wrapper is `.agents/skills/sprite-pack/SKILL.md` + `generate_sheet.py`: concept → brief → **two** gpt-image-1 sheets, expressions `[4,3]` and mouths `[5,3]` → numeric gates → previews, under the rule _"the validator rejects, it never promotes — the human is the only promoter"_); drop the PNGs into `source/`; `build` runs 16 stages (background keying → segmentation → fake-pixel-grid snapping → quantise to the locked palette → rig/anchor derivation → 9 validation gates → C emission → manifest + previews), **twice, hash-compared for determinism**; `publish` installs `fspp_<id>_<target>_atlas.c` → `components/avatar/src/`, the header → `include/iterate/kit/avatar/`, and regenerates `face_avatar_catalog_generated.inc`, which `face_avatar_registry.c:17` `#include`s mid-file so the registry array is generated, never hand-written. Gate: `apps/kit/src/firmware/sprite-pipeline-atlases.test.ts` runs `publish --check` under vitest (~55 s) and byte-compares against what is committed.

**Adding a sprite map today costs one manual step that the pipeline does not do, in two files** — the atlas `.c` must be hand-added to `firmware/components/avatar/CMakeLists.txt` SRCS **and** to `firmware/CMakeLists.txt:75-91` (`add_library(iterate-kit-avatar STATIC …)`). `publish` edits neither. This is exactly how `fspp_gameboy_bot_cores3_fine_atlas.c` (905 lines, 57 KB) ended up **tracked in git, compiled by neither build, catalogued by nothing**. 5 of 6 characters ship.

Notably, the ancestor pipeline in `iterate/stackchan` **did not have this problem**: its `publish` copied atlases, **deleted stale `fspp_*` files no character produced**, and CMake `GLOB`ed the sources, so _"no firmware registry or JavaScript edit is ever needed."_ Kit regressed on both prune and glob when it vendored the tool.

### The dead procedural path (stackchan only, ships nowhere)

`iterate/stackchan` has **two** rendering paths sharing only the 40-byte IR, the 16 kHz clock and the 160×120 surface. The sprite (FSPR) path is in the ESP-IDF build and the WASM build. The procedural path — `face_render.c` (215 KB) plus `face_*_actors.c`, `fta_*`, `face_robot_eyes*`, `face_pixel_pack*`, ~**1.5 MB** and **74 profiles** — is in **neither** build (verified: `firmware-ws/main/CMakeLists.txt` SRCS lists only the sprite files; `tools/face-grid/build-wasm.sh` contains zero references to `face_render.c`). Its only live consumers are host-side contact-sheet tools. A procedural family structurally _cannot_ register into the avatar registry (`face_avatar_entry_t` holds only `const face_sprite_atlas_t *`). `face_sprite_actors.c` additionally carries a **second, incompatible sprite container** (magic `"FSA2"`, `FSA_MAX_VISEMES = 32`). Kit deliberately took **none** of it — but `face_render.h`'s 74-profile enum plus five undefined functions leaked into the firmware component anyway and should be deleted.

### The server-side viseme work

`apps/os/scripts/voicelab/config-repo/viseme.ts` (722 lines, **uncommitted**) is a TypeScript adaptation of met4citizen/HeadAudio — MFCC + 39 Gaussian prototypes — measured at **5.8e-6 parity** against the upstream oracle. It turns reply PCM into a smoothed change-track and emits `voice-agent/viseme` on the same ordered outbound lane as the audio, purged by the same answer-identity rule. The device subscribes at `components/core/src/voicelab_stream.c:861`, parses in `handle_viseme()` (354-391), rejects `viseme < 0 || viseme > 14` outright, drains `face_viseme_queue_advance()` against **released** samples with a 300 ms TTL (`VISEME_TTL_WINDOWS = 30`), and resets on barge-in. While a call is active, `face_animator_set_external_mouth()` **gates the envelope's five mouth guesses off entirely** — "a resting mouth over an amplitude-flapping one". Commit `30bf3d693`: _"the mouth is told, not guessed."_ **Eyes are always local** (deterministic xorshift PRNG + a fixed 6-step blink curve `{176, 64, 0, 64, 176, 255}`).

**This lane is Waveshare-only.** `on_viseme` appears only in `targets/waveshare_s3_amoled/main/main.c`, `tests/voicelab_stream_test.c`, and the core/avatar definitions. `face_viseme_queue` is a shared, tested component with exactly **one** production caller. StackChan and m5sticks3 still animate from the local envelope, because the Lane A `pcm-proxy.ts` emits no visemes.

The predecessor on-device model is the reason not to fall back to it: `local/claude-fable-expression-review-result.md` verified the MFCC port bit-faithful (1311/1311 frames) but **measured** the shipped 14 KB model — trained on 4 Kokoro US-English TTS voices — misbehaving on real Grok audio: RR bias 22–28 % on a non-rhotic British voice, SIL chosen in only 13–15 % of clearly-quiet windows, median confidence 14–18/255, and closed-mouth labels **1.46× louder** than open-mouth labels ("acoustically backwards").

### Three adapters, one engine

The shared engine is **4,778 lines**. The per-board adapter layer is **4,826 lines**: `stackchan_avatar.c` (1,612, owns the raw panel + FT5x06, bounded 5,600-byte PNG screenshot encoder, deliberately lossy latest-state mailbox) + `waveshare_display.c` (1,649) + `m5unified.cpp` (1,039) + `waveshare_avatar.c` (526). Each reimplements the same sequence with different doze timers and different mouth sources. The adapter layer is as large as the engine it adapts.

### What would make adding sprite maps easier

- Kill the two parallel build definitions (`components/<x>/CMakeLists.txt` for IDF, `firmware/CMakeLists.txt` for host) or make `publish` write both. Adopt the stackchan pipeline's **glob + prune** behaviour so publish is idempotent and orphans cannot survive.
- `avatar.json` has **no JSON schema and no tests** — the schema documents only the derived intermediate `fspp-spec.json`, and `tests/run_tests.py` never imports `avatar_pipeline.py`, so `assemble()` and the publish install/prune path are untested.
- The lid axis is never populated: every character sets `eyes.blink = "none"`, so `banks[0].eye_left.cells` is always empty and the blink preview is never emitted. Real sprite blinking needs `rig.eyes.blink: "synth"` lid cells, currently **forbidden by `features_only` composition** (`spec.py` hard-requires it). That is an art/pipeline decision, not a code one.
- The documented 10-step assembly line's step 7 — an interactive review for crops, anchors, pivots, z-order and fallback mappings — exists in neither pipeline copy.

---

## 6. The server side

### `config-repo/voice-agent.ts` — one file, four runtime shapes

| Export                           | Kind                                           |     Lines | Role                                                                                                                                     |
| -------------------------------- | ---------------------------------------------- | --------: | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `VoiceAgentEntrypoint` (default) | `IterateWorkerEntrypoint`                      | 3353–3859 | RPC: `health`, `setupVoiceAgent`, `removeVoiceAgent`, `startCall`, `endCall`, `probeGrok`, plus a `fetch()` routing the `voice` app host |
| `VoiceAgentProcessor`            | `StreamProcessor<Contract, Deps>`              | 2988–3262 | The hosted processor: turns `voice-agent/call-requested` into a bridge. **Control plane only.**                                          |
| `VoiceAgentProcessorHost`        | `IterateDurableObject` + `createProcessorHost` | 3273–3351 | The DO the subscription wakes                                                                                                            |
| `VoiceBridge`                    | `IterateDurableObject`                         |  698–2743 | The call itself: the xAI WebSocket, the stream connection, all audio                                                                     |

Four `?mode=` shapes on `VoiceBridge.fetch()`: **`proxy`** (raw client-WS ↔ Grok-WS pump — the measurement baseline), **`bridge`** (audio rides the stream; the client socket carries no audio and is only a lifetime anchor), **`detached`** (no anchor; the call holds itself open with `ctx.waitUntil(finished)` — **this is what a device uses**), **`warm`** (returns `{activeCallId, building, className, ok, token}` and does nothing else; reaching it proves the bridge worker is built and its DO instantiated). The xAI key never enters the isolate: the upgrade fetch carries the literal `Bearer getSecret("/secrets/xai")`, substituted en route to a pinned `api.x.ai` egress — and deliberately withheld from any non-x.ai host, because `grokBaseUrl` is caller-choosable.

### The load-bearing constraint

**Hosted stream processors never receive ephemeral events, and every audio frame in this protocol is ephemeral. The bridge therefore cannot be a processor — architecturally, not by preference.**

Enforced in three places: `stream-event-sender.ts:2026-2032` filters `ephemeral !== true` for hosted delivery; `stream-event-sender.ts:738-742` does the same for copy / itx-call / webhook receivers; `processor-contracts.ts:699-703` throws at contract level (`Processor "<slug>" cannot consume ephemeral event "<type>"`), with type-level exclusion on top. `PRESSURE.md:31-37` states the conclusion outright. Hence `VoiceBridge` is a DO holding an `openConnection`, and `VoiceAgentProcessor` handles only lifecycle — using the obligation pattern, because a 30 s cold build plus a 15 s handshake cannot run under `blockProcessorWhile` (that would head-of-line-block the very `call-ended` that would cancel it): `reduce` folds `pendingCall`, an at-head pass (only when `delivery.caughtUp`) retries a still-fresh call an eviction lost or writes one `call-failed` obituary under a state-derived idempotency key, and `#starting: Set<string>` dedupes within an isolate and is deliberately in-memory so eviction hands the obligation back to the fold.

### Correction: ephemeral does not mean unpersisted

The common phrasing "ephemeral events reach live connections and are never persisted" is two-thirds right and the middle clause is wrong. `ephemeral` is typed `z.literal(true)` (so `ephemeral: false` is a loud input error) and is a **committed field** on `StreamEvent`. Ephemeral events go through the _identical_ commit path (`stream-durable-object.ts:791-936`): the idempotency check applies and conflicts throw, an offset is assigned, the event is folded through `reduce`, and **it is written to SQLite** (`stream-storage.ts:110-134`; column `ephemeral integer not null default 0` at `:47-53`). Point reads by offset or idempotency key **always return them**; only _range_ reads gate (`stream-storage.ts:181`: `and ephemeral = 0` unless `includeEphemeral: true`). Core-state rebuild deliberately re-folds them with `includeEphemeral: true`.

Accurate statement: _an ephemeral event is a fully committed, persisted, offset-bearing, idempotency-checked, state-reducing row that is flagged second-class at read and delivery time — excluded from range reads unless asked for, returned by point reads, delivered live only to session connections opened before it was appended, never replayed, and never delivered to hosted processors, durable subscriptions or the project-worker feed._

**There is no eviction sweep in this tree** — every "evict" mention is defensive plumbing for a future one. So **audio costs stream-DO storage**: a 90-minute call at 50 frames/s each way writes ~**540,000** rows nothing will ever read. Two full sessions of audio move the head ~10,000 offsets — the measurement that killed the brief-tail read design and forced the `voice-agent/brief-current` marker.

Other pinned rules worth carrying: control events cannot be ephemeral; copies never inherit the flag; an ephemeral-only append **still wakes** a hosted processor (`maxOffset` moves) — it just receives a batch with zero events, which is why every per-event switch must guard `event === null`.

### The other constraints the server design is built around

- **The ~1000-push connection ceiling is real, measured and unfixed in the platform.** Delivery to one live callback stops silently after ~1000–1300 pushed batches (worker subrequest budget); appends keep succeeding, the socket stays healthy, no close event. At 50 events/s that is ~25 s of delivery per connection. Mitigation is entirely client-side: `resilient.ts` recycles at 700 batches, the firmware at 600. The append circuit breaker (100k burst / 6M per minute) is nowhere near binding — **the connection ceiling is the constraint, not the rate limit.**
- **The server does not pace; the listener owns the clock.** Four regimes were tried and each was audible: 2× realtime (60 s answer left 30 s queued, shredded the waveform), +5 % drift (same), exact realtime (**45 starves in 3,099 frames**, ~7 s of stutter/minute), realtime+lead (every lead value was wrong for some network). What replaced pacing is identity — `callId` / `answer` / `frame` — which also makes barge-in a purely local act with no round trip.
- **The ordered outbound lane**: at most one append in flight; the queue coalesces whatever accumulates during a round trip into one atomic multi-event append, `MAX_EVENTS_PER_APPEND = 20`; `MAX_QUEUED_EVENTS = 20_000`; on overflow the **oldest `spk-frame` and `viseme` events** are dropped, never transcripts or lifecycle.
- **Mic reassembly**, because the wire does not promise order: every append is an independent DO call, so order rides in the payload. `MIC_REORDER_WINDOW = 16`, `MIC_MAX_LEAD = 64` (beyond which a frame is not reordering, it is _a frame from a different turn_ — the measured failure was turn 1's tail dragging `micExpected` up so every genuine frame of turn 2 was dropped and the provider answered turn 2 having heard turn 1).

### The CLI

19 commands under `apps/os/scripts/voicelab/`, resolved by trpc-cli module mode from `export * as voicelab` in `scripts/cli.ts` — **there are no zod arg schemas**; the `XxxOptions` interfaces _are_ the flag definitions and their JSDoc is the `--help` text. Drivers: `talk` (installs the guest, ensures `/secrets/xai`, reveals the ingress key, then **builds and runs `iterate-kit-cli`** — the same C the device runs), `client`, `bridge`, `device`, `probe`. Gates: `sessions` (the strictest — _"Not a percentage: every frame delivered must be heard"_, `lostFrames == 0` exactly, plus a 37-row `COUNTER_POLICY` in three tiers whose `assertPolicyCoversEveryKnownCounter` throws at startup if `device-stats.ts` knows a counter the table does not), `stress`, `soak`, `reliability`, `prove`, `bench`. Instruments: `pressure` (28 adversarial scenarios against a fake Grok the harness owns on both ends), `wire`, `matrix`, `chronology`.

**One confirmed bug:** `prove.ts:565` and `:604` return `"fail"` / `"pass"`, which are not members of `Verdict` (`:232`; `:1230` gets it right). Because `summary.pass` matches exact strings, the always-running case 1 falls through every bucket: **the run can never report PASS**, and the console prints `failed 0 []` while exiting 1.

---

## 7. Research written up but not built

### 7.0 Keystone: the Kit v2 plan

**Where:** `apps/kit/docs/fable-v2-plan/` — `README.md`, `PLAN.md` (822), `DECISIONS.md` (647), `OPEN-QUESTIONS.md` (313), `exploration/` (26 files, ~9,000 lines). Written in a single day, 2026-07-31, by parallel planning agents while a _separate codex agent_ implemented "v1" in the same worktree. The whole directory landed in one commit (`9f89dd87e`) and **has never been touched since** — four days of subsequent firmware work happened without editing it.

**Proposal** (a minimal-delta refactor, not a rewrite): two new non-blocking audio interfaces, `audio_codec.h` (capture + playback + properties: duplex? has echo reference? already echo-cancelled? owns the sample clock?) and `audio_processor.h` (AEC/VAD); split `components/core` into `core` + `audio` with a CI link test that fails if an audio symbol reaches a no-audio build; every non-audio datum becomes a **64-byte event record from boot**, generated from one `event_types.def` (killing ~7 hand-spelled copies of the metrics schema, ~2,260 lines); wire shape copied **verbatim from apps/os** `StreamEventInput` with idempotency key `kit-device:<deviceId>:<bootCounter>:<sequence>`; transport stays two always-connected WebSockets plus an _optional_ negotiated 16-byte PCM v2 header carrying a **timestamp echo** (each mic frame tagged with the speaker timestamp playing at that instant) as groundwork for server-side AEC; media strictly on demand (connections permanent, frames not — **kills the per-device `/pcm` Durable Object**); `push_to_talk` replaced by `call_control` (connect / hangUp / setMuted) with the provider's server VAD doing all turn-taking on every board; an SD-card event log; per-board profiles as plain data; six numbered stages ending Waveshare → StackChan → HAVPE.

**Status: NOT IMPLEMENTED, verified symbol by symbol.** Absent: `components/audio`, `audio_codec.h`, `audio_processor.h`, `event_types.def`, `event_sd_log`, `sd_card_block_store.c`, `wifi_station.c`, `call_control`, `event_relay`, `m5sticks3_codec.c`, `iterate_kit_audio_profile`, PCM v2 header / timestamp echo, `add_iterate_kit_test()`. Actively **refuted**: the 64-byte event record (`device_events.h` still defines a **2-byte** struct with a comment defending it), PTT's deletion (`push_to_talk.c` still ships, `talk_button.h` is a live one-button PTT-with-latch reducer, and the uncommitted diff is _more_ PTT work), server-VAD-everywhere (`turn_detection: {type:null}` is still exercised in tests and Waveshare runs manual turns with **no VAD anywhere**). The only traces of v2 in code are **two comments that cite it in order to depart from it**.

**Relevance:** this is the only document in the corpus that designs for _four_ devices plus audio-less/mic-only/speaker-only classes as first-class citizens, and its two interfaces are precisely the seams a four-device consolidation needs. Also inherit its `DECISIONS.md` §5 "corrections of record" convention, kept explicitly _"so nobody re-derives the wrong version."_

### 7.1 Audio / AEC

| Proposal                                                                                                                                                                                                                                                                                                                                                                                                    | Status                                                                                                                                                                                                                                                            | Relevance to consolidation                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Idle-gate `aec_process` on far-active (+128 ms hangover)** (`fable-stackchan-aec-post-greeting-review-2026-08-03`). Binary-verified against vendored ESP-SR 2.4.7: `VOIP_HIGH_PERF` is Alibaba `dios_ssp`, internally **8 kHz**; during far-idle it freezes the last far-active reference spectrum while the dual-filter NLMS keeps adapting against it. Idle processing _destroys_ the converged filter. | **NOT IMPLEMENTED**                                                                                                                                                                                                                                               | The highest-value single unimplemented fix in the corpus. Kills the corruption channel _and_ ~60 % of core-1 CPU (`aec_process` costs 9.3–12.7 ms per 16 ms frame, always on). StackChan-only.                                                                                                         |
| **Worker interruption corroboration window** (~250–300 ms, or transcript, before physical purge — no muting, no threshold change). Today the worker treats _any_ `speech_started` as barge-in.                                                                                                                                                                                                              | **NOT IMPLEMENTED**                                                                                                                                                                                                                                               | **Server-side, so it fixes all four devices at once.** A measured 4 ms edge purged a reply in prd; one 7-edge session transcribed `"[noise]"` / `"Fuck."`×3.                                                                                                                                           |
| **Reference = I2S TX ISR tap** (bit-exact digital reference), the central recommendation of three separate 08-03 reviews (~1,700 lines)                                                                                                                                                                                                                                                                     | **NOT IMPLEMENTED — and the code they review no longer exists.** `core_s3_playback_reference_reserve.c` survives only as stale object files under `firmware/.build/host/`; the exact-TX pairing is DELETED at HEAD (`playback_activity_dma` activity bit instead) | Do not design toward this from the documents alone; see §8 for why the ERLE record behind it collapsed.                                                                                                                                                                                                |
| **18 dB reference PGA on mask 1\|2** (`reference-calibration-review`)                                                                                                                                                                                                                                                                                                                                       | **SUPERSEDED** — the ×8 saturating digital scaler (`aec_reference_scaler.c`) shipped instead; PGAs stay 0\|0                                                                                                                                                      | The physics is worth keeping: the CoreS3 "divider" is a differential 150 kΩ series tap with the bottom legs **unpopulated**, so attenuation is set by the ES7210's gain-dependent input impedance. Untested prediction: PGA 12 realises _more_ than PGA 18 (a non-monotonic staircase across code 15). |
| **Route O1→O2→O3** for double-talk (equal branch gains + export dark counters + always-processed probe; then a BSP `mic_selected` fix; then wire the 3-plane trace + an offline speex-MDF falsifier)                                                                                                                                                                                                        | **NOT IMPLEMENTED as written; SUPERSEDED in practice** by `AFE_TYPE_VC` / VOIP profile 3, shipped 2026-08-04 16:14 and driven by a live user observation (ordinary "bye bye" did not interrupt; a loud "STOP PLEASE" did)                                         | The new profile is **explicitly not release-accepted**; the recorded next gate is one quiet-room production run of normal speech plus ordinary-volume double-talk.                                                                                                                                     |
| **Single playback substrate for all boards** (`fable-audio-architecture-alternatives-2026-07-30`, 1,106 lines): one full-duplex `i2s_std` TX+RX pair at boot, ring + blocking writer task (~400 LOC), killing the 4,121-line "fortress" that treats the IDF I2S driver as an adversary                                                                                                                      | **PARTIAL** — per-platform owners exist, but M5Unified is still referenced in 11 files and the §9 migration sequence was never run                                                                                                                                | The only report that costs out a single playback path. Four boards currently reach the speaker four different ways.                                                                                                                                                                                    |
| **`audio_processor` vtable seam before StackChan** (R2 of the firmware architecture review)                                                                                                                                                                                                                                                                                                                 | **NOT IMPLEMENTED — and StackChan's AEC shipped through the hole it was written to close**, so AEC is now welded into `core_s3_audio_owner.c`                                                                                                                     | The direct cause of "two devices share DSP and two share only the transport layer."                                                                                                                                                                                                                    |
| HAVPE AGC→NS tap + worker `uplinkGainMultiplier` ×16 + threshold 0.1                                                                                                                                                                                                                                                                                                                                        | **IMPLEMENTED** (residue: homophone-robust oracle word, a no-unexpected-provider-turns gate, a 60 s echo census, provenance recording)                                                                                                                            | Reusable across all four devices: the Grok VAD level anchors — fires at uplink mean **810 @0.1**, does not fire at 466 @0.1 or peak 12,670 @0.5, **deaf at mean ~70 at any threshold**.                                                                                                                |
| Live AEC tuning knobs over HTTP (`POST /api/audio/aec-reference-offset`, `/aec-nlp`, `/mic-gain`) — stackchan's on-device REST server                                                                                                                                                                                                                                                                       | **Exists only in `iterate/stackchan`; kit has no equivalent**                                                                                                                                                                                                     | This is what made a 70-report offset/NLP/gain sweep possible **without reflashing**. The single most transferable operational asset in that repo.                                                                                                                                                      |
| The 3-channel synchronized capture contract (raw mic / reference / clean recorded in the _same_ audio-frame loop) + `aec_lab.py`                                                                                                                                                                                                                                                                            | Partly reincarnated as `aec_diagnostic_trace` (now wired: StackChan 3 planes × 16,384 samples, HAVPE 2 × 16,000); **the fixture self-test does not exist**                                                                                                        | Recording all three channels in one loop is why stackchan's failures were diagnosable at all.                                                                                                                                                                                                          |

### 7.2 Avatar / face

| Proposal                                                                                                                                                                                                    | Status                                                                                                                     | Relevance                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server-authored visemes, no device fallback (grilled and confirmed)                                                                                                                                         | **PARTIAL** — landed for Waveshare only; StackChan and Stick still guess from the envelope because Lane A emits no visemes | The cleanest example of the pattern consolidation wants (intelligence server-side, dumb typed events on the wire, per-board renderers) _and_ the clearest example of the risk (one board got it, three did not, so a fourth rendering path now exists). |
| A shared performance layer + renderer support for `mouth_round`/`mouth_press`/`mouth_teeth` + render-clock interpolation + retraining on Grok audio (`claude-fable-expression-review-result.md`, 748 lines) | **NOT IMPLEMENTED** (all four recommendations)                                                                             | All four renderers of the day **discarded** three mouth control bytes.                                                                                                                                                                                  |
| A 40-byte→pose adapter + acceptance grid before any bulk renderer import (`fable-renderer-integration-audit.md`)                                                                                            | **NOT IMPLEMENTED**                                                                                                        | Prescribed precisely to catch the activity-vs-emotion trap.                                                                                                                                                                                             |
| Salvage the procedural corpus (`fta_*` is the only family written natively against the dense IR; `face_robot_eyes` has a real behaviour solver)                                                             | **Not decided.** ~1.5 MB orphaned from every build                                                                         | Decide explicitly: salvage two families or discard the lot. Do not assume any of it ships — it does not.                                                                                                                                                |
| Bitmap font + timed transcript presentation (`fable-bitmap-font-v1`)                                                                                                                                        | **Exists only in an untracked stackchan worktree**, named as a requirement by `docs/sprite-avatar-pipeline.md`             | An avatar that shows transcripts needs this and there is exactly one copy.                                                                                                                                                                              |
| `avatar.json` JSON schema + tests for `assemble()` and publish install/prune                                                                                                                                | **NOT IMPLEMENTED**                                                                                                        | The human-authored front door is the only untested stage.                                                                                                                                                                                               |

### 7.3 Transport

| Proposal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Status                                                                                                         | Relevance                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Replace `esp_websocket_client` with a first-party allocation-free RFC 6455 transmit machine (`fable-tiny-c-websocket-research-2026-07-30`, 1,027 lines; ~8 candidate libraries read at source)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | **IMPLEMENTED — the corpus's biggest completed proposal.** `esp_websocket_client` is gone from firmware source | Sets the precedent: the seam-and-policy analysis transferred; no third-party machinery did.                                                                                                                          |
| §8.3 trap list — **four traps still OPEN**: T3 single control slot (two server PINGs in one flush window answer the **older** one; a CLOSE cannot preempt a parked PONG — one-line fix, overwrite-newest); T4 trickle liveness (no time-based frame-age bound; the deferral limit now counts 10 ms probes so restart fires after **~40 ms** of backpressure where it used to take ~1 s); T6 handshake spillover drain (a server that pipelines its first frame behind the 101 **stalls until unrelated traffic arrives**); T9 keepalive ownership (**client PING scheduling and the pong deadline died with `esp_websocket_client` and were never replaced — there is no application-level keepalive on the control socket on any board**) | **OPEN ×4**; _"the connection layer has zero host tests"_ also still true                                      | T9 is the one that bites a fleet: combined with §7.5's orphaned-socket class, it is why a device can look healthy and be unreachable.                                                                                |
| HAVPE long-response fix A: firmware defers socket reads when the ring is full, making **TCP the flow control** (needs a drain-to-EOS ghost guard + worker EOS on interruption); fix B: worker resumes the response across a device reconnect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | **NOT IMPLEMENTED**                                                                                            | Today **any `/pcm` socket death also kills conversation context** (new session id per reconnect). Note the trap: `esp_idf_pcm_transport_test.c:537` is a **GREEN test asserting the bad teardown policy** — flip it. |
| Wi-Fi station extraction + single-defer reconnect ladder (`fable-esp32-station-outage-research`, 857 lines): one disconnect trips both the edge branch and `wifi_retry_later`, so the first reconnect happens at +2 s with backoff already 4→8→16 s                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | **NOT IMPLEMENTED** — `wifi_station.c` does not exist                                                          | The 17–19 s outages decompose as ≤8.5 s driver detection + our own ladder. Also unexplained and unfixed: the control transport did not remount after a **proven** GOT_IP.                                            |
| Debt double-drop cap (`recoveryDropDebt_` → `resetAfterUnderrun()`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | **NOT IMPLEMENTED** (plausible, not hardware-reproduced)                                                       | Userspace overrun-discard and firmware recovery-debt both drop one frame per elapsed slot; past ~400 ms stalls this can become a 1-in-1-out silence treadmill until the END marker.                                  |
| Retain and print `getDiagnostics` churn replies (the harness parses and **discards** them 20×/s, including `wifiDisconnects` and `lastWifiDisconnectReason`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | **NOT IMPLEMENTED**                                                                                            | Zero-firmware fix; retaining first+last costs nothing.                                                                                                                                                               |

### 7.4 Testing / tooling

| Proposal                                                                                                                                                                                                                                                                                         | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Relevance                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The 5-lane off-device rig. Lane (b) — vendored-real `transport_ws` via the `esp_transport_set_func` scripted-parent trick — is the only fully realised one                                                                                                                                       | Lane (a) **PARTIAL**: virtual clock built and better than proposed (`cli_virtual_clock.{h,c}`, ANCHORED + SEALED, fixed-point ppt rate, max 1000×), fault schedule built, fake audio HAL built, **scripted scheduler absent** — and **the SEALED lane is dead code** (grep for `cli_virtual_clock_seal`/`_advance` outside its own files returns only `main.c:732` and its own test, while `adversarial-seams.md` claims "Sealed lane… where regressions are gated"). Lanes (c) mbedTLS, (d) `IDF_TARGET=linux` **NOT IMPLEMENTED**; (e) QEMU **explicitly rejected** | The rig is 3 of 4 primitives away from existing, and the gate it advertises does not exist. Key negative result: **no ESP32 voice product ships an off-device audio rig**; the best prior art is outside the ecosystem (WebRTC `audioproc_f`/`aecdump`, NetEq `rtpplay`, PJSIP `Jbtest.dat`, Zephyr `i2s_native_sim`).                                                                                                                                                     |
| The five-rung test-dependency ladder (pure host → local Node on the LAN → captun tunnel → miniflare/workerd with the actual config-worker → a real apps/os project), with **one media-session module used at every rung**                                                                        | **PARTIAL.** Rungs 1–3 seeded; **rung 4 does not exist** (its prerequisite is that the `/api` proxy target becomes a parameter — it is hard-coded to `os.iterate.com`); **the shared media-session module is not built**, which is the whole point                                                                                                                                                                                                                                                                                                                    | The worked justification is the strongest argument in the corpus for cheap rungs: a scratch-buffer aliasing bug (a whole provider burst arriving as repeated copies of its final frame) was **invisible in production workerd** and caught through the captun tunnel. _The expensive rung masked it._ Today the session logic is **duplicated** between the lab proxy (`DevicePcmProxy`) and the deployed bridge (`PcmSessionBridge`), which diverged within a single day. |
| ~25 lines of attributed far-only window to close the semantic-oracle hole in `prove-production-stackchan-grok.ts`, plus an offline replay driver                                                                                                                                                 | **NOT IMPLEMENTED**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | The invariant is **measured RED, not unproven**: three live-Grok runs on 08-03 each retained a false `speech_started` while the speaker was rendering, the last on the then-current firmware. VAD firing is **spectral, not energetic** — far-only tests must use real speech; fixture noise cannot false-trigger and therefore cannot prove absence.                                                                                                                      |
| Fix the three broken measurement gates: gain-domain bias (`farEndResidualDb` compares a post-gain residual against a **pre-gain** renderer, +18.06 dB), the "recorder did not close complete" misnomer, and the **arithmetically unsatisfiable** double-talk gates (perfect AEC fails by ~19 dB) | **NOT FIXED**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | A consolidation that re-baselines against these will re-baseline against speaker THD.                                                                                                                                                                                                                                                                                                                                                                                      |
| Per-turn `PcmDiagnosticCapture` + sha256 in the Grok proof; replay-with-expectations flags on `replay-production-grok-vad-pcm.ts`                                                                                                                                                                | **NOT IMPLEMENTED**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | A ready replay corpus already exists and is unused (`stackchan-grok-uplink-incident-20260803/*`: "Hey pal" → "Hey Pal." / "Playtime." / "PayPal."), with `accepted-uplink.pcm` + sha256 retained and frames conserved.                                                                                                                                                                                                                                                     |

### 7.5 Device lifecycle

| Proposal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Status                                                                                                                                            | Relevance                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **One shared `/pcm` session lifecycle owner** (`platforms/iterate_esp_idf/pcm_session.c` + `esp_idf_pcm_session.h`), six enforced invariants, **all three Lane A boards call it**                                                                                                                                                                                                                                                                                                                                             | **IMPLEMENTED 2026-08-04 — the most important already-built artifact for this plan.** Acceptance explicitly _not_ claimed; Waveshare is not in it | **The enforcement mechanism is the transferable idea**: raw start/poll/restart/stop declarations moved into a **platform-private** header (`pcm_transport_lifecycle.h`) absent from the public include tree, so _"a target cannot hide a bypass behind a newly named wrapper: direct lifecycle use fails to compile"_ — plus an architecture test rejecting target source that imports it, reintroduces deleted local flags, or writes the hardware media gate from more than the one registered callback. Copy this pattern for every consolidated seam. |
| The multi-device abstraction task (`iterate/stackchan/experiments/02-minimal-realtime-aec/docs/task-multi-device-abstraction.md`) — a **capability matrix rather than product names**: Display · Pixel format · Audio duplex (half / continuous-no-AEC / soft AEC / HW-offloaded) · Mic topology · Speaker reference (none / software tap / HW loopback) · Talk modality (open-mic / PTT-hold / PTT-toggle / wake-word / server-VAD) · Buttons/touch · Indicators · Actuators · CPU-memory class, and five shippable profiles | **NOT IMPLEMENTED — by its own admission** ("a task marker, not the finished design"); its entire "still to invent" checklist is unticked         | **The single most on-point document for this consolidation.** Its key assertion: _"PTT on Stick and open-mic on Voice PE should be the same session with a different talk-modality gate, not two apps."_ Its axes map exactly onto the four boards' real differences. Its unticked items name what must be invented: the board/capability profile schema, intent + presence APIs core depends on (no GPIO in core), the audio backend interface, **how screenless targets project stage IR onto LED rings**, and repo layout.                             |
| StackChan portability notes' adopt / adapt / **reject** ledger                                                                                                                                                                                                                                                                                                                                                                                                                                                                | **LARGELY IMPLEMENTED**, except the synchronized 3-channel diagnostic record with a self-testing harness                                          | Copy the three-way ledger _shape_ verbatim into the consolidation plan. Its reject list is a do-not-migrate list with reasons.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| The endurance ladder (longer speaker-only echo census → 1 → 2 → 10 minute), the mechanical centre-button provenance run, the deployed-worker kill/remount lifecycle                                                                                                                                                                                                                                                                                                                                                           | **NOT IMPLEMENTED**                                                                                                                               | The three board landing docs say it directly: _"do not reinterpret this short vertical proof as endurance."_                                                                                                                                                                                                                                                                                                                                                                                                                                              |

### 7.6 Dead ends — do not redo

| Dead end                                                                                                                                                              | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **WebRTC / Opus over UDP via Cloudflare Realtime SFU**                                                                                                                | Adopted as the target transport, then **cancelled by Jonas the same day after trying it**: _"okay actually we DO NOT want the webrtc stuff now - i tried it… we are doing 'double websocket' for now."_ The whole W1–W4 transport track was deleted. Framed as present-tense, not a forever ban; TCP-stall telemetry is deliberately retained as the evidence that could reopen it.                                                                                              |
| CF Workers terminating WebRTC                                                                                                                                         | Refuted live — Workers/DOs have **no UDP in either direction**.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Grok reachable via WebRTC                                                                                                                                             | Refuted live — xAI's realtime API is WebSocket-only; the "WebRTC Agent" demo is a self-hosted relay, not an endpoint.                                                                                                                                                                                                                                                                                                                                                            |
| `esp-webrtc-solution` as the device transport                                                                                                                         | Closed Espressif-only blob, device-only-testable.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **PRBS31 as an oracle on any lossy lane**                                                                                                                             | Measured refutation: chip-exact decode round-tripped through libopus passes **0–6.5 %** of chips, and Opus PLC lets the tone rung's continuity check **pass during real outages** — the instruments' semantics invert.                                                                                                                                                                                                                                                           |
| **Opus on device, now**                                                                                                                                               | Refused twice. On TCP there is no packet loss, only delay, so PLC is worthless and it buys bandwidth alone (256 → ~25–30 kbps) while costing chip-exact oracles, ~40+40 KB task stacks + ~30 KB codec state against the DIRAM ledger, encode CPU on a 160 MHz Stick, and a negotiated codec surface. **Reopen trigger: bandwidth becoming scarce.** Natural shape when reopened: subprotocol-negotiated beside PCM v1, **uplink-only first** so downlink oracles stay bit-exact. |
| ESP-ADF / ESP-GMF frameworks; rewriting toward xiaozhi's C++ class graph or ESPHome components                                                                        | Refusal upheld with named re-evaluation triggers. Espressif's own latency-critical examples bypass their framework. _Seam placement and backpressure policy transfer; machinery does not._                                                                                                                                                                                                                                                                                       |
| seekaudio AEC                                                                                                                                                         | Eval-only obfuscated blob that links esp-sr internally (**verified by `nm`**); host-untestable. Take only its MIT AECMOS/ERLE harness methodology.                                                                                                                                                                                                                                                                                                                               |
| **Blanket nonlinear (pre-NLP) filter bypass on StackChan**                                                                                                            | **Physically rejected**: ran inside its 32 ms deadline, but **Grok transcribed StackChan's own spoken reply verbatim and created a second response.**                                                                                                                                                                                                                                                                                                                            |
| FD_HIGH_PERF as a double-talk fix                                                                                                                                     | FD has **no DTD** (the ref-VAD hook has zero importers) ⇒ it would make double-talk worse.                                                                                                                                                                                                                                                                                                                                                                                       |
| XMOS loss-control rebuild; threshold tuning below 0.1 (xAI floors there); DAC above 0 dB; tone-mode echo tests (MCRA NS flatters tones); **any adaptive uplink gain** | Explicit NO-GO list.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Multi-waiter C capability slot                                                                                                                                        | Rejected — responder-lifetime-across-`session_ended` is the historic fatal-latch bug class. Keep it one-slot.                                                                                                                                                                                                                                                                                                                                                                    |
| Requiring provider cancellation in any gate                                                                                                                           | **xAI think-fast never cancels on barge-in in practice** — 0 cancellations in every StackChan run ever.                                                                                                                                                                                                                                                                                                                                                                          |
| Pacing designs B (credit flow), C (adaptive lead), D (device-buffered PSRAM)                                                                                          | Considered and rejected with reasons.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Enlarging the 160 ms budget or any queue                                                                                                                              | Explicitly forbidden — the premise was disproven (§8).                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `ld --wrap` on macOS ld64; Renode for ESP32; Wokwi; seedable statistical fault injection (curl WBLOCK / netem / Toxiproxy)                                            | Unavailable or unsuitable, evidenced. Statistical injection is a robustness lane only, never a determinism lane.                                                                                                                                                                                                                                                                                                                                                                 |
| Inheriting StackChan's 12 s drop-newest FIFO or capped retries                                                                                                        | Forbidden; copy only the reconnect-**test** shape (the attempt counter must strictly increase).                                                                                                                                                                                                                                                                                                                                                                                  |
| Proving processor liveness structurally                                                                                                                               | **Three vacuous methods, all disproven.** `getProcessorRuntimeState(...) !== null` proves a fact about the _stream_; a `health()` reply proves _some wrapper_ answered; `this.processor` proves it fetched a function reference and ran nothing. Only an end-to-end token round trip works — now implemented, 13.6 s cold / ~185 ms warm, taking first calls from 16.2 s to 7.7–8.2 s.                                                                                           |
| A `voice-agent` stream **processor** in the call path                                                                                                                 | Architecturally impossible (§6).                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Speaker-active energy gates for the AEC oracle                                                                                                                        | **Never** — VAD firing is spectral, not energetic; energy gates are non-predictive and kill double-talk.                                                                                                                                                                                                                                                                                                                                                                         |

### 7.7 Measured but unfixed

Everything here has evidence attached and no repair.

| #     | Defect                                                                                                                                                                  | The measurement                                                                                                                                                                                                                                                            |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | AEC adapts against a frozen stale reference during far-idle                                                                                                             | onset residual **−26…−35 dBFS for 400–600 ms**; user speech on the same wire **−29.9 dBFS** ⇒ **onset echo ≥ user speech**; every pause→resume leaks −37…−41 dBFS                                                                                                          |
| 2     | Worker treats **any** `speech_started` as barge-in — purge + physical reset, no corroboration                                                                           | a **4 ms** edge purged a reply, live in prd                                                                                                                                                                                                                                |
| 3     | Double-talk duck is real and engine-fixed                                                                                                                               | near gain 0.583 ⇒ dios NLP duck g≈0.29 (−10.7 dB); VOIP is 8 kHz internally ⇒ processed uplink ≤4 kHz, damaging barge-in STT                                                                                                                                               |
| 4     | **Dark counters** — selector, ref-scale clip, slot peak, HPF clip, receipt ledger, AEC µs, recreates: computed and never exported                                       | re-flagged independently by **four** reviews (08-01, 08-02, 08-03 ×2). The single most-repeated unfixed complaint.                                                                                                                                                         |
| 5     | Ref ×8 clips at volume 100, invisibly                                                                                                                                   | ref peak −2.1 dBFS at vol 90; the volume curve adds +5 dB to 100                                                                                                                                                                                                           |
| 6     | Near mic rails during far playback                                                                                                                                      | nearPeak −0.4…−1.1 dBFS (32768) at PGA 24 / vol 90 in **every** run                                                                                                                                                                                                        |
| 7     | The MIC3 reference analog path is unmanaged — **the divider works by accident of reset registers**                                                                      | BSP omits `mic_selected` → `REG4C=0xff`, `REG45` never set, `REG12=0x00`; `reference_gain_db` writes silently no-op                                                                                                                                                        |
| 8     | Two silent DMA pairing slip paths                                                                                                                                       | anchor roulette ~5–18 % per reset; the `+1` continuity check **can never fire** for real DMA loss                                                                                                                                                                          |
| 9     | `fatal_failure_latched` is the leading cause of production "no capability" and is **not in the diagnostics schema**                                                     | the latch uses **lifetime-minimum** stack headroom (856 B vs a 512 B floor) so it is permanently poisonable; a reboot fully heals it                                                                                                                                       |
| 10    | The worker subscription is established **once per `/pcm` socket** with a finite ~15.75 s ladder and never re-subscribed after a control remount                         | silence is undetectable. **`worker.ts` has zero tests.**                                                                                                                                                                                                                   |
| 11–13 | Wi-Fi double-defer; PCM retry gate is Wi-Fi-blind and never reset on recovery (can sleep 13–27 s post-GOT_IP); control transport did not remount after a proven GOT_IP  | 0451: pinged 17 s, zero mounts, against a live accepting server                                                                                                                                                                                                            |
| 15–17 | HAVPE ring-full → deliberate generation retire kills long responses; a `/pcm` socket death kills conversation context; **a GREEN test asserts the bad teardown policy** | `esp_idf_pcm_transport_test.c:537`                                                                                                                                                                                                                                         |
| 20    | `livenessRestarts` moved by **133** in a 9-minute held call                                                                                                             | it counts _requests_, which coalesce (connGeneration reached 3) ⇒ overstates ~40×; should be `livenessRestartRequests`. Best untested hypothesis: a ping delayed behind inbound audio in the control inbox — _the same shape as the server-side recycle-vs-busy-peer bug._ |
| 21    | **The −18 dB rail-sag/brownout fix is uncommitted**                                                                                                                     | BOD level 7 = 2.44 V ⇒ the rail sagged ~0.9 V. Gates the 160→240 MHz flip and confounds every battery/endurance number.                                                                                                                                                    |
| 22    | Zero avatar metrics left the device _(now partly false — see §8)_                                                                                                       | the general metrics wire object has ~120 B headroom in a 2 KiB slot ⇒ new fields need a separate VIEW and a third subscription slot                                                                                                                                        |
| 24    | The semantic invariant is **measured RED**                                                                                                                              | 3 false `speech_started` during playback on 08-03; far-speech residual post-×8 is 0.021 — **exactly the firing rung, zero margin**                                                                                                                                         |
| 25–26 | Four WebSocket traps open (T3/T4/T6/T9); **the connection layer has zero host tests**                                                                                   | §7.3                                                                                                                                                                                                                                                                       |
| 27    | Waveshare downlink: **9–31 frames/s against the 50 realtime needs**, and separately the reader stalls with audio in hand (`ringMs=340`, `played+0`, six seconds)        | accounting balances exactly (90 played + 75 concealed + 1 discarded = 166): nothing is lost, **45 % of playback is self-inserted silence**. The mu-law half was fixed; the reader stall is uninstrumented.                                                                 |

---

## 8. Contradictions and corrections

**Documentation that is provably wrong.**

1. **The stackchan AEC reference documentation is wrong in four places.** `experiments/02-minimal-realtime-aec/docs/aec-validation.md:11-16`, `docs/device-observability.md:28,33-37`, `tools/collect_device_evidence.py:296` and `firmware-ws/main/audio_pipeline.c:296-300` all describe channel 1 as _"the exact PCM written to the AW88298 speaker path"_. **It is not.** It is the **ES7210 analogue loopback on TDM slot 1 (MIC3)**, de-interleaved by the ISR at `audio_pipeline.c:544-548`, with the source comment at `:446-452` saying so and the vendor BSP header agreeing. The software tap **exists but is dead code**: `s_reference_frame` is allocated at `:850` and written from the TX DMA tap at `:701` and **never read by anything** — both `diagnostics_record_frame()` and `audio_trace_record()` are passed `s_hardware_reference_frame`. Empirical proof of the loopback (`local/device-evidence/20260729T202257Z-live-audio-regression/device.log`): TDM one-second peaks `[32768, 3723, 2732, 2]` while the device speaks vs `[32768, 5, 1847, 2]` while a human speaks — slot 1 = 5 while a human saturates slot 0. Anyone reusing this AEC design from the docs alone will build the wrong thing. `docs/architecture.md`'s ASCII diagram also still routes the reference from `levelled PCM → codec/I2S`, i.e. it still describes the dead tap.
2. **`experiments/02-minimal-realtime-aec/docs/claude-review.md` is factually wrong about the shipped hardware.** Its central claim — _"AW88298 … cannot loop back speaker audio onto the I2S bus. There is no reference channel on the wire"_ — is contradicted by the working MIC3 loopback above. (It reviews the abandoned WebRTC port, not `firmware-ws`.)
3. **`docs/github-survey.md` and the _committed_ `docs/architecture.md`** recommend and describe an Espressif `openai_demo` / WebRTC / Opus architecture that was never built. The uncommitted working-tree versions describe what exists.
4. **`apps/os/src/types.ts` no longer exists** (deleted in `1ef08db1a`), but `apps/os/src/README.md:9-11` still calls it "the public contract of record". The contract is now handwritten `apps/os/src/rpc-targets.ts` (8,267 lines) plus generated `itx-api.generated.ts` / `itx-api-graph.generated.ts`.
5. **`remoteCapability` does not exist.** A repo-wide grep finds exactly one hit — the index line in `CLAUDE.md:130`. `docs/remote-apps.md` never uses the word. The real mechanism is `provideCapability`.
6. **`apps/os/scripts/voicelab/README.md`'s event table is stale** — it documents `voicelab/*` where the code and the firmware both use `voice-agent/*`.
7. **`voicelab_stream.h:32-36` says "12, at mu-law" for `MAX_FRAMES_PER_APPEND`** — a stale comment per one catalogue, live truth per the other. **See the direct disagreement below.**
8. **Evidence directory names lie.** `vad-015` / `vad-02` name a threshold that is hardcoded **0.1** in `providers.ts:527-547`. Never trust directory names for config. Relatedly, the firmware build hash is still missing from `capability-description.json`.

**Where the sources disagree with each other.**

9. **Frames per mic append: 4 or 12?** `cat-ccap.md` §3.8 states `ITERATE_KIT_VOICE_MIC_FRAMES_PER_APPEND = 4` (80 ms/append), that the header argues for 12, and that at 12 _"the uplink stopped dead — frames=0 for the rest of a 26-minute soak"_, reverted by commit `1574945ad`; it separately flags `voicelab_stream.h:32-36`'s "12" as a stale comment resolving to 4 via `voice_device_profile.h:74`. `cat-server.md` §4 and §4.2 state the device appends **12 frames (240 ms) per append**, citing the header note at `voicelab_stream.h:16-48` and the measurement that _at 4 frames/append the uplink sat on the ceiling — a 3 s turn put 43,520 bytes on the wire where realtime is 96,000_. **These cannot both be current.** One catalogue read the header comment and one read the resolved constant, or the constant moved between reads. This is the uplink budget for the lane the consolidation is choosing — resolve it by reading `voice_device_profile.h` before any client is written, and delete whichever comment is stale.
10. **Per-board profile polarity.** The v2 plan's stage 3 specifies **one profile struct per board** (`device_profile.h`: frame geometry, ring capacities, gain ceiling, `has_sd`, `has_aec_reference`, `aec_nlp_level`). What exists is the **opposite polarity**: `voice_device_profile.h`, one table shared by all targets, documented as _"the measurement profile shared by the physical and host voice targets… a target may adapt only a physical seam… never in a second copy of this table."_ Both are defensible; the plan must pick.
11. **The interaction model is genuinely contested, three ways.** v2's G18 **deletes push-to-talk entirely** (button connects/hangs up, server VAD everywhere, mute is a device-local uplink gate, `push_to_talk` → `call_control`). `task-multi-device-abstraction.md` keeps **PTT as a first-class talk-modality gate** and argues _"PTT on Stick and open-mic on Voice PE should be the same session with a different talk-modality gate, not two apps."_ Reality ships PTT on the Stick, and **Waveshare runs manual turn-taking with no VAD anywhere** — the exact opposite of the plan's call model, on the board v2 nominated to go first.
12. **The prior-art ERLE record inverted twice in one week.** (i) 08-03 morning: _"prior-art evidence reverses the 'software reference failed' memory"_ — DMA-tap digital reference measured **33.7–50.5 dB** vs the divider's 13.2–16.4. (ii) 08-03 same day: partly corroborates while correcting three of the morning review's own claims — **VOIP's TDE is dead code** in 2.4.7/esp32s3 (objects unreferenced, absent from the link map) so _no_ engine absorbs bulk misalignment; the TX-tap lead is a measured **28–44 ms, not 0.5–2 ms**; `GET_ERLE_CH0_AEC` does not exist on HAVPE. (iii) 08-03 evening, twice independently: **the 33.7 / 50.5 dB record candidates failed their own confirmation reruns** at 12.9 / 21.9 dB with the far phrase verbatim intelligible at similarity 1.000. **Treat 33.7–50.5 dB as single-shot outliers, not a record.** Anyone reading only the morning review will design toward a ceiling that does not exist.
13. **"One byte of IRAM free" — refuted, still propagating.** The linker map shows v1's IRAM code (96,000 B) fills the 16 KB instruction-only block and **legally spills 79,616 B into shared D/IRAM**; new IRAM code links fine at 1:1 DIRAM cost. The real budget is DIRAM: **142,465 B static free / ~77.8 KiB runtime heap**. `home-assistant-voice-preview-edition-vertical-slice-landing-2026-08-02.md` still lists _"reduce or rigorously account for the reported one-byte IRAM margin"_ as a remaining gate, and the DIRAM ledger that should replace it was never opened.
14. **"The AEC runs every frame to stay warm" is exactly backwards** — binary analysis shows idle processing destroys the converged filter. **The comment is still in `core_s3_audio_owner.c`.**
15. **"Steady-state avatar allocates nothing" is false at the driver layer** — `spi_master` on S3 v5.4.2 cannot DMA from PSRAM, so PSRAM TX buffers get a per-transaction internal bounce alloc + memcpy (`spi_master.c:1163-1176`). This explains the 81,307 → ~30 K min-internal-heap delta in avatar runs.
16. **Two memory notes are now stale in the good direction.** "Zero avatar metrics exported" is **false** — a 26-field `KitAvatarMetrics` view exists at `src/device/kit-device-contract.ts:299-325` with `subscribeToAvatarMetrics` wired into the Grok proof. "`aec_diagnostic_trace` is unwired" is **false** — it has real callers at `core_s3_audio_owner.c:716` and `voice_pe_audio_owner.c:1151`, a capability, two host tests, and is present in `iterate-kit-stackchan.map`.
17. **Three 08-03 architecture reviews (~1,700 lines) review code that no longer exists.** `core_s3_playback_reference_reserve.c` survives only as stale object files under `firmware/.build/host/`; exact-TX pairing is deleted at HEAD. **Two stale source comments still claim exact-TX is the AEC reference.**
18. **"160 ms device receive stall" — disproven, firmware exonerated.** Each `4013` is an abrupt bidirectional TCP cessation of **≥4.2 s**; the "8 callbacks / 5,152 bytes / ~157-159 ms" signature is only the last 160 ms, because macOS's 131,072-byte kernel send buffer silently absorbs ~4.05 s of paced audio. Standing instruction: **do not enlarge the 160 ms budget or any queue.**
19. **"The selector removes 92–99 % of near-only"** was measured **only** under an exact-zero exact-TX reference and **never re-measured under the divider** (which is never exactly zero). The probe that would decide whether the selector is deletable has not been run.
20. **`co5300` is not used by any Iterate target** — it appears only inside M5GFX vendor sources under the _m5sticks3_ target, despite being the Waveshare panel controller family name.

---

## 9. The consolidation target

The end state must have these properties:

1. **One architecture serves four boards plus a host/browser client.** Device differences are declared, not branched on: no `if (DEVICE)` trees in shared code, and no second copy of any decision.
2. **One socket, one protocol.** Audio and everything else travel as ordinary stream events through `os.iterate.com/api`. No second origin, no second auth scheme, no separate binary socket, no per-device Durable Object on the media path.
3. **Device differences are abstracted at a declared capability boundary** — duplex class, echo-reference availability, talk modality, display class, actuators — reported once at mount and consumed by the server, so the server behaves differently without the firmware branching.
4. **A consistent UX across boards**: one call lifecycle, one presence/activity vocabulary, one set of conversation lights/status semantics rendered by per-board renderers (WS2812 ring, drawn LCD ring, AMOLED, terminal).
5. **Face movement comes back from the server as ephemeral events** — `voice-agent/viseme` on the same ordered lane as the audio, purged by the same answer identity — on **every** board with a face, with no device-side fallback model.
6. **Adding a sprite map is a pure content operation**: drop `avatar.json` + two grid PNGs, run `publish`, done — no CMake edit, no registry edit, no orphan possible, with a byte-identity gate in CI.
7. **A TypeScript client — browser and CLI — that is a first-class participant** on exactly the same contract as the C: `authenticate` → `projects.get` → `provideCapability` at `itx.kit.<name>` → `streams.get` → `openConnection` + `append`, with the same resilient recycling and the same `(callId, answer, frame)` playout classifier.
8. **Every board's protocol is exercised off-hardware.** No lane ships on a board without a host end-to-end test.
9. **The repository is mergeable**: no tracked build artefacts, evidence bytes out of git with manifests in git, and every branch either merged or explicitly archived.
10. **The measured-but-unfixed ledger (§7.7) is a tracked list**, not folklore, and the broken instruments (§7.4) are fixed before anything is re-baselined.

---

## 10. Open decisions

These must be settled before code is written. Each is stated as decision / options / trade-off / recommendation.

### D1. What happens to the `c-capabilities` branch

**Options.** (a) Rewrite history — `git filter-repo` the 143 commits to drop `apps/.build/**` and the evidence binaries, rebase onto current `main`, open a PR. (b) Import the _tree_: branch from `origin/main`, land the working tree of `cafa736f8` minus `apps/.build/` and minus evidence as a small number of curated commits, and keep `c-capabilities` as an archive ref. (c) Leave it and keep developing on it.

**Trade-off.** (a) preserves commit-level provenance but is a 143-commit rewrite that is also 66 commits behind main, so the rebase is the hard part regardless; conflicts land on firmware nobody can compile-check quickly. (b) loses bisectability of the firmware's own history. (c) compounds daily and guarantees the branch never merges.

**Recommend (b), with a tag.** Push `archive/c-capabilities-2026-08-04` pointing at `cafa736f8` — the history stays on the remote forever and is one `git checkout` away — then import the tree onto a fresh branch. Reason: nothing depends on that branch's history (no PR has ever existed), the _reasoning_ is preserved in the source itself under the house style (`firmware/docs/reasoning-comments.md`: "reasoning comments are part of the correctness proof") and in 90 markdown docs that come across with the tree, and the artefact-to-source ratio (14,798 build files + 3,095 evidence files vs ~1,000 source/doc files) makes any history-preserving path cost more than it returns. Import in this order so review is possible: (1) `firmware/` C/C++ + host CMake, (2) `src/` TypeScript + tests, (3) `docs/`, (4) `tools/sprite-pipeline/`. Fix `apps/kit/.gitignore` to cover `apps/.build/` and delete the doubled `apps/kit/apps/kit/evidence/` path in the same import.

### D2. What happens to the `iterate/stackchan` repo

**Options.** (a) Commit and keep developing it. (b) Commit, then archive read-only and migrate nothing. (c) Commit, salvage a named list into `iterate/iterate`, then archive.

**Trade-off.** The repo is superseded on every axis kit covers — kit strictly dominates on hardware breadth, transport, auth, and testability, and the two share **no** audio, transport, AEC or web source file, so there is no merge path. But it holds three things kit does not have: the only AEC measurement corpus, the only runtime AEC tuning surface, and the only bitmap-font/timed-transcript work.

**Recommend (c).** Salvage exactly five things and archive the rest: (i) the 3-channel synchronized capture contract and `tools/aec_lab.py` + `tools/audio_assess.py` — recording raw mic / reference / clean in the _same_ audio-frame loop is the reason its failures were diagnosable; (ii) the live AEC HTTP tuning knobs (`aec-reference-offset`, `aec-nlp`, `mic-gain`) as kit capability methods, since they are what made a 70-report sweep possible without reflashing; (iii) the three orphan worktrees (H2), keep-or-discard decided explicitly; (iv) the corrected `README.md` / `architecture.md`; (v) `tools/fake_grok_server.py`'s scenario shape, if `fake-grok.ts` does not already cover it. Explicitly **discard** the ~1.5 MB procedural renderer corpus unless someone names a use for `fta_*` (the only family written against the dense IR) — it ships nowhere, in neither build, and carries a second incompatible atlas container. Reason: the value is measurement and tooling, not code.

### D3. Which transport lane survives

**Options.** (a) Lane B everywhere — everything through `/api` streams. (b) Lane A everywhere — restore the binary `/pcm` socket as the audio path. (c) Bless both, per board.

**Trade-off.** Lane B is proven on one board (10/10 sessions, 0 lost frames, first-audio median 692 ms) and is the stated goal, but it is the lane with no credit-based flow control: it free-runs into a 30 s ring, and the one open Waveshare defect is exactly starvation (9–31 frames/s against the 50 realtime needs; 45 % of playback self-inserted silence). Lane A's credit pacing by _hardware release receipts_ is a genuinely better flow-control story, and Lane A carries the two AEC-bearing boards whose acoustic behaviour has been tuned against it. (c) is the status quo and costs two protocols, two server halves in two repos, two failure models and — measured twice in one week — the duplicate-decision failure mode (§10 D6).

**Recommend (a), sequenced, and do not pretend the flow-control question is settled by the decision.** Lane B wins because the goal is one socket and because the second origin, second auth scheme, second server repo and 2,681-line proxy are pure cost. But adopt Lane A's one genuinely superior idea into Lane B before moving the AEC boards: the device already knows how many samples the DAC has _released_, and the current protocol throws that away. A per-answer release count riding on the existing `voice-agent/turn`-shaped lane (or on the `dev-stats` cadence) gives the bridge the depth signal it needs without reintroducing a socket. Explicitly retire `apps/kit/src/userspace/config-worker/pcm-proxy.ts` and the `/pcm` route when the last board leaves Lane A — do not leave it as a fallback, because a fallback is a second decision.

### D4. Does audio stay mu-law-over-JSON, or move to binary

**Options.** (a) Keep base64 mu-law inside Cap'n Web JSON. (b) Build a binary lane through streams. (c) Opus.

**Trade-off.** The instinct that JSON+base64 is wasteful is wrong on the measured numbers: 20 ms is 640 B as PCM16, 320 B as mu-law, ~428 chars base64, **~520 B on the wire including the event envelope** — _smaller_ than the 640 B binary frame Lane A sends. The real costs are CPU (mu-law + base64 both ends, on a device with a 7,600-byte args buffer that has already overflowed once and silently disconnected the microphone) and 8-bit companded quality. A binary lane through streams does not exist today and would be new platform surface. (c) is a recorded dead end with a named reopen trigger.

**Recommend (a), and record the arithmetic so it stops being re-litigated.** Keep base64 mu-law. Revisit only on a measurement — either device CPU attributable to encode/decode, or a per-event size ceiling that binds. If it is ever revisited, the right move is a binary _value_ inside the same Cap'n Web envelope (one lane, one ordering, one connection), never a second socket. Opus stays closed with its stated trigger (bandwidth scarcity) and its stated shape (subprotocol-negotiated beside PCM, uplink-only first).

### D5. Does the bridge stay a Durable Object

**Options.** (a) DO holding `openConnection` (today). (b) Stateless worker per call — the v2 position, _"why wouldn't our audio websocket proxy between us and grok be a stateless worker?"_ (c) Stream processor (impossible, §6).

**Trade-off.** The v2 argument was "nothing needs to outlive a conversation", which is true — but a DO keyed per stream path already dies with the call, so statelessness buys nothing here. What the DO buys is an _addressable identity for the call_, and the current design leans on it hard: `#activeCallId` / `#startingCallId` latched before any slow work with a 60 s staleness release, cross-isolate stand-down when a bridge sees `call-accepted` for its own `callId` from a different `bridgeId`, a 65-minute watchdog, a 15 s handshake timeout, and redial-with-history-replay (the provider closes on its own schedule — measured at 296 s into a soak — and the last 24 turns are replayed as a `conversation.item.create`). None of that existed when "stateless worker" was decided.

**Recommend (a).** Keep the DO. Reason: the supersede/stand-down protocol requires a name for the call, and a stateless worker would have to reinvent it in the stream. The one change worth making is bounding the failure mode nobody has a signal for: `MAX_QUEUED_EVENTS = 20_000` ≈ 6 min of speech, and past that _"the failure is a DO OOM with no event, no reason and no obituary"_ — emit an obituary before the ceiling, not at it.

### D6. How device differences get abstracted

**Options.** (a) Build-time board profile struct per board (v2 stage 3). (b) One shared table with named seam overrides (`voice_device_profile.h`, what exists). (c) Runtime capability negotiation — the device declares what it is and the server adapts.

**Trade-off.** These are not alternatives; they answer different questions and the corpus conflates them. Memory sizing (ring slot counts, frame geometry, IRAM/DIRAM budgets, `max_flash_bytes`) _must_ be build-time — it is `_Static_assert`ed and it is what makes the bounded design provable. Server behaviour (does this device do AEC? is it half-duplex? does it have a face? does it consume visemes? what is its talk modality?) _must_ be runtime — otherwise the server carries a board table and every new board is a server deploy.

**Recommend a hard split with a named boundary.** Build-time: anything that sizes memory or is asserted at compile time — keep the shared `voice_device_profile.h` table with per-target seam overrides (option b), not four structs, because the v2 per-board struct polarity would re-fragment the one thing that is already consolidated. Runtime: a declared capability record carried in the **mount's `instructions` + `types`**, which is already the single source of truth the voice prompt quotes verbatim (`describeProvidedCapabilities`) and is already answered from **provide-time metadata** so it works with the device offline. Use the multi-device task's axes as the record's schema — duplex class, speaker-reference class, talk modality, display class, indicators, actuators — because they map exactly onto the four boards' real differences. And enforce it the way `pcm_session.c` enforced its seam: a platform-private header plus an architecture test, so _a bypass fails to compile_ rather than failing review. Make "N copies of one decision" a lint: the two most expensive bugs of the week (the self-renewed idle lease, and five speaker-abandon sites with three orderings) were both duplicates, not logic errors.

### D7. Where visemes are computed

**Options.** (a) Server only, no device fallback (today, Waveshare only). (b) Device only (the stackchan `face_viseme.c` + 6,472 B state + 14,352 B model). (c) Server with device fallback.

**Trade-off.** (b) is measured bad on real audio: RR bias 22–28 % on a non-rhotic British voice, SIL chosen in only 13–15 % of clearly-quiet windows, median confidence 14–18/255, and closed-mouth labels **1.46× louder** than open-mouth labels. (c) sounds safe and is the worst option — it guarantees two mouth implementations, which is precisely the divergence class that has cost the most.

**Recommend (a), unchanged, and close the gap by lane rather than by code.** The decision is already made, grilled, and measured at 5.8e-6 parity. Accept the stated consequence: no viseme events means the mouth does not move (envelope mouth gated off by `face_animator_set_external_mouth`, disconnected → awake-idle 3 min → doze). StackChan and the Stick get server visemes **for free the moment they move to Lane B** (D3) — which is a strong argument for doing D3 before touching the face code at all. Do not add visemes to `pcm-proxy.ts`.

### D8. How the TS client shares code with the C client

**Options.** (a) Share nothing; port. (b) Generate both from one schema (v2's `event_types.def`). (c) Compile the C to WASM and run it in the browser.

**Trade-off.** The client's whole job is six steps, five of which are pure protocol: authenticate/navigate (3 Cap'n Web calls), mount at `itx.kit.<name>`, `setupVoiceAgent`, open a recycled downlink connection, append five event types, classify and play. The new TS is ~350 lines plus `resilient.ts` verbatim. (b) buys type safety over six event types at the cost of a codegen stage nobody has built and the v2 plan's own generator never landed. (c) drags the bounded-allocator design — 7,600-byte args buffer, 2 KiB outbox slots, fixed token pools — into an environment that has none of those constraints, and gives the browser the device's limits for free.

**Recommend (a) with exactly one shared artefact: the spec, not the code.** Port. Keep `components/core/include/iterate/kit/audio_playout.h` as the normative statement of the three-action classifier (`IGNORE` / `APPEND` / `REPLACE` from `(call, answer, frame)`) — it is already written as a full spec with the counter semantics argued out, including why `replaced` fires once per answer _always_ and why `gaps` are counted where the hole appears and never inferred by subtraction. Have the TS classifier cite it by path and mirror its counter names, so a divergence is visible in a diff. Extract the recommended seam: a platform-agnostic `VoiceParticipant` owning connect → mount → setup → call lifecycle → mic encoding/pacing → downlink classify/decode → counters, with two injected ports (`MicPort { onFrame(pcm: Int16Array) }`, `SpeakerPort { write(pcm), clear(), depthMs() }`) — Node fills them with sox, the browser with `AudioWorklet`. That is the same seam the C already has between `components/core` and `targets/*`.

### D9. What the browser auth story is

**Options.** (a) `project-secret` (`/secrets/project-api-key`) in the page. (b) `admin-secret`, as every voicelab TS command uses today. (c) `project-app-session` (`auth.ts:104`, `docs/remote-apps.md:44-56`): a short-lived HS256 token minted by a project app's own server after the config worker's `iterate-project-auth` cookie identifies the user.

**Trade-off.** (a) is a long-lived machine credential that must never reach a page. (b) is an operator credential. (c) is the only lane the platform actually provides for a browser, and it has a structural cost: the client must be **served by a project app** (a `voice--<slug>` page), not shipped as a bare static bundle.

**Recommend (c), and accept the serving requirement as a feature.** A served page is also where the config worker can inject the stream path and mount name, which removes the device's whole reflash-to-rename problem. Two boundaries to design around: a live capability whose `fetch()` upgrades WebSockets **cannot** serve a project app host — the socket dies crossing the internal workerd RPC hops (pinned at `apps/os/e2e/vitest/live-capability-websocket.e2e.test.ts:6-24`) — so the page's socket must be the platform `/api` socket; and mount names are platform-enforced to `/^[A-Za-z_$][A-Za-z0-9_$]*$/` with a reserved list, which is where `talk.ts`'s "NO HYPHEN" rule comes from (`mac-$STAMP` never once connected). For the **Node CLI** there is no question at all: `project-secret` is exactly what `iterate-kit-cli` already uses.

### D10. Does `host_cli` survive once a TS CLI exists

**Options.** (a) Delete at TS parity. (b) Keep as-is. (c) Keep, re-scoped.

**Trade-off.** As "a CLI that holds a conversation", the TS client supersedes it — better auth story, no build step, shares the browser's code. But that is not what it is. `host_cli` is the only thing that runs **the same C the device runs** against a runtime device-profile table, a virtual clock (ANCHORED/SEALED, "reads no host clock ever… every run of a seed identical"), a pre-drawn fault schedule with a 1024-slot fate table, and delivery-boundary fault injection. Nothing else can catch a firmware regression off-hardware, and `talk.ts` already depends on it.

**Recommend (c): keep it, re-scope it, and stop calling it a CLI.** It becomes the C parity + fault rig; the TS client becomes the human driver and the Lane-agnostic participant. Two concrete follow-ons: the Lane A host-e2e gap closes by _deleting Lane A_ (D3), not by writing a `/pcm` host client — so do not build one; and the **SEALED virtual-clock lane is currently dead code** (referenced only from `main.c:732` and its own test) while `adversarial-seams.md` claims it is "where regressions are gated" — either wire it or delete the claim, because a documented gate that does not exist is worse than no gate.

### D11. Does audio keep costing stream-DO storage

**Options.** (a) Accept it. (b) Add a platform eviction sweep for ephemeral rows. (c) Keep audio off streams (contradicts the goal).

**Trade-off.** "Everything through normal streams" is only affordable if ephemeral rows can be reclaimed. Today a 90-minute call writes ~540,000 rows that nothing will ever read, and the head movement is already load-bearing on read design (two sessions of audio move the head ~10,000 offsets, which is what killed the brief-tail read and forced the `brief-current` marker). The rows are already _declared_ evictable; nothing evicts them.

**Recommend (a) now, (b) filed as a platform change with a number attached.** Measure bytes-per-call in the current SQLite before deciding urgency, then file the sweep with that number. Reason: this is not a blocker for the consolidation, but it is the one platform-level assumption the whole "audio through normal streams" architecture rests on, and it should be an owned item rather than an unstated bet.

### D12. Which interaction model wins — PTT or `call_control`

**Options.** (a) v2's G18: delete PTT; button connects/hangs up; server VAD everywhere; mute is a device-local uplink gate. (b) The multi-device task's: keep PTT as one talk-modality among several. (c) Status quo: PTT on the Stick, manual turns on Waveshare, server VAD on HAVPE/StackChan.

**Trade-off.** v2's model cannot be universal: the Stick is **half-duplex** (playback is flushed while the mic is live) and Waveshare has **no AEC at all**, so an open mic on either is a self-trigger loop — and the measured barge-in defects (a 4 ms `speech_started` edge purging a reply) are exactly what an open mic on an echo-bearing board produces. The multi-device task's model cannot be universal either: four talk modalities means four session shapes unless something above them is common. Both documents are half right.

**Recommend a split neither document makes.** **Call lifetime is `call_control` (v2 wins):** one `connect` / `hangUp` / `setMuted` surface on every board, replacing `push_to_talk` as the lifecycle capability. **Turn-taking is a declared modality (the multi-device task wins):** `manual` (explicit `voice-agent/turn` start/commit edges) vs `server-vad`, declared in the capability record (D6) and chosen by the device's duplex/echo class, not by the server guessing. This makes the task doc's assertion literally true — _the same session with a different talk-modality gate_ — while keeping PTT where physics requires it. Accept and record v2's honest cost note: an open call is a hot mic, and PTT was accidentally privacy-preserving.

### D13. What happens to 2.7 GB of tracked artefacts

**Options.** (a) Keep tracked. (b) Git LFS. (c) External artifact store with sha256 manifests in git.

**Trade-off.** The evidence naming discipline is genuinely valuable — `-valid`, `-network-valid`, `-rerun`, `-final`, `-baseline`, `-warmed` encode the honesty rule that invalidated runs are retained beside their clean repeats rather than deleted, and `collect_device_evidence.py` already emits a SHA-256 manifest per bundle. None of that requires the bytes to be in every clone. LFS keeps the coupling and adds a dependency.

**Recommend (c).** Manifests, `manifest.json`, campaign names and any `.md` in git; PCM/WAV/AIFF/PNG bytes in an object store keyed by the existing sha256. Reason: 3,095 of 4,140 tracked files under `apps/kit` are evidence, which means the repo's shape currently misrepresents what the project is.

### D14. What the first shippable increment is

**Options.** (a) Big-bang consolidation onto the new architecture. (b) TS client first. (c) Move one Lane A board to Lane B first. (d) Preservation and repo hygiene only.

**Trade-off.** (a) has no shippable intermediate state and would freeze four boards at once. (d) is necessary but produces no architecture. (b) and (c) are both real increments; the question is order.

**Recommend a strictly ordered four-step increment, each step independently shippable.**

**Step 0 — preservation (hours, no architecture).** H1–H5 in order. Commit stackchan; rescue the three worktrees; archive `local/`; push this worktree's two commits and land (a)/(b)/(c)/(d) as four commits; commit the Stick cue work. Nothing else starts until this is done — four independent reviews already flag that the substrate is uncommitted, and the memory note is blunt: push every milestone.

**Step 1 — make PR #2376 mergeable and land the server side.** The rename is the highest-interest debt in the tree because the firmware already emits `voice-agent/*` and neither side is committed. Fix the `prove.ts` `Verdict` typo while in there. This ships value with zero device risk.

**Step 2 — the TS participant as a Node CLI, at parity with `iterate-kit-cli` on Lane B.** ~350 lines plus `resilient.ts` verbatim: mu-law both ways, `(callId, answer, frame)` classification, manual turn edges, `colleague`/`turns` on `call-requested`, 12-frames-per-append (after resolving §8 item 9), `setupVoiceAgent`, mount at `itx.kit.<name>`, `project-secret` auth. Needs no hardware. **This is the highest-leverage single step in the plan**, because it gives Lane B a second independent implementation — something the fleet has never had — and every subsequent board move can be diffed against it. The browser client is then this plus `AudioWorklet`, 48 k→16 k resampling (~30 lines) and D9's auth lane.

**Step 3 — move exactly one Lane A board to Lane B: the M5StickS3 first.** It is the cheapest honest proof that Lane B carries a board that is not Waveshare: no AEC to re-tune, PTT/half-duplex so turn edges are explicit, and it already has a `devices/` profile and a simulator. Then **HAVPE** (proves the screenless profile and the hardware-AEC class, and its downlink death is a flow-control test Lane B needs to pass anyway). Then **StackChan last**, because it is the only board with software AEC, the one with the open double-talk and dark-counter work, and therefore the one where a lane change and an acoustic change would be indistinguishable if done together. Retire `pcm-proxy.ts` and the `/pcm` route only when the third board lands.

Everything else in §7 — the `audio_processor` seam, the sprite-map build unification, the AEC idle gate, the barge-in corroboration window, the WebSocket traps — queues behind these and should be scheduled against the §7.7 ledger, not against the documents that proposed them.

---

# 11. Decision log

Answers from the grilling session, newest last. Each entry records the decision,
the reasoning given, and anything it forecloses. Following `DECISIONS.md` §5 from
the v2 plan, corrections stay in place rather than being edited away, so nobody
re-derives a superseded answer.

## Facts settled by lookup (not decisions)

**F1 — mic frames per append is 4, and the header lies about it.**
`components/core/include/iterate/kit/voice_device_profile.h:74` sets
`ITERATE_KIT_VOICE_MIC_FRAMES_PER_APPEND = 4`.
`components/core/include/iterate/kit/voicelab_stream.h:39` aliases
`ITERATE_KIT_VOICELAB_MAX_FRAMES_PER_APPEND` directly to it, under a comment
reading "12, at mu-law". The comment describes an intent the value does not
implement — the two catalogues disagreed because each read a different one.
Anything that ports the uplink (the TS client above all) must take **4** from the
profile rather than either comment. The neighbouring comment on the same constant
records why 8 failed: eight frames needed ~7.8 KiB of base64 against a 7,600-byte
buffer, so the encode ran out of room and the append was abandoned _with the
microphone silently disconnected_. Whatever replaces this needs that failure to
be loud.

## Decisions

### D2 — `iterate/stackchan` becomes a read-only archive. **DECIDED: (b).**

Preserve first, regardless: commit all 981 untracked files on a branch (`local/`
and `upstream/` stay ignored), archive the 9.5 GB `local/` corpus separately, and
capture the three `.claude/worktrees/` explicitly — a `git add -A` in the main
tree does **not** reach them.

Then freeze it. The useful parts move into `apps/kit` once, and nothing is spiked
there again.

**Reasoning.** The fork already cost us. `components/avatar/README.md` records
that the engine "was extracted from the measured StackChan prototype"; kit has
since forked ahead and nothing has flowed back. The visible price is the
_procedural_ face path — ~1.5 MB across `face_*_actors.c`, `fta_*`,
`face_robot_eyes*`, `face_pixel_pack*` — which ships in neither the ESP-IDF nor
the WASM build and which kit never took. It exists because nobody had to decide.
A second copy of the sprite pipeline would repeat that.

**What this forecloses.** There is no longer a scratch repo where acoustic
measurement can happen without touching the product repo. Anything that replaces
it has to live in `apps/kit` and be tolerable there — which raises the bar on the
measurement tooling (§7.4) rather than lowering it.

**What must move before the freeze** (from §5, §7): the `avatar_pipeline.py
publish` authoring loop, the WASM face-review room, the Remotion video rig, the
live AEC HTTP tuning knobs (`/api/audio/aec-reference-offset`, `aec-nlp`,
`mic-gain`), the 3-channel synchronised capture contract, and the unapplied
memory audit. The 70+ AEC reports are evidence, not code — archive, do not port.

### D1 — `c-capabilities` is NOT merged. **DECIDED: keep as backup only.**

143 commits, pushed, no PR, and it stays that way. It is a backup branch, not a
merge candidate. The artefact-cleanup work described in H6 therefore does not
need doing — nothing is landing.

**Consequence:** this worktree has no firmware at all (`apps/kit/firmware/` does
not exist here — verified). The firmware must be brought over deliberately, file
by file, and NOT wholesale. See A3 below.

### A1–A3 — Anchors fixed before planning

**A1. Waveshare's stream-backed audio is the reference design for every board.**
All media travels as Cap'n Web stream events over ONE `/api` socket. The binary
`/pcm` lane is retired. Rationale from Jonas: the Waveshare pipeline — stream
audio plus manual push-to-talk, no AEC, no server VAD — "worked incredibly well"
and is a solid pipeline; it becomes the starting point for all devices rather
than one option among several. Consequence: every R-item and v2 stage that
exists to serve `/pcm` dies with it.

**A2. Push-to-talk stays, on every board.** This REVERSES the v2 plan's decision
to drop PTT for `call_control`. PTT is also the entire echo story on the two
boards with no AEC — removing it would be a real acoustic regression, not a
simplification.

**A3. Take as little as possible from `c-capabilities`.** Default is re-derive,
not port. Anything adopted must earn its place explicitly and be named.

**A4. First-party vendor documentation is the anchor everywhere.** Espressif's
own docs and example code, and the silicon vendors' datasheets and reference
designs, are generally of high quality and must always be considered before we
invent. This applies to audio pipeline design, register programming, gain
staging, power sequencing, provisioning and flashing.

### D10 — `host_cli` survives. **DECIDED.**

It stays as the acoustic and fault-injection rig — a real macOS voice target with
CoreAudio, not a mock. The TypeScript client becomes the _product_ client. Two
artefacts with different jobs, rather than two clients competing.

### D12 — Push-to-talk. **DECIDED: PTT stays.** See A2.

### D6 — Device profile polarity. **DELEGATED to Claude.** Recommendation to be

made once the deep-dive research lands; must be justified against A1/A3 rather
than inherited from v2.

### Research pass — five deep dives (2026-08-04)

Files: `deep-waveshare.md` (1205 ln), `deep-espressif.md` (873), `deep-silicon.md`
(710), `deep-v2judge.md` (813), `deep-flashing.md` (931), all in the scratchpad.

**Findings that change the plan:**

**R-A. ES8311 exposes a free hardware echo reference, and we throw it away.**
Register `0x44 ADCDAT_SEL = 5` routes DACR into the right ADCDAT slot; the user
guide (§10.4 p.25) says verbatim it is "helpful in the application which need to
do echo cancellation". Waveshare sets `no_dac_ref = false` — so the reference IS
already being generated — and then reads the codec as **mono**, discarding it.
Both ES8311 boards (Waveshare, M5StickS3) get a sample-aligned reference for the
cost of reading stereo. This is the cheapest AEC on the table by a wide margin.

**R-B. [RETRACTED — see R-N.] StackChan's ES7210 reference channel is powered down.** The BSP never sets
`mic_selected`, so Espressif's driver defaults to MIC1|MIC2, leaves
`MIC34_POWER (0x4C) = 0xFF` (MIC3/MIC4 **off**) and, with fewer than 3 mics
selected, writes `SDP_INTERFACE2 (0x12) = 0x00` — **TDM is never enabled**.
`set_in_channel_gain(MASK(2), …)` is gated on `mic_select` and is a silent no-op.
The entire CoreS3 AEC reference story stands on a channel that is not on. This
strongly corroborates A3: the StackChan AEC work is not a foundation to port.

**R-C. Our ES8311 "mic gain" knob is a no-op.** `esp_codec_dev_set_in_gain(24.0f)`
writes `0x16 ADC_SCALE` — a _digital_ OSR-compensation gain whose reset default
is already 24 dB. The analog PGA is `0x14 PGAGAIN[3:0]`, which `es8311_start()`
pins at 0x1A = 30 dB (max) and which we never touch. The same write also clears
`ADC_SYNC` (0x16 bit 5) that `es8311_open()` had set.

**R-D. The flasher already exists on `main`.** `apps/kit/src/firmware/` ships ESP
Web Tools + `ITERKIT1` + `esptool-js@^0.6.0`. Take nothing from `c-capabilities`
for it. Two cheap gaps: no `deviceId`/boot counter in `config-image.ts` (~20 ln),
and `readFlash()` exists in esptool-js but is unused, so there is no verification
or diagnostics read-back.

**R-E. A1 pays for A2.** The v2 case against push-to-talk was a list of _two-lane_
ordering problems — commit race, tail-delivery guard, in-band end-of-turn frame.
On one ordered stream they do not need rebuilding; they need not building.

**R-F. Espressif publishes an explicit DMA sizing formula**
(`esp-idf/docs/en/api-reference/peripherals/i2s.rst:1210-1238`):
`interrupt_interval = dma_frame_num / sample_rate`,
`dma_buffer_size = dma_frame_num * slot_num * data_bit_width / 8 <= 4092`,
`dma_desc_num > polling_cycle / interrupt_interval`. Every board's ring geometry
should be derived from it and shown to be derived, not chosen.

### D6 — Device profile polarity. **RECOMMENDED: split by what the value sizes.**

The two positions are not actually opposites. `hardware-plugability.md` never
argues against the global table — it attacks a seven-place scatter of _board_
knobs. Its own rule is the answer: **split by whether the value sizes storage or
describes hardware.**

- The ~28 supervision constants (frame sizes, ring depths, timeouts, the
  measurement invariants) stay in ONE global table. These are what make the
  acoustic oracles comparable across boards; a second copy is how they drift.
- Genuine hardware facts (duplex? reference channel? gain ceiling? owns the
  sample clock?) move into `audio_codec_properties` on the codec seam.
- The per-board struct exists only for the scatter — the knobs that are today
  spelled in seven places.
- Copies are allowed where a copy is genuinely needed (the host rig), but each
  copy gets a drift test, generalising what `cli_device_profile` already does.

**Decisive evidence:** M5StickS3 _already_ bypasses the global table with its own
arena constants differing by up to 16×, with no test linking them. The "never a
second copy" rule is already violated in silence — a ban that is not enforced is
worse than a copy that is tested.

**R-G. `MALLOC_CAP_SPIRAM|MALLOC_CAP_DMA` always returns NULL on ESP32-S3.**
`heap/port/esp32s3/memory_layout.c:65` never grants `MALLOC_CAP_DMA` to the SPIRAM
region — while `mem_alloc.rst:112` tells you to use exactly that combination. That
is the mechanism behind the avatar framebuffer blocker. No such allocation exists
in the current tree (the face buffer is `SPIRAM|8BIT` and sound), but it is a
permanent trap for anyone adding a DMA buffer later, and the docs will mislead
them. **Source beats docs** — that rule should be written into the plan.

**R-H. `on_sent` semantics, and a caveat on the ledger.** One callback per
descriptor is guaranteed (every descriptor has `eof=1`, the chain is circular),
and it fires from the ISR _during_ a write — which is why Waveshare reserves
credit before writing, and that part is correct. But a _strict_ ownership ledger
is unsound at source level: the queue holds `desc_num−1` and the ISR **silently
discards** a queued pointer on overflow. Waveshare already works around this by
measuring starvation on the writing task against an absolute deadline
(`dma_empty_at_us`) rather than by counting callbacks — a 600 ms injected gap
moved the ISR counter by zero, which is what forced that design. Keep the
deadline; do not promote callback counting to a correctness signal when porting.
(The harsher critique — that equal TX/RX EOF counts imply the same instant — was
levelled at the _stackchan_ `firmware-ws` tree, not at the Waveshare target.)

**R-I. `i2s_channel_write`'s `timeout_ms` is per DMA-buffer acquisition, not per
call.** The real bound is `(1 + buffers) × timeout`; `esp_codec_dev` passes
1000 ms. Any watchdog around a write must use the real bound.

**R-J. First-party sources disagree on the esp-sr reference slot index** —
esp-skainet says slot 0, openai_demo says slot 1, on the same board. This must be
measured, not read. It is also an argument for the codec-generated reference of
R-A, which has no slot ambiguity at all.

**R-K. Espressif contradictions worth fixing wherever they recur:** the I2S ISR
lands on the Wi-Fi core; lwIP at priority 18 unpinned outranks every audio task;
`FD_HIGH_PERF` is used where Espressif recommends `FD_LOW_COST` (+29% frame
time); Espressif's own realtime example ships 20 ms Opus at 24 kbps with Nagle
unset where we send 100 ms PCM16 chunks.

**R-L. Flashing: hybrid, and two measured browser defects.** Keep `ITERKIT1`
(bump to v2 — add `device_id` and the `kit_path` the goal doc specified and never
got); adopt the esp-web-tools **manifest schema** as a superset, one manifest per
board; add `improv-serial` on-device (~200 lines) for USB-free re-provisioning.
improv-wifi cannot replace ITERKIT1 — it carries SSID and password only, with no
vendor range. Encrypted NVS is XTS-AES-128, which **WebCrypto cannot do**, so a
browser can never write it. Two defects in the shipped browser path:
`esptool-js` has **no `watchdog_reset`**, which our own CLI proved is required to
leave the stub on native USB-Serial/JTAG (`esptool-cli.ts:150-161`), and
`browser-flasher.ts` calls `hard_reset` with no fallback; and it passes no
`calculateMD5Hash` and never calls `readFlash()`, so browser flashing has **zero
write verification** where the CLI has `--verify`.

### D-AEC — ES8311 hardware echo reference. **DELEGATED to the implementor.**

Shape `audio_codec.h` to expose `has_reference_channel` from day one so the seam
fits it. Whether to switch the ES8311 boards to stereo capture and use it is the
implementor's call, taken AFTER all four boards are on one lane and behaving
identically — not during the port, when a regression could not be attributed.
Evidence for the decision is R-A (free, sample-aligned, no slot ambiguity) and
R-J (first-party sources disagree on esp-sr's slot index, so that path needs
measuring rather than reading).

### Status of the fourteen open decisions

| #   | Decision                                | Status                                                     |
| --- | --------------------------------------- | ---------------------------------------------------------- |
| D1  | `c-capabilities` branch                 | **DECIDED** — backup only, never merged                    |
| D2  | `iterate/stackchan`                     | **DECIDED** — preserve, then read-only archive             |
| D3  | Which transport lane                    | **DECIDED** by A1 — stream lane everywhere, `/pcm` retired |
| D4  | mu-law-over-JSON vs binary              | Claude to decide                                           |
| D5  | Bridge stays a Durable Object           | Largely forced; Claude to record                           |
| D6  | Device profile polarity                 | **DECIDED** — split by what the value sizes                |
| D7  | Where visemes are computed              | **DECIDED** by the goal — server, ephemeral events         |
| D8  | TS/C client code sharing                | Claude to decide                                           |
| D9  | Browser auth                            | **JONAS** — needs a serving project app                    |
| D10 | `host_cli`                              | **DECIDED** — survives as the acoustic/fault rig           |
| D11 | Audio's stream-DO storage cost          | **JONAS** — platform-wide, not kit-local                   |
| D12 | PTT vs `call_control`                   | **DECIDED** — PTT stays (A2)                               |
| D13 | Tracked artefacts                       | **MOOT** — nothing from `c-capabilities` is landing        |
| D14 | First shippable increment               | Claude to propose; Jonas cares about outcome over phases   |
| D15 | Cheap local test loop after `/pcm` dies | **JONAS** — see below                                      |

**D15, newly raised by the research.** The v2 test ladder's rung 2 — a local LAN
server giving a ~10 s edit/measure loop, credited with "~80% provable here" — was
cheap precisely because `/pcm` was a dumb binary socket. On the stream lane the
equivalent needs a local Cap'n Web/stream endpoint. Price that before the lane is
deleted, or the fast loop is lost silently and every acoustic change starts
costing a deploy.

### R-M. Waveshare schematic, read first-party (peer session, 2026-08-04)

Source: <https://files.waveshare.com/wiki/ESP32-S3-Touch-AMOLED-1.8/ESP32-S3-Touch-AMOLED-1.8.pdf>
(single page, Altium zone grid; the wiki HTML 403s to a plain fetch, curl with a
browser UA works). Four facts that bear on the reference design:

- **The ES8311 supply is SPLIT.** AVDD ← `A3V3` ← AXP2101 **ALDO1** (R37 0R);
  PVDD+DVDD ← `VCC3V3` ← **DCDC1** (R35 0R). `A3V3` has exactly three consumers
  sheet-wide: ALDO1, ES8311 AVDD, and the mic. **Disabling ALDO1 kills the analog
  front end and the microphone while the codec still ACKs I2C and clocks I2S** —
  it records silence with no error anywhere. That is a failure mode the health
  surface must be able to name; no Waveshare demo ever enables ALDO1 explicitly,
  it is relied on to come up by AXP2101 default.
- **The mic is MEMS and only PSEUDO-differential.** MIC_P carries signal; MIC_N is
  driven by nothing — caps to AGND only. **Do not assume any CMRR benefit for
  AEC.** There is no MICBIAS anywhere (the ES8311 has no such pin).
- **Amp is an NS4150B on 3.3 V (`VCC3V3`), not a boost** — yet Waveshare's own IDF
  example declares `.pa_voltage = 5.0`. The dB mapping is calibrated for a rail
  this board does not have. Affects any gain arithmetic ported from the demo.
- **GPIO46 drives NS4150B CTRL directly** through R38 0R, with R39 10K pulldown to
  AGND as the only pull. The safe strapping state and the amp-muted state
  coincide, so there is no boot pop and no strapping hazard.

Unverified and worth a bench test before anyone acts: the mic part number, the
NS4150B CTRL semantics (Waveshare links no datasheet), and whether AXP2101 DCDC5
is truly NC — its legend says NC but the SW pin is populated into the VSYS/charger
node.

### D15 — The fast local loop. **DECIDED: local dev server, no bespoke endpoint.**

Test against the fully-local OS dev server (`pnpm dev`, miniflare/workerd) with a
project whose config repo carries `voice-agent.ts` as a dynamic worker, driven the
way `apps/os` e2e tests already are. Verified feasible: `e2e/vitest/itx-workers.e2e.test.ts`,
`agent-codemode-fence.itx.e2e.test.ts` and `worker-build-version.e2e.test.ts`
already exercise dynamic workers and config repos against it; `miniflare` is an
`apps/os` dependency; project hosts resolve as `<slug>.localhost:<port>`.

**Why this beats the v2 ladder's rung 2.** That rung was a bespoke local LAN
server, cheap only because `/pcm` was a dumb binary socket. This runs the REAL
server code — same processor, same bridge, same stream semantics — so the loop
tests what ships instead of an approximation of it. Nothing bespoke to build or
keep in sync.

**Hazard the plan must carry:** the local worker loader **accumulates isolates at
roughly 78 MB each, keyed by nonce, and never evicts them locally**. A loop that
rebuilds the guest worker on every iteration will OOM the dev server. Mitigation:
stable content-version cache keys, reuse of the runner across iterations, and
sharding if a suite gets long. This is a known local-dev property, not a bug in
the voice work — but it will look like one to whoever hits it first.

**Knock-on for D9 (browser auth):** largely dissolved for development. A browser
can reach a project host at `<slug>.localhost:<port>` against the local server, so
the TS browser client can be built and tested without standing up production
infrastructure first. Production browser auth (the `project-app-session` lane and
a serving project app) becomes a later, separable step rather than a prerequisite.
Recommendation stands: **Node CLI first, browser second.**

### R-N. Silicon deep dive, final (2,094 lines, 30 findings, 20 marked UNVERIFIED)

**RETRACTION of R-B.** `mic_selected` **is** set, via a build-time CMake patch
(`patch_core_s3.cmake` rewrites it to `MIC1|MIC2|MIC3` = 0x07 into the build tree
at configure time). The earlier conclusion that TDM was never enabled and the
reference channel was powered down is **wrong**, and the inference drawn from it —
that StackChan's AEC stood on nothing — does not hold. A3 still stands on its own
merits; it just loses this argument.

**ES7210 dispute settled.** Slot order **MIC1, MIC3, MIC2, MIC4 is correct**
(DS Rev 2.0 Fig. 2e p.8). The "channel 1 is the exact PCM sent to the speaker"
claim is impossible — no DAC, no host input, `TDMIN` is a no-connect on CoreS3.
The analogue-loopback claim has the right mechanism (150 kΩ off the AW88298 BTL
into MIC3P/N) but the wrong levels: **R41/R43 are unpopulated**, so it is not a
divider. 150 kΩ works against a _gain-dependent_ input impedance (24 kΩ at ≤12 dB,
6 kΩ at ≥15 dB), producing an **~11 dB non-monotonic step** — which finally
explains the unexplained "+18 dB commanded → +7.3 dB realised". Everest's PB Note 2
also requires an ADC reset after amp power-up in exactly this topology; we do not
do it.

**R-C confirmed and sharpened.** The ES8311 gain call is a no-op, and "at 30 dB
the capture railed" was **digital** saturation, not analogue. `0x32 = 0x9b` is
genuinely −18.0 dB and the right register for a _power_ ceiling, but it cannot
prevent source clipping — Everest's answer for that is DRC (`0x34`/`0x35`), which
we do not use. Keep ALC off: one time constant, no separate attack/decay, and
Espressif ships it off on every ES8311 board.

**AW88298:** our 64FS patch (`0x06[5:4] = 10`) is **correct**. But Espressif's
volume mapping is linear against a 6 dB/0.5 dB nibble encoding, so low volumes
come out **~10 dB louder than asked**, and we silently inherit `INPLEV = −6 dB`
plus a mono downmix.

**HAVPE is not an XVF3800.** It runs XMOS `sln_voice` FFVA v1.3.1 with **two PDM
mics**. Home Assistant taps AGC on ch0; we tap NS and then replace the AGC with a
fixed ×8 applied _after_ the network hop.

**Waveshare:** `0x63 = 0x01` **clears AXP2101 charge-termination enable** (bit 4,
default 1) — an unintended battery-charging change. `pa_voltage = 5.0` is wrong
(the NS4150B runs at 3.3 V, corroborating R-M). And **NS4150 specifies t_ST =
30 ms**: we toggle GPIO46 with no delay. The ~160 ms reply prefill covers a
turn-start toggle; **mid-turn toggles are not covered**.

**There is no 80 MHz PSRAM erratum.** Waveshare ships 80 MHz. Our revert to 40 MHz
changed three symbols at once, and 40 MHz is the configuration with _no_ timing
calibration. esp-idf issue #18640 (verified open) shows the same TLS failure point
on an I2S device, cured by `MBEDTLS_HARDWARE_SHA=n`. **Test that before touching
PSRAM speed again** — we may be running memory at half rate for the wrong reason.

### D11 — Audio's storage cost. **RESOLVED — already fixed on `main`.**

`origin/main` carries **"Keep ephemeral stream events in memory only (#2408)"**.
`apps/os/src/domains/streams/stream-storage.ts` now _throws_ if an ephemeral event
reaches the durable log ("ephemeral events must not be written to the durable
event log"); durable bytes go to `event_chunks`, ephemeral bytes are held in
memory, and the offset allocator keeps only a high-water mark. Audio costs no
stream-DO storage. No eviction sweep is needed and none should be built.

**Correction of record:** §6 says ephemeral rows are committed and stored. That
was true of this branch's base and is **no longer true of `main`**. Anything
downstream of that claim — including the storage half of the "one lane for
everything" cost argument — should be re-read.

### D16 — Getting this branch onto current `main`. **OPEN, and it is a real job.**

Attempted a rebase; **aborted and fully restored** (HEAD `6665a487f`, 55 commits
ahead, working tree intact). It is not a quick operation:

- **55 commits** to replay, against a `main` that has landed **17 commits under
  `apps/os/src/domains/streams/` alone** since this branch diverged — including
  #2408 (ephemeral memory-only), #2386 (idle sessions stop pinning Stream DOs),
  #2378 (raised subrequest limit) and #2311 (cross-stream subscriptions). All four
  touch exactly what this branch changes.
- Conflict 1 of many hit at commit 10/55 (a docs rename, easy). Conflict 2 was
  structural — a delete/modify in `apps/os/src/rpc-targets.ts` with no content
  markers.
- The uncommitted work — visemes, the `voice-agent/context-added` mechanism, the
  namespace rename — is the ONLY copy (H4) and would sit in a stash for the
  duration.

**Recommendation: commit the working tree first, then MERGE `origin/main` rather
than rebase.** A merge is one conflict pass instead of up to 55, and it keeps the
measured commit history intact — which matters here because several commits are
themselves the record of an experiment. Rebasing buys linear history at a cost
that is disproportionate to it. Whichever is chosen, it should be its own task
with a clean context, not a step inside another one.

**Also uncovered:** the push-budget ceiling documented in
`apps/os/docs/stream-event-connections-and-subscriptions.md` (~1000–1300 batches,
which `resilient.ts` recycles at 700 to stay under) was measured **before** #2378
raised the subrequest limit that constitutes that budget. The recycling design is
still right; the numbers are now a floor rather than a measurement, and are due a
re-run.

_(next: write consolidation-plan.md)_
