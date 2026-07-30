# Fable realtime-audio review reconciliation

Status: active implementation ledger, 2026-07-30.

This document preserves the actionable feedback from the completed Fable Max
research runs:

- `iterate-kit-esp32-realtime-audio-research` (`ef94715f`)
- `iterate-kit-audio-latency-design-space` (`b510e6d4`)
- the independent source trawl completed on 2026-07-30, retained verbatim as
  [`fable-audio-architecture-alternatives-2026-07-30.md`](./fable-audio-architecture-alternatives-2026-07-30.md)
- the targeted M5StickS3 acoustic/startup investigation
  (`kit-acoustic-startup-review`, `86b7af89`), retained verbatim as
  [`fable-m5sticks3-acoustic-startup-investigation-2026-07-30.md`](./fable-m5sticks3-acoustic-startup-investigation-2026-07-30.md)

It is intentionally separate from the raw transcript in
[`physical-device-voice-goal.md`](./physical-device-voice-goal.md). A finding
leaves this ledger only when a regression test and the relevant host, firmware,
or physical proof make the claimed boundary observable.

## Targeted acoustic/startup review reconciliation

The targeted review materially changed the diagnosis. It proved that the
multi-second shortened/jiggly room recordings were produced by the FFmpeg
AVFoundation capture path, while an independent SoX/raw CoreAudio path recorded
the Stick's 997 Hz output cleanly. It also found a separate, genuine firmware
failure: one roughly 50 ms refill delay could leave a completed ESP-IDF
descriptor unconsumed, overflow the private finished-pointer queue, and
destructively reset playback. These are different defects and remain separate
in the evidence.

### Accepted and implemented

- SoX/raw CoreAudio is the acoustic acceptance recorder. A run must record
  recorder wall time, sample count, sample rate, recorder implementation, and
  capture integrity. FFmpeg AVFoundation output remains useful only as a known
  failing control until its single-buffer delegate behavior is removed.
- One missing downlink frame is now a bounded resynchronisation incident rather
  than permission to recreate I2S. The owner writes one exact zero
  `recoverySilence` descriptor immediately, thereby consuming ESP-IDF's private
  completed-pointer credit without replaying stale memory.
- Every inserted silence creates exactly one scalar recovery debt. The next
  ordered late content frame pays that debt by being discarded; no second PCM
  queue or retained payload is introduced. The following on-time frame resumes
  in the same I2S generation.
- Ordered EOS clears debt that can no longer be paid. A full completed-DMA
  cycle, driver failure, impossible counter state, or arithmetic saturation
  still fails closed.
- Recovery initially had three separate saturating counters:
  `underrunSilenceFramesSubmitted`,
  `underrunSilenceFramesCompleted`, and
  `underrunLateFramesDropped`. They are exported through playback metrics
  schema 2 rather than allowing an older consumer to mistake absent recovery
  evidence for zero. Physical clean-EOS evidence later required schema 3's
  fourth counter, `underrunSilenceFramesRetired`: a successful synchronous
  stop owns and retires any recovery descriptors that have not produced DMA EOF
  callbacks. Exact terminal conservation is now
  `submitted = completed + retired`, while a stop failure remains an explicit
  failure rather than being papered over.
- Host regressions cover one-late-frame ride-through, completion accounting,
  EOS with unpaid debt, multiple completion credits before the owner wakes,
  descriptor-kind preservation through wrap, and the retained destructive
  full-cycle case.

This policy adds no audio payload storage. The portable playback object first
grew from 280 to 296 bytes on the host ABI, then from 296 to 304 bytes for exact
EOS retirement accounting. The final increment is one 32-bit counter plus one
32-bit scalar outstanding-recovery count, still far below one 640-byte PCM
frame.

### Accepted as a later comparison, not a prerequisite

The review's create-once full-duplex I2S substrate remains a credible
architectural simplification, particularly for StackChan/AEC. It is not yet
proven to be smaller or more reliable on M5StickS3 than the now-repaired direct
descriptor path. Compare both behind the existing portable playback/driver
contract with the same physical fixture before replacing working code.

### Rejected or narrowed

- A deterministic “gapless” acceptance run may not pass with a budgeted
  nonzero underrun. Such a budget would redefine an audible discontinuity as
  success. The strict endurance policy therefore requires all three recovery
  counters, underrun incidents, flushes, queue overflows, resets, and failures
  to remain zero.
- A separate injected-fault proof may allow a precisely classified recovery,
  but it must assert conservation
  (`silence submitted == silence completed == late content dropped`), continued
  same-generation playback, bounded incident count, no queue overflow/reset,
  and no later stale burst. Recovery quality and uninterrupted cadence are two
  different claims.
- The review's clean SoX recording falsifies the earlier inference that every
  shortened FFmpeg capture was a device startup/codec defect. It does not
  falsify the independently observed one-late-frame queue overflow.

### Current verification status

- Normal native suite: 38/38 passing.
- ASan/UBSan native suite: 38/38 passing. Apple ASan does not implement leak
  detection, so `detect_leaks=0` is an explicit platform limitation; address
  and undefined-behaviour instrumentation remain enabled and fail-fast.
- Kit TypeScript suite after the schema-3 edit: 303 passing, one intentionally
  skipped live public-tunnel test; typecheck passes.
- ESP-IDF M5StickS3 build and realtime post-link audit pass.
- Schema-3 bounded-recovery firmware is physically flashed and validated on
  M5StickS3 `70:04:1D:D5:45:88`. A ten-second tunnel-adversity run completed
  all 500 accepted frames with 207 exactly conserved recovery incidents and
  zero resets, overflow, driver/stop failures, state errors, or stale catch-up.
  That is a recovery proof, not a continuity proof: the strict acoustic policy
  correctly failed. The direct/deployed zero-recovery endurance path remains
  open.

## Independent architecture review reconciliation

The third review was deliberately asked to search for a materially simpler
system rather than polish the current implementation. Its central criticism is
accepted: the descriptor-identity ledger, destructive channel recreation, and
cross-task lifecycle mailboxes have turned ESP-IDF's ordered blocking I2S API
into a larger and more fragile scheduler. The review did not prove that its
replacement works on this board, so this is a migration decision, not an
instruction to delete the existing path immediately.

### Accepted now

- Keep the two-WebSocket product contract, exact 640-byte/20-ms PCM frames,
  generation-fenced bounded SPSC lanes, static realtime storage, native
  `16 kHz` codec clock, explicit stale-audio policy, and acoustic evidence rig.
- Move the Cap'n Web network owner to core 0. The source currently pins it to
  `CONFIG_FREERTOS_NUMBER_OF_CORES - 1`, the same core as the priority-19
  speaker owner, despite comments claiming that audio has stable scheduling
  headroom. This is a source-proven contradiction, not a tuning opinion.
- Disable `CONFIG_ESP_WS_CLIENT_SEPARATE_TX_LOCK`. The control socket does not
  justify allowing two tasks to enter one mbedTLS context concurrently when
  mbedTLS C threading is disabled. The custom PCM socket remains independent.
- Build a create-once full-duplex `i2s_std` TX/RX substrate behind a target
  switch. On the Stick, capture/playback exclusivity is policy; it must not
  require deleting the hardware channel. The first candidate above that
  substrate is a dedicated blocking writer and blocking reader, with the
  codec/DMA clock providing the pace.
- Treat an ordinary playback underrun as a bounded silence/resynchronisation
  incident, not permission to delete/recreate I2S and reprogram the codec.
  Old audio is still discarded by freshness/generation policy. The distinction
  is important: riding through a brief missing frame does not mean replaying a
  backlog after recovery.
- Retain the existing ISR callbacks only as passive timestamps/counters in the
  first simpler implementation. ESP-IDF's finished-buffer queue provides write
  ordering, while `auto_clear_before_cb` makes an unfilled completed buffer
  silent instead of replaying stale PCM.

### Accepted with a narrower interpretation

- The host proxy should primarily authenticate, adapt provider events, rechunk,
  fence PTT release, and preserve close provenance. It must not end a healthy
  generation merely because one JavaScript timer fires after its very small
  source-slack window.
- This does **not** yet justify an invisible 500-ms speech reservoir or
  unconstrained bursting. Any host elasticity remains age-bounded, drops the
  oldest stale audio visibly, and exports counters. Whether a small shaper is
  still useful is decided by the direct deployed-worker cadence proof, not by
  fake timers or the known-bursty reverse tunnel.
- Architecture A (separate blocking reader/writer tasks) is the least disruptive
  Stick migration. Architecture C (one device-clocked duplex task) remains the
  likely StackChan/AEC destination. Sharing a substrate does not require
  pretending those device policies are identical.

### Not accepted without measurement

- `CONFIG_FREERTOS_HZ=1000` is not an automatic improvement. The audio path
  must be notification/DMA driven and must not depend on sub-10-ms tick waits.
  A faster tick has a permanent interrupt/CPU cost; measure it only if a real
  bounded control wait needs that resolution.
- Running at 240 MHz may buy deadline headroom, but “as few CPU cycles as
  possible” and thermal/power cost remain product constraints. Compare
  160/240 MHz with the same acoustic/load challenge before setting a default.
- Task-watchdog user handles are useful terminal safety evidence, but they do
  not replace per-stage lateness histograms or classified recovery. A watchdog
  that resets the device before retaining the incident would weaken diagnosis.
- The existing delivery-barrier PING cannot be removed merely because a tunnel
  may mishandle it. First prove the actual direct worker's RFC 6455 control
  behavior, then simplify the idle-probe policy without losing the distinction
  between local TCP acceptance and peer-ordered receipt.

### Migration proof order

1. Re-run a short physical tone with exact socket-close provenance and detailed
   device metrics to classify the measured 127.5-ms playback death.
2. Land source/config regressions for core placement and the unsafe WebSocket
   lock setting before changing either.
3. Add a fake blocking-I2S contract whose red cases cover create-once lifetime,
   partial writes, silence on underrun, bounded resynchronisation, freshness
   trim, EOS drain, and PTT transitions without channel deletion.
4. Implement the simpler substrate behind a target switch and compare both
   paths using the same 5-10-second acoustic fixture.
5. Only after the simpler path wins the physical comparison, delete the
   descriptor ledger/mailbox path and replace fortress-specific metrics in one
   explicit contract migration.
6. Run the 1-, 2-, and 10-minute idle/load ladder, then held-PTT and direct
   deployed-worker/Grok proofs.

## Agreed architectural direction

Both reviews independently reached the same high-level conclusion:

- Preserve the two independent WebSockets, bounded SPSC rings, static
  allocation, copy-once lane ownership, task notifications, explicit failure
  taxonomy, and generation-based stale-frame rejection.
- The current scheduling arrangement is a local maximum. Audio pumping cannot
  remain in the priority-1 main loop alongside display, Cap'n Web, logging, and
  button/PMIC work.
- Introduce a dedicated audio owner pinned to core 1 at priority 19. The
  network-facing tasks remain below lwIP priority 18; capture and playback
  hardware work sit above it.
- Keep M5Unified only as a measured intermediate step. The intended StickS3
  audio floor is a direct, same-clock `i2s_std` TX/RX pair with one
  320-sample/20-ms descriptor boundary. That removes its hidden resampler/DMA
  tail, makes PTT direction changes a policy rather than driver teardown, and
  creates the sample-synchronous speaker reference needed for future AEC.
- No queue depth is inherently "low latency." Every queue needs an age/depth
  policy, an observable high-water mark, and an explicit drop/reset action.

The Stick currently uses 32 uplink and 32 downlink slots rather than either
review's suggested eight. This is deliberate: the direct Grok playback proof
already reached downlink high-water 12, the target has 8 MB PSRAM, and the user
asked not to over-constrain memory. Capacity is resilience headroom, not
permission to accumulate latency. A separate maximum-lead/maximum-age policy
will bound playable and sendable audio.

## Correctness findings and dispositions

### F1: one outstanding M5Unified recording request creates capture gaps

M5Unified has a two-request recorder queue. The current one-buffer adapter
waits for completion and a later main-loop pass before rearming it. Under
sustained PTT this can leave no destination for live samples and eventually
drain stale DMA data or drop old samples.

Disposition:

- **Implemented, red then green:** a host regression whose fake recorder proves
  two distinct buffers remain queued while completed frames are submitted in
  order.
- **Implemented:** the adapter is now a two-buffer bounded recorder bridge.
- Keep the wire-side backpressure rule bounded and observable; never solve this
  by accumulating microphone audio without an age limit.
- Prove continuous frame growth during a physical held-button run.

### F2: legal fragmented WebSocket delivery currently kills the PCM lane

`esp_websocket_client` may deliver one 640-byte binary message through multiple
offset-bearing callbacks. Rejecting that transport-legal segmentation as a
terminal protocol failure is incorrect.

Disposition:

- **Implemented, red then green:** all 639 two-chunk split points plus invalid
  offset, oversize, and interrupted-fragment host regressions.
- **Implemented:** transport callbacks reassemble directly into one acquired
  640-byte downlink ring slot without an extra frame allocation and publish
  only on the final exact byte.
- A malformed sequence fails the message/session explicitly, but normal TCP/TLS
  segmentation must not latch the firmware dead.

### F3: `CONFIG_ESP_WS_CLIENT_SEPARATE_TX_LOCK=y` permits unsafe concurrent

mbedTLS access

Both reviews traced the library source and found that separate TX/RX locks can
drive one `mbedtls_ssl_context` concurrently. The observed ten-second physical
failure also aligns with the WebSocket ping path contending for this TX lock.

Disposition:

- Keep the already-added allocation-free uplink sender: a connected lock
  deferral retains the exact frame and retries; four consecutive deferrals
  request a bounded restart.
- Add a configuration regression before disabling the separate TX lock.
- Re-run the long PTT proof across multiple ping intervals.
- Let the tiny-C-WebSocket source review decide whether the durable solution is
  an owned wrapper around Espressif's lower transport or a small vendored PCM
  client. Do not grow compensating policy around undefined library ownership.

### F4: M5Unified hides roughly 90–100 ms of playback below our metrics

Its StickS3 path resamples 16 kHz PCM to 22.05 kHz and defaults to an
approximately 93 ms DMA ring. `isPlaying()` reports mix ownership, not the
audible/DMA boundary.

Disposition:

- Do not label `playRaw` acceptance or mix completion as "audible."
- **Implemented, red then green:** before every `M5.Speaker.begin()`, the
  bounded playback adapter overrides M5Unified's StickS3 `22,050 Hz` preset
  with the PCM lane's native `16,000 Hz`. Its `playRaw()` input and I2S mixer
  rate therefore match, removing sample-rate conversion from the current
  happy path.
- Measure the current proxy boundary honestly, including a modeled DMA tail.
- Shrink the intermediate M5Unified DMA configuration and compare physical
  underruns/latency.
- Direct I2S must expose descriptor-consumed timestamps; an adjacent-computer
  acoustic chirp/correlation rig calibrates the final codec/air delay.

### F5: transport and proxy add avoidable latency and drift

The reviews identified three separate mechanisms:

- `TCP_NODELAY` is absent, so 640-byte uplink messages can become
  RTT/delayed-ACK paced.
- The proxy advances its next deadline relative to the last actual send,
  accumulating timer lateness over a response.
- PTT release can commit before frames still resident in the device or TCP
  path arrive.

Disposition:

- Add a source/config regression for `TCP_NODELAY`, then prove packet/frame
  cadence physically.
- **Implemented, red then green:** downlink pacing uses a monotonic absolute
  20-ms grid. Sub-frame timer lateness is recovered on the following interval;
  a full-frame miss resets one frame ahead rather than bursting queued PCM.
- Introduce an epoch/frame-count close fence over the control lane. The proxy
  commits only after it has relayed the declared final frame, or produces a
  bounded, classified timeout.
- Provider and device queue overflow must follow an explicit stale-audio policy;
  it must not silently grow latency or kill an otherwise healthy session.

### F6: the system has counters but no boundary timestamps

No current signal proves the user-requested time from microphone frame to
provider or server frame to audible playback.

Disposition:

- Track `(socket generation, frame index, epoch)` without changing PCM v1
  bytes.
- Stamp device capture completion, ring publish, send start/return, device
  receive, downlink publish, playback dequeue, and the strongest available DMA
  consumption boundary.
- Stamp proxy receive, provider send return, provider audio receive, and proxy
  emit.
- Use small fixed log2 histograms rather than per-frame logs on-device.
- Align clocks using periodic four-timestamp control-plane exchanges and
  minimum-RTT samples.
- Never claim per-frame "Grok received": xAI has no per-append acknowledgement.
  The honest signals are device-to-proxy/provider-send latency plus per-turn
  commit-to-committed round trips and content/VAD evidence.

### F7: runtime settings and hot-path work are not realtime-shaped

The reviews found 100 Hz tick quantisation, a 160 MHz CPU, core-0 I2S interrupt
allocation, priority-2 unpinned M5Unified tasks, blocking PMIC polling, possible
USB-JTAG log stalls, and flash operations that can suspend both cores.

Disposition:

- The dedicated audio task is event-driven; tick-rate changes are supporting
  configuration, not the deadline mechanism.
- Initialise audio hardware from its pinned owner so DMA interrupts land on
  the intended core.
- Keep display, Cap'n Web, metrics construction, PMIC/button polling, and logs
  out of the audio owner.
- Measure 160 versus 240 MHz and internal/PSRAM allocation before choosing
  production defaults.
- Perform no steady-state flash writes. OTA/NVS work later needs an explicit
  measured stall policy.

## Test and proof gates

Each host-testable defect above starts with a failing regression. The physical
ladder is:

1. Direct Grok downlink with zero drops/failures and fully drained playback.
2. Held PTT with continuously increasing capture/uplink counters through at
   least two WebSocket ping intervals.
3. Injected connected-send deferrals recover without loss; a bounded terminal
   threshold restarts with an explicit discarded-frame count.
4. Fragmented downlink frames reconstruct exactly.
5. Nominal 1, then 2, then 10 minute runs show no post-warmup heap decline,
   monotonic latency growth, unexplained reconnect, drop, underrun, or error.
6. Injected 50/150/500 ms stalls recover according to the declared age/drop
   policy and never leave divergent state.
7. The adjacent-computer rig reports p50/p95/p99 for every claimable boundary,
   plus acoustic playback delay. The other nearby device is powered down during
   acoustic measurements.

Current completed evidence:

- The full native firmware suite passes 20/20 and the Kit TypeScript suite
  passes 88/88 after the two-buffer capture, fragmented receive, native-rate
  playback, and metric-contract changes.
- The M5StickS3 resource profile now classifies its five owned PCM frames
  explicitly: 3,200 bytes of audio storage, 128 bytes of platform control
  metadata, and an 8,040-byte complete portable working set under an 8 KiB
  ceiling.
- The ESP-IDF target build succeeds at 1,137,886 bytes total image size and
  193,503 bytes static DIRAM use, leaving 148,257 bytes reported DIRAM.
- Direct Grok-to-Stick playback: 174 frames accepted, submitted, and completed;
  zero drops/failures; downlink high-water 12.
- Host proxy: 500 microphone frames over ten seconds reached the provider
  before PTT release; release then issued commit/create.
- The first physical ten-second held-PTT run exposed, rather than hid, one
  connected send failure at the periodic-ping boundary. Its regression now
  retains the exact frame across temporary deferrals and restarts only after a
  bounded streak.

## Pending research input

The active Fable Max run `iterate-kit-tiny-c-websocket-research` (`d81d5065`)
is comparing small pure-C WebSocket implementations and Espressif's lower-level
transport by source, including ownership, ping/pong, partial writes,
allocations, TLS separation, flash/RAM cost, licensing, and tests. Its output
must be reconciled here before replacing or substantially extending the current
PCM WebSocket client.
