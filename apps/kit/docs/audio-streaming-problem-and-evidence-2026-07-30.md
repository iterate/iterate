# Audio streaming problem, constraints, and evidence

Status: active engineering brief and research input, 2026-07-30.

This document is the durable map of the realtime-audio problem currently being
solved in Iterate Kit. It distinguishes requirements, known failure classes,
implemented mechanisms, measured evidence, and open hypotheses. It is not a
claim that the audio path is finished.

The broader product goal and verbatim decision transcript remain in
[`physical-device-voice-goal.md`](./physical-device-voice-goal.md). Prior Fable
findings and their disposition are in
[`fable-audio-review-reconciliation-2026-07-30.md`](./fable-audio-review-reconciliation-2026-07-30.md).

## Product shape

Each device has two independent long-lived WebSockets:

1. ordinary Cap'n Web for capabilities, events, metrics, and diagnostics;
2. a binary PCM lane whose v1 device contract is mono signed PCM16LE at
   16 kHz, in exact 20 ms / 320-sample / 640-byte frames.

The device keeps its PCM connection to an Iterate userspace worker. The worker
authenticates the project bearer token, substitutes the upstream voice-provider
secret, adapts provider control events, and relays audio. Provider JSON never
shares the binary PCM lane.

M5StickS3 is the first realtime target. It is half-duplex push-to-talk: capture
and send continuously while the button is held, commit on release, then play
the response. StackChan will be full duplex with provider VAD, interruption,
and device-specific AEC. The portable design must later accommodate the Home
Assistant Voice Preview Edition and the Waveshare ESP32-S3 touch device without
forcing every hardware driver into one false abstraction.

## Non-negotiable realtime constraints

- Microphone completion and speaker refill are the highest-priority work.
  Display, Cap'n Web, metrics serialization, logging, reconnect policy, and
  other capabilities are bounded background work.
- A freshly completed microphone frame is offered to the network immediately.
  A received output frame is offered to the speaker as soon as the explicit
  startup policy permits. No batching or queue exists merely for convenience.
- RAM, work per callback/wake, queue depth, retry count, and diagnostic history
  are bounded. Overload has a named drop/reset/reconnect result and a monotonic
  counter.
- Recovery returns to current realtime conversation. It must never replay a
  stale backlog after Wi-Fi, TLS, a peer, or the scheduler recovers.
- Audio callbacks do not allocate, take unbounded locks, wait for control work,
  log, or perform network I/O. Cross-task communication is fixed-capacity and
  ownership is explicit.
- The system reports what it can actually prove. Socket acceptance is not peer
  receipt; DMA submission is not acoustic audibility; an opaque TLS/Wi-Fi queue
  is reported as unavailable or as a conservative bound rather than zero.
- Every physical acceptance run retains the exact source identity/hash,
  microphone recording/hash, device/firmware identity, raw one-second metric
  samples, stage/load evidence, build-size report, and final assessment.
- The nearby Mac microphone is an independent acoustic oracle. Device counters
  alone cannot prove uninterrupted audible playback.

## Failure classes the design and harness must cover

### Backlog and freshness

- The microphone/application ring, WebSocket transmitter, TLS/lwIP, Wi-Fi, host
  proxy, device downlink ring, speaker owner mailbox, or DMA descriptors retain
  old audio while forward progress stops.
- A reconnect or scheduler recovery releases stale speech in a burst.
- A retry duplicates a partially accepted frame, or a reset silently skips one.
- A finite response ends while a partial frame remains, causing truncation or
  an indefinite prebuffer wait.
- Queue capacity is increased until tests pass, converting a visible overload
  into hidden conversational latency.

Required outcome: a small jitter allowance may absorb ordinary variation, but
its capacity and maximum age are explicit. Crossing the freshness/no-progress
policy discards the affected generation, records why and how much was lost, and
restarts from current audio.

### Scheduler, ownership, and priority inversion

- A network task, Cap'n Web callback, display update, metrics encoder, logger,
  allocator, or shared driver mutex blocks speaker refill or microphone capture.
- A high-priority task does too much work per wake and starves Wi-Fi/lwIP.
- An ISR callback calls flash/PSRAM-resident code while cache access is unsafe.
- A synchronous lifecycle operation and an asynchronous refill notification
  share one mailbox, so stale completions satisfy a later generation.
- Timer lateness accumulates into drift, or catch-up pacing emits a burst.

Required outcome: audio-critical work has a short, measured, allocation-free
path; slower owners communicate through generation-fenced bounded messages.
Task priority and core affinity are justified with real ESP-IDF/driver behavior,
not folklore. Deadline misses are classified and visible.

### Playback continuity

- Startup begins with too little PCM for normal network jitter, producing an
  immediate underrun.
- Excessive startup prebuffer hides network instability as added latency.
- A zero/partial I²S write is retried indefinitely or treated as progress.
- An underrun leaves an old descriptor, borrowed buffer, or retry tick alive.
- Descriptor reuse occurs before the hardware has consumed the previous data.
- Sample-rate/clock mismatch gradually drains or fills a ring.
- A reset, EOS transition, or response generation boundary inserts silence,
  repeats a frame, or joins the waveform at the wrong phase.
- A path appears healthy in counters but produces an audible gap, phase jump,
  level step, or “jiggle”.

Required outcome: direct callback-to-I²S completion timing and descriptor
lifecycle are measured; zero progress destructively resets the generation;
startup/underrun policy is explicit; deterministic non-frame-periodic audio and
an independent microphone capture expose skips, duplicates, gaps, and drift.

### Capture and push-to-talk

- Firmware buffers the entire button hold or waits until release before sending.
- The network stalls while captured frames accumulate and later escape as stale
  microphone audio.
- Partial WebSocket writes or an ambiguous local-send result duplicate audio.
- Release races a final capture callback, losing or reordering the tail.
- Capture and playback overlap on a half-duplex target after interruption.

Required outcome: complete 20 ms frames stream throughout an arbitrarily long
hold. When current audio cannot be sent within the bounded freshness policy,
pending frames are discarded, the transport generation is reset, and the
incident is available through diagnostics. Release has an explicit ordered
barrier before commit/response creation.

### Network and protocol faults

- Disconnect, long RTT, loss, TLS backpressure, Wi-Fi outage, peer silence, or
  proxy event-loop stalls create retry storms or unbounded retained payloads.
- A Blob/Promise conversion forms a hidden ingress queue outside the byte ring.
- Control events and PCM arrive out of order or a previous connection's events
  mutate the current generation.
- A provider produces bursts or a different chunk boundary than the device.
- The connection is “ready” locally but no end-to-end forward progress exists.

Required outcome: one in-flight asynchronous conversion at most; fixed queue
bounds; generation fencing; explicit peer-delivery/no-progress thresholds;
bounded reconnect with classified failures; arbitrary even provider chunks are
streamingly rechunked into exact device frames without storing a response.

### Observability under pressure

- Metrics collection itself steals audio time, allocates too much, or creates a
  callback backlog.
- A slow/disconnected diagnostics consumer retains history on-device.
- Aggregate counters cannot tell receive failure from speaker/DMA failure.
- Samples are stale, reordered, cross a reboot/session boundary, or silently
  skip.
- Runtime/OS buffer depths are claimed more precisely than ESP-IDF exposes.

Required outcome: one fixed-cost coherent one-second snapshot feeds bounded
general or detailed Cap'n Web views. The host owns durable history and checks
sequence/cadence/quiescence. Optional microSD is an outer sink, never a
realtime-core dependency. Metrics distinguish exact occupancy, derived bounds,
configured capacity, and unavailable layers.

### Memory, CPU, and long-session degradation

- Per-frame allocation, fragmentation, task-stack erosion, leaking sockets, or
  retained callbacks make later minutes worse than the first.
- Counters wrap and make an incident look recovered.
- Test instrumentation changes scheduling or memory enough to hide the fault.
- An over-tight arbitrary ring makes a capable ESP32-S3 fragile; an oversized
  ring hides freshness failure.

Required outcome: build size, internal RAM/PSRAM, minimum heap, every task's
stack high-water mark, normalized CPU/work cycles, callback duration, queue
high-water marks, and counter saturation are measured. Endurance proceeds
1 minute, 2 minutes, then 10 minutes, first idle and then under explicitly
lower-priority device load.

### Full-duplex and AEC (later StackChan tranche)

- Speaker reference, microphone samples, and AEC processing are misaligned.
- Far-end echo suppresses interruption detection, while aggressive cancellation
  damages near-end speech/double-talk.
- Playback queueing makes the reference timing increasingly wrong.
- A device-specific AEC API leaks into the portable transport core.

Required outcome: a hardware adapter supplies timestamped microphone input,
speaker output/reference, and any DSP-specific state behind a clean contract.
The rig measures echo reduction, near-end damage, double-talk interruption, and
latency rather than accepting subjective speech.

## What is implemented

### Portable firmware and target layering

- Allocation-free C components separate the PCM lane, peer-delivery/no-progress
  guard, WebSocket receive parsing, playback pipeline, runtime diagnostics,
  metrics subscription, Cap'n Web peer, and device capability/event core.
- M5StickS3's M5Unified/ESP-IDF hardware integration stays in the C++ target
  adapter. Button and remote push-to-talk transitions enter the same deferred
  bounded event path.
- PCM and Cap'n Web use independent network connections and task/state
  ownership. Async generation notifications are separated from synchronous
  owner lifecycle/snapshot commands.
- ISR/refill callbacks and their callees are post-link audited into IRAM; their
  mutable state is audited into internal DRAM rather than PSRAM.

### Bounded PCM policies

- Device protocol frames are fixed at 640 bytes / 20 ms.
- Application and host-proxy queues have fixed capacities and observable
  high-water/drop/failure counters.
- The host proxy holds an eight-frame / 160 ms downlink jitter budget by
  default, incrementally rechunks arbitrary even provider messages, and closes
  the generation rather than preserving more stale PCM.
- Exactly one Blob conversion may be in flight per direction; a second message
  is an explicit mailbox-overflow failure.
- Zero-length PCM downlink is an ordered EOS marker after preceding frames.
- Push-to-talk sends each captured frame while held; commit and response create
  occur on release.
- Interruptions clear downlink state and use response-generation fencing.
- Zero/partial I²S forward progress, deadline misses, underruns, freshness
  incidents, flushes, resets, EOS state, and descriptor reuse have dedicated
  counters.

### Diagnostics and harness

- `subscribeToMetrics` reports resource, audio, queue, and transport evidence.
- A dedicated fixed-size `subscribeToPlaybackMetrics` serializer now carries
  raw playback/refill/runtime classifications from the same coherent sample;
  its TypeScript contract and physical-run wiring are still being completed.
- Host simulation covers delay, loss, reconnects, memory pressure, queue
  overflow, stale audio, and sanitizer builds.
- A progressive physical playback harness is being built around a deterministic
  997 Hz PCM source, exact source digest, nearby-Mac PCM capture, waveform
  continuity/phase analysis, one-second device metrics, and idle/loaded stages.
- Mac capture provenance now resolves AVFoundation index `:0` to stable device
  `BuiltInMicrophoneDevice` (`MacBook Pro Microphone`) and records microphone
  mode. Canonical acceptance requires Wide Spectrum; the current host is in
  Standard mode and therefore correctly fails closed rather than pretending
  OS AGC/EC/noise suppression are disabled.

## What has been proven

### Host and build evidence

- Full portable C host suite: 38/38 passing after the direct-I²S/refill changes.
- Focused direct-I²S tests pass both normally and under ASan/UBSan.
- The post-link realtime audit passes: audited callback code is in IRAM and
  state is in internal DRAM.
- The exact physical source/proxy contract now has a fast regression:
  60 seconds of 997 Hz PCM, emitted as 1,000-byte provider chunks, becomes
  exactly 3,000 ordered 640-byte frames plus EOS with no proxy failure while
  retaining the 160 ms queue bound. The complete emitted PCM SHA-256 is
  `f740bf139d3dd8962fd20491400eaea74eff84d7a84bdba247d38682b6a8c80f`.
- Latest M5StickS3 build evidence before the current diagnosis:
  binary 1,154,608 bytes; total image 1,154,490 bytes; flash code 801,304;
  flash data 236,840; DIRAM 209,087 / 341,760 bytes with 132,673 bytes free.
  ESP-IDF's separate 16,383 / 16,384 “IRAM” line is a region-accounting split;
  shared DIRAM/IRAM headroom is the relevant bound and the Iterate/M5Unified
  audited IRAM contribution is small. The gate remains post-link placement plus
  total internal-memory headroom, not that misleading one-byte number alone.

### Physical evidence

- M5StickS3 stable USB identity is `70:04:1D:D5:45:88`.
- Earlier real Grok proofs mounted through a public local tunnel, streamed 222
  microphone frames during a held button, received a transcription, and
  completed 27 response frames. A separate Grok playback completed 192 frames.
  Those runs had no reported capture drops, uplink deferrals/restarts, or
  playback failures, but they did not constitute an acoustic endurance proof.
- A loud direct tone was physically audible next to the Mac.
- The first attempted 60-second acoustic run **failed** and is retained rather
  than normalized:
  - capture:
    `apps/kit/evidence/m5sticks3-playback/iterate-kit-acoustic-NaZWLD/microphone.pcm16le`
  - capture SHA-256:
    `487cd849f41e616eec4860dc2168cedcef555051fb868bb6e56dd8bc8a95f6f9`
  - capture duration: 73.8133 seconds at 48 kHz;
  - detected tone: only about 127.5 ms, from 2,882.5 to 3,010 ms;
  - three internal gaps, longest 5 ms; maximum phase-step error 0.422509 rad;
  - about 59,875 ms of the requested tone was missing;
  - the PCM device session later reconnected and the runner timed out.

The exact proxy reason and detailed device counters were not retained in that
first run. Because the composed provider/proxy regression is green, current
ranked hypotheses are:

1. a device playback-owner/I²S generation reset, zero-progress condition, or
   descriptor/refill lifecycle failure after the first few frames;
2. device downlink receive/prebuffer policy discarding the response or the PCM
   transport reconnecting before playback can continue;
3. an end-to-end timing/backpressure fault that the ideal fake-clock host test
   does not yet inject;
4. a host acoustic-detector error (low probability because the retained
   waveform itself contains almost no sustained tone).

The next physical run must subscribe to detailed playback metrics, persist the
proxy failure reason, and use a short deterministic duration before any further
one-minute attempt.

## Open proof obligations

- Complete and test the TypeScript contract/parser for detailed playback
  metrics, expose it in M5StickS3 `__describe`, and attach/detach a stage
  observer with proven quiescence.
- Persist host proxy timing, queue depth/high-water, close reason, source
  deadlines, and event-loop lateness in every run.
- Diagnose the 127.5 ms physical cutoff with a fast short-run loop, add a
  failing regression at the responsible seam, fix it, and repeat the original
  physical repro.
- Pass continuous acoustic playback at 1 minute, then 2 minutes, then 10
  minutes. Repeat under bounded lower-priority Cap'n Web/display/CPU/network
  load and reject any gap, phase jump, unexplained reset, heap drift, stack
  exhaustion, or stale backlog.
- Add independent dual-carrier/PRBS challenge audio where appropriate so whole
  frame skip/duplicate/replay and clock drift cannot hide in a periodic tone.
- Build the equivalent microphone-input ladder: exact injected/captured source,
  long PTT streaming before release, provider-boundary evidence, freshness
  resets under loss/stall, and no backlog after recovery.
- Prove behavior under deterministic scheduler stalls, loss, latency, packet
  fragmentation, reconnects, TLS/WebSocket backpressure, memory allocation
  failures, diagnostics-sink stalls, display load, and long-duration counter
  growth.
- Define and prove the StackChan full-duplex/AEC adapter and acoustic metrics.

## Independent Fable research assignment

The independent reviewer should look for materially simpler architectures, not
merely tune constants in the current one. It should inspect:

- this document and the two linked goal/reconciliation documents;
- `apps/kit/src/voice/`, especially `device-pcm-proxy.ts`,
  `deterministic-pcm-tone-provider.ts`, and `pcm-frame-pacer.ts`;
- `apps/kit/src/device/`, especially the playback-endurance harness/types;
- `apps/kit/firmware/components/core/`,
  `apps/kit/firmware/components/audio/`,
  `apps/kit/firmware/components/capabilities/`, and their tests;
- `apps/kit/firmware/targets/m5sticks3/main/main.cpp`, its sdkconfig/link map,
  M5Unified/M5GFX, and the ESP-IDF WebSocket/network implementation;
- `/Users/jonastemplestein/esp/esp-idf`, including I²S standard/channel/DMA,
  FreeRTOS scheduling/notifications/ring buffers/stream buffers, Wi-Fi/lwIP,
  esp-tls, WebSocket, heap/PSRAM, task watchdog, and tracing facilities;
- `/Users/jonastemplestein/src/github.com/iterate/stackchan` as useful DSP and
  device prior art, while treating its historical accumulating audio queues as
  a known warning;
- Espressif ESP-ADF/audio pipeline/audio element/audio board source, official
  ESP-IDF and FreeRTOS documentation/source, Home Assistant Voice Preview
  Edition/ESPHome voice-assistant source, M5Stack examples/libraries, and
  credible small embedded/WebSocket/audio implementations.

The reviewer should deliver:

1. a critique of the current ownership/task/queue/timing model and any places it
   is tying itself in knots;
2. at least three materially different architectures, including the simplest
   credible design, with task/core ownership diagrams in prose;
3. exact implications for latency, underrun tolerance, stale-audio recovery,
   RAM, CPU, stack, allocations, instrumentation, portability, and AEC;
4. specific ESP-IDF/driver/library mechanisms worth reusing, with source paths,
   symbols, and authoritative URLs;
5. mechanisms that look attractive but should be rejected, and why;
6. a recommended migration sequence that preserves working vertical proofs and
   introduces red tests before replacing behavior;
7. explicit “keep / simplify / delete / defer” recommendations for the current
   modules.

The reviewer must not edit production code. Its report belongs at
`apps/kit/docs/fable-audio-architecture-alternatives-2026-07-30.md`. Findings
are proposals until reconciled against source, tests, build evidence, and real
device measurements.
