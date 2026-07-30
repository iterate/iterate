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

## Remote backup checkpoint

The complete Git-visible worktree state was snapshotted before the next
physical diagnosis. This is a recovery checkpoint, not a completion claim.

- branch:
  `backup/c-capabilities-audio-checkpoint-20260730T184536Z`
- checkpoint commit:
  `5cfc9276beae458a506d432133b166d894ff0a4e`
- verified remote branch tip (the follow-up records this verification):
  `7afea65f9f10c21f05641de7bca1dfc58e07e63c`
- source branch and parent:
  `c-capabilities` at `9020285b8128e716f8a5fa23480cc9650b065db1`
- remote:
  `origin` (`https://github.com/iterate/iterate.git`)
- verification:
  `git ls-remote --heads origin` returned
  `7afea65f9f10c21f05641de7bca1dfc58e07e63c` for the dedicated ref, and
  `git merge-base --is-ancestor` verified that the complete checkpoint commit
  above is its ancestor.

The snapshot used a separate Git index so it did not switch or clean the active
worktree. It contains every tracked modification and every non-ignored
untracked file reported by Git, including the retained 7,086,080-byte acoustic
failure artifact. Generated/ignored build trees, dependency installs, managed
component caches, generated `sdkconfig`, and generated local Wrangler output
remain reproducible local products and were not forced into Git.

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
- A single late frame no longer forces I2S teardown. The owner writes one exact
  zero recovery descriptor to consume the completed ESP-IDF DMA pointer, then
  drops exactly one subsequently arriving stale content frame. This uses a
  scalar debt rather than a PCM queue and resumes the next on-time frame in the
  same generation. A full completed-DMA cycle or driver invariant failure
  remains destructive.
- Clean EOS now has an exact terminal disposition for every recovery-silence
  descriptor. A descriptor completed before the synchronous stop increments
  `underrunSilenceFramesCompleted`; one still owned by the stopped DMA channel
  increments `underrunSilenceFramesRetired`. The conservation law is therefore
  `submitted = completed + retired`. This avoids the false choice between
  waiting for an acoustically pointless silent DMA tail and leaving one frame
  apparently lost in diagnostics.

### Diagnostics and harness

- `subscribeToMetrics` reports resource, audio, queue, and transport evidence.
- A dedicated fixed-size `subscribeToPlaybackMetrics` serializer now carries
  raw playback/refill/runtime classifications from the same coherent sample.
  Playback metrics schema 3 is implemented end to end in the device,
  simulator, C serializer, TypeScript parser, evidence flattener, fixtures, and
  physical runner. It makes recovery silence and late-frame discard visible
  and distinguishes DMA-completed silence from clean-EOS retirement rather
  than allowing a missing field to look like zero.
- Host simulation covers delay, loss, reconnects, memory pressure, queue
  overflow, stale audio, and sanitizer builds.
- A progressive physical playback harness is being built around a deterministic
  997 Hz PCM source, exact source digest, nearby-Mac PCM capture, waveform
  continuity/phase analysis, one-second device metrics, and idle/loaded stages.
- Mac capture provenance now resolves AVFoundation index `:0` to stable device
  `BuiltInMicrophoneDevice` (`MacBook Pro Microphone`) and records microphone
  mode. The targeted investigation additionally proved FFmpeg's AVFoundation
  recorder shortened/corrupted the timeline while a SoX/raw CoreAudio capture
  recorded the same Stick output cleanly. Canonical acceptance therefore uses
  SoX/raw capture and asserts sample-count-versus-wall-time integrity before
  analyzing the device.

## What has been proven

### Host and build evidence

- Full portable C host suite: 38/38 passing after the direct-I²S/refill and
  bounded-recovery changes.
- Full portable C host suite under ASan/UBSan: 38/38 passing. Apple ASan does
  not support LeakSanitizer, so `detect_leaks=0` is recorded as a platform
  limitation rather than silently dropping the whole sanitizer lane.
- The focused schema-3/recovery/endurance TypeScript regressions pass 65/65.
  The complete post-edit Kit suite passes 303 tests with one live public-tunnel
  test intentionally skipped by its opt-in environment gate, and Kit typecheck
  passes.
- The post-link realtime audit passes: audited callback code is in IRAM and
  state is in internal DRAM.
- The exact physical source/proxy contract now has a fast regression:
  60 seconds of 997 Hz PCM, emitted as 1,000-byte provider chunks, becomes
  exactly 3,000 ordered 640-byte frames plus EOS with no proxy failure while
  retaining the 160 ms queue bound. The complete emitted PCM SHA-256 is
  `f740bf139d3dd8962fd20491400eaea74eff84d7a84bdba247d38682b6a8c80f`.
- A real-clock comparison has isolated a separate public-tunnel timing defect.
  The current three-frame proxy startup reservoir delivered a ten-second
  response locally with 16.40 / 20.06 / 22.06 / 22.74 / 23.18 ms
  min/p50/p95/p99/max gaps and no gaps below 15 or above 25 ms. The same 500
  frames, 320,000 bytes, EOS, and
  `4203a2c0c0083d60c667ba5a19a5e175c55f0fe4629911c1fe94a01f6497bf6e`
  SHA-256 through `tunnels.iterate.com` arrived with approximately 0.002 /
  20.04 / 31.44 / 52.70 / 100.50 ms gaps, including 81 gaps below 15 ms and
  75 above 25 ms. A retained opt-in 60-second public-WebSocket regression at
  `src/voice/public-pcm-tunnel-cadence.live.test.ts` reproduced the defect
  while first proving all 3,000 frames, 1,920,000 bytes, EOS, and the fixed
  source digest: 128 gaps were below 10 ms, 111 above 30 ms, and the observed
  min/p50/p95/p99/max were 0.030 / 19.968 / 28.567 / 39.872 / 113.070 ms.
  This test runs with:

  ```sh
  ITERATE_KIT_LIVE_TUNNEL_TEST=1 \
    doppler run --project kit --config dev_jonas -- \
    pnpm exec vitest run --config vitest.config.ts \
      src/voice/public-pcm-tunnel-cadence.live.test.ts
  ```

  The byte-perfect result does not make this realtime-safe. Captun currently
  forwards each WebSocket message as a fire-and-forget Cap'n Web RPC behind a
  Promise chain that is neither visible to `DevicePcmProxy` queue metrics nor
  bounded by its WebSocket `bufferedAmount` check. Wider device buffering would
  hide the transport defect by adding stale-audio latency. The production PCM
  proof therefore needs a direct raw WebSocket to the deployed config worker;
  replacing Captun with an arbitrary raw reverse proxy is not itself sufficient.
  A separate 60-second 3,000-frame Bun WebSocket through a fresh Cloudflared
  quick tunnel still measured 0.001 / 19.978 / 27.620 / 38.978 / 100.002 ms
  min/p50/p95/p99/max gaps, with 86 gaps below 10 ms, 92 above 30 ms, and a
  simulated four-frame playout lead reaching -19.5 ms. Local iteration must use
  a measured transport and the actual bounded receiver policy; the release
  verdict must come from the direct deployed edge path plus physical acoustic
  continuity, not the word “raw” or a larger buffer.

- Latest M5StickS3 build evidence after clean-EOS retirement and metrics schema
  3: padded binary `0x11a0a0` / 1,155,232 bytes; ESP-IDF reported total image
  1,155,110 bytes; flash code 801,972; flash data 236,792; DIRAM 209,127 /
  341,760 bytes with 132,633 bytes free. The final firmware binary SHA-256 is
  `b20b9518479777b522b1dea448c9423651e55caca0bb556cd2654feb5615e852`;
  the ELF SHA-256 is
  `50802c437a86a3945b2da9f40ec4592973e6153506f31ec97e2dd2749e33ebc8`.
  Relative to the immediately preceding schema-2 build, the change costs 160
  app-image bytes, 124 flash-code bytes, 32 flash-data bytes, and eight bytes
  of DIRAM. The portable playback object grows from 296 to 304 bytes on the
  host ABI.
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
first run. Two subsequent five-second runs added the missing one-second detailed
metrics and reduced one failure to an exact ESP-IDF queue invariant:

- both runs received and submitted all 250 expected content frames;
- the second run completed 249, classified one frame as
  `underrunFramesFlushed`, consumed one EOS marker, never produced an EOS
  response, and reported exactly one driver-queue overflow;
- all ordinary loss/freshness/backpressure/state/driver-failure counters were
  zero;
- the maximum measured EOF-to-successful-refill interval was 19,576 us, with a
  minimum descriptor-reuse lead of 40,424 us;
- internal free heap remained about 76.5 KiB, with a 62.5 KiB minimum, and the
  audio-owner stack retained 6,660 bytes of headroom;
- the preserved second recording is
  `/var/folders/p8/rkz0wfgd3tsfwzm9zk7s_v5r0000gn/T/iterate-kit-acoustic-5x809T/microphone.pcm16le`,
  2,957,312 bytes, SHA-256
  `866016423a829003897aa3a1d8a5656a37ce84bd0cd0a878c6a2eb4ba9312de4`;
- its independent acoustic analysis found a roughly 3,997.5 ms span, 1,097.5
  ms of missing tone, 96 internal gaps (longest 5 ms), and 30 phase
  discontinuities (maximum error 0.240067 rad).

The responsible host fake had modeled callback completions but not ESP-IDF's
separate `dma_desc_num - 1` completed-DMA-pointer queue. At EOS, policy stopped
calling `i2s_channel_write`; auto-clear made reused buffers silent but did not
consume their private queue entries. Four DMA descriptors therefore overflowed
the three-entry queue, dropped the oldest pointer, and caused the exact
250/249/one-flushed terminal state above.

A new 250-frame regression enables the real three-entry capacity and reproduced
that failure before the repair. The repair writes explicit silence behind the
remaining content solely to consume each completed pointer, then still stops on
the exact final content EOF. It adds no PCM allocation or queue. Both the
policy regression and a lower-level exact-descriptor/padding test are green.
This repair was subsequently flashed and physically exercised; the retained
post-fix evidence is described below.

The targeted Fable investigation then falsified the apparent roughly 20%
device-duration loss: FFmpeg's AVFoundation input path itself lost timeline,
whereas SoX/raw CoreAudio captured the Stick's 997 Hz output cleanly. The
retained bad recordings remain valuable instrument-control failures, not
evidence of a codec startup delay.

A subsequent ten-second SoX run exposed a different genuine defect at frame 73:

- retained run:
  `apps/kit/evidence/m5sticks3-playback/tone-10s-coreaudio-no-flash-20260730-2205/run.log`;
- at the failure sample, downlink accepted 73, content submitted 72, content
  completed 67, one underrun frame was flushed, one underrun incident occurred,
  and the ESP-IDF finished-pointer queue overflowed once;
- maximum EOF-to-refill time was 50,687 us and minimum descriptor-reuse lead was
  9,313 us;
- the strict counter policy stopped the run immediately rather than allowing a
  destructive reset to masquerade as successful endurance.

That exact one-late-frame class is now red-then-green in the host rig. The
repair writes one `recoverySilence` descriptor immediately, records one scalar
drop debt, discards one later stale content frame, and continues in the same
I2S generation. Recovery submission, completion, and discard each have their
own saturating metric.

The first physical bounded-recovery run then exposed a diagnostics defect at
clean EOS: 44 recovery-silence frames had been submitted, 43 completed, and 44
late content frames had been dropped. The content response and EOS were
otherwise clean. The missing disposition was not leaked audio: synchronous
channel stop legitimately retired the final queued silence before a DMA EOF
callback. A red host regression now reproduces that exact lifecycle. Schema 3
adds `underrunSilenceFramesRetired`, stops account for all outstanding
recovery descriptors only after successful driver stop, and a stop failure
continues to fail visibly rather than inventing ownership. Normal and
ASan/UBSan native suites pass 38/38 with the fix.

The schema-3 firmware was resolved by stable identity and flashed only to
M5StickS3 `70:04:1D:D5:45:88` (USB location `1-1.2` at the time of the run).
The settings partition was preserved. Three post-flash physical runs provide
different evidence:

- `tone-2s-retirement-fix-20260730-2334/run.log` completed 100 source frames,
  classified 28 bounded recovery incidents and 33 recovery frames, and had no
  reset, overflow, or driver failure. Its 380,928-byte Mac microphone capture
  has SHA-256
  `848723b22820bc1dc5bb33092bc882b3ffdd424eb5c95ea2b00149578867cbba`.
- `tone-2s-retirement-verbose-20260730-2337/run.log` completed with exact
  schema-3 conservation: 100 accepted content frames; 62 content submitted and
  completed; 38 recovery-silence frames submitted and completed; zero retired;
  38 matching late-content drops; one EOS marker and response; and zero reset,
  overflow, failure, state-error, or deadline-miss counters.
- `tone-10s-recovery-verbose-20260730-2340/run.log` completed all 500 accepted
  content frames without stale catch-up. It submitted/completed 293 content
  frames and submitted/completed 207 recovery-silence frames with 207 matching
  late drops and zero retired. It reported one EOS marker/response, zero
  generation/freshness/partial-prebuffer/underrun flushes, zero deadline
  misses, queue overflows, driver/stop failures, fatal flushes, backpressure,
  invalid frames, state errors, or clock regressions. Downlink high-water was
  one frame. Peak observed device CPU was about 305-315 permille during
  playback (176 permille in the final sample); minimum internal/DMA-capable
  heap was 62,431 bytes; stack headroom was 6,652 bytes for the audio owner,
  2,504 for main, 960 for control networking, and 2,480 for PCM networking.
  Maximum EOF-to-refill was 793 us, maximum write time 95 us, and minimum
  descriptor-reuse lead 59,207 us. The retained 1,155,072-byte Mac microphone
  capture has SHA-256
  `a39cc3c94570975f45378dc769daf74ae586642527cc72b9be741971a2290e10`.

These runs prove bounded same-generation recovery and exact accounting under a
hostile transport. They do **not** prove gapless playback. In the ten-second
run, 207 of 500 frame intervals required inserted silence, the acoustic oracle
found 328 gaps (longest 17.5 ms), and 65 ms of tone was missing. The recovery
acoustic policy correctly passed because every discontinuity fit the classified
4,140 ms recovery budget; the strict acoustic policy correctly failed. The
public tunnel is therefore retained as a deterministic adversity/recovery lane,
not treated as the strict continuity lane. The device's one-frame downlink
high-water also proves that merely declaring a four-descriptor startup reserve
does not preserve that reserve when a real-time-paced sender subsequently
arrives late.

## Open proof obligations

- Add a deterministic physical end-stall fixture if a nonzero
  `underrunSilenceFramesRetired` device sample is still required. The host
  regression already proves the path; stochastic reruns that happened to
  complete all recovery descriptors are not a substitute for controlled fault
  injection.
- Persist host proxy timing, queue depth/high-water, close reason, source
  deadlines, and event-loop lateness in every run.
- Add a per-run recorder loopback/control fixture and a hard
  sample-count-versus-wall-time invariant so host instrumentation cannot again
  manufacture a device continuity defect.
- Prove a deterministic direct/deployed cadence run with all recovery,
  underrun, overflow, reset, freshness, and failure counters at zero. The
  public development tunnel's measured 0.03-113 ms delivery gaps make it
  appropriate for recovery injection, not for declaring gapless transport.
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
