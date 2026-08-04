# Consolidation plan

**For the implementing agent.** Everything here is decided. `consolidation.md`
(995 lines, same directory) is the evidence behind it — read a section when this
plan cites one, not front to back.

---

## 0. User amendment — 2026-08-04

- StackChan firmware is in scope. Port the proven `c-capabilities` AEC path into
  the shared audio-processor architecture and keep it compiling and tested.
- StackChan is offline: do not flash it and do not claim physical proof. This
  supersedes the StackChan/AEC exclusions below, but not the preservation rule;
  the archived `iterate/stackchan` repository remains read-only input.
- If Claude cannot perform a mandatory review because of usage limits, run a
  fresh Codex CLI review with `gpt-5.6-sol` at maximum reasoning effort instead.

---

## 1. The goal, in the order it will be judged

1. **A PR that is green and mergeable.** Not a branch, not a checkpoint. Green CI
   and no unresolved review threads.
2. **Only code we like and need in the branch.** No build artefacts, no evidence
   binaries, no vendored upstreams, no dead paths carried "just in case". If a
   file cannot be justified in one sentence, it does not go in.
3. **Markdown docs can stay for now.** Docs are cheap and several are the only
   record of a measurement. Do not spend effort pruning them.
4. **Proof on real hardware: Waveshare, HAVPE, M5StickS3 — and above all the Mac.**
   StackChan is physically offline and is explicitly **out of scope for proof**;
   keep its code compiling, do not claim it works. The Mac host target is the one
   that must work best, because it is the loop everything else depends on.

**Non-goals.** Merging `c-capabilities`. Reviving `iterate/stackchan`. AEC of any
kind. Opus. Browser auth against production. Anything the plan does not name.

---

## 2. How to work

### 2.1 Review checkpoint after every phase — mandatory

At the end of each phase, before starting the next, get an independent review from
a fresh Claude on the **fable** model at **max** effort:

```bash
claude --model fable \
  -p "You are reviewing phase <N> of consolidation-plan.md in this worktree.
      Read consolidation-plan.md and IMPLEMENTATION-LOG.md first.
      Review the diff for that phase only: <git range>.
      Judge it against the four goals in §1, hardest on goal 2 —
      is there anything in this diff we do not need?
      Then check the phase's own exit criteria are genuinely met,
      not merely claimed. Be adversarial. Cite file:line."
```

Treat the output as a gate, not a suggestion. Record what it found and what you
did about it in the log. If it disagrees with this plan, the reviewer is not
automatically right — but the disagreement gets written down and resolved
explicitly.

### 2.2 Implementation log — mandatory

Maintain `IMPLEMENTATION-LOG.md` at the worktree root. Append-only; never edit a
past entry, correct it with a new one. One entry per session or per phase,
whichever is smaller:

```
## <date> — phase <N>: <what>
**Did:** …
**Measured:** … (numbers, not adjectives)
**Surprised by:** …
**Reviewer said:** … → **did:** …
**Open:** …
```

The "surprised by" line is the valuable one. Most of the findings in
`consolidation.md` came from someone noticing a number that did not fit.

### 2.3 Two standing rules

- **First-party sources are the anchor.** Espressif's own docs and example code,
  and the silicon vendors' datasheets, reference designs and schematics, are
  considered before we invent anything. Cite them in comments where a constant
  comes from one.
- **Source beats docs.** Where vendored source and vendor documentation disagree,
  the source wins and the disagreement gets a comment. Evidence:
  `mem_alloc.rst:112` tells you to allocate `MALLOC_CAP_SPIRAM|MALLOC_CAP_DMA`,
  and `heap/port/esp32s3/memory_layout.c:65` never grants `MALLOC_CAP_DMA` to the
  SPIRAM region, so that allocation **always returns NULL on ESP32-S3**.

---

## 3. Decisions already taken — do not relitigate

| #     | Decision                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1    | **One lane.** All media travels as stream events over one Cap'n Web `/api` socket. The binary `/pcm` lane is retired.                                                                                                                                                                                                                                                                                                         |
| A2    | **Push-to-talk stays**, on every board. It is also the entire echo story on the boards with no AEC.                                                                                                                                                                                                                                                                                                                           |
| A3    | **Take as little as possible from `c-capabilities`.** Default is re-derive. Anything adopted is named in §5.                                                                                                                                                                                                                                                                                                                  |
| A4    | **First-party docs are the anchor** (§2.3).                                                                                                                                                                                                                                                                                                                                                                                   |
| D1    | `c-capabilities` is a **backup branch**, never merged.                                                                                                                                                                                                                                                                                                                                                                        |
| D2    | `iterate/stackchan` is **preserved then frozen** (§4.1).                                                                                                                                                                                                                                                                                                                                                                      |
| D4    | Audio stays **mu-law + base64 in JSON**. Opus is a later phase, not this one.                                                                                                                                                                                                                                                                                                                                                 |
| D5    | The bridge **stays a Durable Object**. Forced: hosted processors never receive ephemeral events and every audio frame is ephemeral.                                                                                                                                                                                                                                                                                           |
| D6    | **Profile polarity: split by what the value sizes.** Supervision constants (frame sizes, ring depths, timeouts) stay in ONE global table — that is what makes acoustic oracles comparable across boards. Genuine hardware facts move onto `audio_codec_properties`. A per-board struct exists only for knobs currently spelled in several places. Copies are allowed where genuinely needed, but each copy gets a drift test. |
| D7    | **Visemes are computed server-side** and delivered as ephemeral events. The device renders a mouth track it is given, and owns only wall-clock idle motion (blink, saccade, breathe) so a network stall does not freeze the face.                                                                                                                                                                                             |
| D8    | **No shared code between the C rig and the TS client** — a shared _wire contract_ only.                                                                                                                                                                                                                                                                                                                                       |
| D9    | **Node CLI first, browser second.** Local dev serves project hosts at `<slug>.localhost:<port>`, so the browser client can be built locally later without production infrastructure.                                                                                                                                                                                                                                          |
| D10   | `host_cli` **survives** as the acoustic and fault-injection rig. The TS client is the product client.                                                                                                                                                                                                                                                                                                                         |
| D11   | **Resolved upstream.** `main` carries #2408: ephemeral events are memory-only and `stream-storage.ts` throws if one reaches the durable log. Audio costs no stream-DO storage. Build no eviction sweep.                                                                                                                                                                                                                       |
| D12   | **PTT** (see A2).                                                                                                                                                                                                                                                                                                                                                                                                             |
| D15   | **Test against the local dev server** (`pnpm dev`, miniflare/workerd) with a project whose config repo carries the voice agent as a dynamic worker, driven like the existing `apps/os` e2e tests. No bespoke local endpoint.                                                                                                                                                                                                  |
| D-AEC | The ES8311 hardware echo reference (§6.2) is **the implementor's call, after** all boards are on one lane and behaving identically. Shape the seam for it now; do not use it yet.                                                                                                                                                                                                                                             |

---

## 4. Target layout

```
apps/kit/
  firmware/
    components/core/          control plane only — no audio, no hardware
    components/audio/         linked only on boards that have audio
      audio_codec.h           HARDWARE seam: capture, playback, properties
      audio_processor.h       PROCESSING seam: AEC/VAD (do-nothing impl for now)
    components/capabilities/  push_to_talk, metrics, leds, servos, screen
    components/avatar/        the face engine (shared, unchanged)
    platforms/iterate_esp_idf/
    platforms/darwin/         macOS is a platform, not a test harness
    devices/<board>/          composition root + profile data
    targets/<board>/main/     thin — no logic
    tests/                    host ctest
  src/firmware/               the flasher (ALREADY ON main — see §5.2)
  clients/                    TypeScript client (Node first, browser later)
apps/os/
  scripts/voicelab/           server: processor, bridge, harnesses
```

**The rule that makes it real:** `components/core` never learns which board it is
on. It talks to two headers. Enforce it the way `pcm_session.c` already enforces
its seam — a **platform-private header**, so a bypass _fails to compile_ — plus an
architecture test that fails if `core` gains an audio or platform include. A lint
rule is not enough; the last attempt at this decayed within a month and StackChan's
AEC was welded into `core_s3_audio_owner.c` through the hole.

---

## 5. What to take, and from where

### 5.1 From `c-capabilities` — the whole list

Nothing else. Copy the file, read it, delete what the new structure does not need.

**Tier 1 — take:**

- `components/core`: `voice_device_profile`, `voicelab_stream`,
  `audio_playout`, `configuration`, `device_events`, `itx_connection`,
  `itx_mount`, `itx_outbox_sender`, `peer`, `voice_playback_clock`, the
  WebSocket frame/RX/text/TX stack, `status.h`, `spsc_ring`, `retry_gate`,
  `talk_button`, and `atomic.h`, with their host tests. These are the complete
  load-bearing control and transport graph for the A1 lane; do not copy any
  other core module.
- `components/capabilities`: `push_to_talk`, `subscription.h`, and its private
  `rpc_internal` support, with their host tests
- `platforms/darwin/` — the Mac transport implementation
- `targets/host_cli/` — the Mac conversation and fault-injection rig
- `targets/waveshare_s3_amoled/main/` — the reference implementation

**Tier 2 — take only when the board that needs it is being ported:**

- `voice_pe_hardware_config.c` (HAVPE)
- the M5StickS3 codec bring-up

**Do not take:** `metrics.c`, `device-pcm-proxy.ts`, the ~9,000 lines of
`fable-v2-plan/exploration/`, anything under `apps/.build/`, any evidence binary.

### 5.2 From `main` — the flasher already exists

`apps/kit/src/firmware/` ships ESP Web Tools, `ITERKIT1` and `esptool-js@^0.6.0`.
**Take nothing from `c-capabilities` for flashing.** Two cheap fixes belong in a
late phase: add `device_id` and `kit_path` to `config-image.ts` (~20 lines), and
call `readFlash()`/`calculateMD5Hash` so browser flashing has write verification —
today it has none, where the CLI has `--verify`. Also note `esptool-js` has no
`watchdog_reset`, which our own CLI proved is required to leave the stub on native
USB-Serial/JTAG; `browser-flasher.ts` calls `hard_reset` with no fallback.

### 5.3 From `iterate/stackchan` — preserve first, then take three things

**Before anything else, and before any `git clean` anywhere:** it has 981
untracked files, no stashes and no remote copy. Commit them on a branch (`local/`
and `upstream/` stay ignored), archive `local/` separately, and capture the three
`.claude/worktrees/` explicitly — `git add -A` in the main tree does not reach
them. Then freeze the repo.

Take: the `avatar_pipeline.py publish` authoring loop (drop `avatar.json` + two
grid PNGs into `characters/<id>/`, everything regenerates), the WASM face-review
room, and the live AEC HTTP tuning knobs. Nothing else.

---

## 6. Phases

Each phase ends with the §2.1 review and a log entry. **The Mac target must be
green at the end of every phase** — it is the loop, and a broken loop makes every
later phase slower.

### Phase 0 — Preservation and skeleton

Preserve stackchan (§5.3). Create the §4 directory structure in this worktree with
`components/core` and `components/audio` empty but wired into CMake, the
architecture test that fails on a bad include, and `IMPLEMENTATION-LOG.md`.
**Exit:** the tree builds empty; the architecture test fails when you deliberately
add an audio include to `core`, and passes when you remove it.

### Phase 1 — The Mac, end to end

Port Tier-1 core plus `targets/host_cli` and `platforms/darwin`. Stand up the
local dev server with a project carrying the voice agent as a dynamic worker
(D15). Prove a full push-to-talk conversation on the Mac against local dev.
**Exit:** a scripted conversation runs against `pnpm dev` with no cloud; host
`ctest` green; `pnpm typecheck && pnpm lint && pnpm test` green.

### Phase 2 — The two seams

Introduce `audio_codec.h` and `audio_processor.h`. The Mac implements both
(CoreAudio codec, do-nothing processor). Expose `has_reference_channel` in
`audio_codec_properties` now, unused (D-AEC). Apply D6: global table stays,
hardware facts move to the codec properties, per-board struct only for scattered
knobs, drift test for any copy.
**Exit:** `core` contains no audio and no platform include, proven by the test;
the Mac still passes phase 1's conversation unchanged.

### Phase 3 — Waveshare

Port the reference board. It is already on the A1 lane, so this is a structural
move, not a protocol change. Derive the DMA ring geometry from Espressif's own
formula (`i2s.rst:1210-1238`) and comment the derivation.
**Exit:** conversation on hardware equals phase 1's on the Mac; `spkStarvedMs` 0;
`faceFrames` climbing.

### Phase 4 — M5StickS3, then HAVPE

One board per sub-phase, each with its own review. These are the two real tests of
the seams: StickS3 is half-duplex with no AEC, HAVPE has no screen and hardware
AEC in an XMOS DSP — between them they exercise every property on the codec seam.
**Exit:** each board holds a conversation; the Mac and Waveshare are unregressed.

### Phase 5 — The TypeScript client

A Node CLI client that is just a stream participant: same events, same
`voice-agent/context-added`. Reuse `resilient.ts` verbatim. It must handle mu-law
both directions and `(call, answer, frame)` identity — today's `client.ts` does
neither and is a stale harness, not a starting point.
**Exit:** the TS CLI holds a conversation against local dev; the C rig still does.

### Phase 6 — PR hygiene

Prune to goal 2. Flasher fixes from §5.2. Green CI, every review thread resolved.
**Exit:** merged.

**StackChan** gets a phase only when hardware is back. It moves **last** in any
case: it is the only board where a lane change and an acoustic regression are
indistinguishable.

---

## 7. Hazards — read before you hit them

1. **Local dev accumulates worker-loader isolates at ~78 MB each, keyed by nonce,
   never evicted.** A loop that rebuilds the guest worker every iteration will OOM
   the dev server. Use stable content-version cache keys and reuse the runner.
   This will look like a voice bug and is not one.
2. **`MALLOC_CAP_SPIRAM|MALLOC_CAP_DMA` always returns NULL on ESP32-S3** (§2.3).
3. **`i2s_channel_write`'s `timeout_ms` is per DMA-buffer acquisition, not per
   call.** The real bound is `(1 + buffers) × timeout`; `esp_codec_dev` passes
   1000 ms. Size any watchdog against the real bound.
4. **Do not promote `on_sent` callback counting to a correctness signal.** One
   callback per descriptor is guaranteed and it fires during a write — which is
   why credit is reserved _before_ writing, and that part is right. But the queue
   holds `desc_num−1` and the ISR silently discards on overflow. Waveshare
   measures starvation against an absolute deadline (`dma_empty_at_us`) instead,
   because a 600 ms injected gap moved the ISR counter by zero. Keep the deadline.
5. **`ITERATE_KIT_VOICE_MIC_FRAMES_PER_APPEND` is 4.** Comments claiming 12, 8 and
   6 all exist and are all stale. At 12 the uplink died after 15 turns; at 8 the
   base64 encode overflowed a 7,600-byte buffer and abandoned the append **with the
   microphone silently disconnected**. Whatever replaces this must fail loudly.
6. **The abandon ordering is load-bearing:** disarm → note flush → read → discard
   → reprime. Five sites once had three orderings; the wrong one recorded a
   starvation the device caused on purpose and failed an acceptance run.
7. **Getting this branch onto current `main` is its own task** (D16): 55 commits
   against a `main` with 17 commits in `apps/os/src/domains/streams/` alone. A
   rebase was attempted and aborted cleanly. Commit the working tree, then
   **merge** — one conflict pass, not up to 55 — as a separate piece of work with
   a clean context.

---

## 8. Known-wrong things you may trip over

These are documented in `consolidation.md` §R-C, §R-M, §R-N. Do not "fix" them in
this consolidation — record them and move on.

- `esp_codec_dev_set_in_gain(24.0f)` on ES8311 writes `0x16 ADC_SCALE`, a digital
  gain whose reset default is already 24 dB. It is a **no-op**, and its only real
  effect is clearing `ADC_SYNC`. The analog PGA is `0x14`, pinned at 30 dB.
  "At 30 dB the capture railed" was digital saturation.
- Waveshare's own example declares `.pa_voltage = 5.0`; the NS4150B on that board
  runs at **3.3 V**. Gain arithmetic ported from the demo is miscalibrated.
- Disabling AXP2101 **ALDO1** kills the ES8311 analog front end _and_ the mic while
  the codec still ACKs I2C and clocks I2S — it records silence with no error. The
  health surface should be able to name this.
- The Waveshare mic is MEMS and only **pseudo**-differential (MIC_N is driven by
  nothing). Assume no CMRR benefit.
- **There is no 80 MHz PSRAM erratum.** Waveshare ships 80 MHz; our revert to
  40 MHz changed three symbols at once and 40 MHz is the config with no timing
  calibration. esp-idf #18640 shows the same TLS failure cured by
  `MBEDTLS_HARDWARE_SHA=n`. Test that before touching PSRAM speed.
