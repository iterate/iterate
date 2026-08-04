# Audio/AEC adversarial review — 2026-08-03

Status: read-only review of the live, unstaged `c-capabilities` worktree at
HEAD `29be889c9`. Line numbers and live-state observations are a snapshot and
may move as the persistent agent edits the tree.

Reconciliation on 2026-08-04: this artifact is intentionally retained as a
snapshot, not treated as current truth. The following findings are closed in
the newer tree and have focused regression coverage:

- P0.2: M5StickS3 reports cumulative hardware-release receipts; retained
  production evidence closes hundreds of items exactly.
- P0.3: physical interruption tracks the assistant item/content part, computes
  the played duration from hardware-release receipts, sends
  `conversation.item.truncate`, and fences new output until the provider
  acknowledges `conversation.item.truncated`.
- P1.4: a missing automatic server-VAD response now retires the provider after
  a bounded timeout; it does not race Grok with a fallback `response.create`.
- P1.5: normal greetings are interruptible, while manual-PTT sessions remain
  silent until the user completes a turn.
- P1.7: provider overflow now retains a one-bit, credit-ordered retired-EOS
  fence separate from the replacement generation's response state. A public
  WebSocket regression first reproduced replacement audio crossing that
  boundary, then passed with the fix.
- P0.1: schema 11 exports the raw/processed wire-gain multipliers, the assessor
  normalizes both signal modes before applying the unchanged 0.5--2 and 3 dB
  gates, and the production harness requires observed playback resets to equal
  its commanded interruption count exactly. The offline perfect-canceller
  x6/x8 satisfiability test and commanded-versus-surplus reset test pass.
- P1.1 and the primary simplification: exact-TX PCM/reserve/skew/poison/reset
  pairing has been deleted from normal capture. Each synchronous RX descriptor
  contains the real analogue microphone/reference pair plus a playback-owned
  activity bit; missing TX completions and TX overflow no longer block or
  reset valid microphone capture. The concrete no-TX-completion host regression
  and the full native suite passed when this was landed.
- P1.2/P1.3 as an architectural choice, not as an AEC-quality claim: the
  prescribed physical comparison was run. FD_LOW_COST constant output
  self-triggered and performed worse; VOIP linear output exceeded its 16 ms
  deadline and caused capture-loss/recreate storms; playback-switched VOIP
  later self-triggered at its raw/AEC edge. The product target now uses one
  constant VOIP processed output. That removes the split microphone contract,
  but retained evidence still shows damaging near-speech ducking during
  double-talk, so StackChan AEC remains incomplete.
- Oracle hygiene, lifetime timing maxima: HAVPE now summarizes the firmware's
  `maximumPlaybackWriteUs` and `maximumReceiveToRenderMs` high-water marks, not
  the most recent healthy samples. A red-then-green regression preserves an
  intermittent 91 ms write and 417 ms receive-to-render stall after the latest
  values have recovered.
- Oracle hygiene, capture completeness: the apparent unenforced frame-count
  bounds are not a valid gate and are intentionally superseded by exact
  provider-accepted ordinal conservation, PCM-byte conservation, accepted-frame
  monotonic timing, and maximum inter-frame gap. The older count was derived
  from Cap'n Web recorder wall time; a retained production regression proves
  that enforcing it would classify control-RPC latency as missing audio.
- Oracle hygiene, monotonic capture time: the schema-2 recorder used wall time
  for accepted-uplink ordering and disabled itself after a backward clock
  adjustment. Schema 3 now carries epoch and monotonic boundaries together;
  only monotonic time owns capture duration, arrival span, and maximum-gap
  gates. A red-then-green regression retains a backward wall-clock step without
  weakening exact ordinals or realtime cadence.
- Oracle hygiene, independent count transcripts: one public assessment now
  receives the raw Grok output transcript and the independently transcribed Mac
  microphone interval, and requires each to contain the exact requested integer
  range. The regression supplies a complete provider ledger while deleting 37
  from only the microphone transcript; it failed before the composition existed
  and now reports the acoustic boundary as the failure. The later normalized
  transcript comparison is redundant corroboration, not the acceptance oracle.
- Oracle hygiene, count duration and bounded source memory: two direct
  `grok-voice-think-fast-2.0` measurements on 2026-08-04 invalidated the old
  12-second/25-number assumption. Grok rendered 300..400 as 4,920,064 bytes /
  153.752 seconds of 16 kHz PCM in 20.85 wall-clock seconds, and 300..330 as
  1,512,646 bytes / 47.270 seconds. The userspace response limit is now an
  explicit 180-second / 5.76 MB per-call budget, with a public-WebSocket
  regression retaining all 7,688 device frames from the measured long count.
  The interrupted proof waits for 2,250 cumulative hardware-release receipts
  (45 seconds) rather than worker sends, then keeps the unchanged independent
  acoustic requirement of at least 25 exact sequential numbers. Its regression
  proves that 2,250 sends with only 600 hardware releases cannot pass.
- P1.6, device startup livelock: the proposed one-frame-per-100-ms host case
  reproduced a real permanent N-1-slot deadlock. The playback owner now keeps
  bounded stale-scan authorization across hardware edges, retains at most the
  first current frame, and re-applies the unchanged watermark before any sample
  can play. The regression failed before the change at seven occupied slots,
  then passed with all 12 outage frames explicitly discarded, zero underruns,
  and recovery beginning on the first current frame. All 87 native tests pass.
  The source-watermark seam now executes 8/12/32 policies through the public
  provider/device WebSockets and reports the selected value in metrics. This
  closes the testability defect, but the production tuning decision remains
  open: retained timing does not justify changing the 32-frame default by
  inspection.

The worker source-watermark experiment, the profile-3 double-talk defect, and
the long-soak gate remain live. Check every cited path against live source
before changing it.

Reviewers:

- Codex controller: direct code/dataflow review plus current first-party
  ESP-SR, ESP-IDF, Espressif hardware-design, and xAI Voice documentation.
- Claude CLI background agent `944de6ff`, model `fable`, effort `xhigh`, with
  five internal firmware, worker, oracle, BSP/I2S, and documentation passes.

No implementation changes were made by the reviewers. This document is the
handoff requested by Jonas.

## Executive conclusion

Repair, then prune; do not rewrite the audio stack.

The hardware-release credit protocol is coherent on StackChan and HAVPE, the
analog amplifier-divider reference is the right reference source, 16 kHz is the
right end-to-end rate for ESP-SR, and direct AEC is simpler than adopting the
full ESP-SR AFE.

The current tree is nevertheless not valid for release:

1. The StackChan schema-v7 AEC oracle is arithmetically inconsistent with the
   firmware's x6/x8 wire gains and counts commanded barge-in resets as defects.
2. M5StickS3 consumes the new finite credit window but appears not to produce
   hardware-release receipts, so responses longer than about 240 ms stall and
   the worker retires the session.
3. CoreS3 mic publication is coupled to a functioning TX completion stream,
   even though the real AEC reference is the synchronous analog RX channel.
4. The exact-TX reserve/skew/poison/reset subsystem transports little more than
   the fact that playback is active. It should be removed, not debugged further.
5. Physical barge-in purges the speaker but does not truncate unheard assistant
   audio/transcript from Grok's conversation history.
6. The selected VOIP AEC mode and raw/processed switching policy are not the
   first-party-supported target for full-duplex dialogue.

## What the live design does

### Downlink

```text
Grok WebSocket
  -> worker response reservoir: 4,500 x 640-byte frames = 90 s / 2.88 MB
  -> 32-frame / 640 ms source-start watermark
  -> 12-item hardware-release credit window
  -> device lane ring: 32 StackChan / 64 HAVPE slots, but protocol depth <= 12
  -> 8-item / 160 ms firmware start watermark
  -> retained 320-sample wire frame
  -> 128-sample render blocks
  -> 5 x 128-sample I2S TX DMA = 40 ms
  -> amplifier
```

The release-credit accounting was independently traced through grant, consume,
purge, reset, generation fencing, and reconnect. On devices that emit receipts,
credit does not go negative or double-count, and worker lead 12 exceeds device
startup watermark 8.

### CoreS3 uplink

```text
I2S RX DMA: 4-slot TDM
  -> capture reserve: 8 x 8 ms
  -> pair with exact-TX reserve: 8 x 8 ms, <= 4 ms completion skew
  -> deinterleave near mic + analog speaker-divider reference
  -> 100 Hz high-pass + x8 reference scale
  -> 256-sample / 16 ms VOIP AEC
  -> raw-near x6 OR processed x8 selector, with 128 ms playback hangover
  -> 320-sample / 20 ms wire frame
  -> uplink lane and WebSocket
  -> worker sends immediately to Grok; no worker uplink queue
```

The important distinction is that exact TX PCM never enters the canceller. AEC
uses the analog divider captured in the same RX DMA descriptor as the near mic.
Exact TX is used only to identify playback-active windows and for diagnostics.

## P0 — proven blockers

### P0.1 The StackChan AEC oracle cannot pass the current firmware

`core_s3_audio_owner.c` publishes raw near speech at x6 outside playback and
processed speech at x8 during playback before measuring the exported `clean`
signal. `stackchan-aec-assessment.ts` still requires near-end clean/input energy
ratio 0.5 through 2.0 and computes echo suppression between pre-gain near and
post-gain clean.

Retained evidence proves the contradiction:

```text
Near-end clean/input energy ratio was 6.029; expected 0.5 through 2.
Playback reset 2 times during the run.
```

The ratio is the intended x6 raw branch, not bad AEC. The resets were commanded
by the harness's own barge-in sequence, not unexplained firmware resets.

Relevant locations:

- `apps/kit/firmware/platforms/iterate_core_s3_audio/core_s3_audio_owner.c:646`
- `apps/kit/src/device/stackchan-aec-assessment.ts:116`
- `apps/kit/src/device/stackchan-aec-assessment.ts:153`
- `apps/kit/src/device/stackchan-aec-assessment.ts:247`
- `apps/kit/evidence/stackchan-production-grok-post-watermark-20260803/2026-08-03T19-22-46-399Z/failure.json`

Recommended repair:

1. Publish the applied raw/processed gains in schema-v7 metrics and normalize in
   the assessor, retaining the honest wire tap; or add a separate pre-gain DSP
   tap. The former is smaller.
2. Require `observed playback resets == harness-requested resets`, while still
   failing any unexplained surplus.
3. Reuse the gain-immune construction already present in
   `voice-pe-aec-assessment.ts`.
4. Add an offline satisfiability test containing a mathematically perfect AEC
   behind the production x6/x8 gains. It must pass before another physical run.

Do not widen the 0.5–2 or 3 dB thresholds. They currently measure incompatible
quantities.

### P0.2 M5StickS3 does not appear to return release credit

`pcm-proxy.ts` admits twelve downlink items and then waits for device release
receipts, retiring the session after 1.5 seconds without progress. The old
ingress receipt was removed. StackChan and HAVPE wire the new
`note_downlink_item_released` ledger. M5StickS3's `RealtimePlayback` frees lane
slots directly and drops its `discardedItems` count without updating the
conductor ledger.

Result: a response longer than approximately twelve 20 ms items exhausts credit
and ends with `downlink-device-receipt-timeout`.

Relevant locations:

- `apps/kit/src/userspace/config-worker/pcm-proxy.ts:2011`
- `apps/kit/src/userspace/config-worker/pcm-proxy.ts:2052`
- `apps/kit/firmware/platforms/common/include/iterate/kit/platforms/realtime_playback.hpp:354`
- `apps/kit/firmware/targets/m5sticks3/main/main.cpp`

Recommended repair: wire M5StickS3 into the same hardware-release ledger and
treat firmware plus worker as a flash-together deployment. Add a unit test that
queues more than twelve items without receipts and pins the current timeout
trace. Do not restore ingress-based acknowledgements as a silent compatibility
path.

### P0.3 Grok history is not truncated to what the user heard

On `input_audio_buffer.speech_started`, `pcm-proxy.ts` discards the worker tail,
abandons the provider response, requests a physical playback reset, and fences
fresh output until the device acknowledges. It does not track the assistant
output item/content index and does not send `conversation.item.truncate` with
the duration actually rendered by hardware.

The current xAI Voice reference says VAD-mode response cancellation is
automatic, but separately defines `conversation.item.truncate` to remove audio
and transcript after the played duration. Cancellation prevents more bytes;
truncation corrects conversation history. Without truncation, unheard assistant
content can condition the next Grok turn.

Relevant locations:

- `apps/kit/src/userspace/config-worker/pcm-proxy.ts:1149`
- `apps/kit/src/userspace/config-worker/pcm-proxy.ts:1453`
- xAI Voice API reference:
  <https://docs.x.ai/developers/rest-api-reference/inference/voice>

Recommended repair:

1. Capture assistant item ID/content index from response output events.
2. Derive played duration from cumulative hardware-release/render accounting,
   not provider bytes received or worker bytes sent.
3. On barge-in, send `conversation.item.truncate`, require/observe
   `conversation.item.truncated`, then preserve the existing physical reset and
   generation fence.
4. Add a semantic replay test proving the next answer is conditioned only on
   assistant speech that physically played.

## P1 — high-risk implementation choices

### P1.1 CoreS3 mic capture depends on live TX completions

The AEC task retains a capture chunk and stops draining when the TX-reference
reserve is empty. After three speaker write failures, `speaker_io_enabled`
becomes false while microphone reads continue. No more TX completion callbacks
arrive, so capture backs up, poisons epochs, resets AEC repeatedly, and publishes
no uplink despite a working microphone.

Relevant locations:

- `apps/kit/firmware/platforms/iterate_core_s3_audio/core_s3_audio_owner.c:956`
- `apps/kit/firmware/platforms/iterate_core_s3_audio/core_s3_audio_owner.c:997`
- `apps/kit/firmware/platforms/iterate_core_s3_audio/core_s3_audio_owner.c:1207`

The immediate safe fallback is to keep publishing raw mic when TX activity is
unavailable. The preferred architectural repair is to remove the TX-pairing
dependency entirely, as described below.

### P1.2 AEC mode is not the documented full-duplex target

The code uses `AEC_MODE_VOIP_HIGH_PERF`, while current Espressif documentation:

- classifies FD modes as the modes for full-duplex dialogue;
- classifies VOIP as ordinary calls;
- generally recommends `AEC_MODE_FD_LOW_COST`;
- says `nlp_level` is effective only in FD mode;
- warns aggressive NLP can damage near-end speech;
- reports 16 ms frames and high CPU/RAM for VOIP_HIGH_PERF versus 32 ms frames
  for FD modes.

The code comment's integrated-DTD and knob-inertness claims depend on binary
inspection of ESP-SR 2.4.7 rather than a first-party API contract, and the
component version is not pinned to that binary assumption.

Relevant location:

- `apps/kit/firmware/platforms/iterate_core_s3_audio/core_s3_audio_owner.c:554`
- Espressif AEC docs:
  <https://docs.espressif.com/projects/esp-sr/en/latest/esp32s3/acoustic_echo_cancellation/README.html>

Recommended experiment: pin the current ESP-SR version, then compare current
VOIP plus selector against `AEC_MODE_FD_LOW_COST` plus `AEC_NLP_LEVEL_NORMAL`
and one constant output/gain. FD requires changing the bridge's asserted AEC
frame from 256/16 ms to 512/32 ms; do not change only the enum.

Required physical matrix:

- near-only speech, including quiet speech;
- far-only playback at representative and maximum volume;
- true double-talk and barge-in;
- enclosure-tail transition after playback;
- long multi-turn soak;
- no provider tools or workaround prompt during audio qualification.

Acceptance should cover near preservation, residual echo, stable gain/timbre,
zero speaker-only VAD edges, positive near-speech VAD edges, DSP time, gaps,
allocations, and complete transport conservation.

### P1.3 Raw/processed switching creates two microphone contracts

Retained evidence says VOIP output suppressed 92–99% of near-only speech even
with zero reference, so firmware bypasses AEC outside playback. That workaround
switches between raw x6 and processed x8 at playback edges plus a 128 ms
hangover. It can create gain, noise-floor, phase, and timbre discontinuities
immediately upstream of xAI VAD set to its minimum threshold of 0.1.

This selector is defensible as a temporary diagnostic workaround, but it should
not become the permanent interface contract without proving that a supported FD
mode cannot provide one stable output. If constant FD output passes, delete the
selector, its exact-TX activity input, the branch gains, and the hangover.

### P1.4 Server-VAD recovery can race automatic response creation

After a grace timeout, `pcm-proxy.ts` sends an explicit `response.create`. The
current xAI reference says response creation is automatic under server VAD. A
late automatic response can race the explicit fallback and produce duplicate
assistant turns.

Relevant location:

- `apps/kit/src/userspace/config-worker/pcm-proxy.ts:1260`

Recommended repair: when the documented automatic contract times out, retire
and replace that provider generation with a durable diagnostic. Do not request
a second response for the same committed turn.

### P1.5 Initial greeting deliberately drops caller audio

The greeting uses xAI `force_message` with `interruptible: false`. xAI documents
that this drops caller audio until playback finishes. That is suitable for a
compliance disclosure or IVR prompt, not a normal full-duplex greeting. The code
currently uses it to hide residual echo before AEC settles, which turns an audio
defect into intentional user-input loss.

Relevant location:

- `apps/kit/src/userspace/config-worker/pcm-proxy.ts:2056`
- xAI Speech-to-Speech docs:
  <https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech>

Recommended repair: omit `interruptible` or set it true for normal greetings.
Reserve false for explicit non-interruptible product modes. Make the AEC/VAD
qualification succeed during the greeting rather than suppressing input.

### P1.6 Startup watermark and stale-age policy can add latency or livelock

Reconciliation on 2026-08-04: the firmware livelock described below was
reproduced red and fixed without weakening either freshness or startup depth.
The worker source-watermark latency experiment remains open; see the dated
reconciliation above and the StackChan landing log for the retained timing
evidence.

The worker waits for 32 provider frames / 640 ms before sending anything, then
sends a 12-frame lead to firmware, which itself waits for 8 frames / 160 ms.
xAI recommends streaming output deltas immediately. The 32-frame source gate
therefore adds up to 640 ms before the device can begin its own already-bounded
startup policy.

Separately, firmware's 8-item startup gate and 400 ms stale-age limit can cycle
fill -> discard -> refill under trickling delivery and never start.

Relevant locations:

- `apps/kit/src/userspace/config-worker/pcm-proxy.ts:33`
- `apps/kit/src/userspace/config-worker/pcm-proxy.ts:1881`
- `apps/kit/firmware/src/pcm_clock_playback.c`

Recommended experiments:

- Compare source start at 8, 12, and 32 frames for first-audio latency,
  underruns, stale discards, and reset behavior. Start with 12 or 8.
- Host-test one item every 100 ms with watermark 8 and 400 ms maximum age; the
  stream must either start within a bound or fail explicitly, never cycle.
- Prefer a bounded oldest-item fallback to exempting arbitrarily stale startup
  frames.

### P1.7 Provider swap can leak response-complete state

Claude's worker pass traced a path where downlink overflow retires a provider,
sets `#downlinkResponseDone = true`, cannot flush EOS because credit is full,
and `attachProvider` does not reset the flag. The replacement provider can then
bypass the 32-frame watermark and inherit a phantom EOS.

Relevant locations:

- `apps/kit/src/userspace/config-worker/pcm-proxy.ts:636`
- `apps/kit/src/userspace/config-worker/pcm-proxy.ts:1836`

Reset response-local done/started state when attaching a provider and add a
replacement-provider regression test.

### P1.8 Coupled constants need one long soak

The following values form one coupled control system and have not been proven
together across many turns:

- worker lead: 12 items / 240 ms;
- receipt no-progress timeout: 1.5 s;
- device start watermark: 8 items / 160 ms;
- device stale age: 400 ms;
- StackChan lane: 32 frames;
- HAVPE lane: 64 frames.

Run a long multi-turn physical soak per device family after the deterministic
host tests. If the watchdog is too aggressive, derive its value from the former
bounded device-ring budget rather than adding retries or raising every buffer.

## Primary architectural simplification

### Delete exact-TX audio pairing from the normal AEC path

The analog divider is sampled in the same RX DMA descriptor as the near mic and
matches Espressif's recommended post-amplifier reference design. Exact TX audio
is not an AEC input. The current TX reserve therefore spends roughly hundreds
of lines plus ISR copies and exceptional AEC allocation cycles to supply
playback-active selection and diagnostic alignment.

Staged change:

1. Preserve the RX capture reserve temporarily.
2. Remove TX PCM from `aec_capture_bridge_push_aligned` and stop resetting AEC
   on TX reserve overflow, poison, empty, or completion skew.
3. If the selector remains during A/B, publish one atomic
   `far_active_through_us` watermark from the playback owner. Include known DMA
   depth; the existing 128 ms acoustic hangover already dominates small timing
   error.
4. Keep exact TX PCM only in an explicitly enabled diagnostic recorder if a
   proof needs it.
5. If constant FD AEC output passes the physical matrix, delete the selector and
   watermark too.

This removes the speaker-failure -> mic-starvation path, TX-driven AEC
destroy/recreate, one ISR audio copy, a reserve, skew/epoch state, metrics, and
their tests without weakening the real AEC reference.

### Split CoreS3 RX and TX ownership

The current priority task performs blocking speaker write and then blocking mic
read. ESP-IDF exposes separate RX and TX channels and documents that read/write
block independently. HAVPE already uses separate same-core playback and capture
tasks.

After removing TX pairing:

- TX task: render -> blocking codec write -> release receipt/metrics.
- RX task: blocking codec read -> push one static capture item to DSP task.
- DSP task: deinterleave near/reference -> HPF -> AEC -> 20 ms egress.

This lets capture survive speaker stalls and may allow moving RX reserve push
out of the ISR. Keep ISR callbacks minimal and allocation-free.

ESP-IDF I2S reference:
<https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-reference/peripherals/i2s.html>

## Buffer reductions after invariants are green

1. Reduce worker source-start watermark from 32 to 8–12 frames if the A/B shows
   no underrun regression.
2. Derive the 4,500-frame / 90-second reservoir from a declared maximum response
   duration and concurrency memory budget. A fixed ring is acceptable; the
   unexplained 90-second size is not.
3. Because hardware-release credit caps outstanding downlink at twelve items,
   use a 16-slot downlink lane after reset/EOS/control invariant tests. HAVPE's
   64-slot downlink ring can no longer absorb 64 outstanding frames under this
   protocol.
4. Keep the uplink zero-queue behavior and cumulative hardware receipts.
5. Keep 16 kHz PCM end-to-end. ESP-SR direct AEC supports 16 kHz and xAI
   explicitly supports 16 kHz; changing to generic-recommended 24 kHz would add
   resampling without fixing AEC.

## Other deletable or stale layers

- `deviceDownlinkDepthCorrectionFrames/Corrections` appear never incremented.
- The worker comment about pausing at most three frame periods describes the
  deleted JavaScript pacing timer.
- Four `downlinkPacing*` metrics and `downlink-pacing-overrun` appear unreachable
  after release-credit pacing.
- `GrokServerVadProfile` should either remain genuinely per-device or collapse;
  do not retain an inert abstraction.
- Deterministic PCM provider implementations have diverged; consolidate them so
  the `beforeResponseDone` fix cannot exist in only one copy.
- Drop `changeSpriteSet` from M5StickS3 tool exposure until firmware implements
  the advertised capability.

## Oracle hygiene found by the Claude pass

- Timing gates read `last*` values rather than exported `maximum*` values.
- Capture-completeness bounds are computed but not enforced.
- A count-mode transcript gate compares the expected ledger to itself.
- Stimulus volume changed from 85 to 40 while retaining margins calibrated at 85.
- `PcmDiagnosticCapture.observe` treats a backwards `Date.now()` adjustment as
  repeated observer failure; use monotonic time for intervals.
- Double-talk leak correlation steps on a 16-sample grid and can miss sub-chip
  lags without an energy backstop.
- The count-mode request for roughly 25 numbers in a 12-second delivered-frame
  window may be physically impossible at normal speech rate; measure provider
  rate first and end the assessment window at the observed barge-in boundary.

None of these should be repaired by weakening thresholds. Correct the measured
quantity, time base, window, or oracle invariant.

## Things that should remain

- The analog speaker-divider reference. Espressif recommends recovering the
  reference near the speaker side, including a low-pass path from Class-D output.
- The measured CoreS3 channel mapping: acoustic microphones plus MIC3 divider.
- Static, 16-byte-aligned DSP buffers and `aec_get_chunksize` validation.
- Direct ESP-SR AEC. The full AFE adds NS/VAD/WakeNet, feed/fetch tasks, and
  significant memory for functions the provider already owns.
- 16 kHz PCM and 20 ms wire frames.
- Hardware-release credit and bulk credit return on purge, after every device
  family emits receipts.
- Immediate uplink forwarding with bounded device-side loss classification.
- Generation fences around physical reset and fresh provider audio.
- The pinned xAI model identifier for production stability.

## Recommended execution order

1. Fix oracle arithmetic, gain semantics, and commanded-reset accounting.
2. Add the offline perfect-canceller satisfiability test.
3. Wire and test M5StickS3 release receipts; coordinate firmware/worker rollout.
4. Add Grok item tracking and hardware-duration `conversation.item.truncate`.
5. Replace server-VAD `response.create` fallback with bounded provider retirement.
6. Make the ordinary greeting interruptible.
7. Decouple capture from TX health and collapse exact-TX reserve/pairing to an
   atomic playback watermark.
8. Pin ESP-SR, implement the FD frame shape, and run VOIP-selector versus
   FD-normal-constant-output A/B tests.
9. Split CoreS3 RX and TX tasks if the retained ISR reserve is no longer needed.
10. Reduce the 640 ms worker start watermark and oversized rings only after
    deterministic tests and a long physical soak.
11. Remove dead metrics, stale comments, duplicated providers, and inert policy
    axes.

## First-party references

- ESP-SR direct AEC modes, frames, alignment, NLP, and resource table:
  <https://docs.espressif.com/projects/esp-sr/en/latest/esp32s3/acoustic_echo_cancellation/README.html>
- ESP-SR AFE format and feed/fetch model:
  <https://docs.espressif.com/projects/esp-sr/en/latest/esp32/audio_front_end/README.html>
- Espressif microphone and echo-reference hardware design:
  <https://docs.espressif.com/projects/esp-sr/en/latest/esp32s3/audio_front_end/Espressif_Microphone_Design_Guidelines.html>
- ESP-IDF ESP32-S3 I2S driver:
  <https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-reference/peripherals/i2s.html>
- xAI Speech-to-Speech formats, VAD, force messages, latency, and prompting:
  <https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech>
- xAI Voice event reference, automatic VAD response/cancel, and truncation:
  <https://docs.x.ai/developers/rest-api-reference/inference/voice>

## Note on one Claude documentation conclusion

The Claude pass used an older/alternate xAI voice-agent page and reported that
automatic VAD cancellation was undocumented. The current first-party Voice API
reference explicitly says VAD interruptions are automatic. This handoff uses
the current reference: do not add a redundant `response.cancel` in server-VAD
mode. The missing operation is `conversation.item.truncate` to the duration the
hardware actually played.
