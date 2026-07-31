# Reconciliation of the Fable acoustic-oracle and endurance review

Status: reviewed against source, tests, and the subsequent physical
M5StickS3 runs on 2026-07-31. This is a decision ledger, not an assertion that
playback endurance is complete.

The independent report is
[`fable-acoustic-oracle-and-endurance-review-2026-07-30.md`](./fable-acoustic-oracle-and-endurance-review-2026-07-30.md).
It was produced by Claude Fable Max CLI job `746b7639` from the durable prompt
in
[`fable-acoustic-oracle-and-endurance-review-prompt-2026-07-30.md`](./fable-acoustic-oracle-and-endurance-review-prompt-2026-07-30.md).
The reviewer inspected the retained raw recordings, the current StackChan
source, the Kit playback path, M5Unified, and the relevant ESP-IDF I2S and
WebSocket source. The report was not accepted wholesale: every disposition
below states what was checked and what remains an experiment.

## Decisions

### Accepted and implemented

1. **Anchor acoustic analysis to a causal host marker.**

   The review proved that CoreAudio/SoX can begin a new file with a coherent
   approximately 10–12 ms fragment from the preceding recording. Some
   fragments are essentially full playback level, so an amplitude-only filter
   cannot distinguish them from this run's speaker output.

   `analysisStartMs` is now part of the analyzer contract and the physical
   runner supplies it from the capture sample count recorded immediately
   before the provider request. Only windows wholly inside the selected
   interval can establish the playback episode. The analyzer also reports
   `excludedCoherentWindowCount`, so excluding recorder pre-roll is visible
   evidence rather than silent cleanup.

   This was red-first:
   - a full-level file-start fragment initially produced
     `observedStartMs = 0` instead of the real 500 ms onset;
   - the anchored implementation made that fixture green;
   - a real 300 ms mid-stream outage remains a hard gap;
   - a coherent fragment after the start marker remains visible and cannot be
     removed by the boundary.

   The focused analyzer suite passes 14/14 and the related four-file
   endurance/parser suite passes 131/131.

2. **Treat the Mac microphone as an independent but fallible instrument.**

   The physical verdict now distinguishes:
   - device counters;
   - host WebSocket timing;
   - capture-process sample-time integrity;
   - acoustic continuity inside the causal interval;
   - coherent content excluded outside that interval.

   A clean digital ledger is therefore necessary but cannot manufacture a
   clean acoustic verdict. Conversely, stale recorder pre-roll cannot
   manufacture a device gap.

3. **Keep the direct-I2S hardware-reserve policy, but describe it correctly.**

   Source and tests support the review's conclusion that the completed
   descriptor credits/debt/deadline mechanism is a bounded way to respect
   ESP-IDF's private completed-descriptor queue. It owns no second PCM payload
   queue and its conservation counters are valuable.

   It is not a replenished jitter reservoir. A real-time-paced sender can
   consume its startup phase lead and leave frames arriving just in time.
   Descriptor count must therefore not be increased to disguise a pacing or
   transport problem.

4. **Use non-periodic challenge audio for the longer ladder.**

   The existing tone remains useful for an immediately audible continuity
   discriminator. PRBS/dual-carrier audio is the stronger 2- and 10-minute
   oracle for whole-frame skip, duplication, replay, and sample-clock drift.
   It will be promoted only after its episode boundary uses the same causal
   marker contract.

5. **Borrow StackChan's instruments, not its buffering policy.**

   The useful prior art is the sample-synchronous analogue speaker-reference
   input, sequence-numbered DMA taps, post-playout viseme tap, seqlock pose
   handoff, pure renderer boundary, integer leveler, and evidence tooling.
   The seconds-long StreamBuffers, newest-frame tail drop, zero-fill latency
   ratchet, blocking display/status locks, and silent microphone loss are
   explicitly excluded from Kit.

### Accepted with a stricter interpretation

1. **Two evidence lanes are useful, but recovery is not continuity.**

   The direct-LAN strict lane still requires zero acoustic gaps and zero
   underrun/recovery/reset/loss counters. A separate adversity lane may prove
   that every classified recovery incident has exactly one matching acoustic
   consequence and that current conversation resumes without backlog. Passing
   that adversity contract must never be reported as “gapless” or used to
   waive the strict one-minute, two-minute, and ten-minute ladder.

2. **A device-clocked sender is a comparison, not yet an accepted product
   design.**

   The simplest current comparison removes the host 20 ms timer and forwards
   each provider frame immediately through the already bounded socket path.
   This eliminates one scheduler and one timing authority without adding a
   queue. The device's finite PCM/DMA admission becomes the clock.

   The first verbose physical comparison sent all 1,000 source frames plus EOS
   with host `bufferedAmount = 0` and a 34.627 ms maximum host interarrival.
   The microphone observed 18,277.5 ms of continuous 997 Hz output with zero
   internal gaps and zero phase discontinuities before abrupt truncation. The
   device accepted only 909 frames before its capability connection closed and
   remounted. Thus the comparison improves the signal before failure, but it
   does not yet prove a complete response or identify the close cause.

3. **Create-once audio substrate remains a high-value A/B simplification.**

   Leaving I2S/codec state alive across response generations could remove
   boundary work, PA toggles, and brownout inrush. It is not being substituted
   on inference alone: the current known-working path remains the baseline
   until a red test and matched physical A/B establish whether create-once
   reduces discontinuities, memory, CPU, or failure surface.

### Deferred pending a falsifiable contract

1. **Automatic `analysisEndMs = playback-completed marker + 250 ms`.**

   The current capture markers are quantized lower bounds on file progress,
   and 250 ms has not been derived from a maximum codec, room-decay, and
   recorder-flush bound. A guessed upper boundary could hide a real terminal
   restart or repeated tail. `analysisEndMs` exists as an explicit analyzer
   option, but the runner does not invent the margin. It will be wired only
   after a synthetic anti-masking test and a measured bound.

2. **Masked-versus-absent acoustic classification.**

   Separating broadband environmental masking from amplitude collapse is
   plausible and useful, but a “masked” budget could also excuse audible
   corruption. It needs synthetic truth cases and an explicit acceptance
   meaning before changing the strict gate. Current gaps remain conservative.

3. **All four proposed extra playback timestamps/counters.**

   Outage duration, first-sample timestamp, substituted-slot sequence, and an
   EOF watchdog could help later fault localization. They are not all
   prerequisites for the current failure, and each consumes code, wire, and
   stack on a target whose instrumentation must stay cheaper than audio. Add
   only the fields that distinguish a live hypothesis, with a red host test
   and maximum-width wire-size proof.

4. **A numerical product recovery budget.**

   “At most one incident per minute” and “0.2% silence” are proposals, not
   product requirements supplied by the user or established by conversation
   quality evidence. The adversity lane will retain raw counts and exact
   acoustic matching first. A release budget can be chosen later without
   weakening the strict lane.

### Rejected

1. **Longer PCM queues or TCP windows as the cure.**

   They make the symptom less immediate by retaining older speech. They do not
   restore the realtime invariant and can make an apparent recovery resume
   stale conversation.

2. **Selecting the longest/loudest waveform episode.**

   That would make a true mid-stream outage disappear whenever playback
   resumed into a second strong episode. Causal markers select the allowed
   interval; every sample inside remains accountable.

3. **Blindly attributing the latest truncation to WebSocket keepalive
   opcodes.**

   Espressif does publish PING/PONG/CLOSE through `WEBSOCKET_EVENT_DATA`
   before its internal control-frame switch, so this was a reasonable
   source-backed hypothesis. Inspection then found that Kit's
   `iterate_kit_websocket_text_ingress_feed()` already validates and ignores
   all three control opcodes without mutating its text-message cursors. An
   ESP-IDF-shaped host regression now injects both PING and PONG into a mounted
   Cap'n Web session and passes without a generation change or failure. No
   production workaround was added. The unexplained close remains open.

## Physical evidence after the report

Marker-anchored re-analysis changes the interpretation of three retained
schema-4/device-clocked captures:

- `direct-lan-tone-20s-device-ingress-schema4-20260731-0000`: the apparent
  635 ms gap was excluded stale pre-roll. Inside the causal interval there is
  exactly one 20 ms gap matching the single device recovery incident; the run
  was truncated by the strict gate.
- `direct-lan-tone-20s-device-clocked-20260731-0015`: one 20 ms gap and one
  phase discontinuity before truncation.
- `direct-lan-tone-20s-device-clocked-verbose-20260731-0019`: 18,277.5 ms
  observed span, zero internal gaps, zero phase discontinuities, then
  approximately 1,722.5 ms missing because the response was truncated.

The last run is especially diagnostic:

- the host provider emitted all 1,000 frames and EOS, 640,000 bytes total;
- the device accepted 909 frames and had no application backlog
  (`downlink high-water = 1`, playback high-water = 4);
- device maximum complete-frame interarrival was 70 ms and maximum
  receive-to-DMA-start was 84 ms;
- the old `/api` socket ended abnormally with bridge close code 1006 at
  38.063 seconds and the capability/PCM sessions remounted;
- the old PCM bridge had already accepted all host sends, so host acceptance
  does not prove device receipt;
- minimum internal/DMA heap remained 128,711 bytes, CPU was approximately
  285–294 permille, and no playback loss/reset/driver counter fired before the
  terminal event.

Terminal control/PCM generation telemetry was then exposed through the
existing metrics capability, without adding a USB diagnostics transport or a
PCM queue. A subsequent complete direct-LAN run,
`direct-lan-tone-20s-device-clocked-after-serial-control-20260731-0122`,
accepted/submitted/completed all 1,000 frames with zero loss, recovery, reset,
or driver counters. The anchored Mac recording observed 19,952.5 ms with zero
gaps and zero phase discontinuities. This proves that the earlier abnormal
control close was not an unavoidable property of a 20-second response.

The first one-minute attempt then exposed a separate host-accounting defect:
Node reported 5,152 raw buffered bytes while eight 640-byte payloads and eight
send callbacks were outstanding. The bridge had reached its real 5,120-byte /
160 ms media budget; the extra 32 bytes were framing, not extra PCM. The
replacement ledger now charges exact payload bytes until each send callback
resolves, and a red-first regression proves that eight frames fit and the
ninth is rejected.

The next one-minute attempt passed that corrected host ledger but produced one
real device underrun after about 2.5 seconds. At teardown the host had zero
payload outstanding; its maximum was only 1,920 bytes / three frames, callback
latency was below 1 ms, and maximum interarrival was 33.681 ms. A verbose
follow-up ten-second run then completed all 500 frames with a zero-loss
digital ledger and a zero-gap/zero-phase-discontinuity Mac recording. In that
clean run the descriptor safety margin nevertheless fell to 28.798 ms, while
maximum device receive-to-DMA-start age reached 83 ms. This mixed result is
consistent with a one-time startup phase lead that ordinary stochastic ingress
jitter can consume; it is not evidence for a hidden host socket backlog.

The explicit seven-frame startup-watermark A/B was subsequently implemented
without changing the eight-frame / 160 ms maximum. Its host contract was
red-first: six frames emit nothing, the seventh releases exactly seven in
order, and later frames are forwarded immediately. The CLI rejects this knob
unless device-clocked delivery is also explicit.

The first physical minute reached a separate 160 ms host no-progress event at
24.864 seconds and correctly closed with eight exact payloads outstanding
instead of accumulating more latency. The immediate repeat completed all 3,000
frames and EOS with zero device counters and a zero-gap,
zero-phase-discontinuity 59,955 ms Mac recording. The device downlink
high-water rose from the prior zero/one steady-state behavior to five frames,
while exact host payload ownership peaked at seven frames only for the intended
startup burst and was zero at close.

The judgment is therefore deliberately asymmetric: the experiment proves that
a small explicit lead can survive a clean physical minute and provides a
measured `prebufferFrames` candidate for the simpler writer. It does not prove
that proxy-side seven is a universally reliable final default, nor does it
excuse the separately observed 160 ms transport stall.

A requested two-minute repeat failed at 26.664 seconds with the latter
signature: eight exact 640-byte payloads and eight send callbacks remained
outstanding, oldest callback age was 159.296 ms, and the bridge closed code
4013 at the unchanged freshness budget. A mistakenly named verbose-metrics
environment variable means the run has terminal rather than per-second device
samples; that evidence limitation is explicit in the artifact. Two such
failures versus one clean minute make the next priority a minimally
instrumented ESP-IDF/lwIP receive-progress discriminator. They do not justify
more audio buffering.

A correctly instrumented subsequent minute passed 3,000/3,000 with zero
incident counters and clean Mac acoustics. It still recorded 90 ms maximum
device complete-frame interarrival against only 36.260 ms maximum host
interarrival. The existing startup reserve absorbed that event, but the
unchanged PCM-network maximum-work metric could not classify it. This supports
adding counters/timestamps that separate task scheduling, raw socket progress,
and complete-message progress; it does not support more queue capacity.

## Reconciliation with the broader architecture review

The acoustic report correctly judges the existing descriptor-credit/debt
policy as bounded and internally conserved. That judgment applies to the
policy in isolation. The earlier architecture report independently inspected
the surrounding owner/mailbox/channel-lifecycle construction and found that
the implementation is approaching a local maximum: a large amount of code is
reimplementing scheduling and ownership behavior already available in the
ESP-IDF blocking I2S channel contract.

These findings are compatible:

- **keep** the current path as a measured physical baseline and recovery
  oracle;
- **do not** increase descriptor count or add another content queue;
- **do not** deepen the owner/mailbox machinery merely to make stochastic
  runs green;
- **test** one named, freshness-bounded startup watermark as a narrow physical
  discriminator, with the existing 160 ms maximum still hard;
- **build red-first** a create-once I2S A/B seam whose dedicated writer blocks
  on the driver and whose only PCM queue is the existing bounded lane;
- **retain** the current path until the simpler variant proves equal or better
  continuity, interruption freshness, memory, CPU, stack, and build size.

The architecture report's ISR-pull option remains deferred. It would make
interrupt safety, PCM availability, and per-sample rendering more complex
before the simpler task/driver design has failed a measured deadline. Likewise,
full-duplex create-once RX/TX is the eventual substrate for StackChan/AEC, but
the immediate Stick playback A/B should not claim to have solved capture.

## Checkpoint and next proof sequence

The complete pre-reconciliation worktree checkpoint is preserved at:

- remote ref:
  `origin/backup/c-capabilities-full-checkpoint-20260730T2345Z`;
- verified commit:
  `a0c54771d7b92991387eef7644234c57e0529440`.

Next:

1. make a failed playback policy retain the complete failing device snapshot;
2. add a red-first, explicitly named device-clocked startup-watermark option
   without changing the host-paced provider contract or the 160 ms maximum;
3. run the current and experimental watermarks as matched direct-LAN physical
   discriminators, resolving only M5StickS3 `70:04:1D:D5:45:88`;
4. if the named reserve eliminates the stochastic underrun, record its
   latency/memory cost and use the result to set the create-once writer's
   `prebufferFrames` contract rather than treating the proxy experiment as the
   final hardware architecture;
5. advance to one minute, then marker-corrected PRBS at two and ten minutes
   under bounded lower-priority load;
6. build the create-once dedicated-writer A/B behind red host contracts and
   compare it against the retained baseline;
7. only after playback is stable begin the equivalent continuous
   microphone/PTT freshness ladder.
