# Iterate Kit audio/firmware architecture review — 2026-07-31

Status: review artifact, Fable xhigh. Inputs: six parallel deep-reads — three of
this tree (portable core + networking, the audio path, the host TypeScript
voice pipeline) and three of prior art cloned under `~/src/github.com/`
(`78/xiaozhi-esp32` @ e0074e9, `n-IA-hane/esphome-intercom` + its
`esphome-audio-stack` sibling @ dev, `espressif/esp-adf` release/v2.x +
`espressif/esp-sr` v2.4.6 + `esp_driver_i2s` + `seekaudio/seekaudio_aec_test`).
File:line references are from the current `c-capabilities` working tree.

The question under review: can the same well-tested core C code be structured
into coherent modules, combined with device-specific modules (physical mic/
speaker, buttons, display), and deliver a high-quality audio experience in both
full-duplex (VAD + AEC) and push-to-talk shapes — and are we ignoring lessons
the best ESP32-S3 projects already paid for?

---

## 1. Verdict

**The bones are better than the prior art in the dimensions the prior art
never attempted; the prior art is better than us in the dimensions we have not
yet faced.**

Ahead of all four studied projects (none of which have _any_ off-device test
story):

- **Host-testability as an architecture.** Sans-I/O portable cores with
  virtual-clock fault harnesses (`tests/pcm_realtime_fault_harness_test.c`),
  the real ESP-IDF transport adapter compiled against pthread fakes
  (`tests/fakes/fake_esp_idf_platform.c`), descriptor-_identity_ (not count)
  playback models, and a TS suite that pins ~20 architectural invariants to
  physical incidents (`src/device/firmware-architecture.test.ts`). Nothing in
  xiaozhi, esphome-audio-stack, or ADF comes close.
- **Bounded-everything with honest telemetry.** Every queue has capacity,
  high-water, drops, and an evidence-typed depth
  (`buffer_metrics.h:27-32` OBSERVED/DERIVED_BOUND/CAPACITY_ONLY/UNAVAILABLE);
  the peer-delivery guard bounds PCM hidden inside opaque TLS/lwIP buffers —
  a failure class the prior art doesn't even model.
- **Freshness-over-throughput as explicit policy.** Epoch purge on uplink
  backpressure, capture-age ceilings, reconnect as a freshness boundary,
  generation fencing down to physical DMA teardown. xiaozhi's equivalent
  ("flush the whole send queue on failure") is a comment-documented special
  case; ours is the design.
- **Zero-heap, allocation-free hot paths** — esphome-audio-stack works hard to
  approximate with preallocation + placement audits what we get by
  construction (all storage static in the target `Runtime` struct).

Behind the prior art, concretely:

1. **The uplink capture path is a priority orphan** (§4.1) — the single
   biggest realtime defect. Every studied project puts mic capture at or near
   the top of the priority ladder; we pump it from the priority-1 main task,
   below both network tasks, with 40 ms of hardware buffer.
2. **There is no speech-pipeline seam** (§4.2). xiaozhi's `AudioEngine` and
   esphome-audio-stack's `AudioProcessor` are the one interface that makes
   AEC/VAD/wake pluggable per device. We have audio _transport_ seams but no
   processor seam; StackChan AEC currently has nowhere to plug in.
3. **Tick-polled cadence in two places** (§4.3) where prior art is unanimous:
   let blocking DMA / event notification own the loop cadence.
4. **No runtime tuning surface** (§4.4). The goal doc demands "explicit tuning
   knobs"; today every knob is a recompile. esphome-audio-stack makes cores,
   priorities, buffer durations, and per-buffer PSRAM placement config data.
5. **Resource headroom is unmanaged for the AEC future** (§4.5): the audio
   path uses zero PSRAM (fine today) but AFE needs 60–90 KB internal +
   0.09–0.78 MB PSRAM and ~20 % of a core; IRAM has **one byte** free.

None of this requires a rewrite. The module boundaries you proposed are
essentially the right cut lines, most already exist in latent form, and the
recommendations in §6 are incremental.

---

## 2. The architecture as it stands

### 2.1 Strata (clean, verified)

```
vendor/capnweb            bounded C99 Cap'n Web peer (libc only, ~3k LOC)
        ▲
components/core           portable sans-I/O: itx mount/connection, websocket
                          tx/rx/text framing, spsc_ring, retry_gate, config,
                          PLUS the whole PCM lane + audio controller  ◄── one component, two concerns
        ▲
components/capabilities   metrics, push_to_talk, event stream, screen/leds/…
        ▲
devices/*                 composition roots (m5sticks3.c: 5 modules, no HW)
        ▲
platforms/iterate_esp_idf   itx_transport, pcm_transport, websocket_connection
platforms/iterate_m5unified m5sticks3_direct_audio, bounded capture
platforms/common            header-only templates (RealtimePlayback, DirectI2sStereoOutput)
        ▲
targets/m5sticks3/main    main.cpp — all storage static, boot order, main loop
```

Grep-verified: no `esp_*`/platform include anywhere under `components/`,
`devices/`, `vendor/`; the only `#ifdef`s in portable code are extern-C
guards. Layering violations are few and small (audio core includes `peer.h`;
the target reads transport struct internals; a platform policy header includes
a core PCM header) — catalogued in §5.

### 2.2 Task model on the M5StickS3 target

| Task                             | Core | Prio  | Owns                                                                                         |
| -------------------------------- | ---- | ----- | -------------------------------------------------------------------------------------------- |
| `app_main` main loop, 10 ms tick | 0    | **1** | buttons/display, Cap'n Web dispatch, **mic capture pump**, transport polls, metrics sampling |
| control net (`iterate-net`)      | 0    | 5     | control socket, reconnect generations                                                        |
| PCM net (`iterate-pcm-net`)      | 0    | 6     | PCM socket, uplink conductor, downlink receive                                               |
| audio owner (`iterate_audio`)    | 1    | 19    | all playback policy, I2S channel lifecycle, codec I2C                                        |
| I2S TX ISR (IRAM)                | 1    | —     | EOF timestamp → 4-slot SPSC → notify owner                                                   |

Downlink is the pampered path (own core, prio 19, new `i2s_channel` API,
4×1280 B DMA prebuffer, silence-recovery, generation poison). Uplink capture
is the orphan (see §4.1).

### 2.3 Dataflow (uplink)

M5Unified recorder (2×640 B armed buffers) → main-task poll (≤1 frame/10 ms
tick, ≤1 borrowed frame in flight) → 32-slot×648 B SPSC ring (640 ms) →
PCM net task: conductor → sender → sans-I/O websocket_tx → nonblocking TLS
socket, with a PING-barrier peer-delivery guard bounding unacknowledged PCM to
160 ms and forcing PTT-tail barriers at 40 ms.

### 2.4 Dataflow (downlink)

PCM net task reassembles TLS short-reads directly into the 32-slot downlink
ring (no second buffer) → notify → audio owner drops frames older than 200 ms,
preloads/writes into the exact oldest DMA descriptor → ES8311 (fixed −18 dB
DAC ceiling, brownout fix) → amp. In-band zero-length EOS slot; underrun →
one silence descriptor + exact-late-frame drop + same-generation resume;
driver-queue overflow → poisoned generation + destructive reset.

### 2.5 Host side

The wire is mono S16LE / 16 kHz / 20 ms / 640 B per binary WS message,
subprotocol `iterate.kit.pcm.v1`, dual sockets (`/api` Cap'n Web + `/pcm`
binary). `DevicePcmProxy` (931 LOC) bridges device ↔ Grok realtime
(`grok-voice-think-fast-2.0`, ephemeral client secret; long-lived key never
leaves the host), with deterministic tone/PRBS31 providers speaking the
identical provider contract, and an acoustic-oracle analysis path
(997 Hz tone, PRBS31 watermark, coherence-gated correlator) that verifies
physical playback independently of the firmware's own claims.

---

## 3. Where we already beat the prior art

Worth stating precisely, because these properties must be _preserved_ through
any refactor:

| Property                    | Us                                                                                                  | Best prior art                                                                 |
| --------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Off-device testing          | sans-I/O cores + virtual clock + pthread-faked real platform adapter + simulator + TS interop suite | none (all four projects: device-only)                                          |
| Buffer accounting           | every layer bounded, evidence-typed depths, high-water/drop counters everywhere                     | xiaozhi: drop counters on 2 queues; esphome: telemetry compiled out by default |
| In-flight network PCM bound | peer-delivery guard (PING barriers, 160 ms unconfirmed ceiling, 200 ms replace)                     | not modelled anywhere; they trust the socket                                   |
| Freshness policy            | epoch purge, capture-age ceiling, reconnect-as-boundary, in-band EOS                                | xiaozhi: drain-send-queue-on-failure (comment-level policy)                    |
| Generation fencing          | socket → ring → tx workspace → physical DMA teardown, fence-acknowledged                            | xiaozhi: `playback_generation_` counter (queues only)                          |
| Heap discipline             | zero allocation after boot by construction                                                          | esphome: worst-case prealloc + placement audit (approximation)                 |
| Reasoning comments          | mandated, pervasive, correctness-proof grade                                                        | esphome-audio-stack is good; others sparse                                     |

The honest caveat: the prior-art systems _ship AEC-grade full duplex under
load today_ and ours does not yet. Their architectures were shaped by that
pressure; several of our gaps below are exactly the marks that pressure
leaves.

---

## 4. Where the prior art beats us

### 4.1 Uplink capture is a priority orphan — the one structural realtime defect

Capture is pumped from the priority-1 `app_main` loop on core 0, **below**
control net (5), PCM net (6), and Wi-Fi/lwIP, with only 2×20 ms of hardware
buffering (`platforms/common/include/iterate/kit/platforms/bounded_capture.hpp:47`,
`targets/m5sticks3/main/main.cpp:1196-1217`). Any main-task stall >~40 ms
(TLS handshake burst, display SPI in `showStatus`, a slow metrics rendezvous —
which can block up to **1 s** on a wedged audio owner,
`m5sticks3_direct_audio.hpp:173`, `main.cpp:482`) silently gaps the mic.

Every studied project inverts this:

- xiaozhi: `audio_input` task, **priority 8 (highest of its audio tasks),
  pinned to core 0 away from nothing-else**, blocking-reads 10 ms chunks
  (`main/audio/audio_service.cc:131-135`).
- esphome-audio-stack: one audio task at **prio 19** (above lwIP 18, below
  Wi-Fi 23) doing both directions, cadence owned by blocking DMA
  (`esp_audio_stack.h:811-813`).
- ADF: i2s_stream tasks at **prio 23** (`i2s_stream.h:44-48`).

The physical evidence so far (222 frames, 0 drops) was collected under light
concurrent load; the margin is structural, not proven. This is also the
compounding term in two other smells (the 1 s metrics rendezvous and the
synchronous PTT fence both execute on the same starved task).

### 4.2 No speech-pipeline (processor) seam

Both hand-tuned projects converge on the same shape, which is also exactly the
seam our host-testable architecture wants:

- xiaozhi `AudioEngine` (`main/audio/audio_engine.h`): feed PCM in → clean
  16 kHz frames + VAD edges + wake events out. The _only_ chip-specific audio
  component; AFE, WakeNet, modes all live behind it. One shared AFE instance;
  mode toggles are state bits applied **by the owning fetch task** via
  dirty-flag + generation counter (`afe_audio_engine.cc:317-368`) — never from
  a control thread.
- esphome-audio-stack `AudioProcessor` (`audio_core_processor.h:66-118`):
  pure-virtual, zero ESP includes — `frame_spec()` + `frame_spec_revision()`,
  `process(mic, ref, out)`, feature taxonomy
  (NOT_SUPPORTED/BOOT_ONLY/RESTART_REQUIRED/LIVE_TOGGLE), fail-closed rule:
  **when the configured processor can't run, emit silence — never raw mic**
  (`esp_afe.cpp:1612-1615`).

We have nothing at this altitude. `iterate_kit_audio` is a lifecycle
controller (PTT vs full-duplex intent, one-borrowed-frame discipline), not a
frame processor; there is no place where AEC/VAD/NS/viseme analysis could be
inserted without rewiring the capture and playback paths. StackChan's "AEC
MUST provably work" acceptance has no seam to land on, and the goal doc's
pluggable viseme analysers (renderer-input structure) need the same tap.

### 4.3 Tick-polled cadence where prior art uses blocking/event cadence

- PCM downlink receive discovery is a 1-tick (10 ms) poll — flagged in our own
  code (`pcm_transport.c:598-611`) — adding up to 10 ms jitter per frame into
  a 4-descriptor/200 ms budget.
- Capture is polled at the 10 ms main-loop tick rather than clocked by the
  recorder's completion.

esphome-audio-stack is emphatic, with measured reasons: "RX/TX cadence is
owned by the blocking codec/I2S DMA operations… Do not append a tick-based
delay: it compounds frame latency (especially at a 100 Hz FreeRTOS tick) and
vTaskDelay is not a cross-core clock" (`audio_pipeline.cpp:917-919`); its AFE
fetch worker is clocked by a semaphore given per successful feed — data _and_
lifecycle are events (`esp_afe.cpp:1902-1938`).

### 4.4 No runtime tuning surface

Goal doc: "Frame duration, DMA geometry, queue capacities, per-wake work
budgets, startup-prebuffer policy, late/overflow drop policy… are explicit
tuning knobs with defaults, bounds, and metrics"
(`docs/physical-device-voice-goal.md:196-199`). Today: named compile-time
constants with compile-time proofs and metrics — good bounds, no knobs.
Descriptor count, freshness windows, prebuffer frames, and gain are template
parameters or literals; per-device experimentation is a recompile.
esphome-audio-stack exposes every core/priority/stack/duration/placement as
config data; xiaozhi's per-board `config.h` + `sdkconfig_append` at least
centralizes them per device.

### 4.5 Resource posture vs the AEC future

Numbers from Espressif's own benchmarks (esp-sr v2.4.6 docs):

| Config                                        | Internal RAM | PSRAM        | CPU (S3, one core)            |
| --------------------------------------------- | ------------ | ------------ | ----------------------------- |
| Full AFE, MR, **FD, LOW_COST** (duplex voice) | 60.2 KB      | **777.7 KB** | ~22 % (feed 12.1 + fetch 9.8) |
| Standalone FD_LOW_COST AEC only               | 30.9 KB      | 90.0 KB      | 19.6 %                        |
| + WebRTC VAD (no model)                       | ~0           | ~0           | ~free                         |

Our audio path currently uses zero PSRAM (all-static internal), which is
clean — but StackChan AEC will need PSRAM enabled and ~20 % of a core
budgeted, and **IRAM is 16,383/16,384 bytes used** — one byte free
(`docs/physical-device-voice-goal.md:352-354`). Any new `IRAM_ATTR` (e.g. an
AEC reference tap in the ISR) will not link. This is a concrete blocker to
schedule before AEC work, not during it.

### 4.6 Smaller lessons we should copy (and two we should refuse)

Adopt:

- **Asymmetric queue depths by payload type** (xiaozhi): PCM queues shallow
  (2×60 ms), compressed queues deep (2.4 s). Relevant the day we add Opus; for
  raw PCM v1 our 640 ms rings are a reasonable middle.
- **Defer mic-open until playback fully drains** + ~120 ms mic warmup discard
  (xiaozhi `application.cc:937-945`) — we already discard one startup frame;
  the drain-edge event is the missing half for half-duplex turn starts.
- **Timestamp-echo server-side AEC** (xiaozhi protocol v2): record play-out
  timestamp per downlink frame, stamp uplink frames with it, advertise
  `features.aec`. On reference-less hardware (M5StickS3: PDM mic, no loopback
  channel — device AEC is _structurally impossible_) this is the only
  full-duplex path. We already have both timestamp domains
  (`realtime_playback.hpp:83-99`); this is cheap to add to the proxy protocol.
- **AEC reference discipline** (esphome-audio-stack, hard-won): reference
  saved only from _complete_ frames (padding pollutes the converter state and
  decorrelates the adaptive filter, `audio_pipeline.cpp:1728-1737`); partial
  reads count as underrun and are never used as reference; ref ring resets on
  every capture-session edge; drop-oldest overflow (keep the newest reference
  window). Plus ADF's alignment contract: mic must lag ref by 0–10 ms,
  measured once per hardware design via an interleaved mic/ref debug dump,
  then trimmed with a configurable ref pre-delay.
- **`i2s_channel_tune_rate()`** for network-vs-DAC clock drift on long
  sessions (`i2s_common.h:267-283`) — plan into the playback depth controller
  instead of resampling.
- **Snapshot pattern**: read all per-frame-mutable atomics once per frame into
  a plain ctx struct; precompute hot values on change (float→Q31 at set time)
  (`audio_pipeline.cpp:790-816`).
- **Drain handshake for DSP reconfig**: `process_busy_`/`drain_request_`
  seq_cst pair; hot path's only lock is a zero-timeout try-lock with a
  silence fallback; rebuilds on a dedicated low-prio task with a depth-1
  latest-wins queue (`esp_afe.h:92-105`, `esp_aec.cpp:168-187`).
- **Espressif core split**: heavy AFE math on core 1 (prio ~21 as the ADF
  algorithm_stream configures it), I2S + network on core 0 — which is the
  split our audio owner on core 1 already anticipates.
- **VAD comes free with the AFE**, including `vad_cache` pre-trigger audio —
  don't build our own pre-roll for StackChan.
- **`ringbuff_free_pct`** from every AFE fetch as the canonical backpressure
  signal → export via our metrics capability.

Refuse:

- **ADF's element/ringbuffer/event-iface framework** — Espressif's own
  examples bypass it where latency matters (taskless writer elements, fused
  read callbacks). Copy the _fused, one-task-per-clock-domain_ pattern, not
  the framework. Newer ADF streams are also MIT-ESPRESSIF (Espressif-hardware
  only) — don't port that code into the portable core.
- **seekaudio AEC** — credible benchmark, real vendor, but the engine is an
  eval-only obfuscated blob (date-locked, ~10 create/destroy per boot) that
  _pins and links against esp-sr internally_ (verified via `nm`: it calls
  `aec_create_from_config`/`aec_linear_process` — it replaces only the
  NLP/NS post-stages). Incompatible with a host-testable core. Keep as a
  quality fallback if FD_LOW_COST residual echo proves insufficient; steal
  its MIT evaluation harness (AECMOS + ERLE + on-device CPU report) for our
  own AEC acceptance rig.
- **The mythical "250 ms AEC gating"** attributed to esphome-intercom: it does
  not exist on any current branch. The author deliberately runs the processor
  continuously with a zero-filled reference when playback is idle so
  consumers never flip between processed and raw surfaces, and gates at the
  coarser park-the-whole-AFE level instead. If we ever want the CPU saving,
  we'd be re-adding something this author engineered away — weigh surface
  consistency against CPU before doing it.

---

## 5. Grading the proposed module boundaries

Your proposed cut lines, against what exists:

| Proposed boundary                        | Status today                                                                                                                                                                                                    | Gap                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Networking / capnweb**                 | ✅ Exists and clean: vendored bounded capnweb; sans-I/O websocket tx/rx/text; itx mount/connection; taskless ESP adapter.                                                                                       | `components/core` physically contains both this and the PCM lane — one component, two concerns. `audio.h` includes `peer.h` (`audio.c:138-141` returns `CAPNWEB_OK`), coupling the audio lifecycle to the RPC framework.                                                                                                                                                                                                 |
| **Metrics / diagnostics**                | ◑ Mechanism cleanly separable (transport never calls metrics; producers bump owner-local atomics; samplers pull).                                                                                               | Schema is triplicated by hand (transport metrics struct ↔ `runtime_diagnostics_snapshot` ↔ `control_diagnostics_sample`) with drifting field spellings; `metrics.c` is a 1,510-line god file with two serialization mechanisms and hand-counted key lengths (`metrics.c:352,405-407`); ESP-IDF error domains + dead managed-client fields baked into the portable capability schema (`metrics.h:147-158`).               |
| **PCM physical in/out (pluggable)**      | ◑ Playback: yes — three injection seams (audio hardware vtable, `RealtimePlayback` Driver template, backend `I2sOps`/`BoardOps`), new `i2s_channel` API, host-tested to descriptor identity.                    | Capture: goes through M5Unified's recorder, a different idiom on the legacy driver path, pumped from the wrong task (§4.1). No single codec-style interface (xiaozhi's `AudioCodec` with `duplex()`/`input_reference()` properties is the model). PTT's mic/speaker pin-sharing fence is M5StickS3-specific policy living in the platform layer — correct place, but the capture half should be symmetric with playback. |
| **PCM transmission / buffer management** | ✅ The strongest part: `pcm_lane` (single buffering boundary per direction), uplink conductor/sender with freshness policy, peer-delivery guard, in-band EOS, generation fencing. All sans-I/O and host-tested. | Downlink receive is tick-polled (§4.3); atomics helpers copy-pasted in ≥6 files while `atomic.h` exists (`spsc_ring.c:29-67`, `pcm_lane.c:45-102`, `pcm_uplink_sender.c:21-55`, `pcm_uplink_conductor.c:26-59`, `pcm_transport.c:76-115`, `itx_transport.c:139-169`).                                                                                                                                                    |
| **PCM → viseme / phoneme**               | ❌ Does not exist. The goal doc specifies the renderer-input structure (idle/listening/thinking/speaking + energy + two StackChan viseme algorithms + stage directions + timing/confidence).                    | Needs the processor seam (§4.2) to exist first: analysers are processors-of-processed-audio; renderers consume the normalized structure. Design it as a second consumer of the same tap that feeds AEC's reference/uplink, never as an inline stage of the realtime path.                                                                                                                                                |
| **All configurable to the device**       | ◑ Per-target compile-time constants, well-organized (`esp_idf_websocket_policy.h` with compile-time ordering proofs; template params; `Runtime` sizing logged at boot).                                         | No runtime knobs at all (§4.4); policy constants for _portable_ modules live in a _platform_ header; a second platform must re-derive the PCM>control priority relationship.                                                                                                                                                                                                                                             |

One extra boundary the prior art argues for that your list implies but doesn't
name: the **speech pipeline / audio processor** module (§4.2) between "PCM
physical in/out" and "PCM transmission". That's where AEC/VAD/AGC/NS live,
where PTT-vs-duplex becomes a _mode of one pipeline_ rather than two designs,
and where the viseme tap hangs.

### Target component layout

```
vendor/capnweb                     (unchanged)
components/core                    protocol/plumbing only: itx, websocket,
                                   spsc_ring, retry_gate, configuration,
                                   device_events, runtime_diagnostics, status/atomic
components/audio                   pcm_websocket constants, pcm_lane,
                                   uplink conductor/sender, peer-delivery guard,
                                   audio controller, playback policy (portable half),
                                   NEW: audio_processor seam (+null processor)
components/analysis     (later)    energy/viseme analysers → renderer-input struct
components/capabilities            unchanged, depends on core (+audio for PTT)
platforms/…                        + esp_sr_processor adapter (AFE behind the seam),
                                   + capture unified onto esp_driver_i2s
devices/, targets/                 unchanged roles
```

This converts the `firmware-architecture.test.ts` text-grep boundary
("core must not include M5Unified") into a link-time truth, and makes "control
stack without audio lane" a possible build (relevant for the Waveshare/HA
Voice PE bring-ups where audio hardware differs radically).

---

## 6. Recommendations

Ordered by (realtime risk × leverage), not by effort. R1–R4 are the ones I'd
do before any new device bring-up.

**R1 — Give capture a real owner (fixes §4.1).**
Move the mic pump off the main task. Two options: (a) extend the core-1
audio owner to own capture too (esphome-audio-stack shape: one task, both
directions, blocking cadence — natural fit with the M5StickS3 half-duplex pin
fence, since the same task already owns the I2S lifecycle); or (b) a dedicated
capture task (xiaozhi shape). Prefer (a): it removes the cross-task fence for
PTT transitions entirely. Do it together with migrating capture from
M5Unified's recorder to an `esp_driver_i2s` RX channel (the legacy driver is
formally deprecated with a compile-time `#warning`; M5Unified stays for board
init only — the direction `m5sticks3_direct_audio.cpp:23-25` already took for
TX). Then the main loop's remaining audio duty is zero, and the 1 s metrics
rendezvous and display SPI stop being capture hazards.

**R2 — Introduce the `audio_processor` seam now, before StackChan (fixes §4.2).**
A portable C vtable in `components/audio`:
`frame_spec()/frame_spec_revision()`, `process(mic, ref, out)`,
`feed`-side staging if we adopt the AFE's internal-ring shape, VAD state in
the result, and the fail-closed contract (unavailable ⇒ silence, never raw
mic). Ship two implementations immediately: a null/passthrough processor
(M5StickS3, simulator — host-testable today) and, when StackChan lands, an
`esp_sr` adapter (standalone `afe_aec_*` FD_LOW_COST + WebRTC VAD first;
full AFE only if NS/AGC prove needed — §4.5 table). Apply the prior art's
concurrency rules from day one: mutations dirty-flagged and applied by the
owning task; drain handshake for rebuilds; frame-spec revision bumps restart
the session. The viseme/renderer-input analysers (goal doc) consume this
module's output as a second, non-realtime consumer.

**R3 — Split `components/core` into `core` + `audio`; break the
`audio.h → peer.h` include.**
Mechanical file moves plus replacing `capnweb_status` in
`iterate_kit_poll_result` with the module's own status enum (the capability
layer can map it). This is the cheapest way to make your first proposed
boundary (networking vs audio) structural rather than conventional, and it
shrinks the minimum link set for non-audio devices.

**R4 — Budget the AEC future before building it (fixes §4.5).**
Three scheduled chores: (i) claw back IRAM headroom (audit `IRAM_ATTR` and
linker placement; one byte is not a margin, it's an incident waiting for a
toolchain bump); (ii) enable + smoke-test PSRAM on the Stick build even
though unused, so the allocator/cache behavior is characterized before AEC
depends on it; (iii) adopt the placement-audit idiom (log requested vs actual
placement for every buffer at boot — esphome's `CapsRingBuffer` pattern) so
"PSRAM crept into a hot path" is visible the day PSRAM exists.

**R5 — Kill the tick-polls (fixes §4.3).**
Downlink: socket-driven wakeup for the PCM net task (the code already
self-flags this). Capture (falls out of R1): completion-driven, not
tick-polled. Keep the bounded per-pass work quanta — they're good — just stop
_discovering_ work by timer.

**R6 — Make tuning knobs data (fixes §4.4).**
One `iterate_kit_audio_profile` struct per target (frame geometry, ring
capacities, freshness windows, prebuffer frames, descriptor geometry, gain
ceiling, priorities/cores), compile-time defaulted exactly as today, but (a)
consolidated in one place per device instead of scattered across template
params, policy headers, and literals; (b) overridable at provisioning time
for the subset that's safe to vary (freshness windows, prebuffer, gain);
(c) reported verbatim through the metrics capability so every physical run
records the knob values it ran with. Move portable-module policy constants
out of `esp_idf_websocket_policy.h` into the portable layer, leaving only the
genuinely platform-specific ones (task priorities) behind.

**R7 — Single-source the metrics/diagnostics schema.**
An X-macro (or tiny generator) defining each counter once — name, type,
which of the three surfaces it appears on — from which the structs, the
capnweb expression builder, and the `getDiagnostics` snprintf format are
derived. Kills the triplication, the hand-counted key lengths, and the
"new counter must be threaded through five files" failure mode. While there:
split `metrics.c` (subscription scheduler vs diagnostics formatter), and
delete the dead managed-client fields — pre-1.0, consumers in-monorepo, the
no-backcompat rule applies.

**R8 — Consolidate the atomics helpers.**
Six hand-copied implementations of saturating-increment/update-max in exactly
the code where memory-order subtleties matter most. `atomic.h`'s own comment
explains why centralizing is correct; finish the job (add the acquire/release
variants itx_transport legitimately needs as named helpers).

**R9 — Fix the two live host-proxy defects and flip the default clock.**
(a) `device-pcm-proxy.ts:429` sets `#suppressDownlink` that only the
PTT-gated branch (`:562-569`) clears — in a `server_vad` session (the
StackChan mode) a text turn blackholes downlink audio forever, and
`#responseRequested` never resets. (b) `maximumProviderMessageBytes` 64 KiB
admits provider messages the 8-frame/5,120 B ring can never hold, so any
message >160 ms kills the generation _even in device-clocked mode_. And make
`device-clocked` the default delivery mode — the file's own doctrine says the
device I2S clock is the only real clock; `host-paced` should be the explicitly
requested comparison path, not the silent default.

**R10 — Adopt the cross-layer wire-constant single source.**
640/320/16 kHz/20 ms and the subprotocol string exist independently in the C
header and at least four TS sites; the startup prebuffer is described by three
different numbers (host 3 frames, firmware 4 descriptors, live test's 4-frame
model) whose _composition_ (they stack in device-clocked mode: 60 ms + 80 ms)
is documented nowhere. One generated artifact (C header + TS module from one
table) plus a short "latency budget" doc section composing the actual
end-to-end startup delay. Cheap, and it converts the architecture test's
"header contains literal" check into real cross-language equality.

**R11 — StackChan AEC plan (when it starts, not before).**
Concrete path assembled from the prior art: reference = software TX tap at
`DirectI2sStereoOutput::writeMono` (mono frame + EOF timestamp already in the
same monotonic domain) into a drop-oldest ~80 ms ring, complete-frames-only,
reset on capture-session edges; verify the 0–10 ms mic-lags-ref window with an
interleaved mic/ref debug dump mode (ADF's method) and trim with a configurable
ref pre-delay; processor = standalone FD_LOW_COST AEC + WebRTC VAD behind the
R2 seam; heavy DSP on core 1; acceptance = our own rig plus the seekaudio
harness's AECMOS/ERLE methodology. If StackChan's ES8311 wiring exposes a
digital loopback slot, prefer hardware reference and delete the tap. For the
Stick (structurally no device AEC), add xiaozhi-style timestamp echo to the
proxy protocol so server-side AEC/full duplex stays open as an option.

**R12 — Half-duplex turn-start polish (cheap, physical-quality win).**
Add the playback-fully-drained edge event (we have all the state: lane depth,
in-flight descriptor, EOS) and defer mic-open on it in PTT/auto-stop flows,
keeping the existing immediate-interrupt path for explicit barge-in. Pair with
the existing one-frame mic warmup discard.

**R13 — Structural hygiene, batched opportunistically.**
Extract Wi-Fi station management (~250 LOC incl. the twice-duplicated inline
backoff — use `retry_gate`) from `itx_transport.c`; express the five
generation counters as an explicit state machine (the invariants currently
live only in comments and ~15 compare sites); collapse the ~40 copy-pasted
host CMake test stanzas into `add_iterate_kit_test()`; delete superseded
`bounded_playback.hpp`; fix the two remaining vacuous-pass `slice(indexOf(...))`
hazards in `firmware-architecture.test.ts:663-677`; guard positional
`capnweb_session_options` initialization with designated initializers.

### Explicitly not recommended

- Rewriting toward any prior-art framework (ADF elements, ESPHome components,
  xiaozhi's C++ class graph). Their _seam placement_ and _scheduling/
  backpressure policies_ transfer; their machinery doesn't, and ours is more
  testable.
- Opus now. All prior art uses it (60 ms frames, DTX, complexity 0 — the
  settings are worth recording for v2), but raw PCM v1 at 256 kbps is within
  Wi-Fi budget, is already physically proven, and skipping the codec keeps
  the latency/evidence story simple. Revisit when cellular/battery targets or
  jitter-buffer depth (compressed queues can be deep cheaply) force it.
- seekaudio, per §4.6.

---

## 7. Prior-art disposition summary

| Source                     | Take                                                                                                                                                                                                                                                                                                        | Leave                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| xiaozhi-esp32              | Engine seam; priority ladder (input top, codec bottom); asymmetric queue depths; drain-before-mic-open + warmup; timestamp-echo server AEC; three listening modes (`realtime`/`auto_stop`/`manual_stop`) as one pipeline; AFE-mutation-by-owner discipline; field self-tests (button loopback, UDP PCM tap) | C++/FreeRTOS class graph; MQTT/UDP transport; no host-test story             |
| esphome-audio-stack        | Processor interface + fail-closed silence; snapshot pattern; permanent parked task; DMA-owned cadence; drain handshake; frame-spec revision; per-role overflow policy; placement audits; 60 ms silence-fill on established-stream gaps                                                                      | ESPHome codegen machinery; the (nonexistent) 250 ms AEC gate                 |
| ESP-ADF / ESP-SR / ESP-IDF | AFE budgets + FD_LOW_COST choice; feed/fetch load model; software-ref TYPE2 tap + 0–10 ms alignment contract + debug dump; fused-callback pipeline style; `i2s_channel` everywhere incl. `tune_rate`, overflow callbacks, preload, auto-clear; `vad_cache`; `ringbuff_free_pct`                             | ADF element framework; MIT-ESPRESSIF-licensed stream code; legacy i2s driver |
| seekaudio                  | Evaluation harness methodology (AECMOS/ERLE/CPU reports)                                                                                                                                                                                                                                                    | The engine (eval-only blob, esp-sr-pinned, host-untestable)                  |

---

_Cross-checked against `docs/physical-device-voice-goal.md` (settled decisions
and the 2026-07-31 execution addendum) and the existing Fable review ledger.
The six underlying deep-read reports are session artifacts; their durable
substance is folded into this document._
