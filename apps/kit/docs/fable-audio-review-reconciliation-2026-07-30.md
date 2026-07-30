# Fable realtime-audio review reconciliation

Status: active implementation ledger, 2026-07-30.

This document preserves the actionable feedback from the two completed Fable
Max research runs:

- `iterate-kit-esp32-realtime-audio-research` (`ef94715f`)
- `iterate-kit-audio-latency-design-space` (`b510e6d4`)

It is intentionally separate from the raw transcript in
[`physical-device-voice-goal.md`](./physical-device-voice-goal.md). A finding
leaves this ledger only when a regression test and the relevant host, firmware,
or physical proof make the claimed boundary observable.

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
