# Three-layer testing architecture (requirement 7) — exploration

Status: exploration-round artifact for the v2 plan. Read together with
`../inputs/brief.md` (requirement 7: "1) super fast host-side unit tests 2) tests on the device with a testing rig where the device is next to the
computer speaker that is running the tests 3) human-in-the-loop tests with
physical buttons etc") and the architecture review
(`../../fable-firmware-architecture-review-2026-07-31.md`, esp. §3 "Off-device
testing … nothing in xiaozhi, esphome-audio-stack, or ADF comes close").

All file:line references are from the current `c-capabilities` working tree.
Paths are relative to `apps/kit/` unless noted.

Position up front: **v1 already has the strongest layer-1 story of any project
we studied and a real (if monolithic) layer-2 harness; layer 3 exists only as
one inline "hold Button A" step buried in the e2e script. The v2 work is
therefore not "build a test system" — it is (a) let the module cut make layer 1
even cheaper and cover the two blind spots, (b) decompose the 1,752-line
`device-e2e.ts` into a scenario-shaped rig and add the four missing acoustic
scenarios (uplink echo loop, AEC proof, barge-in timing, timestamp-echo
alignment), and (c) promote the human step into a first-class < 5-minute
"checkride" driven by the requirement-8 event stream, with a single shared
threshold home under all three layers.**

---

## 1. Inventory: what exists today (with numbers)

### 1.1 Layer 1 as-built — native host tests

- **38 native test executables** registered via `add_test` in the root host
  `firmware/CMakeLists.txt` (grep count 38; the file is 1,008 lines, ~900 of
  which are copy-pasted per-test stanzas — review R13 already proposes
  `add_iterate_kit_test()`; the only existing helper is
  `add_iterate_kit_simulator` at `firmware/CMakeLists.txt:126-141`).
- Style: plain C/C++ with an abort-on-fail `assert` macro, **zero test
  framework**, behavior-named tests each documenting the physical failure mode
  it models (e.g. `pong_waits_until_the_pcm_frame_boundary` in
  `firmware/tests/websocket_tx_test.c`).
- The crown jewels, all in `firmware/tests/`:
  - `pcm_realtime_fault_harness_test.c` — sans-I/O virtual-clock fault harness
    driving the uplink sender through would-block/trickle/disconnect link
    modes.
  - `realtime_playback_test.cpp` (1,989 LOC) + `direct_i2s_stereo_output_test.cpp`
    (1,104 LOC) — model **descriptor identity** (slots 0/1/2/3), not counts,
    so a count-only fake cannot hide an identity bug.
  - `esp_idf_itx_transport_test.c` / `esp_idf_pcm_transport_test.c` — the
    **real** ESP-IDF adapter sources compiled against
    `firmware/tests/fakes/` (header shims for `esp_wifi.h`, `esp_timer.h`,
    `nvs_flash.h`, `freertos/`, …) with `fake_esp_idf_platform.c`
    implementing FreeRTOS tasks over pthreads, pause/notify control, a
    virtual clock offset, and contract-modelling knobs (`defer_connected`,
    `short_next_send`).
  - `esp_idf_tcp_transport_host/` — a Catch2 ESP-IDF host-target project that
    runs the actual patched `tcp_transport` WebSocket parser against scripted
    byte streams.
  - `vendor/capnweb`: native tests + **a fuzzer** + the TS interop suite
    driving the compiled C peer against the real `@iterate-com/capnweb`
    runtime, with a typed known-failure ledger
    (`firmware/__tests__/c-interop-known-failures.ts`).
- CI wiring: the **default TS suite builds and runs the native suite** —
  `src/device/stackchan-simulator.e2e.test.ts:168-186` runs
  `cmake --build <dir> --parallel` then `cmake --build <dir> --target test`,
  and `firmware-architecture.test.ts:684-693` pins both that invocation and
  the `-UNDEBUG` assert guarantee. Goal-doc evidence: "Normal and ASan/UBSan
  native suites both pass 38/38; the Kit TypeScript suite passes 295 tests
  with one intentional skip" (`docs/physical-device-voice-goal.md:375-377`).
- Known layer-1 gaps (from the firmware-core deep read §6): no host test
  compiles `websocket_connection.c` itself (errno-classification switch
  `platforms/iterate_esp_idf/websocket_connection.c:209-237` and the
  security-relevant URL parser `:80-163` untested on host); no dedicated
  `peer_test.c` (the `invokeCapability` envelope unwrapping,
  `components/core/src/peer.c:159-207`, is tested only through device-level
  tests).

### 1.2 Layer 1 as-built — host TypeScript

- `src/voice/device-pcm-proxy.test.ts` (24 tests) drives the 931-LOC proxy
  through captun `WebSocketPair` fakes, `StrictCloseWebSocket`, `DeferredBlob`.
- `src/device/firmware-architecture.test.ts` (694 LOC, ~20 invariants) — the
  text-grep "architecture as regression tests" suite; every anchor is a rename
  landmine and two `slice(indexOf(...))` vacuous-pass hazards remain at
  `:663-677` (review R13).
- Deterministic signal stack: `DeterministicPcmProvider`
  (`src/voice/deterministic-pcm-provider.ts`, 189 LOC — one transport/pacing
  loop, stateful renderer factories so "provider message boundaries are not
  media boundaries", `:9-18`), tone (78 LOC, 997 Hz for phase-visible frame
  loss — reasoning verbatim in `scripts/device-e2e.ts:229-236`), PRBS31
  dual-carrier watermark (`src/device/acoustic-prbs31-challenge.ts`, 1,143
  LOC — 1 kHz/2 kHz carriers, 16-sample = 1 ms chips, SHA-256 seed
  commitment, `:145-173`).
- Analyzers: `src/device/acoustic-tone-analysis.ts` (1,307 LOC; coherence-gated
  correlator, 5 ms half-overlap windows, phase-step continuity, O(1)-memory
  streaming variant with `maximumBufferedAudioBytes` exported, `:82-92`) and
  the PRBS31 analyzer with versioned frozen thresholds
  (`acoustic-prbs31-challenge.ts:102-113`); plus
  `causal-speech-energy-analysis.ts` (bounded 20 ms-window RMS oracle for
  non-deterministic speech).

### 1.3 Layer 2 as-built — the physical harness

`scripts/device-e2e.ts` — 1,752 lines total, `runDeviceE2e` alone spans
`:164-1254` (~1,090 lines). What it already does (worth keeping verbatim):

- Flash or **verified `--no-flash` reuse**: reads the config partition over
  esptool and refuses a base-URL mismatch (`:411-422`, `:1307-1335`).
- Captun tunnel or **direct-LAN** with the _same_ fetch handler so a LAN pass
  isolates tunnel cadence, not a friendlier server (`:349-386`).
- Control mount + `subscribeToMetrics` + `subscribeToPlaybackMetrics`, a
  `DeviceRuntimeProbe` (`:1388-1689`) racing every wait against first failure
  with metric-envelope continuity checking, and "reconnect is evidence, not
  recovery" (`control-mount-diagnostics.ts`).
- SoX/CoreAudio capture (`src/device/macos-pcm16-capture.ts`, 571 LOC) with
  the hard-won instrument-integrity doctrine: SoX because ffmpeg's
  AVFoundation input "advertises 48 kHz but has repeatedly emitted only 38.4k
  samples for each wall-clock second" (`:110-118`); ffmpeg demoted to
  read-only device-identity enumeration; provenance (CoreAudio UID, mic mode)
  recorded per run.
- **Causal acoustic markers**: `recordAcousticMarker` snapshots the recorder's
  `capturedSampleCount` at named phases (`:248-277`); the marker taken
  _before_ requesting the response supplies `analysisStartMs` so recorder
  warm-start replay is excluded without cherry-picking a waveform episode
  (`:894-911`).
- Armed playback-counter tripwire (`:536-553`), bounded control churn (real
  `getDiagnostics` at N Hz, judged for ≥ 90 % applied load, `:614-685`),
  physical network monitor on direct LAN only (refuses to invent
  reachability under Captun, `:743-753`), and a network-validity artifact
  that can retroactively fail a passing audio run (`:1036-1041`).
- The `--voice` path already uses **the computer speaker as the far-end
  talker**: `/usr/bin/say` speaks the prompt while PTT is held
  (`:1075-1081`), then metric predicates assert uplink streaming — but the
  uplink _audio_ is never captured or analyzed; Grok's transcription is the
  only (non-deterministic, unasserted) witness.
- Endurance: `runPlaybackEnduranceLadder`
  (`src/device/playback-endurance-ladder.ts`, durations frozen at
  `[60_000, 120_000, 600_000]` ms, `:35`) with the frozen acceptance policy
  (`m5sticks3-playback-endurance-target.ts:48-121`: idle + capability-churn
  load profiles, ~21 all-zero `counterMaximumDeltas`); currently **fails
  closed on an intentionally empty runtime adapter**
  (`device-e2e.ts:554-574`, `runtime: {}`) because the capability surface
  can't yet attest firmware SHA / stable identity / recording ownership.

### 1.4 Simulator

`firmware/simulator/` is a deliberate **control-plane** model — "deliberately
does not synthesize sound or imitate I2S/DMA, FreeRTOS task priorities,
WebSocket buffering, AEC, or audible latency"
(`simulator/devices/m5sticks3.cpp:10-23`); its fake PCM egress withholds
completion to force the backpressure interval (`:55-60`). StackChan simulator
is control-plane only, no audio at all (`simulator/devices/stackchan.cpp`).
This honesty is a keeper; v2 should not grow it into a board emulator.

### 1.5 Prior art worth stealing for the three layers

| Steal                                                                                                                         | From                                                                         | For                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Mic loopback self-test: record ≤ 10 s of mic, then move the queue straight into the decode queue and play your own voice back | xiaozhi `audio_service.cc:679-693` (`EnableAudioTesting`)                    | Layer 3 checkride step: zero-extra-infrastructure whole-audio-chain proof         |
| Raw-PCM debug tap streamed to host (`CONFIG_USE_AUDIO_DEBUGGER`, UDP + `scripts/audio_debug_server.py`)                       | xiaozhi `audio_debugger.cc`                                                  | Layer 2 raw-mic / AEC-reference capture channel (ours: bounded WS or SD, not UDP) |
| 16-byte frame header carrying play-out **timestamp for server AEC**                                                           | xiaozhi `protocol.h:17-24` (BinaryProtocol2)                                 | Layer 2 scenario v; requirement 9                                                 |
| ERLE/AECMOS/CPU evaluation-harness methodology (harness is MIT even though the engine is a blob)                              | seekaudio `seekaudio_aec_test`                                               | Layer 2 AEC acceptance math                                                       |
| Interleaved mic/ref debug dump + "mic must lag ref by 0–10 ms" alignment contract, trimmed via configurable ref pre-delay     | ESP-ADF algorithm_stream docs/pattern (review §4.6)                          | Layer 2 AEC bring-up calibration                                                  |
| `frame_spec()`/`frame_spec_revision()` + fail-closed "unavailable ⇒ silence, never raw mic"                                   | esphome-audio-stack `audio_core_processor.h:66-118`, `esp_afe.cpp:1612-1615` | Layer 1 processor-seam contract tests                                             |

---

## 2. Layer 1 — host unit tests, sub-second

### 2.1 What the v2 module cut buys

The review's target layout (review §5: `core` / `audio` / `analysis` /
`capabilities` / platforms) turns three convention-only properties into
link-time truths, and each one is a new _cheap_ test family:

1. **"Control stack without audio lane" becomes a buildable target.** Today
   `components/core` physically contains both (`device.h:4` includes
   `audio.h`; `audio.c:138-141` returns `CAPNWEB_OK`). After R3 splits them,
   add a one-line negative link test: an executable linking `iterate-kit-core`
   only, with `-Wl,--no-undefined` semantics — the Waveshare/HA-Voice-PE
   control-only bring-up build is CI-proven before those boards exist. This
   also retires the text-grep include checks in
   `firmware-architecture.test.ts:59-98` (keep them for one release as belt
   and braces, then delete — text grep is the fallback, the linker is the
   truth).

2. **The processor seam (R2) is the single highest-value new unit-test
   surface.** The C vtable gets three host-tested implementations before any
   DSP exists:

   ```c
   /* components/audio/include/iterate/kit/audio_processor.h (sketch) */
   struct iterate_kit_audio_frame_spec {
     uint32_t sample_rate_hz;     /* 16000 */
     uint16_t samples_per_frame;  /* 320 */
     uint16_t channels;           /* 1 */
   };
   struct iterate_kit_audio_processor_result {
     bool voice_active;             /* VAD state, when supported */
     bool output_is_silence;        /* fail-closed marker */
     uint32_t processed_frames;
   };
   struct iterate_kit_audio_processor {
     const struct iterate_kit_audio_processor_ops *ops;
     void *context;
   };
   struct iterate_kit_audio_processor_ops {
     struct iterate_kit_audio_frame_spec (*frame_spec)(void *context);
     uint32_t (*frame_spec_revision)(void *context);
     /* mic and reference are same-spec mono frames; reference may be NULL
      * (no playback active). Contract: on any internal failure the
      * implementation MUST fill out with silence and set output_is_silence —
      * never pass raw mic through a broken processor. */
     enum iterate_kit_status (*process)(
         void *context,
         const int16_t *mic, const int16_t *reference, int16_t *out,
         struct iterate_kit_audio_processor_result *result);
   };
   ```

   Implementations: `null_processor` (copy mic→out; M5StickS3 + simulator),
   `fake_processor` (test-only: scriptable per-call failures, spec-revision
   bumps, latency injection via virtual clock), and later the `esp_sr`
   adapter behind the same header. Host tests that become possible **now**:
   fail-closed silence on processor error; drain-handshake ordering for
   reconfig (steal the seq_cst pair rationale from esphome
   `esp_afe.h:92-105`); frame-spec revision bump forces session restart;
   reference=NULL vs reference=frame parity; and — once a software AEC is
   plugged in — a _pure-host ERLE regression_ on recorded rig fixtures
   (§2.3.5).

3. **Event core (requirement 8) golden tests.** v2 wants the on-device data
   structure expressed as events (`path`, `type`, `payload`) "from the
   earliest moments". The existing `device_events` queue (198 LOC,
   single-task, bounded) and `device_event_stream` capability
   (`components/capabilities/src/device_event_stream.c:6-12` — "carries only
   the low-rate state edges that give push-to-talk audio meaning",
   boot-local sequence, coalescing overflow with counters at `:90-108`)
   generalize into an `event_core` whose unit-test idiom is **golden event
   logs**: drive a scenario (button press → PTT start → uplink → release →
   playback → EOS), serialize the emitted event sequence to canonical JSON
   text, diff against a checked-in golden file. This is the cheapest
   possible spec of device behavior, it is the same shape the SD-card log
   (requirement 5) and the apps/os stream (requirement 8) will carry, and it
   gives layers 2 and 3 their assertion vocabulary for free:

   ```c
   /* golden-log fixture shape (host test emits, vitest diffs) */
   {"seq":1,"path":"/kit/m5sticks3","type":"pushToTalk.started","payload":{"source":"physical"}}
   {"seq":2,"path":"/kit/m5sticks3","type":"uplink.streaming","payload":{"frames":50}}
   {"seq":3,"path":"/kit/m5sticks3","type":"pushToTalk.stopped","payload":{"source":"physical"}}
   {"seq":4,"path":"/kit/m5sticks3","type":"playback.started","payload":{}}
   {"seq":5,"path":"/kit/m5sticks3","type":"playback.completed","payload":{"frames":192,"eos":true}}
   ```

   (Exact event names are an open choice; the _mechanism_ — one bounded
   emitter, golden text diff on host, same records on SD and on the wire —
   is the recommendation. Per the no-invented-concept-names rule, reuse
   apps/os event vocabulary verbatim where one exists.)

4. **Protocol conformance stays two-sided.** Keep the C-peer-vs-TS-runtime
   interop suite and the known-failure ledger as-is; add the _PCM_ framing
   the same treatment: one conformance fixture set (binary frames, EOS,
   subprotocol negotiation, close codes 4002/4011/4013) executed both by the
   C `websocket_rx`/`pcm_lane` tests and by `device-pcm-proxy.test.ts`,
   generated from the single wire-constant table (R10). Today nothing
   cross-checks the TS `iterate.kit.pcm.v1` string against the C macro
   except a `toContain` grep (`firmware-architecture.test.ts:136`).

5. **Metrics schema single-sourcing (R7) makes schema tests trivial**: with
   an X-macro table, one host test renders every surface (struct, capnweb
   expression, `getDiagnostics` snprintf) from one fixture and diffs — the
   current hand-counted key lengths (`metrics.c:352,405-407`) and
   triplicated field spellings stop being reviewable-only.

### 2.2 Keeping the pthread-fakes trick for new platform adapters

This is the single most distinctive v1 property (review §3 table row 1) and
must survive as a **rule**, not an artifact:

- Every platform adapter ships three things or it doesn't merge: (a) its
  sources compile in the host tree against `tests/fakes/` shims, (b) the fake
  models _contracts_ (short writes, deferred connects, coalesced
  notifications, virtual clock) — never happy paths, (c) at least one test
  drives the adapter's riskiest concurrency (generation handshake / discard /
  restart) on the fakes, sanitized build included.
- Close the two existing holes while the pattern is being touched:
  compile `websocket_connection.c` on host (its errno classifier and URL
  parser are exactly the fake-able kind), and add `peer_test.c`.
- The future ESPHome adapter (deferred; see repo commit "Document deferred
  ESPHome device adapter") gets the same treatment: fake the ESPHome
  component API surface it consumes, compile the real adapter against it.
- Practical cost datum: the fakes directory is ~15 files today
  (`firmware/tests/fakes/`), and the two transport tests it enables cover the
  five-generation-counter machine the firmware-core report calls "the
  correctness core" — this is the cheapest insurance in the codebase.

### 2.3 New layer-1 families worth adding (with honest costs)

1. **Property/fuzz targets** (cheap, high yield on parsers):
   - `websocket_rx` frame parser and `websocket_frame_writer` round-trip
     (libFuzzer harness like capnweb's existing fuzzer; run 60 s in the
     nightly lane, not per-PR).
   - `configuration.c` TLV decoder (attacker-adjacent: it parses flash images
     also produced by the browser flasher).
   - `spsc_ring` model-based test: random interleavings against a reference
     deque model (the existing `spsc_ring_test.c` already links pthreads;
     add a seeded-schedule variant). _Not_ recommended: TLA+/model checking
     of the generation counters — the review's R13 "express the five
     generation counters as an explicit state machine" gets 90 % of the value
     for 5 % of the cost, and the explicit state machine then unit-tests
     conventionally.
2. **Null/fake processor seam tests** (§2.1.2) — sub-millisecond each.
3. **Event-core golden logs** (§2.1.3) — sub-millisecond each, and they
   replace ad-hoc assertions scattered across `m5sticks3_events_test.c` and
   the simulator e2e.
4. **Wire-constant equality tests** (R10): one generated C header + one
   generated TS module from one table; vitest asserts deep-equality of the
   TS module against constants extracted from the C header build; the
   "startup prebuffer described by three different numbers" composition
   (host 3 frames + firmware 4 descriptors, stacking to 60+80 ms in
   device-clocked mode) becomes one named, tested constant.
5. **Golden-replay corpus — rig captures as host fixtures.** Every layer-2
   run already writes retained PCM16 artifacts (mic capture; v2 adds uplink
   capture, §3.1). Curate a small corpus (~10 clips × ≤ 10 s = ~10 MB at
   16 kHz) of _real_ rig captures — including the convicted-instrument and
   late-frame incidents — and run the analyzers over them in vitest. This is
   how analyzer refactors (e.g. the dual in-memory/streaming tone
   implementations flagged in the host-pipeline report §6.12) stay honest
   without a device. The analyzers are already O(1)-memory streaming, so the
   suite stays fast.

### 2.4 CI lane and wall-clock budget

| Stage        | What                                        | Budget (warm local)                                            | Budget (cold CI) |
| ------------ | ------------------------------------------- | -------------------------------------------------------------- | ---------------- |
| native build | cmake configure + build host tree           | ≤ 5 s incremental                                              | ≤ 90 s           |
| native test  | 38 → ~50 executables, assert-style          | **≤ 5 s total** (they are pure-CPU; virtual clocks, no sleeps) | ≤ 10 s           |
| vitest       | ~295 → ~350 tests incl. analyzers on corpus | ≤ 30 s                                                         | ≤ 90 s           |
| sanitized    | ASan/UBSan native rebuild + run             | opt-in                                                         | nightly, ≤ 5 min |
| fuzz         | capnweb + websocket_rx + TLV, 60 s each     | opt-in                                                         | nightly          |

Rules to keep it sub-second _per test_: no real sleeps anywhere (the fault
harness and pthread fakes already use virtual clocks — make that a review
gate); no network even to localhost in unit lanes (captun `WebSocketPair`
in-process pairs only); the live tunnel test stays opt-in behind
`ITERATE_KIT_LIVE_TUNNEL_TEST=1` as today. The current structure where vitest
_shells out_ to cmake (`stackchan-simulator.e2e.test.ts:168-186`) is fine and
keeps "one command runs everything" (`pnpm test`); do not split native tests
into a separately-forgettable CI job.

### 2.5 Layer-1 roads not taken

- **QEMU/Wokwi ESP32-S3 emulation.** Rejected (again): timing infidelity
  makes it a _misleading_ middle layer — it would pass scheduling tests the
  real chip fails and vice versa. The prior off-device-rig research reached
  the same conclusion (sans-I/O virtual-clock rig, not emulation). The
  pthread-fakes + virtual-clock approach tests the same code with _honest_
  non-claims about timing.
- **Adopting a C test framework (Unity/CMocka/Catch2 everywhere).** The
  zero-framework assert style is faster to build, trivially debuggable, and
  the behavior-named + reasoning-comment convention does the documentation
  work a framework would. Catch2 stays confined to the vendored-IDF host
  suite where it already exists.
- **Running esp-sr AFE on the host.** Impossible — the AFE is a prebuilt
  Xtensa/RISC-V blob. Host-side AEC coverage instead comes from the
  processor-seam fake + golden-replay corpus (and optionally a host build of
  WebRTC AEC3 behind the same seam purely as a _reference implementation_
  for analyzer development — explicitly not the device engine).
- **Model-checking the memory-ordering discipline.** Cost/benefit fails;
  R13's explicit state machine + existing hammer tests are the pragmatic
  substitute. Host x86/ARM being stronger-ordered than Xtensa remains a
  documented non-claim (firmware-core report §6).

---

## 3. Layer 2 — the rig: device next to the computer speaker that runs the tests

### 3.0 Rig principles (mostly already paid for)

- **The Mac is the precision test controller** (goal doc
  `physical-device-voice-goal.md:289-296`): injects deterministic far-end and
  near-end audio, captures, timestamps, collects Cap'n Web metrics, computes
  echo reduction / near-end damage / drop rate / heap drift / latency slope.
- **Two acoustic directions, one loudspeaker, one microphone.**
  - _Downlink direction (device speaker → Mac mic)_: fully built — tone +
    PRBS31 oracles.
  - _Uplink direction (Mac speaker → device mic)_: today only the `--voice`
    `say` + Grok path. v2's key addition: the Mac speaker plays a
    **deterministic fixture rendered by the exact same renderer factories**
    (`DeterministicPcm16LeRenderer`, `deterministic-pcm-provider.ts:9-18`),
    and the harness captures the **device's uplink PCM** at the proxy and
    runs the _same analyzers_ on it. Symmetry is the design: one signal
    family, one analyzer family, both physical directions.
- **Recorder integrity is a precondition, not a hope**: keep the SoX-only
  capture with provenance (`macos-pcm16-capture.ts:110-118`), the
  sample-count-vs-wall-time integrity check, and the recorder loopback
  control required by the goal doc (`:360-366`) — a short Mac-speaker→Mac-mic
  self-play at run start proves the instrument before it judges the device.
  This same self-play doubles as **room calibration**: measure noise floor
  (assert < threshold RMS, reusing `causal-speech-energy-analysis.ts`
  constants: `minimumAbsoluteActiveRms=120`, `baselineMultiplier=2.5`) and
  the Mac-speaker→Mac-mic level so fixture amplitude can be normalized per
  room/desk. Store the calibration block in every run manifest.
- **Device isolation**: the goal doc already mandates "power down, mute, or
  acoustically isolate the inactive target" (`:323-324`). With four boards on
  the hub (brief: M5StickS3, StackChan, HA Voice PE, Waveshare), make this
  _asserted_, not procedural: the rig refuses to start an acoustic scenario
  unless every other known board is either unpowered (no /api mount within a
  2 s probe window) or explicitly acknowledged muted by the operator flag
  `--accept-cohabitant <id>`. Cheap and prevents a whole class of
  cross-contaminated captures.
- **Drive plumbing**: unchanged in kind — control via the mounted Cap'n Web
  device (`/api`), audio via `/pcm` with deterministic providers behind the
  provider seam, Captun or direct-LAN with identical fetch handler. The
  requirement-8 event stream subscription becomes the rig's primary ordering
  witness (replacing several bespoke metric predicates like
  `deviceUplinkStreaming`).

### 3.1 Scenario i — PTT uplink echo loop (new)

_Purpose_: deterministic, analyzable proof of the entire capture→uplink chain
(mic hardware → BoundedCapture → lane → conductor/sender → TLS → proxy),
which today has only counter evidence (222 frames, 0 drops, goal doc
`:338-341`) and an unasserted Grok transcription.

Mechanics:

1. New `DeterministicPcmUplinkRecorderProvider`: speaks the provider contract
   like the tone/PRBS providers but the interesting direction is _inbound_ —
   it appends every uplink binary frame to a PCM16 artifact on disk (mirroring
   `MacOsPcm16Capture`'s bounded-artifact discipline) and emits a trivial
   canned `response.done` when asked. ~80 LOC next to
   `deterministic-pcm-tone-provider.ts`.

   ```ts
   // src/voice/deterministic-pcm-uplink-recorder-provider.ts (sketch)
   export class DeterministicPcmUplinkRecorderProvider implements Disposable {
     // connect(): WebSocketPair; on binary message → append to artifact file
     // (frames are exact 640 B by proxy contract, device-pcm-proxy.ts:462-500)
     // exposes { artifactPath, frameCount, firstFrameAtMonotonicMs }
   }
   ```

2. Render the PRBS31 challenge to a 10 s WAV **once per run** using the same
   challenge object (`createDualCarrierPrbs31Challenge({runId})`), upsampled
   to 48 kHz for the Mac DAC, and play it through the Mac speaker (SoX `play`
   — same binary we already require — or `afplay`). Record a marker
   (`recordAcousticMarker` pattern, `device-e2e.ts:248-277`) before starting
   playout.
3. Choreography: `pushToTalk.start` RPC → Mac speaker plays fixture → hold
   spans fixture + 500 ms → `pushToTalk.stop` → wait for uplink counters +
   `input_audio_buffer.commit` boundary.
4. Assertions on the _uplink artifact_ via the existing PRBS31 analyzer
   (`analyzeDualCarrierPrbs31Pcm16Artifact` — it takes any PCM16 path):
   acquisition, carrier agreement, `skippedChipCount` (mic capture gaps at
   1 ms resolution — this is the direct physical detector for the §4.1
   "capture is a priority orphan" defect class), `duplicatedChipCount`,
   `fittedClockDriftPpm` (now measuring Mac-DAC→room→device-ADC clock chain —
   widen the threshold from 500 ppm to ~2,000 ppm and record; drift here is
   _diagnostic_, discontinuity is _acceptance_), and amplitude-envelope
   steps. Acoustic path degradation (room EQ) affects soft-correlation
   margins, so acceptance thresholds for the airgapped uplink direction get
   their own entry in the threshold home (§5) seeded looser than the
   speaker-side ones, tightened after baseline runs — exactly the goal-doc
   posture for AEC numbers (`:437-438`).
5. Layer interplay: with `--control-churn-hz` and display activity enabled,
   this scenario becomes the _physical regression test for capture
   starvation_ (R1): pre-R1 firmware should show skipped chips under a main
   task stall; post-R1 must not.

Cost: ~1 new provider (~80 LOC), ~1 WAV-render helper (~40 LOC; renderer
reuse), 1 scenario file (~150 LOC). Runtime ≈ 40 s.

### 3.2 Scenario ii — full-duplex AEC proof (StackChan; new)

_Purpose_: requirement "AEC MUST provably work" with the goal doc's numeric
hypotheses: **≥ ~10 dB far-end echo reduction, < 3 dB near-end speech damage
during double-talk, successful interruption**
(`physical-device-voice-goal.md:317-321`), and the mandated three-way
capture: "speaker reference, raw microphone, and post-AEC microphone"
(`:292`).

Design (three timed phases in one capture, boundaries via acoustic markers):

| Phase                   | Device plays (far end) | Mac speaker (near end)                                          | Uplink contains   | Measures                                                                                                                                                                        |
| ----------------------- | ---------------------- | --------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A: far-end only, ~20 s  | PRBS31 (run-keyed)     | silence                                                         | residual echo     | ERLE = 10·log10(P_mic_raw_echo / P_uplink_residual) in the PRBS band; also PRBS acquisition on uplink should _fail_ (good AEC destroys the watermark — an elegant binary check) |
| B: near-end only, ~15 s | silence                | speech fixture (fixed recorded phrase, not `say` — determinism) | near-end baseline | uplink/fixture spectral distance baseline; also VAD edge events (requirement 8) asserted                                                                                        |
| C: double-talk, ~20 s   | PRBS31                 | same speech fixture                                             | mix               | near-end damage = spectral-band distance of uplink-vs-phase-B in speech bands, target < 3 dB; residual echo as in A                                                             |

The three-way capture problem: post-AEC mic is the normal uplink; the
**reference** is the R11 software TX tap at `DirectI2sStereoOutput::writeMono`
(mono frame + EOF timestamp already in one monotonic domain,
`realtime_playback.hpp:83-99`); the **raw mic** needs a debug tap. Options:

- (a) _Interleaved debug dump mode_ (ADF's method, review R11): a diagnostic
  device mode that uplinks interleaved raw-mic/ref stereo instead of the
  processed mono — used only in phase-A calibration runs to verify the
  0–10 ms mic-lags-ref window and set ref pre-delay. Cheapest; my
  recommendation.
- (b) SD-card capture of raw mic + ref during the run (requirement 5 synergy;
  16 kHz × 2 ch × 2 B = 64 KB/s, trivially within SD bandwidth), pulled after
  the run. Better fidelity (no network competition), slower iteration.
- (c) A second bounded WS debug stream (xiaozhi's UDP debugger shape).
  Rejected for v1 of the rig: a third socket contradicts the
  two-connections-at-all-times doctrine and competes with the lane under
  test.

Acceptance math: steal the seekaudio harness's ERLE/AECMOS report format
(their harness is MIT; the engine is not — review §7). AECMOS (a learned MOS
estimator) is optional/nightly; band-power ERLE and spectral-distance damage
are deterministic and CI-able. All three numbers go to the manifest verbatim
per the goal doc's "report exact measurements so thresholds can be corrected"
(`:319-321`).

Runtime ≈ 3 min including analysis. Precondition: R2 processor seam +
StackChan audio bring-up; the _scenario code_ has no StackChan dependency and
should be written against the seam first (it degenerates to a null-processor
echo-measurement run on the Stick, which is itself the **server-side AEC
feasibility measurement** — the echo path magnitude the server AEC must
cancel).

### 3.3 Scenario iii — barge-in / interruption timing (new)

_Purpose_: put a stopwatch on "interruptions immediately discard queued
playback" (goal doc `:531`), which today is proven logically
(`audio.c:236-273` stop+flush always) but never physically timed; the PTT
press fence is "bounded at 1 s … unmeasured as a first-class metric"
(firmware-audio report §8.3).

Mechanics: device plays the 997 Hz tone via the deterministic provider; at
T≈50 % of the fixture the harness issues the interrupt (PTT variant:
`pushToTalk.start` RPC; StackChan/VAD variant: Mac speaker speaks the
near-end fixture and server VAD triggers). Assertions:

- Acoustic: tone `observedEndMs` (existing analyzer field) minus the
  interrupt marker ≤ **budget**; zero coherent tone windows after
  `observedEndMs + 50 ms` (no zombie DMA). Budget derivation: RPC dispatch
  (≤ 20 ms tick) + fence (amp off + `i2s_del_channel`) + in-flight
  descriptor (≤ 80 ms of DMA prebuffer) ⇒ propose **≤ 250 ms** initial,
  tighten with data. VAD variant adds the provider round trip; budget
  ≤ 700 ms initial (measured, not guessed — record always).
- Event ordering (requirement 8): `pushToTalk.started` /
  `playback.interrupted` events precede acoustic silence; sequence gaps zero.
- Counters: exactly one flush incident; all other
  `counterMaximumDeltas` zero (reuse the recovery-proof "conserved
  incident" pattern, `device-e2e.ts:545-552`).

Runtime ≈ 30 s. This is also the natural home for the R12
playback-drained → mic-open turn-start polish measurement (device-side gap
between EOS acoustic end and first captured uplink chip).

### 3.4 Scenario iv — endurance ladder (exists; extend)

Keep `runPlaybackEnduranceLadder` exactly as designed (frozen
1/2/10-minute rungs × load profiles, stop-at-first-failure, manifest per
rung — `playback-endurance-ladder.ts:35-124`; frozen Stick acceptance policy
with ~21 zero-tolerance counters,
`m5sticks3-playback-endurance-target.ts:48-121`). v2 work:

1. **Fill the intentionally-empty runtime adapter**
   (`device-e2e.ts:554-574`): the blocker list is explicit — stable running
   identity, firmware SHA, per-descriptor playback telemetry, exact applied
   load, physical recording ownership. Most of these fall out of R6 (profile
   reported through metrics) + R7 (schema single-source) + the event core
   (boot id in every event).
2. **Add rungs for the new directions**: uplink echo-loop endurance (Mac
   speaker loops the PRBS fixture for the rung duration; device in
   full-duplex capture) and — post-StackChan — a duplex rung (phases A/C of
   §3.2 alternating). The ladder core needs no change; these are new
   `PlaybackEnduranceTarget`s/load profiles, which is exactly the
   adapter/core split the module was built for
   (`playbook-endurance-ladder.ts:42-55` comment).
3. Full ladder cost stays ~30 min (2 profiles × 13 min + overhead) per
   direction; the 1-minute rung alone is the pre-merge smoke.

### 3.5 Scenario v — server-side AEC validation via timestamp echo (new; requirement 9)

_Purpose_: prove the transport carries what a server AEC needs **before**
implementing server AEC. On the Stick (PDM mic, no loopback — device AEC
structurally impossible, review §4.6), this is the only full-duplex road.

Mechanics: adopt the xiaozhi v2 idea in our wire vocabulary — device records
the play-out timestamp of the downlink frame currently at the DAC
(per-descriptor EOF timestamps already exist,
`realtime_playback.hpp:83-99`) and stamps each uplink frame with it
(header extension on `/pcm` v2 uplink frames, or a parallel low-rate event —
open wire question for the plan round; xiaozhi uses a 16-byte binary header,
`protocol.h:17-24`). Rig scenario:

1. Device full-duplex (null processor); deterministic downlink = PRBS31;
   Mac speaker silent; device mic hears its own speaker.
2. Host aligns its known downlink reference against uplink audio two ways:
   (a) by echoed timestamps, (b) by PRBS31 correlation peak (ground truth —
   the watermark decodes the _exact_ chip index, so alignment truth is
   ±0.5 ms).
3. Assert |timestamp-alignment − correlation-alignment| ≤ 20 ms (1 frame),
   drift of that error < 500 ppm over 60 s, and monotonicity across an
   induced reconnect (generation boundary must re-anchor, not accumulate).

This turns requirement 9 into a measurable transport property with ~1 rig
scenario + a small firmware timestamp-echo change, deferring all actual
echo-cancellation DSP to userspace later. Runtime ≈ 60 s.

### 3.6 Reuse-vs-new against `device-e2e.ts`, and its decomposition

Reuse verbatim (move, don't rewrite):

| Asset                                                                          | Today                                                                          | v2 home                                                                                                         |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `DeviceRuntimeProbe` (fail-fast racing, envelope continuity, counter tripwire) | `scripts/device-e2e.ts:1388-1689`                                              | `src/rig/device-runtime-probe.ts` (it's the rig kernel; it does not belong in a script file)                    |
| Acoustic marker discipline                                                     | `:248-277`, `:894-911`                                                         | `src/rig/acoustic-session.ts` wrapping `MacOsPcm16Capture` + markers + tail + preserve-on-failure (`:852-1003`) |
| Transport bring-up (captun vs direct-LAN, same fetch handler)                  | `:346-399`                                                                     | `src/rig/transport.ts`                                                                                          |
| Flash / verified no-flash / provisioning                                       | `:186-206`, `:401-422`, `:1307-1335` (+ existing `device-e2e-provisioning.ts`) | `src/rig/provisioning.ts`                                                                                       |
| Bounded control churn + applied-load judgment                                  | `:614-685`                                                                     | `src/rig/load/control-churn.ts`                                                                                 |
| Physical network monitor + validity artifact + refuse-to-guess under tunnel    | `:711-753`, `:1005-1042`                                                       | `src/rig/network-evidence.ts`                                                                                   |
| Deterministic providers + renderers                                            | `src/voice/*`                                                                  | unchanged; add uplink-recorder + WAV-render helper                                                              |
| Analyzers + assessments                                                        | `src/device/acoustic-*.ts`                                                     | unchanged (they are already pure)                                                                               |
| Endurance ladder + acceptance policy                                           | `src/device/playback-endurance-*.ts`                                           | unchanged core; adapters filled                                                                                 |
| SoX capture + provenance                                                       | `macos-pcm16-capture.ts`                                                       | unchanged; add the loopback-control self-play helper                                                            |

New shape — **scenario objects, one file each**, composed by a thin runner:

```ts
// src/rig/scenario.ts (sketch)
export interface RigScenario<Result> {
  id: string; // "tone-playback", "uplink-echo-loop", …
  requires: {
    acousticCapture: boolean;
    macSpeaker: boolean; // rig refuses headless runs when true
    serial: boolean;
    provider: "tone" | "prbs31" | "uplink-recorder" | "grok" | "none";
  };
  run(rig: RigSession): Promise<Result>; // RigSession = probe + mounted
  // device + server + acoustic +
  // evidence writer
}
```

Scenario inventory after decomposition: `tone-playback`, `prbs31-playback`,
`playback-recovery`, `endurance` (ladder driver), `voice-grok` (kept as the
one non-deterministic smoke), `uplink-echo-loop` (§3.1), `aec-proof` (§3.2),
`barge-in` (§3.3), `server-aec-alignment` (§3.5), `remote-ptt` +
`physical-ptt` (the current non-audio tail, `:1053-1245` — the physical half
migrates into layer 3's checkride).

Evidence protocol: replace the stringly `console.log key=json` line protocol
(host-pipeline report smell #8) with one **JSONL evidence writer** — every
record `{atMonotonicMs, kind, payload}` appended to
`<run-dir>/evidence.jsonl`, console keeps a human mirror. The endurance
manifest writer (`playback-endurance-evidence-writer.ts`) already models the
durability discipline; generalize it rather than inventing a second one. This
matters doubly because layer 3 and the future apps/os stream (requirement 8)
consume the same records.

What this does to size: `runDeviceE2e` (~1,090 lines) becomes a ~150-line
composition per scenario plus ~500 lines of shared rig modules — and the
shared modules gain unit tests they cannot have today (the probe is only
testable because `device-e2e-runtime-probe.test.ts` reaches into a script
file; several helpers (`withTimeout` triplication, smell #10) fold into one
`src/rig/util.ts`).

### 3.7 Layer-2 roads not taken

- **Electrical loopback (aux cable) instead of acoustics.** The Stick has no
  line-in; more importantly the whole point of the rig is that "DMA
  completed" ≠ "audible" (`realtime_playback.hpp:107-113` doctrine). Room
  air is the medium under test. (For _analyzer_ development, the Mac
  speaker→Mac mic self-play is the controlled substitute.)
- **A second reference microphone / measurement-grade audio interface.**
  Tempting for AEC work; deferred until phase-A measurements show the Mac
  mic's AGC/mode variance (already captured as provenance,
  `macos-avfoundation-provenance.ts`) actually blocks a threshold decision.
  Buying hardware before the software rig saturates is premature.
- **Automated power/mute control of cohabitant boards (smart plugs).**
  Nice-to-have; the assert-isolation check in §3.0 gets the safety without
  new hardware. Revisit when the rig runs unattended on a schedule.
- **Turning the rig into CI (device farm).** The rig stays
  human-initiated-but-fully-scripted for v2. A scheduled nightly on the hub
  Mac is cheap once scenarios are decomposed, but gating PRs on physical
  acoustics invites flake-driven erosion of the zero-tolerance thresholds —
  the thresholds are the asset; protect them from statistical pressure.
- **Driving the far end through a real Grok session for deterministic
  scenarios.** Explicitly rejected already (the tone provider comment,
  `deterministic-pcm-tone-provider.ts:11-21`): provider synthesis is an
  uncontrolled variable. Grok stays as exactly one smoke scenario.

---

## 4. Layer 3 — human-in-the-loop checkride

### 4.1 Shape: a scripted checklist the kit CLI walks a human through

Today the only human-in-the-loop test is the tail of `device-e2e.ts`
(`:1207-1242`): print "hold and release Button A", wait for the
serial-observed event. v2 promotes this into `pnpm kit checkride
--device m5sticks3` — a **< 5-minute, ~8-step interactive session** where the
harness does every assertion it can (events, metrics, timing, acoustics) and
the human supplies only what no instrument can: intent, perception, and
fingers.

```ts
// src/checkride/step.ts (sketch)
export interface CheckrideStep {
  id: string; // "ptt-hold-speak"
  prompt: string; // shown + spoken via `say` (hands are busy)
  timeoutMs: number; // auto-fail, keeps the 5-min budget
  expect: {
    events?: Array<{
      type: string;
      payload?: Record<string, unknown>;
      withinMsOfPrevious?: number;
    }>; // asserted against the
    // requirement-8 stream
    metrics?: Array<{ name: string; delta: ">0" | "0" | number }>;
    acoustic?: "device-spoke" | "silence" | { toneHz: number };
  };
  ask?: Array<{
    id: string;
    question: string; // subjective verdicts
    kind: "yes-no" | "scale-1-5";
  }>;
}
```

Example M5StickS3 checkride (≈ 4 min 30 s wall, timeouts included):

| #   | Prompt (human does)                                                                                                                       | Harness asserts                                                                                                                                              | Human answers                                             |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| 1   | "Do nothing" (5 s)                                                                                                                        | mount healthy, event stream subscribed, ambient noise floor OK                                                                                               | —                                                         |
| 2   | "Press and HOLD Button A; say 'testing one two three'; release"                                                                           | `pushToTalk.started{source:physical}` → uplink frames > 0 while held → `pushToTalk.stopped` ordering + sequence gaps 0; press-to-first-uplink-frame ≤ 500 ms | "Did the button feel like it registered immediately?"     |
| 3   | (device replies via Grok or canned playback)                                                                                              | `playback.started` → `playback.completed{eos}`; speech-energy oracle sees device audio                                                                       | "Was the reply clearly audible? Any clicks/pops?" (scale) |
| 4   | "Press A _during_ the reply"                                                                                                              | interrupt event; acoustic stop ≤ budget (same math as §3.3, looser because human timing)                                                                     | "Did it stop instantly to your ear?"                      |
| 5   | "Double-click A quickly"                                                                                                                  | exactly 2 start/stop pairs, no stuck state                                                                                                                   | —                                                         |
| 6   | Mic loopback: "hold A, speak, release — your own voice should play back" (steal xiaozhi `EnableAudioTesting`, `audio_service.cc:679-693`) | capture→playback counters conserve                                                                                                                           | "Did you hear yourself clearly?"                          |
| 7   | "Unplug the Wi-Fi AP (or toggle it off) for ~10 s, then restore"                                                                          | both sockets recover (requirement 10); reconnect events observed with reasons; no reboot; recovery ≤ 30 s                                                    | —                                                         |
| 8   | "Look at the screen/LED through steps 2–4" (retrospective)                                                                                | avatar-state events emitted matched audio-state timeline                                                                                                     | "Did the face/LED state match what it was doing?"         |

Step 7 is worth flagging: the AP-kill drill is **only** doable at layer 3
(a human physically controls the radio environment), and it is precisely the
station-outage class we have paid for twice in incident research. It converts
requirement 10 from a code-review property into a 30-second ritual.

### 4.2 What ONLY layer 3 can prove

- **Button feel**: debounce vs. perceived responsiveness; hold-vs-click
  thresholds matching human motor expectations.
- **Perceived latency**: mouth-to-ear round trip "feels snappy" — the rig
  measures milliseconds; only a human decides if the milliseconds are okay.
- **Avatar/screen/LED correctness**: the rig's microphone cannot see; camera
  automation is not worth building for four boards (road not taken, §4.4).
- **Acoustic quality opinions**: timbre, loudness comfort, hiss, resonance —
  the tone/PRBS oracles prove _continuity_, not _pleasantness_. (The −18 dB
  DAC ceiling brownout fix changed loudness; only a human noticed vs. cared.)
- **Physical robustness rituals**: cable wiggle, AP kill, pick-the-device-up
  (mic handling noise), case buzz at volume.

### 4.3 Evidence

Every checkride writes the same JSONL evidence + a manifest in the endurance
manifest's shape (policy identity, thresholds version, per-step verdicts,
subjective answers verbatim, artifact paths). Two extra witnesses:

- **SD cross-check (requirements 5+8 synergy)**: after the run, pull the
  device's SD event log (or read the tail over a diagnostic RPC) and diff the
  device's own event ledger against the host-observed stream — sequence gaps
  in either direction are findings. This makes the SD logger _tested by
  default_ rather than being an untested comfort feature, and it is the
  cheapest possible proof that "the on-device data structure is events"
  survived contact with reality.
- Optional acoustic capture runs throughout (checkride is < 5 min ⇒ < 30 MB
  at 48 kHz mono), so any subjective "it clicked" answer has a waveform to
  point at.

### 4.4 Layer-3 roads not taken

- **Camera pointed at the screen to automate avatar checks.** Cost (fixture,
  lighting, CV flake) wildly exceeds value at 4 devices; the event-timeline
  assertion in step 8 plus a human eye is strictly more trustworthy today.
- **Making checkride steps skippable/reorderable.** The endurance ladder's
  lesson applies (frozen acceptance policy object,
  `m5sticks3-playback-endurance-target.ts:40-47`): a diagnostic mode may
  cherry-pick; the _acceptance_ checkride is a frozen versioned list or the
  manifest says "diagnostic".
- **Voice-controlled harness ("say next to continue").** Cute, but the
  harness's own speech would contaminate acoustic steps; keyboard + spoken
  prompts (`say`) is the right asymmetry.

---

## 5. One home for fixtures and thresholds

Today's split (host-pipeline report smell #9): acoustic acceptance literals
inline at call sites (`scripts/device-e2e.ts:913-921`: 1.5 dB / 1.5 dB /
200 ms / 0 ms gap / 200 ms missing / 0.1 rad) _and_ the same six numbers
frozen inside `m5StickS3PlaybackEnduranceAcceptancePolicy.thresholds.acoustic`
(`m5sticks3-playback-endurance-target.ts:66-74`), plus PRBS31 defaults in a
third file (`acoustic-prbs31-challenge.ts:102-113`), plus the live tunnel
test's own receiver model, plus C-side policy constants in
`esp_idf_websocket_policy.h`.

v2 rule: **one threshold module per device target, one wire-constant table
for both languages, everything else imports.**

```ts
// src/acceptance/m5sticks3.ts (sketch — THE home; naming open)
export const m5sticks3Acceptance = deepFreeze({
  version: 2,
  wire: pcmWireV1, // generated from the R10 table; the C
  // header is generated from the same table
  acoustic: {
    /* today's six numbers, one place */
  },
  acousticUplink: {
    /* §3.1 airgapped-direction seeds, looser, versioned */
  },
  watermark: dualCarrierPrbs31DefaultThresholds,
  bargeIn: { maximumStopLatencyMs: 250, vadVariantMaximumStopLatencyMs: 700 },
  aec: { minimumErleDb: 10, maximumNearEndDamageDb: 3 }, // goal doc :317-321
  counters: {
    /* counterMaximumDeltas — today's ~21 zeros */
  },
  endurance: { durationsMs: [60_000, 120_000, 600_000] },
  checkride: { pressToFirstUplinkMs: 500, wifiRecoveryMs: 30_000 },
});
```

Consumers: rig scenarios (layer 2), the endurance target (its `thresholds`
becomes a re-export), the live tunnel test, the checkride (layer 3), _and the
golden-replay vitest fixtures_ (layer 1) — so a threshold change is one diff
reviewed once, and every manifest already records the policy version it ran
under (the endurance manifest does this today; extend the idiom). Fixtures
follow the same rule: renderer factories are the single signal source —
unit tests consume them via `WebSocketPair`, the rig consumes them via
provider _and_ via WAV render for the Mac speaker, so a fixture change
propagates to all three layers by construction.

---

## 6. Test-pyramid table — every v2 module × the three layers

Modules per the review's target layout (§5). ● = primary proof lives here,
◐ = exercised/witnessed, — = not applicable.

| v2 module                                         | L1 host (<1 s)                                                          | L2 rig                                             | L3 human                                          |
| ------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------- |
| `vendor/capnweb`                                  | ● unit + fuzzer + TS interop w/ known-failure ledger                    | ◐ every mount                                      | —                                                 |
| `core/itx_mount`, `itx_connection`                | ● real-JSON round-trip tests (`itx_mount_test.c`)                       | ◐ real tunnel mount; churn under load              | —                                                 |
| `core/websocket_tx/rx/text/frame_writer`          | ● unit + tcp_transport host suite + NEW fuzz                            | ◐ live tunnel cadence gate (opt-in)                | —                                                 |
| `core/spsc_ring`, `retry_gate`, `atomic`          | ● unit (threaded) + NEW model-based schedules                           | —                                                  | —                                                 |
| `core/configuration` (TLV)                        | ● unit + NEW fuzz                                                       | ◐ no-flash esptool read-back verify                | —                                                 |
| **`core/event_core` (req 8, NEW)**                | ● golden event-log diffs                                                | ● ordering witness in every scenario               | ● checkride assertion vocabulary + SD cross-check |
| `core/runtime_diagnostics`                        | ● unit                                                                  | ◐ serial lane (`ITERATE_KIT_SERIAL_DIAGNOSTICS=1`) | —                                                 |
| **`sd_logging` (req 5, NEW)**                     | ● unit vs fake block device incl. write-stall/never-blocks-audio faults | ◐ ledger-vs-host-evidence diff after runs          | ● checkride pulls the card                        |
| `audio/pcm_lane`, conductor, sender, peer guard   | ● unit + virtual-clock fault harness                                    | ● uplink echo loop; endurance                      | —                                                 |
| `audio/audio_controller` (PTT/duplex modes)       | ● unit (`audio_controller_test.c`)                                      | ● barge-in timing                                  | ● button feel, double-click                       |
| **`audio/audio_processor` seam (R2, NEW)**        | ● null/fake processor contract tests; ERLE regression on replay corpus  | ● AEC proof (ERLE ≥ 10 dB, damage < 3 dB)          | ● perceived duplex quality                        |
| `audio/playback policy` (`RealtimePlayback`)      | ● descriptor-identity tests (1,989 LOC)                                 | ● tone/PRBS oracle, recovery proof, endurance      | ◐ clicks/pops opinion                             |
| `analysis` (viseme/renderer-input, later)         | ● golden fixtures from recorded PCM                                     | ◐ avatar-state events vs audio timeline            | ● only judge of avatar feel                       |
| `capabilities/metrics`                            | ● subscription scheduler unit (1,169 LOC)                               | ● envelope continuity + churn load                 | —                                                 |
| `capabilities/device_event_stream`                | ● unit                                                                  | ● subscription is the rig's witness                | ● checkride mechanism                             |
| `capabilities/screen`, `leds`, `servos`, `camera` | ● unit vs fake drivers                                                  | — (rig is blind)                                   | ● visual verification — only layer                |
| `platforms/*` itx + pcm transports                | ● REAL sources vs pthread fakes (generation machine)                    | ● station churn, outage recovery telemetry         | ● AP-kill drill (req 10)                          |
| `platforms/*` websocket_connection                | ● NEW: compile on host (errno + URL parser)                             | ◐ every connection                                 | —                                                 |
| `platforms/*` direct audio / capture              | ● descriptor-identity + bounded-capture tests                           | ● all acoustic scenarios                           | ◐ loudness/timbre                                 |
| `platforms/*` esp_sr processor (later)            | ◐ contract-only (blob can't run on host) — fake stands in               | ● AEC proof is its real test                       | ◐                                                 |
| `devices/*` composition roots                     | ● simulator e2e (control-plane)                                         | ● full scenarios                                   | ● checkride                                       |
| `targets/*` main                                  | ◐ arch tests → link-time checks                                         | ● everything physical                              | ● everything human                                |
| host `device-pcm-proxy` + providers               | ● 24+ unit tests                                                        | ● drives every scenario                            | ◐ drives checkride playback                       |
| host analyzers                                    | ● unit + replay corpus                                                  | ● produce every verdict                            | ◐ post-hoc on checkride capture                   |

Reading the table: only three cells demand new _infrastructure_ (event core
goldens, uplink echo loop, checkride); everything else is decomposition,
relocation, or filling documented holes.

---

## 7. Open questions to put to Jonas (for the interview round)

1. **Event vocabulary**: adopt apps/os stream event shape verbatim now
   (path/type/payload + which envelope fields?), or freeze a device-local
   schema and map later? This decides the golden-log fixtures' spelling and
   the SD record format in one stroke.
2. **Timestamp echo wire shape** (§3.5): header bytes on `/pcm` uplink
   frames (xiaozhi-style, breaks the pristine 640 B frame) vs a parallel
   low-rate control event (keeps PCM pure, needs correlation logic)?
3. **Raw-mic tap for AEC proof** (§3.2): interleaved debug-dump mode (my
   recommendation) vs SD capture vs neither-until-StackChan?
4. **Should the 1-minute endurance rung + tone scenario become a scheduled
   nightly on the hub Mac**, or stay strictly human-initiated? (Decomposed
   scenarios make either trivial; the flake-pressure argument in §3.7 says
   go nightly-with-nonblocking-reports first.)
5. **Checkride cadence**: per-PR-touching-firmware, per-flash, or
   per-release? The 5-minute budget was chosen so "per-flash" is realistic.
