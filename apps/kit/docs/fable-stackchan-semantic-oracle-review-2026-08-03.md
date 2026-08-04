# Fable Max review: simplest StackChan semantic AEC oracle — 2026-08-03

Independent read-only review at `c-capabilities`. Sources: first-hand reads of the
userspace worker (`worker.ts`, `pcm-proxy.ts`, `providers.ts`, `server-vad-policy.ts`,
`provider-event-stream.ts`, `pcm-diagnostic-capture.ts`), both prove scripts and every
assessment module they import, the CoreS3 firmware audio owner and its capture/playback
reference reserves, the latest physical run
`apps/kit/evidence/stackchan-exact-tx-reference-reset-fix-20260803/2026-08-03T15-21-34-016Z/`
plus ten sibling runs from 2026-08-02/03, the accepted-uplink VAD replay ledger, and the
prior-art `iterate/stackchan` experiment 02 tooling and retained runs. No code was edited,
no device was touched; only this file was created.

## Executive verdict (five sentences)

The semantic invariant is **measured-red today, not merely unproven**: three live-Grok
runs on 2026-08-03 at ×8 — `hardware-clock-grok` 14:48, `vad-015-playback` 14:58, and
`voip-exact-reference-grok` 15:26 (the last on the current VOIP + exact-TX-reference +
reset-fix firmware) — each retained one **false `speech_started` while the device speaker
was still rendering** (161 ms, 3 ms, and at-`response.done` edges; no meaningful
transcript), and the harness's exactly-one-edge gate caught all three, so what is missing
is _attribution and margin_, not detection. The least-new-code proof already exists:
`prove-production-stackchan-grok.ts` proves near-speech VAD firing, exact input
transcripts, and double-talk barge-in today, and needs only a ~25-line **attributed
far-end-only window** (all building blocks are already in the file) plus the
already-calibrated accepted-uplink **replay probe** (near ×4 no-edge / ×8 edge + exact
transcript / old speaker-only PCM ×4 → three false turns "Yeah/Stop/Hi"). The waveform
proof is semantically empty by construction (its deterministic fixture provider has no
VAD and the script makes zero provider-event assertions) and its gain-domain accounting
is partly broken (a +18.06 dB bias in `farEndResidualDb`, an uncompensated −40 dBFS
absolute branch, and unasserted clipping), though its ambient-relative far gates are
gain-invariant and the latest tone failure is real in any frame. "The PCM recorder did
not close complete" is a **misnomer proven from code**: it is `every(phase capture
assessment passed)`, tripped here by two 62/66 ms inter-accept gaps that co-time with
the run's RTT excursions — the recorder closed all seven phases cleanly and no product
close defect exists. The two biggest program risks are that the entire oracle harness
and the exact-TX firmware exist **only as uncommitted working-tree state** (two firmware
files are untracked), and that energy is measured non-predictive of Grok VAD firing
(noise at 0.083 normalized RMS never fired while real speech at 0.039 fired three
times), which is also why a speaker-active energy gate can never substitute for AEC.

## 1. The invariant, and every semantic observation that exists

Product invariant under review: far-end device-speaker-only audio produces **no**
provider `speech_started`, **no** input transcription, and **no** response; independent
Mac speech triggers server VAD promptly — including during device playback — and stays
intelligible; transport/heap/network failures are validity gates, never acoustic verdicts.

Every provider-semantic data point on record (all sessions use profile `low-level-aec` =
`threshold 0.1, silence 1000 ms, prefix 400 ms` — `providers.ts:527-547`; the wire config
is confirmed by each run's retained `session.updated`):

| run                             | firmware era                              | gain      | speech edges | semantic outcome                                                                                                                                                       |
| ------------------------------- | ----------------------------------------- | --------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| grok-aec-baseline 03:18         | pre-exact-TX                              | ×1        | 0/0          | real near speech inaudible to xAI (uplink peak 479, RMS 43); also 32 uplink restarts — invalid era                                                                     |
| grok-aec-x8 03:25               | pre-exact-TX                              | ×8        | 2/2          | both genuine; input transcript exact ("…signal amber is clear and audible"); 13 clipped samples                                                                        |
| hardware-clock-grok 14:48       | hw-clock pairing                          | ×8        | 2/2          | 1 genuine + **1 false during playback** (161 ms, no transcript, 4.06 s after `response.done`)                                                                          |
| vad-015-playback 14:58          | hw-clock pairing                          | ×8        | 2/2          | 1 genuine + **1 false during playback** (3 ms edge). The dir name lies: the artifact echoes `threshold: 0.1` — 0.15 never reached the wire                             |
| voip-exact-reference-grok 15:26 | **current** (VOIP + exact TX + reset fix) | ×8        | 2/1          | 1 genuine + **1 false at `response.done`** (transcribed "I"); turn-1 input transcript also carries unattributed pre-roll ("On everything. Which was kinda pointless.") |
| valid-oracle 08-02 08:49        | pre-policy                                | —         | 4/4          | the semantic path demonstrably works end-to-end (3 completed responses, correct independent STT); failed only on interruption phrasing + one RTT excursion             |
| vad-replay (offline)            | n/a                                       | ×4/×8/×16 | see below    | the calibration rails                                                                                                                                                  |

Replay rails (`stackchan-vad-replay-20260803/README.md`, real xAI socket, threshold 0.1,
sources = accepted uplink of the ×1 run `2026-08-03T01-45-53-719Z`):

| source                                          | normalized RMS | xAI result                                                                                                       |
| ----------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------- |
| near-only ×4                                    | 0.0113         | no edge                                                                                                          |
| near-only ×8                                    | 0.0225         | **1 turn + exact transcript** ("Please verify that this nearby voice remains clear while the device speaker is") |
| far speech-shaped noise ×16                     | 0.0826         | no edge                                                                                                          |
| double-talk (noise far) ×16                     | 0.1375         | no edge                                                                                                          |
| **prior real speaker speech, old firmware, ×4** | 0.0388         | **three false turns — "Yeah", "Stop", "Hi"**                                                                     |

Three conclusions fall straight out. First, **firing is spectral, not energetic**: noise
at 0.083 RMS never fires while real speech at 0.039 fires — so far-only tests must use
_real speech_ far-end (the fixture's tone/PRBS/speech-shaped noise cannot produce a
false positive and therefore cannot prove absence of one), and no energy threshold can
stand in for the provider edge. Second, the current far-speech residual post-×8
(RMS 682 ≈ 0.021) sits essentially **at** the near-speech firing rung (0.0225): the
margin is zero, which is exactly consistent with the three observed playback-tail false
edges. Third, the harness's exactly-N-edges gate already _detects_ the violation (all
three runs failed with "Turn 1 retained 2 … expected exactly one") but cannot _attribute_
it — the false edge had to be dug out of raw event timing by hand each time.

## 2. Q1 — which existing command proves the invariant with least new code

**Answer: `prove-production-stackchan-grok.ts` (committed, `7165d3796`), plus one
~25-line attributed far-only window; with the offline accepted-uplink replay as the
zero-device companion.** Nothing else comes close, and nothing new needs building.

What the script already asserts today (all line refs to that file):

- **Near speech fires VAD promptly and transcribes**: per turn, exactly one
  `speech_started`/`speech_stopped`/`response.done` and exactly one input transcription
  whose normalized text must equal the prompt _exactly_ (:673-708). Both the count and
  conversation scenarios prove this.
- **Double-talk survives**: the barge-in phase speaks over an actively playing response
  and requires exactly two edges, an exact interruption transcript, physical purge
  (`downlinkInterruptedBytes` growth, queue drained), and interruption completion
  (:816-918, :1552-1581). This is the anti-energy-gate guard: an uplink gated on
  speaker-active would fail it structurally.
- **Any speaker-triggered surplus edge fails the run**: whole-run deltas of
  `providerSpeechStarts/Stops` and `playbackInterruptionsRequested/Completed` must equal
  the planned turn count exactly (:1690-1709) — this is what caught all three false
  edges. Zero-deltas on clipping, drops, send failures, speech timeouts (:1710-1728).
- **Ambient attribution**: a 2 s pre-prompt window must stay semantically silent
  (:473-486), and a 5 s post-drain guard catches reverberant-tail turns (:550, :841).
- **Validity**: RTT/RSSI/socket/DNS gates via `classifyPhysicalNetworkValidity`; any
  non-valid classification fails the run rather than blessing it.

What it does **not** assert — the one hole: there is no _attributed far-end-only
window_, i.e. "the device speaker is demonstrably playing, the Mac is silent, and in
exactly this interval there were zero `speech_started`, zero `speech_stopped`, zero
response-creates, zero input-transcription completions." The `server-vad-policy.ts:18-32`
docstring claims every physical acceptance run rejects speaker-only edges; today that is
true only as whole-run counter arithmetic. The minimal insertion (all helpers exist in
the file, ~25 lines): in the interrupted-count scenario, between the 12 s paced-prefix
wait (:776-786) and barge-in injection (:816) — take `latestProviderSequence` + a worker
baseline, hold ≥5 s while the story/count plays, then assert the provider-subset of
`isStackChanSilencePreserved` plus zero new provider events in the window, with the
speaker-active fact device-attested (un-gate the HAVPE-only `playbackContentSamples`
wait at :789-815, or use `referencePeak ≥ 500` AEC windows for StackChan). Grok's own
speech is the far-end stimulus — real speech, the only kind that can false-trigger.

The **offline replay** is the same oracle without the device or the room:
`connectGrokRealtimeVoice` (`src/voice/grok-realtime-voice.ts`) against retained
accepted-uplink PCM. It has already produced decisive answers (the rails above) and is
deterministic and network-trivial. Two caveats: the replay _driver_ script is not in the
repo (the README documents the procedure and the event ledgers are retained; promote the
driver into `scripts/`), and current captures are post-×8 egress, so replay them at
volume 1 — they are byte-exactly what Grok would hear.

**Why not the waveform proof**: `prove-production-aec-waveform.ts` connects the
deterministic fixture provider (`connectDeterministicAec`), which implements
`response.create`/`committed`/`done` and streams the fixture — it has no VAD, and the
script makes zero provider assertions (grep-proven: no `speech_started`, no transcript,
no journal read). Its `providerSpeechStarts: 0` says nothing about Grok. It is the
acoustic diagnosis instrument, and should stay that.

One structural note: the worker's PCM recorder is **deliberately unavailable during Grok
mode** (`worker.ts:157-165` — "raw conversational audio must not become ordinary Durable
Object state"). So live-run far-only egress cannot be re-captured for later replay; the
live far-only verdict must ride on provider events, which _are_ captured raw and
unfiltered to the `/devices/<id>` stream during Grok runs (`pcm-proxy.ts:1411-1424`,
`provider-event-stream.ts`). That is sufficient, and respects the privacy boundary.

## 3. Q2 — does the post-worker ×8 invalidate acoustic thresholds or cause VAD false positives?

**Where the gain lives.** `pcm-proxy.ts:929-936`: in-place saturating multiply on the
device frame, clipped samples counted; policy `server-vad-policy.ts:42` (stackchan ×8,
HAVPE ×16); firmware applies **no** digital uplink gain (verified — near-mic PGA 24 dB,
speaker 90 % on a custom curve, nothing else). The diagnostic recorder tap fires _after_
`provider.send()` on the mutated buffer (`pcm-proxy.ts:954-969`), so every
`*.accepted-uplink.pcm` is **egress truth, byte-identical to what Grok received** — a
deliberate and correct invariant.

**Threshold audit** (`aec-waveform-assessment.ts`):

- _Gain-invariant by construction_ (post-gain ÷ post-gain): the `ambient + 6 dB` branch
  of the far-only ceiling (:187-196), the 10/15 dB near-SNR gates, all similarities,
  near gain/residual ratios. The latest run's tone failure is therefore **real in any
  frame**: native tone residual ≈ −38.8 dBFS vs native ambient+6 ≈ −49.0 — about 10 dB
  over, with the clean capture peak actually railing at 32 768. The PRBS 0.19 dB miss on
  the same ambient-relative gate is measurement noise, not signal.
- _Gain-broken_: (a) the **−40 dBFS absolute branch** of the far ceiling equals −58 dBFS
  device-native at ×8 — 18 dB stricter than designed, masked only while ambient is loud
  enough that the relative branch wins; (b) **`farEndResidualDb` compares a post-gain
  residual against the pre-gain renderer source** (:301-302), a +18.06 dB systematic —
  the headline "−3.15 dB residual" is ≈ **−21.2 dB** in a consistent frame; (c) the
  `source.dbfs < −25` challenge floor (:184-186) mixes domains the same way; (d)
  **clipping is unasserted in the waveform digital gates** (`uplinkPcmClippedSamples`
  is counted but never checked — 674 clipped near-speech samples in the latest run,
  53 769 in the 14:00 digital-×8 run, whose similarity numbers are thereby unusable —
  the calibration review's "stop letting ×8 destroy evidence" warning re-confirmed).
  The Grok proof, by contrast, gates clipping at zero delta.

**VAD false positives at ×8: yes, measured** (§1). ×8 is simultaneously the smallest
rung at which xAI hears the near voice at all (replay: ×4 no-edge) and a rung at which
the current far-speech residual sits exactly at the firing level. Gain is the wrong
knob to "fix" this with — the firmware comment at `targets/stackchan/main/main.c` says
it precisely: raising gain amplifies residual echo together with genuine near speech.
The residual has to come down (or the threshold up, with the near margin re-proven).

**Cleanest way to observe both native and egress truth — no new capture lane:**

1. **Egress truth**: the existing accepted-uplink capture, unchanged. It already _is_
   what Grok heard.
2. **Native truth**: divide non-clipped samples by the recorded `uplinkGainMultiplier`
   (×8 = a left-shift; division is exact) and evaluate every absolute-dBFS gate in the
   native frame; treat `uplinkPcmClippedSamples > 0` in far-only phases as a validity
   failure and in near phases as a recorded budget. Assessment-side edits only.
3. **Independent cross-check**: the firmware AEC view (`aec-metrics.json`, schema v6)
   already reports per-second `near/reference/cleanMeanAbsolute` _before_ the worker
   multiplier — device-native truth with zero extra plumbing.

This keeps the "capture = what Grok heard" invariant, needs no worker or firmware
change, and makes the ×8 an accounted transform instead of an ambient bias.

## 4. Q3 — why "The PCM recorder did not close complete", and what kind of defect it is

**Mechanism, proven from code**: `recorderComplete` is not about closing. It is
`allCaptureAssessments.every(a => a.passed)` (`prove-production-aec-waveform.ts:586`),
where each per-phase assessment aggregates duration ≥ 1 s, ordinal conservation,
span-vs-frames cadence, `maximumInterFrameGapMs ≤ 60`, and zero truncation
(`production-aec-diagnostic-capture.ts:259-321`). The message text is emitted at
`aec-waveform-assessment.ts:406`. The design is deliberate (script :890-898): cadence
misses do not abort phases — evidence completeness first — and resurface in this flag.

**This run**: all seven phase captures closed cleanly (each has `finishedAtMs`, a
sha256, exact frame conservation, zero truncation). Two phases had maximum inter-accept
gaps of **62 ms and 66 ms** against the fixed 60 ms limit (`far-speech-shaped`,
`near-repeat`). Those gaps co-time with the run's independently measured RTT excursions
(device ping 104–116 ms, router 96–113 ms at ~18.5/21.5/50.5 s). The device transport
was clean throughout: zero restarts/drops/failures, send-deferral streak max 5, buffer
high-water 1 920 of 20 480 bytes, socket healthy-open at interval end.

**Verdict: a harness-labeling defect riding on real but marginal network jitter — not a
product defect.** The same Wi-Fi event is counted twice (once by the RTT gate, once
re-labeled as a recorder failure), and the label sends readers hunting for a close
handshake that does not exist. The recurrence pattern confirms it: the message appears
in **every** run that reached a full seven-phase verdict (4 of 4: 01:45, 14:00, 14:46,
15:21) and never in aborted runs — with ~30 s of media per run on this network, the
probability that at least one of seven windows catches a ≥60 ms jitter event is simply
high. The run's `network-invalid` classification is the correct verdict on its own:
rerun, don't tune.

Two adjacent findings, neither implicated here: (a) a **latent capture-slot leak** —
`rawCaptureStillActive` is set only after the arm RPC resolves (script :847), so a lost
arm reply leaks the DO's single capture slot for the rest of the generation (the 18-run
ledger contains exactly one "worker rejected the bounded PCM diagnostic capture"
instance); (b) the `previousSession.lastSocketClose = 1006` in the latest failure.json
is the _pre-run_ session being replaced at `conversation.start` — benign, and retained
first-close-wins by `lastSocketClose ??=`.

## 5. Q4 — delete, combine, defer right now

**Delete / fix while committing (all in currently-uncommitted files):**

1. The "did not close complete" wording: split validity into _recorder integrity_
   (conservation/truncation/short capture) vs _media cadence_ (gap > 60 ms, naming the
   phase and the gap) so network jitter stops masquerading as a recorder defect.
2. Dead thresholds: `minimum/maximumExpectedFrames` are computed and persisted but never
   asserted (`production-aec-diagnostic-capture.ts:263-264`) — assert or delete.
3. `deterministic-aec-fixture.ts:47-52` re-declares the validated amplitude ceilings as
   literals instead of importing `quietPhysicalAecAcousticProfile` — one source of truth.
4. `doubleTalk.nearSource` is supplied to the assessment but only shape-checked
   (script :559, assessment :393) — remove the parameter or use it.
5. Firmware/doc rot: the `initialize_codecs` comment still describes the deleted
   divider reference as the AEC reference (`core_s3_audio_owner.c:380-392` — the file
   now contradicts its own startup log); `CORE_S3_TDM_REFERENCE_SLOT` (:58) is dead;
   `providers.test.ts:186-197` still says HAVPE's next rung is ×8 while the policy is ×16.
6. Evidence naming discipline: `stackchan-vad-015-playback`/`vad-02` imply thresholds
   that never reached the wire — `providers.ts:527-547` hardcodes 0.1 and the retained
   `session.updated` proves it. Never derive configuration from a directory name; put
   the firmware/config identity in `capability-description.json` (build hash is still
   missing there, as flagged in two prior reviews).

**Combine:**

7. Tone becomes sanity-only in waveform acceptance (it is currently a full gate,
   `aec-waveform-assessment.ts:103`; the architecture review already ruled tones NO-GO
   for acceptance). Keep it printed. Consider a small tolerance on ambient-relative
   gates so 0.19 dB misses stop generating "regressions".
8. The waveform proof's missing semantics and the Grok proof's missing far-only window
   are **one hole, closed once** — in the Grok proof (§2). Do not add provider
   assertions to the waveform proof; its fixture provider has no VAD to assert against.

**Defer:**

9. `aec_diagnostic_trace` wiring. Still fully unwired, and **two of its five planes
   (`linear`, `playout`) are unobtainable post-VOIP** — the design predates the engine
   migration (VOIP exposes no truthful linear tap; the reference reserve _is_ the
   playout now). The schema-v6 AEC windows already carry the native per-second truth the
   semantic oracle needs. Redesign (3-plane) only if the semantic gate is green and
   deeper attribution is still required.
10. Offline ideal-canceller (NLMS) falsifier — confirmed absent from the prior art too
    (its nearest primitives are `_reference_projection_gain`/`_reference_transfer_gain`
    in `aec_lab.py`); build it only if VOIP + exact-TX plateaus under the gates after
    the harness fixes land. What _is_ worth lifting from prior art sooner: the
    **transcript-similarity leak gate** (clean-channel STT similarity ≤ 0.25 vs the far
    phrase, with a hallucination guard) and the **analyzer self-test** pattern (prove
    the metric separates known-good from known-bad synthetic fixtures before trusting a
    device number) — the kit's `xai-streaming-stt.ts` already provides the STT lane.
11. Endurance step, HAVPE signal-window unification, the PGA staircase experiment, and
    per-step network attribution (architecture review §5.5) — all still right, all
    after the semantic gate exists.

## 6. Q5 — bounded next-run matrix

Preconditions (≤1 day, mostly host-side): commit the tree; add the far-only window
(§2); make the waveform gates native-frame and clip-gated (§3); promote the replay
driver into `scripts/`. Then:

| #   | run                                                                                                                                              | stimulus                                                                                                                                      | numeric pass criteria                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | validity gates                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| R0  | **Offline replay, far-only + controls** — retained PCM through `connectGrokRealtimeVoice`, threshold 0.1, volume 1 (files are already ×8 egress) | the 15:21 run's `far-tone/far-dual-carrier-prbs31/far-speech-shaped.accepted-uplink.pcm`; `near-only.accepted-uplink.pcm` as positive control | far files: **0** `speech_started` within file duration + 3 s each; near control: **≥1** edge and an input transcript containing ≥6 consecutive words of the Samantha sentence                                                                                                                                                                                                                                                                                                                                                                                       | offline; bounded 30 s/file timeout; no network gate needed                                                                                |
| R1  | **Live semantic oracle** — `prove-production-stackchan-grok.ts --count-300-to-400-interrupted` with the attributed far-only window               | Grok's own speech = real far-end (12 s paced prefix); Mac Samantha phrases at 40 %                                                            | far-only window (≥5 s, device-attested playback: `playbackContentSamples` delta ≥ 8 000): **0** `speech_started`, **0** `speech_stopped`, **0** input-transcription completions, **0** response-creates. Whole run: `providerSpeechStarts == providerSpeechStops == playbackInterruptions{Requested,Completed} == 2` exactly; barge-in input transcript normalizes to exactly "stop and reply exactly interruption test complete"; count prefix ≥ 25 in-order numbers and < 101; `providerSpeechTimeouts`, `uplinkPcmClippedSamples`, drop/restart deltas all **0** | `network classification == "valid"` — anything else is **rerun, never tune**; heap recorded (observed floors ≥ 14 kB internal), not gated |
| R2  | **Acoustic rerun (diagnostic, not the invariant)** — `prove-production-aec-waveform.ts` with native-frame gates                                  | six-phase fixture, Mac at 40 % (raise once toward ~50 % if near SNR < 15 dB twice — 14.16 dB was a near-miss)                                 | native frame: PRBS and speech-shaped clean ≤ ambient + 6 dB; tone reported, not gated; near SNR ≥ 15 dB; repeat similarity ≥ 0.85; double-talk absolute + relative bounds as coded; far-only clipped samples = 0                                                                                                                                                                                                                                                                                                                                                    | per-phase cadence reported as cadence; RTT gates as today                                                                                 |
| R3  | **Margin ladder (only if R1 far-only is red)** — replay R0's far files at SoX `vol 0.5 / 0.71 / 1.0` (≡ ×4 / ×5.7 / ×8 end-to-end)               | same far files + near control at the same volumes                                                                                             | the largest gain with **0 edges across all three far files** at which the near control still fires with an intelligible transcript; if no such gain exists, the fix is residual suppression or threshold (a `providers.ts` change), not gain                                                                                                                                                                                                                                                                                                                        | offline                                                                                                                                   |

Anchors for interpreting R0–R3 (all measured): near fires from 0.0225 normalized RMS
(×8) and not at 0.0113 (×4); real-speech echo fired three turns at 0.0388; noise never
fired even at 0.083; current far residuals are 0.021 (speech-shaped), 0.029 (PRBS),
0.092 (tone).

**Explicitly out of bounds — the speaker-active energy gate.** Muting or attenuating
the uplink while the speaker plays would trivially pass R1's far-only window and destroy
the product: barge-in requires VAD to fire _during_ playback (R1 asserts exactly that),
and the measured rails prove energy cannot separate echo from speech in the first place.
The firmware already has the right shape — AEC output always replaces the uplink, silence
on failure, never raw mic and never a gate (`aec_capture_bridge.h:14-27`) — keep it.

## Ordered actions (at most five)

1. **Commit the working tree on `c-capabilities` today** — firmware (including the two
   untracked reference-reserve files), scripts, assessments, evidence. Every conclusion
   in this series currently rides on an uncommitted tree; one checkout loses the
   exact-TX reference implementation outright.
2. **Add the ~25-line attributed far-only window** to `prove-production-stackchan-grok.ts`
   (interrupted-count scenario, between paced prefix and barge-in; un-gate the
   speaker-active wait for StackChan) and promote the replay driver into `scripts/`.
3. **Run R0 then R1** under one evidence label with the firmware build hash recorded in
   `capability-description.json`; expect R1's far-only window to be red (three prior
   false edges say so) — that red, with timing, is the first attributed measurement of
   the actual product gap. Run R3 to size the margin if so.
4. **Fix the waveform harness accounting in parallel** (native-frame gates via
   `uplinkGainMultiplier` division, far-only clip gate, recorder-message split,
   tone→sanity, fixture-amplitude import, delete dead thresholds) — no device needed;
   rerun R2 afterward as the acoustic diagnostic.
5. **Only after R1 is green at ×8/0.1** treat the calibration as settled; if red, the
   ladder is: residual suppression (firmware) → threshold (a real `providers.ts`
   change, re-proving the near margin) → gain last — and never an energy gate.

## Uncertainty, stated honestly

1. The three false edges are attributed to echo by timing (during playback tail / at
   `response.done`) and by their 3–161 ms, transcript-free shape; an unattended room
   noise source cannot be fully excluded. R1's attributed window in a quiet room settles
   it — that is partly why R1 exists.
2. The 15:26 pre-roll transcript contamination ("On everything. Which was kinda
   pointless.") is unattributed — room audio, or echo of an earlier response. Watch it
   in R1; if it recurs with the room silent, input-transcription contamination is a
   second, independent invariant violation.
3. Grok server-VAD internals are inferred from behavior only. "Noise never fires" is
   measured for these noise types at these levels; it may not generalize, which is
   another reason the far-only acceptance stimulus must be real speech.
4. DTD/TDE inside `AEC_MODE_VOIP_HIGH_PERF` is inferred from Espressif's mode semantics,
   not observed; the engine is closed. R2's double-talk numbers remain the only
   measurement of it.
5. The replay probe driver is not in the repo; R0 assumes reconstructing it over
   `connectGrokRealtimeVoice` is ~50 lines. If it exists elsewhere, promote rather than
   rewrite.
6. Network validity currently voids whole runs; per-step attribution is designed but
   unimplemented. On this Wi-Fi R1/R2 may need reruns — that is the gate working, not
   noise to relax. The 62/66 ms cadence trips and the RTT excursions are the same
   intermittent (not periodic — offsets differ across runs) RF phenomenon.

## Sources inspected (load-bearing)

Worker: `src/userspace/config-worker/{worker.ts (157-223, 336-440, 651-661, 849-881),
pcm-proxy.ts (403-440, 579-604, 848-996, 1149-1209, 1411-1428, 2229-2232),
providers.ts (304-366, 432-547), server-vad-policy.ts, provider-event-stream.ts,
pcm-diagnostic-capture.ts, deterministic-aec-fixture.ts}`. Harness:
`scripts/prove-production-aec-waveform.ts (77-130, 301-346, 389-456, 552-611, 614-681,
765-855, 890-917, 1011-1109, 1218-1262)`, `scripts/prove-production-stackchan-grok.ts
(95-141, 200-258, 473-486, 488-918, 1039, 1398-1432, 1492-1524, 1552-1581, 1619-1843)`,
`src/device/{aec-waveform-assessment.ts (103-133, 176-342, 404-427),
production-aec-diagnostic-capture.ts (8-11, 259-336), physical-network-run.ts (25-33,
556-564), physical-network-validity.ts (133-466), xai-streaming-stt.ts,
stackchan-aec-assessment.ts (111-119)}`, `scripts/transcribe-pcm16.ts`,
`src/voice/grok-realtime-voice.ts`. Firmware:
`platforms/iterate_core_s3_audio/{core_s3_audio_owner.c (36-58, 380-392, 519-608,
707-741, 797-963, 1154-1183, 1237-1246), core_s3_capture_reserve.c (266-283),
core_s3_playback_reference_reserve.h (15-22, 113-122)}`,
`components/core/{aec_capture_bridge.{h,c}, aec_diagnostic_trace.{h,c},
aec_signal_window.c}`, `components/capabilities/src/metrics.c (409-690, 1006-1138)`,
`targets/stackchan/main/main.c (378-463, 788, 1161-1183)`,
`platforms/iterate_esp_idf/pcm_transport.c (298-337)`. Evidence: the eleven runs and
the replay ledger tabled in §1/§4/§6 (failure/manifest, phase-summary, aec-metrics,
network, provider-events.jsonl, capture JSONs; PCM/WAV inspected via retained stats
only). Prior art (`~/src/github.com/iterate/stackchan/experiments/02-minimal-realtime-aec`):
`tools/aec_lab.py (77-87, 146-167, 209-258, 282-315, 384-398, 694, 916-954, 1055-1105,
1195-1441)`, `tools/audio_assess.py (117-206, 317-434, 565)`, `docs/aec-validation.md`,
retained runs incl. `20260729-dma-tap-repeat-1` (ERLE 21.9 dB with verbatim intelligible
echo, similarity 1.000 — the semantic-leak wall) and `local/device-aec-volume-100`
(the 18.64 dB "pass" whose clean output later false-triggered xAI at ×4). Prior kit
reviews: architecture-oracle, reference-calibration, hardware-first-party, shared-AEC
server-VAD (2026-08-01/03).
