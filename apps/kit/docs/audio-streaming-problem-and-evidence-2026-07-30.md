# Audio streaming problem, constraints, and evidence

Status: active engineering brief and research input, updated 2026-07-31.

This document is the durable map of the realtime-audio problem currently being
solved in Iterate Kit. It distinguishes requirements, known failure classes,
implemented mechanisms, measured evidence, and open hypotheses. It is not a
claim that the audio path is finished.

The broader product goal and verbatim decision transcript remain in
[`physical-device-voice-goal.md`](./physical-device-voice-goal.md). Prior Fable
findings and their disposition are in
[`fable-audio-review-reconciliation-2026-07-30.md`](./fable-audio-review-reconciliation-2026-07-30.md).
The latest focused receive-stall investigation and critical decision record
are
[`fable-esp32-receive-stall-research-2026-07-31.md`](./fable-esp32-receive-stall-research-2026-07-31.md)
and
[`fable-esp32-receive-stall-reconciliation-2026-07-31.md`](./fable-esp32-receive-stall-reconciliation-2026-07-31.md).
The independent ESP-IDF/off-device-rig prior-art trawl and its critical
disposition are condensed in
[`fable-esp32-offdevice-rig-prior-art-2026-07-31.md`](./fable-esp32-offdevice-rig-prior-art-2026-07-31.md).

## Remote backup checkpoint

The complete Git-visible worktree state was snapshotted again immediately
before the current device-ingress diagnosis. This is a recovery checkpoint,
not a completion claim:

- dedicated remote ref:
  `origin/backup/c-capabilities-full-checkpoint-20260730T2345Z`;
- checkpoint commit and verified remote tip:
  `a0c54771d7b92991387eef7644234c57e0529440`;
- verification:
  `git ls-remote --heads origin
backup/c-capabilities-full-checkpoint-20260730T2345Z` returned that exact
  commit.

That commit contains every tracked modification and every non-ignored
untracked file Git reported at checkpoint time. It deliberately does not claim
that the code is finished, reviewed, or ready to merge. Work performed after
that commit remains visible in the active worktree and is not silently folded
into the checkpoint.

An earlier recovery checkpoint is retained for provenance:

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

### Direct-LAN continuity discriminator

A clean direct-LAN ten-second run subsequently completed 500/500 content
frames with no recovery, loss, reset, or failure counter:

- firmware binary SHA-256:
  `61e53dc503aaf314ac46d0dac10d4261272ff78efd39a2821558864a25866084`;
- firmware image size: 1,155,232 bytes;
- static IRAM use: 16,383 of 16,384 bytes;
- downlink high-water: one frame; playback high-water: four descriptors;
- maximum EOF-to-refill: 21,232 us; minimum descriptor-reuse lead:
  38,768 us; maximum driver write call: 97 us;
- device CPU: approximately 303–306 permille while playing;
- audio-owner stack headroom: 6,652 bytes; PCM-network task headroom:
  4,288 bytes; control-network task headroom: 960 bytes;
- minimum internal/DMA-capable heap: 130,931 bytes.

This proves that the physical path can complete ten seconds cleanly, but a
longer direct-LAN run is not yet stable. The latest retained discriminator is:

`apps/kit/evidence/m5sticks3-playback/direct-lan-tone-20s-bridge-telemetry-20260730-2341/`

Its strict counter gate stopped after 536 content frames (about 10.72 seconds)
with exactly one playback-underrun incident, one late content frame dropped,
and one recovery-silence frame submitted and completed. The independent Mac
microphone recording has SHA-256
`48d7bea3869f9cee841531839e994eaf530d4d5af6a35e56ef90ada6b32838f1`.
Analysis at the actual 997 Hz source frequency found exactly one 20 ms internal
gap and one phase discontinuity (maximum phase-step error 0.169698 rad). The
remaining missing duration is expected because the strict device-counter gate
aborted the nominal 20-second run.

New terminal bridge telemetry falsifies host WebSocket buffering as the cause
of this incident:

- 536 worker-to-device messages / 343,040 bytes;
- maximum worker-to-device interarrival: 22.787667 ms;
- maximum Node socket `bufferedAmount`: zero bytes;
- maximum send-callback latency: 2.783417 ms;
- maximum concurrent send callbacks: one, with zero outstanding at close;
- clean local close code 1000 after the device gate stopped the run.

Schema 4 then added the missing device boundary without adding a PCM queue:
the lane records the monotonic arrival time of each complete 640-byte frame,
and descriptor completion projects that frame's receive-to-DMA-start age. The
new image was built and post-link-audited before flashing:

- firmware binary SHA-256:
  `12878c5b5adb260adb83c88be7298bdb89beb97ecd57ef37c82e09d1e3947c31`;
- ELF SHA-256:
  `f82029aa684ca20440477bd035de89c91226abe457b3d7c1bedcde482da3cda8`;
- padded binary size: 1,155,488 bytes, 256 bytes above schema 3;
- flash code/data: 802,236 / 236,792 bytes;
- DIRAM: 209,159 / 341,760 bytes, leaving 132,601 bytes;
- the audited IRAM region remains 16,383 / 16,384 bytes.

It was resolved and flashed only to M5StickS3
`70:04:1D:D5:45:88`. The retained physical run is:

`apps/kit/evidence/m5sticks3-playback/direct-lan-tone-20s-device-ingress-schema4-20260731-0000/`

The strict gate stopped at about 18.2 seconds with one and only one underrun
incident, recovery-silence submission/completion, and late-content drop. Its
new boundary evidence is decisive:

- the host bridge sent 910 frames / 582,400 bytes with zero maximum
  `bufferedAmount`, 0.536 ms maximum send-callback latency, and only
  22.764 ms maximum worker-to-device interarrival;
- the Stick accepted 908 frames and measured 70 ms maximum complete-frame
  interarrival at the PCM lane, up from an earlier 50 ms maximum in the same
  run;
- the failure sample measured 40,320 us maximum EOF-to-successful-refill and
  only 19,680 us minimum descriptor-reuse lead;
- receive-to-DMA-start had 903 samples and a 68 ms maximum;
- downlink high-water remained one frame and playback high-water four
  descriptors, so no hidden application backlog accumulated;
- playback CPU was about 299–307 permille; minimum internal/DMA-capable heap
  was 129,051 bytes; stack headroom was 6,652 bytes for audio, 4,288 for PCM
  networking, 960 for control networking, and 2,520 bytes or more for main.

The raw run log SHA-256 is
`317a931c34eb69167b954113699908e9348305762594f169994a3e09e8f5b534`.
The preserved 48 kHz Mac microphone recording SHA-256 is
`35f9f0519f72dfa2cd255014b38806d311a8b9982f7224629ba5ae9f651b2954`.
Because the strict device-counter gate aborted the capture, its duration and
missing-tone assessment cannot be used as a nominal 20-second acceptance
result. Offline analysis nevertheless rejects continuity: it finds two gaps,
a 635 ms longest internal gap, 2,005 ms missing tone, and two phase
discontinuities. Those larger acoustic absences are not yet attributed
one-for-one to the single classified firmware underrun and therefore remain
separate evidence rather than an invented causal claim.

This falsifies the earlier “host sender simply paused for the whole gap”
hypothesis. At least 47 ms of extra worst-case delay arose after the measured
host bridge boundary. More importantly, a real-time-paced upstream sender
keeps the application ring at depth zero or one, so the nominal 80 ms DMA
preload is not a replenished jitter reservoir: after ordinary clock drift and
previous variation have consumed its phase lead, one 70 ms device ingress gap
crosses the cyclic refill boundary. The next design step must make the device
clock authoritative and preserve a small, explicit, freshness-bounded playout
reserve; merely increasing an unmeasured FIFO or retrying stale frames would
hide the failure as conversational latency.

### Exact host payload ledger and latest physical discriminators

The LAN bridge now accounts for WebSocket _payload_ bytes independently of
Node's `bufferedAmount`. A payload enters the ledger immediately before
`send()` and leaves only in that send's callback. The bridge records current
and maximum payload bytes, callback count, oldest callback age, and callback
latency. The media budget is checked against the next payload before sending.
This matters because WebSocket framing bytes are implementation overhead, not
additional retained speech, while an unresolved send callback still owns real
audio even if `bufferedAmount` reads zero.

A deterministic regression admits exactly eight 640-byte frames into the
5,120-byte budget and rejects the ninth. It observes 5,120 payload bytes and
eight callbacks in flight. This corrected an earlier interpretation: the
5,152-byte raw socket reading in the first one-minute attempt represented
eight full PCM payloads plus framing. The intended 160 ms media budget really
was full; it was not a harmless 32-byte accounting discrepancy.

Four retained runs then separate different failure classes:

1. `direct-lan-tone-20s-device-clocked-after-serial-control-20260731-0122`
   completed 1,000 accepted, submitted, and completed content frames with every
   loss/recovery/failure counter zero. The marker-anchored Mac recording
   observed 19,952.5 ms of tone with zero internal gaps and zero phase
   discontinuities. Host maximum interarrival was 34.261 ms, maximum send
   callback latency was 1.539 ms, and at most three callbacks were in flight.
   The run-log SHA-256 is
   `ab788e7db14252c94e2ee4d696464861327dfec68ce930cf6c7834ad8db5b4c6`;
   the microphone SHA-256 is
   `73446deada2fb701a046f40ad690665ebaa4af4868fa5568d2731eaa7255811d`.

2. `direct-lan-tone-60s-device-clocked-strict-20260731-0128` stopped after
   about 9.3 seconds because the old raw-buffer gate closed code 4013 with
   5,152 bytes and eight callbacks outstanding after sending 416 frames.
   This is retained as the regression that motivated the exact payload ledger,
   not as device-underrun evidence. The run-log and microphone SHA-256 values
   are respectively
   `932737add189dd3c47123e970e62d7c3e7316b0430eb501687a36edab204d005`
   and
   `aca573712028c21b9c59dfb72817af433a3113c61371412b5dea2fd94fdbd9bd`.

3. `direct-lan-tone-60s-device-clocked-payload-ledger-20260731-0052` passed
   the corrected host ledger but the strict device policy stopped after about
   2.5 seconds on one classified underrun, one recovery-silence frame, and one
   late-content drop. The host had no retained payload at teardown, peaked at
   only 1,920 payload bytes / three frames in flight, saw a 0.961 ms maximum
   callback latency and 33.681 ms maximum interarrival, and therefore did not
   contain a hidden multi-frame socket backlog. The run-log and microphone
   SHA-256 values are
   `f3a8ab78d5f8f2ebce7af58daaa4836878f9cd2f6d66a72d2c9b3c52d9c6c35a`
   and
   `521bcc0e0d71767bdd079c6676a601fa1cabb22b54c2242253fb73ca390b01bc`.
   The runner recorded the policy failure but did not persist the complete
   failing device snapshot; that is an observability defect, not permission to
   infer missing values.

4. `direct-lan-tone-10s-device-clocked-verbose-underrun-20260731-0058`
   subsequently completed all 500 frames with no underrun, drop, reset, or
   driver failure. Its Mac oracle observed 9,952.5 ms with zero gaps and zero
   phase discontinuities. The exact host ledger again peaked at 1,920 bytes /
   three frames, with 0.804 ms maximum callback latency and 34.410 ms maximum
   interarrival. On-device maxima were 50 ms complete-frame interarrival,
   83 ms receive-to-DMA-start, 31,202 us EOF-to-refill, 95 us driver write,
   and a 28,798 us minimum descriptor-reuse lead. Minimum internal/DMA heap
   was 128,811 bytes; stack headroom was 6,652 bytes for audio, 4,048 for PCM
   networking, 960 for control networking, and 2,440 for main. Detailed
   playback samples were approximately 283–295 permille CPU. The run-log and
   microphone SHA-256 values are
   `afa9e50ebd8ce0de9b37a4a43fa6ee53c8e618fd97bddaf8ce5e9e7ca91178fa`
   and
   `92cfb1947106b8be408c176e9b9abf6ae5b787104024bbae134f0c7c0cff88e8`.

The mixed result is useful rather than contradictory. A clean ten- or
twenty-second run proves the hardware can play continuously. A stochastic
late ingress event still shrinks the nominal 60 ms descriptor-reuse window
enough to create a real audible slot loss. Exact host payload accounting rules
out one suspected backlog layer, but it does not turn the current startup
phase lead into a replenished reserve.

The named seven-frame startup experiment then produced two complementary
one-minute attempts:

- attempt 1
  (`direct-lan-tone-60s-device-clocked-startup7-attempt1-20260731-0110`)
  was terminated at 24.864 seconds by the _host_ freshness gate. Eight exact
  PCM payloads / 5,120 bytes and eight callbacks were outstanding, the oldest
  callback was 156.661 ms old, raw `bufferedAmount` was 5,152 bytes, and the
  bridge closed code 4013 instead of retaining more speech. Maximum
  worker-to-device interarrival before close was 42.279 ms. The terminal
  evidence and preserved microphone SHA-256
  `54bb284799bfa0513c2e1d13c5a4d43f96cbbe0b22437c1800178d68017c3c02`
  are recorded in its `observation.md`; a shell `tee` path error means this
  attempt has no raw run log and cannot be promoted to an acceptance artifact.
- attempt 2
  (`direct-lan-tone-60s-device-clocked-startup7-attempt2-20260731-0111`)
  is the first clean one-minute physical pass. It
  accepted/submitted/completed all 3,000 content frames, consumed EOS, and had
  zero drop, recovery, reset, protocol, or driver failure counters. Downlink
  high-water was five application frames and playback high-water was four
  descriptors. The host transmitted 3,001 messages / 1,920,000 content bytes;
  exact payload ownership peaked at 4,480 bytes / seven frames solely as the
  intended startup burst, returned to zero at close, and saw 3.137 ms maximum
  callback latency and 34.498 ms maximum interarrival. The Mac oracle observed
  59,955 ms with zero internal gaps and zero phase discontinuities; maximum
  phase-step error was 0.095762 rad. Minimum internal heap was 127,331 bytes,
  main stack headroom was 2,504 bytes, and final device CPU was 278 permille.
  The run-log SHA-256 is
  `062957e0b6b879f7bc7d3d22a7802995518ef2758d7d794840dae545341501cc`;
  microphone SHA-256 is
  `76e91da2e760cc2e6b15e48b35a0becc4106559b3c854c0e7faeed98ebfd5cc9`.

This proves that a bounded 60 ms application lead beyond the four DMA
descriptors can carry one complete minute without added firmware RAM or a
growing queue. It does **not** prove that seven is the final product default:
the first attempt demonstrates a separate 160 ms network no-progress event,
and one passing stochastic run cannot establish comparative reliability. The
watermark is retained as an experimental discriminator and as input to the
simpler create-once writer contract, not treated as a substitute for that
refactor.

A requested two-minute repeat,
`direct-lan-tone-120s-device-clocked-startup7-verbose-20260731-0115`,
failed closed at 26.664 seconds with the same distinct transport signature as
attempt 1: eight exact payloads / 5,120 bytes and eight callbacks were
outstanding, the oldest callback was 159.296 ms old, and raw
`bufferedAmount` was 5,152 bytes. Prior completed callbacks took at most
1.051 ms and prior host interarrival was at most 34.552 ms. The host emitted
1,283 frames / 821,120 bytes before close code 4013. The requested detailed
per-second series was not enabled because the invocation used
`ITERATE_KIT_VERBOSE_PLAYBACK_METRICS` instead of the implemented
`ITERATE_KIT_VERBOSE_METRICS`; the artifact records that limitation rather
than pretending terminal state fills the gap. Run-log SHA-256 is
`06088360e7647fe1f3ca88fadd93751b545dae6c2f9ed2f8fcb864883830e13c`;
microphone SHA-256 is
`06ebe1cdb5bff15c00ac2c2fc983ecd96a1bb829dbc6270ccc1c4d550b2755bd`.

The repeated approximately 160 ms signature strengthens the separation
between two problems. Seven-frame startup reserve is a plausible answer to
ordinary shorter ingress jitter; it cannot make a socket that has stopped
advancing accept fresh audio. The exact ledger is doing the intended thing
during the latter failure: prevent a ninth frame and force a visible
generation boundary. The next experiment must localize why the device TCP
receive path stops making progress, not enlarge the freshness budget.

The correctly instrumented one-minute repeat,
`direct-lan-tone-60s-device-clocked-startup7-verbose-20260731-0122`,
then completed all 3,000 frames with zero device incident counters and a
59,955 ms zero-gap, zero-phase-discontinuity Mac recording. Exact host
ownership peaked at the intended seven-frame startup burst and returned to
zero; host send-callback latency was at most 1.758 ms and host interarrival at
most 36.260 ms. Yet the device's maximum complete-frame interarrival reached
90 ms. The reserve absorbed that pause: downlink high-water was six,
descriptor high-water four, and minimum descriptor-reuse lead 59.398 ms.
Minimum internal/DMA heap was 125,923 bytes and steady CPU samples were
approximately 276–301 permille. Run-log SHA-256 is
`69523a6a38cd0243352d1e3d1306912fd95a6b6ce63bafaa4d8b89bac538563e`;
microphone SHA-256 is
`ffd1204adfd6c52a3a3849e5c8842b7ce0667f8cb52652e0cbcd2ba3a51f90ec`.

This passing trace narrows but does not finish the diagnosis. Recoverable
delivery pauses already arise below the host pacer. The current maximum PCM
network work-cycle metric stayed unchanged throughout and therefore cannot
distinguish a descheduled network task, repeated nonblocking socket
would-block results, or raw bytes that do not yet complete a WebSocket
message. Those are the next bounded progress discriminators.

The schema-5 two-minute attempt
`direct-lan-tone-120s-device-clocked-startup7-schema5-verbose-20260731-0134`
then supplied the missing discriminator and changed the interpretation of the
repeated `4013` failures. Through the final delivered sample (sequence 44,
device uptime 59,309 ms), the Stick remained exactly on cadence:
`downlinkAccepted=2051`, submitted/completed `2048/2044`,
`pcmReceiveCalls=10405`, and `pcmReceiveChunks=2071`, with every incident
counter zero. The last seven one-second deltas were approximately 248 lower
reads and 50 accepted frames each. No later control sample arrived before the
host failed closed at PCM elapsed 47.446 seconds with the familiar eight
callbacks / 5,120 payload bytes / 5,152 framed bytes and 158.221 ms oldest
callback age.

Independent acoustic re-analysis found no internal tone gap before terminal
starvation and approximately 4.15-4.20 seconds of terminal silence in each of
the four retained `4013` captures. The Mac's measured
`net.inet.tcp.sendspace` is 131,072 bytes; at 50 unmasked 644-byte wire frames
per second, that is approximately 4.07 seconds of speech hidden below Node's
send-callback ledger before user-space backpressure appears. The 5,120-byte
gate is therefore an exact **user-space ownership bound**, but it is not a
peer-receipt or 160 ms freshness oracle. The strongest current explanation is
an abrupt bidirectional endpoint/path outage followed by several seconds of
kernel acceptance and then deterministic gate saturation.

This does not broadly exonerate the firmware or prove an environmental RF
cause. It substantially excludes a PCM-reader-only slowdown while the control
path remains healthy. Device Wi-Fi/driver/lwIP failure, AP/RF failure, and
Mac-side radio interruption remain unresolved until retained ESP-IDF incident
fields or a packet trace names the layer. Exact corrections and accepted,
deferred, and rejected recommendations are recorded in
[`fable-esp32-receive-stall-reconciliation-2026-07-31.md`](./fable-esp32-receive-stall-reconciliation-2026-07-31.md).

A subsequent attempt,
`direct-lan-tone-120s-device-clocked-startup7-schema5-followup-20260731-0145`,
played cleanly for roughly 99 seconds / 4,950 host frames before the separate
`/api` socket closed abnormally with code 1006. That control-session loss
caused the provider session to stop the still-open PCM proxy normally and the
device remounted a replacement capability generation. The old harness waited
on the dead subscription and timed out; it did not resubscribe, and the run is
a failure rather than a partial pass. Its run-log SHA-256 is
`3eea360f20ebe4ed593b4aede41cb9a21a85bab15f6bf556964767a04c2c012c`.
The acoustic artifact was preserved but still needs a final observation file
and hash ledger.

That second failure motivated a smaller postmortem path instead of a log
queue. The ESP-IDF control transport now retains the latest exact error tuple
and bounded inbox/outbox metrics across reconnect. A one-shot
`getDiagnostics()` capability renders schema 2 through a caller-owned fixed
1,280-byte buffer; it allocates no history, adds no idle wire traffic, and
rejects overlapping unpulled replies. The host watches the mount generation,
obtains the retained tuple from the replacement session, logs it, and still
fails the endurance proof. The cited firmware/TypeScript counts were green at
that implementation checkpoint; later sections record the newer targeted
red/green tests rather than treating old counts as current proof.

The diagnostics-enabled real target then built and passed its real-target and
realtime-ELF audits. Its application binary is 1,157,200 bytes
(`bffbb54b5c8ecbfc9d62bee10a7da095756b353ea08629e0d2602e12f98be6d0`);
linked image segments total 1,157,078 bytes; static DIRAM is 209,831 bytes,
leaving 131,929 bytes. Against the immediately preceding build, the retained
diagnostics path costs 1,584 image bytes and 672 static DIRAM bytes, with
reported IRAM unchanged.

After exact USB/MAC re-identification, that image was flashed to the
M5StickS3. The first diagnostics-enabled two-minute physical proof completed
all 6,000 frames with zero drop, flush, underrun, freshness, driver,
write-backpressure, protocol, reconnect, or lifecycle incidents. The Mac
microphone oracle found zero internal gaps and zero phase discontinuities
across a 119,955 ms observed tone span. Terminal internal-heap minimum was
123,535 bytes, steady free internal heap was about 140,259 bytes, and terminal
stack headrooms were 6,644 / 2,344 / 960 / 4,296 bytes for audio owner, main,
control network, and PCM network respectively. Full hashes, counters,
resource accounting, command, and limitations are in
[`direct-lan-tone-120s-control-diagnostics-physical-20260731-0222/observation.md`](../evidence/m5sticks3-playback/direct-lan-tone-120s-control-diagnostics-physical-20260731-0222/observation.md).
This clean pass validates the instrumentation and two-minute continuity rung;
it does not make the earlier intermittent bidirectional outages explained or
fixed.

### Loaded control traffic exposed two independent bounds

The next physical lane used a real Cap'n Web `getDiagnostics()` call at 20 Hz
while the same one-minute deterministic tone played. The first version had
both application-owned Core-0 network tasks at FreeRTOS priority 5. PCM receive
progress stopped after roughly 21 seconds even though control had remained
active. A real C-peer regression then completed 512 sequential retained
diagnostics replies, excluding the simple finite-call-table/borrowed-buffer leak
hypothesis. Host fakes captured a red assertion for equal task priority; the
shared policy now gives PCM priority 6 and control priority 5, with a
compile-time ordering proof and paired green platform tests.

The matched physical rerun did not fully pass, but it materially discriminated
the scheduler issue. It delivered 2,589 PCM frames / 51.78 seconds, and the Mac
recording contained a 51,495 ms continuous tone span with zero internal gaps,
zero phase discontinuities, 0.1055 dB p99 amplitude steps, and 0.0621 radians
maximum phase-step error. It then exposed a distinct control inbox bound:
generation 1 recorded one producer-backpressure incident at high water 4,
`CAPNWEB_E_TRANSPORT`, and a bounded remount to generation 2.

The final trace shows the causally valid overlap: two metrics subscription
callbacks can return four resolve/release messages while the strictly
single-flight diagnostics RPC contributes push, pull, and the preceding
release. Four inbox slots cannot hold that seven-message burst even though
average control throughput is low and no calls accumulate concurrently. A new
architecture test failed `4 >= 7` before the target inbox was changed to eight,
the smallest covering power of two. The change costs exactly 5,152 bytes in
the statically owned runtime (four 1,280-byte slots plus four lengths); it does
not change the 1,158,112-byte application binary because the reserve is BSS.
The rebuilt image reports 226,895 / 341,760 bytes DIRAM used, 114,865 bytes
remaining, and an unchanged one-byte IRAM margin. Pressure beyond the reviewed
burst still terminates and replaces the generation explicitly.

The complete failed-run command, hashes, counters, acoustic analysis, and
classification are in
[`direct-lan-tone-60s-diagnostics-churn20-pcm-priority6-r2-physical-20260731-0352/observation.md`](../evidence/m5sticks3-playback/direct-lan-tone-60s-diagnostics-churn20-pcm-priority6-r2-physical-20260731-0352/observation.md).

The eight-slot physical rerun removed that exact inbox-pressure signature but
still failed the wider loaded acceptance contract. Control resolved normally
through request 493 and then stopped making device-side progress at the same
time as PCM. The microphone oracle observed an entirely continuous 27,585 ms
tone interval with zero internal gaps or phase discontinuities, followed by
abrupt truncation at capture offset 28,277.5 ms. The host did not cross its
5,120-byte user-space freshness gate until PCM elapsed 33,105.9 ms—about 4.8
seconds later—and then used an explicit TCP reset. The final control request,
the six-second PCM follow-up, the 6.5-second control diagnostic grace period,
and the replacement mount all timed out.

This validates the bounded inbox arithmetic, not the complete system. It also
repeats the independently derived macOS-kernel-blind-spot shape and now shows
that both independent device WebSockets lost progress together. The directly
observed class is a coupled endpoint/path outage; device Wi-Fi/lwIP/driver,
AP/RF, and Mac-path causes remain unresolved. More application buffering
would make freshness worse and is not an acceptable response. Exact command,
hashes, timing, resources, and nonclaims are in
[`direct-lan-tone-60s-diagnostics-churn20-inbox8-physical-20260731-0400/observation.md`](../evidence/m5sticks3-playback/direct-lan-tone-60s-diagnostics-churn20-inbox8-physical-20260731-0400/observation.md).

An otherwise identical run added a 10 Hz ICMP sidecar. Its apparent 44.9%
packet loss consists of exactly two contiguous intervals: the expected
17.5-second reset/reboot interval before mounting, and a second 17.2-second
interval overlapping the coupled control/PCM stall. ICMP replies were
continuous immediately before and after the second interval. The acoustic
oracle again saw continuous playback while the path progressed, followed by
abrupt truncation.

This localises the observed failure below both application protocols and their
independent sockets: the Stick's station address itself was unreachable. It
does not yet distinguish device Wi-Fi/lwIP/driver state from AP-side station
state or RF interference. The existing 6.5-second diagnostic grace
necessarily tears down before the measured 17.2-second outage can recover, so
the next narrow change is a longer _post-failure observation_ window. It does
not enlarge an audio buffer, replay stale audio, retry the failed capability,
or convert reconnection into acceptance. A timestamped router-control ping
will distinguish loss of only the device station from loss of the Mac/AP path.
Exact artifacts, hashes, limitations, and nonclaims are in
[`direct-lan-tone-60s-diagnostics-churn20-inbox8-ping-physical-20260731-0414/observation.md`](../evidence/m5sticks3-playback/direct-lan-tone-60s-diagnostics-churn20-inbox8-ping-physical-20260731-0414/observation.md).

The timestamped device/router control repeat sharpened that boundary. The
router received every 10 Hz probe while the Stick alone missed 172 consecutive
probes and then returned after 18.561 seconds between adjacent replies. The
post-gap replies still came from the Stick's exact MAC. It then answered
another approximately 16.86 seconds of continuous ICMP without either
application socket remounting. Playback before the outage was a clean,
zero-gap, zero-phase-discontinuity 12,620 ms interval.

The station-specific outage remains a device/AP/RF question. The subsequent
application non-recovery has a concrete source-level defect: the control
network owner calls the managed `esp_websocket_client_stop()` on Wi-Fi loss,
and the selected component's `stop_wait_task()` joins `STOPPED_BIT` with
`portMAX_DELAY`. That unbounded SDK join contradicts the transport's bounded
recovery contract. It can explain failure to remount after IP recovery, not the
original station disappearance. The smallest architectural correction to test
is replacing the hidden managed-client worker with the already-shared,
single-owner lower WebSocket transport, while keeping control and PCM on
separate sockets. Exact timing, artifacts, acoustic analysis, and limitations
are in
[`direct-lan-tone-60s-diagnostics-churn20-inbox8-dual-ping-physical-20260731-0421/observation.md`](../evidence/m5sticks3-playback/direct-lan-tone-60s-diagnostics-churn20-inbox8-dual-ping-physical-20260731-0421/observation.md).

That candidate simplification has now been implemented and physically tested.
The Cap'n Web owner uses the same fixed-buffer, taskless lower WebSocket
connection as PCM, while retaining a separate socket and scheduling policy.
The resulting ESP-IDF image is 10,160 bytes smaller. Static DIRAM/BSS rose
4,968 bytes for explicit workspaces, but the comparable device sample had
8,924 more free internal heap, 4,224 more minimum free internal heap, and a
3,072-byte larger free internal block because the managed task/client
allocations disappeared. The host suite, sanitizer suite, architecture tests,
ESP-IDF build, and realtime placement audit passed.

The matched physical A/B nevertheless repeated both defects. The Stick alone
missed 172 consecutive ICMP probes for 18.477 seconds while the router received
all probes. After returning, the Stick answered another 160 probes without
either direct WebSocket remounting. Control request 188 remained unresolved;
the PCM bridge reached its fixed 5,120-byte freshness gate at 16,136 ms and
reset the stale connection. The microphone captured a 9,830 ms continuous
tone span followed by abrupt truncation, with two small phase-threshold
violations (maximum 0.112724 radians).

This falsifies the managed client's unbounded join as a _sufficient_ cause of
non-recovery. Removing it remains justified by simpler ownership and measured
flash/runtime-memory gains, but the common failure boundary is now the shared
lower WebSocket/parent transport, Wi-Fi lifecycle, or a device owner blocked
during the station outage. More buffering remains unsupported. Exact artifacts
and nonclaims are in
[`direct-lan-tone-60s-taskless-control-dual-ping-physical-20260731-0451/observation.md`](../evidence/m5sticks3-playback/direct-lan-tone-60s-taskless-control-dual-ping-physical-20260731-0451/observation.md).

### Architectural decision after the independent reviews

The current direct-I2S descriptor policy remains a valuable measured physical
baseline: it has exact ownership, bounded recovery, and conservation
counters. It should not be enlarged or made more elaborate. Both Fable reviews
identify the surrounding approximately 4,100-line
descriptor/owner/mailbox/lifecycle construction as a likely local maximum.

The preferred simplification to test is a create-once I2S substrate with one
dedicated high-priority playback writer:

- the existing fixed, freshness-bounded PCM lane remains the only content
  queue;
- a small named startup watermark establishes an age-bounded playout lead;
- the writer uses the ESP-IDF blocking channel-write contract and the driver
  DMA queue as synchronization rather than reimplementing descriptor
  ownership;
- underrun uses driver auto-clear/silence and a visible incident counter;
- interruption or stale/no-progress failure resets the generation cheaply,
  without deleting the channel or performing codec/I2C setup per response;
- callbacks remain passive metrics/notifications, never a second scheduler.

For the Stick, TX-only create-once playback is the first A/B seam; direct RX
must follow before push-to-talk can stop sharing/deleting M5Unified's channel.
For StackChan/AEC, a single duplex audio task with sample-synchronous speaker
reference is more plausible than forcing the half-duplex Stick lifecycle onto
it. An ISR-pull renderer is explicitly deferred unless the simpler writer
fails a measured deadline. The current path stays available until red host
contracts and matched physical A/B runs show the replacement is at least as
correct and materially simpler.

Before that migration, one narrow experiment may vary the _named_
device-clocked startup watermark while keeping the existing 160 ms maximum
age/capacity. Its purpose is to measure how much explicit lead the physical
path needs, not to bless a larger hidden FIFO. It must preserve discard/reset
semantics and must not change host-paced provider behavior.

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

## Independent Fable research and reconciliation

The first full architecture review was captured in
[`fable-audio-architecture-alternatives-2026-07-30.md`](./fable-audio-architecture-alternatives-2026-07-30.md)
and was reconciled rather than accepted wholesale in
[`fable-audio-review-reconciliation-2026-07-30.md`](./fable-audio-review-reconciliation-2026-07-30.md).

The supplemental Fable Max acoustic/endurance review is complete and captured
in
[`fable-acoustic-oracle-and-endurance-review-2026-07-30.md`](./fable-acoustic-oracle-and-endurance-review-2026-07-30.md).
Its exact prompt is retained in
[`fable-acoustic-oracle-and-endurance-review-prompt-2026-07-30.md`](./fable-acoustic-oracle-and-endurance-review-prompt-2026-07-30.md),
and the source/test/physical-evidence decision ledger is
[`fable-acoustic-oracle-review-reconciliation-2026-07-31.md`](./fable-acoustic-oracle-review-reconciliation-2026-07-31.md).
The broader Fable Max prior-art job completed. Its full 39,592-character
assistant response remains in the Claude CLI transcript identified by
`b95cc9c2-7ab7-4c27-bf2f-ff13b4372b1e`; the durable in-repository
source-level synthesis and disposition are
[`fable-esp32-offdevice-rig-prior-art-2026-07-31.md`](./fable-esp32-offdevice-rig-prior-art-2026-07-31.md).
Two still-narrower follow-up launches were attempted immediately after the
user reported reset credits, but Claude Team rejected both before research
with a monthly spend-limit error. They produced no report and are not counted
as independent review.

The focused Fable Max receive-stall source/docs/evidence trawl is captured in
[`fable-esp32-receive-stall-research-2026-07-31.md`](./fable-esp32-receive-stall-research-2026-07-31.md);
its verbatim prompt is
[`fable-esp32-receive-stall-research-prompt-2026-07-31.md`](./fable-esp32-receive-stall-research-prompt-2026-07-31.md).
Its independent claims were checked against the Mac TCP sysctls, target
configuration, source, counter series, and acoustic evidence, then reconciled
in
[`fable-esp32-receive-stall-reconciliation-2026-07-31.md`](./fable-esp32-receive-stall-reconciliation-2026-07-31.md).
The useful simplification is to leave the measured PCM path alone and make
progress/abort/postmortem semantics honest. The report's broader claim that
firmware is exonerated was rejected.

The reviews were not accepted wholesale. In particular:

- causal acoustic markers and exact host payload accounting were implemented
  and proven red-first;
- StackChan's sample-synchronous reference and post-DMA render tap are useful,
  while its multi-second StreamBuffers, newest-frame drop, zero-fill latency
  ratchet, and blocking display/status locks remain explicitly rejected;
- the current direct-descriptor policy is retained as a diagnostic baseline,
  not treated as the architecture to keep expanding;
- the create-once dedicated-writer design is the preferred A/B simplification;
- proposed numerical recovery budgets, guessed acoustic end markers, and
  extra metrics without a live discriminator remain deferred.

Every further recommendation must still survive a red host contract, the
fixed memory/IRAM/build gates, and matched Mac-microphone physical evidence.
