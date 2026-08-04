# StackChan AEC onset review — why settled cancellation is excellent and the first 0.5–2 s of every reply is not

2026-08-03. Independent read-only review. Sources: this repo's firmware/worker/oracle
code; the vendored ESP-SR 2.4.7 binaries (disassembled read-only); the M5Stack
BSP + esp_codec_dev drivers actually compiled in; the prior-art checkout at
`~/src/github.com/iterate/stackchan`; retained evidence under
`apps/kit/evidence/`; the production project's provider-event stream (read-only
itx queries); and external references (WebRTC AEC3, SpeexDSP, XMOS/Amazon
practice, xAI/OpenAI realtime docs). Every claim below is labeled **[source]**
(read from code/binary/evidence in this pass), **[measured]** (computed in this
pass from retained PCM/metrics), or **[inference]** (mechanistic conclusion that
still needs the named experiment).

---

## 1. Verdict

The DMA pairing, analog-divider reference, epoch machinery, and double-talk
posture are sound and are **not** the problem. The onset failure has one primary
mechanical cause inside ESP-SR's VOIP engine, one gain-staging amplifier of that
cause, and one provider-semantics amplifier that turns a half-second acoustic
defect into a multi-turn conversational failure:

1. **The dios_ssp VOIP AEC un-converges itself during every far-silence gap.**
   Its adaptive filter updates on _every_ frame, but when the reference is
   silent the engine skips the reference-analysis block and keeps the _last
   far-end-active reference spectrum frozen_ in its input stack. During
   silence — and much faster during the user's own turn — the filter adapts
   against that stale spectrum and drifts away from the converged solution.
   Each reply onset then needs ~0.5–2 s to re-converge. **[source: binary]**,
   drift-vs-gap magnitude **[inference → E1/E2]**.
2. **The ×8 processed-branch calibration lifts that onset residual above the
   provider VAD floor.** The wire-level residual during a reply measured
   −26…−35 dBFS for the first 400–600 ms — at or _above_ real user speech
   (−29.9 dBFS mean on the same wire). The VAD threshold (0.1) was calibrated
   exactly so speech at these levels fires. **[measured]**
3. **The worker treats any `speech_started` as physical barge-in**: it discards
   the queued reply and purges device playback before any corroboration. One
   leaked onset therefore kills the reply, commits the echo as a user turn,
   produces a junk transcript, and Grok answers the junk. **[source]** This
   loop is observed live in production event history (§5).

The deterministic waveform oracle cannot see any of this because it slices the
first 1,000 ms off every phase before assessment and runs all six phases inside
one warmed-up session. **[source]** The prior-art firmware had the identical
failure and the identical oracle blind spot (its harness discarded the first
750 ms of every measurement). **[source: prior art]**

Do not call this fixed from settled-only measurements; §8 defines what
"fixed" must mean.

---

## 2. The system as built (facts verified from source)

Firmware (`core_s3_audio_owner.c`, `targets/stackchan/main/main.c`):

- 16 kHz, 4-slot TDM RX, 5×128-sample DMA (8 ms) on one shared I2S clock.
  Near mic = slot 2 (+24 dB PGA, persistent 100 Hz high-pass). AEC reference =
  slot 1, the electrical divider across the AW88298 output, at 0 dB PGA and a
  saturating digital ×8 (`CORE_S3_AEC_REFERENCE_SCALE_MULTIPLIER`).
- Exact completed TX DMA is a _third_ lane used only as the far-active oracle
  for the uplink selector — it is not the cancellation reference. The comment
  in `main.c:1178–1183` still claims "Cancellation uses the exact completed TX
  DMA descriptor"; that is stale (exact-TX-reference era, since reverted).
- `aec_process` runs on **every** 256-sample frame, far-active or not, on the
  stated theory that this keeps "adaptive state … warm when playback begins"
  (`core_s3_audio_owner.c:646–652`). §4 shows the binary does the opposite.
- Uplink selector (`aec_uplink_selector.c`): publishes raw near ×6 while the
  exact-TX playout frame is all-zero; switches to processed (AEC output) ×8 on
  the **first nonzero playout sample**, and holds processed for an 8-frame
  (128 ms) hangover after playout returns to zero. The switch is instantaneous;
  the wire steps ×6→×8 and swaps signal source in one 16 ms frame.
- Selection happens **before** the once-per-second signal window is measured,
  so exported clean numbers are true wire numbers (post-gain). Good.
- Epoch machinery: reference-pair skew gate 4 ms; poisoned reserves and any
  sequence discontinuity destroy/recreate the AEC (ESP-SR exposes no public
  reset). These events are rare in practice: the failing production run below
  shows `recreates: 0`, `referencePairResets: 0` across the whole interval, and
  lifetime counters of 1/1 over 18.75 min of uptime. Pairing is **not** the
  onset culprit.
- AEC config: `AEC_MODE_VOIP_HIGH_PERF`, `filter_length = 4`, `nlp_level =
AGGR`, `caps = SPIRAM`. All three of `filter_length`, `nlp_level`, and `caps`
  are inert in VOIP mode (confirmed at instruction level; §4). The existing
  inline comments already say the first two — the binary confirms them.
- Volume: `speaker_volume_percent = 90`, mic 24 dB, reference 0 dB.

Worker (`pcm-proxy.ts`, `providers.ts`, `server-vad-policy.ts`):

- Grok session: `turn_detection = server_vad`, `threshold 0.1`,
  `prefix_padding_ms 400`, `silence_duration_ms 500`. The 0.1 threshold is a
  deliberate, previously falsified-upward calibration (0.2 missed real
  barge-in; 0.15 split both failures) — raising it is correctly off the table.
- StackChan's uplink gain policy is on-device (×6/×8); the worker applies ×1.
- `input_audio_buffer.speech_started` → immediately: `#interrupted = true`,
  discard the entire queued downlink, abandon the provider response, and
  request a physical playback purge on the device (`pcm-proxy.ts:1149–1209`).
  There is no corroboration step, no echo-awareness, and no minimum duration:
  a 4 ms VAD edge triggers the same physical purge as a real interruption.
- A non-interruptible greeting mechanism exists (`force_message`,
  `interruptible: false`, which makes xAI discard microphone audio during it)
  but **no production site configures `initialGreeting`** — every deployed
  reply, including the first, is interruptible and exposed.

Oracles:

- `prove-production-aec-waveform.ts`: `settledLeadMs = 1_000`,
  `assessmentIntervalMs = 3_000`. Every far/double-talk phase's clean PCM _and_
  its source are sliced from 1,000 ms onward before any gate runs; the six
  phases run back-to-back in one PCM generation. Structurally blind to onset.
- `prove-production-stackchan-grok.ts` (the semantic oracle) is **not** blind:
  it requires exactly one `speech_started` per turn and fails otherwise. It is
  the oracle that caught this defect (§5).
- `stackchan-aec-assessment.ts` (always-on window gates) has two stale gates:
  `cleanToNearRatio` expected within [0.5, 2] — but near-only windows are now
  raw ×6, so a healthy device reports ~6.0 and fails; and `echoSuppressionDb =
20·log10(near/clean)` is gain-blind — clean carries ×8, so the reported
  6.13 dB is really ~24 dB of pre-gain suppression, and the ≥3 dB gate is
  nearly vacuous against a ×6 raw window.
- `aec_diagnostic_trace.c` exists and is referenced only by its own unit test —
  the onset-resolved capture facility is built but unwired.

Dark counters (written, never exported): `owner.reference_scale_clipped_samples`
(divider ×8 clipping) and the selector's `clipped_samples` / `raw_frames` /
`processed_frames`. Both matter for onset forensics and neither reaches
userspace.

---

## 3. Physical evidence (retained + newly measured)

### 3.1 Onset envelope on the exact production path **[measured]**

100 ms RMS over retained accepted-uplink PCM (capture includes the second the
oracle discards). Run `stackchan-production-aec-waveform-start-watermark-20260803/
2026-08-03T19-19-29-014Z`:

- `far-dual-carrier-prbs31`: **−32.3, −32.7, −34.8, −34.9 dBFS for the first
  400 ms**, −43…−45 by 700 ms, settling to −50…−52 dBFS at ~1.8–2.0 s. The
  earlier `corrected` run shows the same shape with a hotter start (−26.1 dBFS
  at 100–200 ms).
- `far-tone`: converges in ~200–300 ms (single frequency is trivial), settled
  −52…−54 dBFS.
- `far-speech-shaped`: settled −56…−60 dBFS, **but every intra-phase pause →
  resume leaks a fresh single-window burst (−36.9 and −41.6 dBFS at the same
  stimulus positions in both runs)**. Re-onset after even a sub-second silence
  is measurably leaky; a cold-ish onset takes ~0.5–2 s.

For scale, on the same wire: idle ambient (raw ×6) ≈ −46 dBFS mean; real user
speech ≈ −29.9 dBFS mean. The onset residual is therefore **louder than real
user speech** for several hundred milliseconds, and the settled residual is
~4 dB _below_ ambient-raw. Settled behavior is genuinely excellent — the −49
dBFS retained figure reproduces here as clean/8 ≈ −48.9 dBFS pre-gain.

### 3.2 The failing production Grok run **[source: evidence]**

`stackchan-production-grok-post-watermark-20260803/2026-08-03T19-22-46-399Z`
(error: _"Turn 1 retained 2 Grok server-VAD speech_started events; expected
exactly one."_):

- Provider timeline: user turn transcribed exactly; `response.done` ("Hey! How
  can I help?") at t=989.0 s; **false `speech_started` at t=990.47 s, with
  detected energy falling inside the reply's device playback (confirmed by
  aligning the retained room recording against the input-audio timeline);
  `speech_stopped` 954 ms later; the echo was committed as a user turn.** The
  edge sits ~1.2–1.7 s after playback began, i.e. the wire stayed VAD-hot well
  beyond the first frames — consistent with the ~2 s broadband re-convergence
  envelope in §3.1, not with a brief switching click.
- Device windows (1 s cadence, schema v7): idle clean mean 165–171 (×6
  ambient); user-speech window clean mean 1043; reply window near mean 1896 /
  clean mean 936 (wire) / `referencePeak` 19168 / `nearPeak` 28730.
  - clean 936 wire ÷ 8 = 117 ≈ −48.9 dBFS pre-gain → mean suppression through
    the second that contains both onset and settled halves ≈ 24 dB; the
    exported gain-blind `echoSuppressionDb` shows 6.13 dB.
  - `nearPeak` 28730 = −1.1 dBFS: the near mic runs within ~1 dB of the rail
    during a loud reply syllable (see §6, volume finding).
  - `referencePeak` 19168 post-×8: the divider reference did **not** clip at
    volume 90 in this run. Reference clipping is not implicated at vol 90.
- Lifecycle deltas across the failing interval: `recreates 0`,
  `referencePairResets 0`, `captureReserveDroppedChunks 0`, `playbackResets 2`
  (both are the worker's own barge-in purges — the reply killing itself).

### 3.3 Live conversation history (production event stream, read-only) **[source]**

- Session `…bb36ba10` (19:37Z): "Hey Pal." → reply → **a 4 ms `speech_started`/
  `speech_stopped` pair (start_ms 5499 → 5503) 1.7 s after `response.done`**,
  committed; the summary shows `playbackInterruptionsCompleted: 1` — a 4 ms
  VAD edge physically purged the reply.
- Session `…5ebfacc1` (13:24Z, real use): after one reply, **seven
  `speech_started` edges in ~10 s**, a "[noise]" transcript, a provider
  retirement (input timeline restarts), then another string of edges ~1.5 s
  apart while the user says "Fuck." three times. This is the machine-gun
  self-barge-in loop, live.
- Session `…90ff1889` (real use): user turns transcribe, but openings fragment
  ("Huh?" → "Not?" → "Not much. How are you?"), and after the counting reply
  the user's correction begins with "No." — the review prompt's `No./No./Out.`
  incident is this same class (its exact event page has rotated beyond the
  window I could pull; the class is otherwise fully evidenced).
- The pre-greeting "hey pal" corpus (16:35–19:37Z, `stackchan-grok-uplink-
incident-20260803/*`) shows the _separate_, already-known slot-0/STT shelf
  issue ("Hey Pal." → committed as "PayPal."/"Playtime."). Distinct defect;
  not this review's subject.

### 3.4 Current oracle status **[source: evidence]**

All three of today's waveform-proof runs failed on **"The PCM recorder did not
close complete"** (the known capture-cadence misnomer), _not_ on any acoustic
gate — their settled windows are green at −48…−52 dBFS. So today the
deterministic oracle is simultaneously (a) failing for a non-acoustic bookkeeping
reason and (b) structurally unable to fail for the real acoustic reason.

---

## 4. Inside `AEC_MODE_VOIP_HIGH_PERF` (verified from the vendored 2.4.7 binaries)

Disassembly of `libesp_audio_processor.a` (full DWARF present; symbol and
literal-pool evidence, read-only):

- The VOIP path is **Alibaba dios_ssp**, not the esp*aec3 kernels (those serve
  SR/FD modes). It runs **internally at 8 kHz**: at 16 kHz the mic and
  reference are resampled 16k→8k, cancelled, and the output upsampled 8k→16k.
  \*\*Nothing above 4 kHz is cancelled \_or preserved* through `aec_process`\*\* —
  the processed branch (i.e., the uplink during playback and hangover) is
  band-limited to 4 kHz. This alone degrades barge-in STT quality during
  playback relative to the raw branch.
- Structure: 256-pt FFT → 129 subbands (31.25 Hz/bin), 128-sample hops,
  dual-filter (always-adapting background + foreground) power-normalized NLMS,
  8 taps/subband in HIGH_PERF ⇒ **≈128 ms tail** (the firmware's 128 ms
  hangover happens to match), `myu = 0.5`.
- **No delay estimation is live**: the TDE objects exist in the archive but no
  live code references them; the reference delay-line length is 0. The
  firmware's inline claim is confirmed; alignment is entirely the caller's job
  (and the DMA pairing does that job well — skew measured 0.38–1.19 ms).
- **`filter_length`, `nlp_level`, and `caps` are all inert in VOIP**: the
  4-word config passed to `esp_voip_init_api` contains none of them;
  `aec_set_nlp_level` logs "Only full-duplex AEC support NLP level setting";
  dios hard-codes SPIRAM for its big buffers.
- **Far-end activity gate**: per 16 ms internal frame, far is "active" iff
  mean|ref| > 100 LSB _and_ > 2× the tracked reference noise floor, with a
  20-frame (**320 ms**) hangover. When the hangover expires, the entire
  reference-side block is skipped — **the reference subband spectrum stays
  frozen at its last far-active contents** (it is not zeroed).
- **Adaptation never pauses.** The FIR update runs every frame and reads only
  the double-talk status: double-talk slows adaptation ~40× (normalization
  pair (0.1, 5.0) → (4.0, 200.0)); far-idle status does **not** gate it. With
  a frozen stale reference and live mic audio, the filter adapts against
  garbage — slowly during quiet gaps, quickly during the user's own speech.
- **Cold-start scaffolding**: for the first 100 processed frames (**1.6 s**)
  after create/reset the double-talk detector is hard-wired to "far-end single
  talk" (fast adaptation, and near speech in that window is treated as echo);
  the noise-floor trackers need ~1 s (62 frames); the residual min-tracker ring
  is 250 frames (~4 s). There is no convergence ramp beyond these counters.
- **Residual suppressor**: two stages, tuned by the mode-0 profile for _both_
  VOIP modes (the high-perf flag changes taps/TDE only). Effective floors:
  res1 −100 dB (suppress factor 30), res2 −40 dB with **identical single-talk
  and double-talk targets** — the suppressor does not relax during double-talk,
  which is the mechanistic root of the measured 0.29 near-speech duck, and it
  keys off the echo estimate produced from the (possibly frozen) reference —
  the mechanism behind "92–99 % of near-only speech removed while the exact
  reference was zero", and thus the justification for the raw/processed
  selector.
- **A zero-allocation warm reset exists**: `esp_voip_reset_api(handle->aec_handle)`
  is an exported (undeclared) symbol that resets filters/DTD/noise trackers
  without any PSRAM churn — `aec_create_from_config` itself calls it after
  init. Using it means depending on a private symbol of the pinned 2.4.7
  binary; that is a deliberate contract break to take knowingly (pin + startup
  assert), not silently.

### The falsifiable explanation

**Primary**: converged filter state is _destroyed between replies_ by
always-on adaptation against a frozen stale reference (fact), at a rate
proportional to near-end energy during the gap (inference). Every reply onset
is therefore a partial cold start; re-convergence takes ~0.5–2 s (measured);
the ×8 branch calibration puts that transient above the server-VAD floor
(measured); the worker's uncorroborated barge-in turns it into self-mute plus
phantom turns (source + observed).

**Contributing**: (a) instantaneous raw×6 → processed×8 selector step at the
exact onset frame; (b) near-mic operation within ~1 dB of full scale at volume
90 during loud syllables (nonlinear echo a linear filter cannot cancel — worst
at loud reply openings); (c) the intra-reply pause/resume leak (every ≥320 ms
TTS pause freezes the reference path; each resume leaks a fresh ~−37…−41 dBFS
burst), which is how one reply can produce _multiple_ VAD edges and how a
user's overlapping utterance gets segmented into several junk turns.

**Predictions that would falsify it** (each cheap to run):

- **E1 (gap experiment)**: two identical deterministic responses, once with a
  0.5 s gap and once with a 30 s gap that contains Mac speech. Prediction:
  first-500 ms wire RMS of reply 2 is much hotter after the long+speech gap.
  If both onsets are equally hot, silence-time corruption is falsified and
  pure per-onset re-convergence dominates.
- **E2 (warm-reset probe)**: call `esp_voip_reset_api` immediately before a
  reply. Prediction: onset residual is _no worse_ than the no-reset case after
  a speech-filled gap (i.e., the retained state was worthless). If reset is
  clearly worse, the filter retained real value across the gap and the
  corruption claim weakens.
- **E3 (idle-gating A/B)**: stop calling `aec_process` while far is idle
  (§7.1). Prediction: onset residual after speech-filled gaps drops toward the
  intra-phase re-onset floor (~−41 dBFS single-window), and Grok proof turns
  stop retaining extra `speech_started` edges.

---

## 5. What the onset failure is _not_ (alternatives examined)

- **Not AEC recreation at onset**: `recreates: 0` in the failing interval
  [evidence]. Recreate storms would also show in `reference_pair_resets`; they
  don't.
- **Not reference misalignment or DMA pairing**: shared clock, skew 0.38–1.19 ms
  vs a 128 ms filter tail; zero pairing resets in the failing run [evidence].
  The pairing machinery is doing its job; do not simplify it away.
- **Not an amplifier turn-on transient**: the AW88298 as configured has HAGC
  disabled, smart boost disabled, no auto-mute-on-silence, no volume ramp;
  un-power-down happens once at boot. The class-D output has no configured
  time-varying behavior at content onset [source: driver + register writes].
- **Not divider ×8 clipping at volume 90**: `referencePeak` 19168 < 32767
  during the loud reply [evidence]. (At volume 100 this was previously real;
  the counter should still be exported — it is currently dark.)
- **Open door, unverified**: ES7210 ALC/automute registers (0x13, 0x16,
  0x1B–0x1E) are never written by any driver in the build and sit at chip
  reset defaults. If those defaults enabled ALC on the divider channel, the
  reference gain could move under signal. One `esp_codec_dev_dump_reg` on the
  mic handle settles it (E5). Until then this is the only hardware path left
  that could vary the reference between turns.
- **Static register-decode discrepancies worth a dump, not a panic**: the
  "64fs" BCK write (0x20) may actually select a 48-BCK code, and
  `set_bits_per_sample(16)` clears the FS field to the 32-bit code after open.
  Both are static (cannot explain a per-turn transient) but bias the DAC bus
  geometry the divider taps; one `dump_reg` after init answers both (E5).
- **Volume-90 headroom is ~1 dB, not ~5 dB**: computing the deployed curve
  through esp_codec_dev's hw-gain arithmetic (pa_gain 15, default 3.3/5.0
  voltages → 11.39 dB) puts logical 90 at register −1 dB, and logical 93–100
  all clamp to 0 dB. The `main.c` comment claiming "about 5 dB below its
  top-of-range cliff" is wrong; the measured near-rail `nearPeak` (−1.1 dBFS)
  agrees with the corrected arithmetic. [source: driver math; confirm with
  dump_reg + one A/B at volume ~85]

---

## 6. Why the oracle passes while conversation onset fails

1. `settledLeadMs = 1_000` removes exactly the failing window from every far
   and double-talk phase, and the deterministic source is sliced identically —
   there is no gate that can see the first second. [source]
2. All six phases run inside one long-lived generation: by the time any far
   phase is assessed the engine has been continuously excited for many
   seconds. Real conversations insert 5–60 s of silence-plus-user-speech
   before every reply — the exact state the proof never reproduces. [source]
3. The always-on window assessment is 1 s-grained (onset and settled halves
   average together), its suppression metric is gain-blind (×8 hides in the
   ratio), and its near-preservation gate pre-dates the ×6 raw gain, so it now
   fails healthy runs ("ratio 6.029; expected 0.5 through 2") — a red herring
   that costs trust in the lane. [source + evidence]
4. Today's runs are additionally red on the "PCM recorder did not close
   complete" cadence misnomer, so the acoustic gates aren't even the active
   signal. [evidence]
5. The semantic oracle (`prove-production-stackchan-grok.ts`) **does** catch
   the defect (exactly-one-`speech_started` gate). The system's oracle gap is
   confined to the waveform proof; keep the semantic gates authoritative for
   accept/reject and make the waveform proof onset-aware for attribution.
   [source]
6. Prior art made the same choice explicitly: its lab discarded 750 ms of
   adaptation before computing ERLE and its docs admit the first window is
   unconverged and unmeasured — and its device logs show the same self-barge-in
   loop shipping. This blind spot is hereditary; treat "settling leads" in AEC
   oracles as a smell. [source: prior art]

---

## 7. Recommendations

### 7.1 Device: process the AEC only while the reference is live (primary fix + simplification)

The "AEC runs on every frame so its adaptive state is warm" doctrine
(`core_s3_audio_owner.c:646–652`) is inverted by the binary evidence: idle-time
processing is what _destroys_ the state. Gate the DSP on the far-active oracle
the code already computes (exact-TX playout nonzero, plus the existing 128 ms
hangover — conveniently equal to the filter tail):

- Far idle: skip `aec_process` entirely; publish raw ×6 (the selector already
  does); the engine's state is simply _left alone_, preserving the last
  converged filter exactly (the electrical divider path is time-invariant, so
  a preserved filter is valid at the next reply's first sample — this is what
  XMOS/Amazon-class stacks do: persist, never re-learn from silence).
- Far active (+hangover): run `aec_process` per frame as today.

Consequences:

- Correctness: removes the corruption channel entirely; onset residual should
  drop to the small re-onset transient (~−41 dBFS bursts) or better. E3 is the
  falsifier.
- CPU: `aec_process` measures 9.3–12.7 ms per 16 ms frame — ~60 % of core 1
  continuously, on a device idling most of its life (whole-device
  `cpuPermille` 728). Idle-gating deletes nearly all of that outside playback.
  This is the single largest realtime win available.
- Simplification: the selector's far-active test and the DSP gate become one
  seam ("AEC exists only during playback epochs"), which is easier to reason
  about than "always-on DSP + output selection". No queues, no new state; the
  bridge alignment path is untouched.
- Cautions: (a) the engine's mic-side noise trackers will now only observe
  playback-time audio — DT thresholds shift; measure double-talk after the
  change (the existing double-talk phase covers this). (b) The first 2–3
  frames after resume have stale filterbank history; harmless next to the
  status quo but visible in a trace. (c) After a _real_ epoch reset the 1.6 s
  forced-single-talk window means near speech is maximally suppressed during
  the next 1.6 s of processed frames; recreates are rare, but the counter
  should be watched in the same evidence.

Optional second layer, only if E3 leaves residual bursts: an AEC3-style onset
post-filter on the processed branch — for the first ~500 ms of far activity,
bound the uplink to a residual predicted from reference energy × a conservative
path gain, with a dominant-nearend override (near energy > ~4× predicted echo
for ~50 ms → go transparent, hold ~200 ms). This is reference-keyed suppression
with a barge-in escape hatch — not a mute and not a VAD threshold change; real
speech (20+ dB above residual) punches through within one hold window. A few
ops per frame in the existing selector callsite.

Also worth taking while in there: replace destroy/recreate in `reset_aec()`
with the warm `esp_voip_reset_api` (zero-allocation, functionally what
`aec_create_from_config` runs) _if_ the private-symbol dependency is accepted
deliberately (pin 2.4.7 + startup assert on the symbol); this removes PSRAM
allocation from the recovery path.

### 7.2 Worker: corroborate before killing the reply (provider-semantics fix)

Keep sending audio continuously (no muting, no threshold change). Change only
the _interruption decision_: while a response is being played out, on
`speech_started` do everything except the physical purge; issue the purge when
any corroboration arrives within a bounded window, and otherwise unwind:

- Corroboration = speech still active after ~250–300 ms, or any non-empty
  transcription delta for the new item, or (later, device-informed) a
  raw-branch energy marker. A real barge-in today already pays ~400 ms of VAD
  prefix; +250 ms of deferral keeps interruption feel intact while making a
  4 ms edge (observed) or a 950 ms onset burst with a junk transcript
  (observed) unable to kill the reply outright.
- Count everything: `speechEdgesDuringPlayout`, `interruptionsDeferred`,
  `interruptionsConfirmed`, `interruptionsUnwound`. The Grok proof already
  gates on exactly-one-edge; these make live incidents attributable without a
  serial cable.
- Strategic (bigger, documented, not first): xAI supports
  `turn_detection: null` + `input_audio_buffer.commit` — the device/worker
  could own turn boundaries outright with an echo-aware local gate, as manual
  PTT mode already does. Keep as the fallback if server-VAD + corroboration
  still misbehaves.

### 7.3 Oracle: make onset a first-class gate

1. Wire `aec_diagnostic_trace` (built, tested, unwired) or add a short-window
   mode to the signal window (e.g., 100 ms windows for the first second of far
   activity, sequence-tagged) so onset is visible in device evidence.
2. Waveform proof: keep the settled gates, and add an onset gate per far
   phase over the currently discarded first second of the _retained_ capture —
   e.g., every 100 ms window ≤ max(−40 dBFS, ambient+6 dB) after the first
   150 ms. Today's retained PCM would fail this at −32…−35 dBFS, which is the
   point: the oracle must fail while conversation fails.
3. Add E1/E2-shaped phases (variable gap, gap-with-near-speech) so convergence
   _between_ responses is what the proof exercises, not only within one.
4. Fix the stale always-on gates: near-preservation bounds must model the raw
   ×6 branch (or the metric should be exported pre-gain alongside wire-gain),
   and echo suppression should be computed gain-aware (÷8 on the processed
   branch) or renamed to what it is (wire ratio, not ERLE).
5. Export the dark counters (`reference_scale_clipped_samples`, selector
   `clipped_samples`/`raw_frames`/`processed_frames`) and add a per-response
   selector-transition count — >1 raw→processed flip per response is the
   pause/resume-segmentation signature and distinguishes it from single-onset
   leaks.
6. Keep the semantic proof's exactly-one-edge/zero-speaker-only-edges gates as
   the acceptance authority; fix the "recorder did not close complete"
   cadence misnomer separately so it stops masking acoustic verdicts.

### 7.4 Hygiene (cheap, do alongside)

- Correct the stale `main.c` comment (cancellation reference is the analog
  divider; exact TX is the selector oracle) and the volume-90 "≈5 dB headroom"
  comment (it is ≈1 dB; 93–100 all clamp to 0 dB).
- One `esp_codec_dev_dump_reg` for both codecs after init in a diagnostic
  build (E5): settles ES7210 ALC defaults on the divider channel and the
  AW88298 BCK/FS field decode in one shot.
- A/B volume 85 (≈−4 dB true headroom): prediction — `nearPeak` leaves the
  rail during loud syllables and settled ERLE improves slightly; also
  re-checks the "railed near mic" note in `main.c` with the corrected curve.
- The 8 kHz-band fact deserves a code comment on the processed branch: uplink
  during playback is 0–4 kHz only. It is also a quiet argument for re-testing
  the FD engine (esp*aec3 kernels, working NLP knobs, full band) with
  NLP_NORMAL against the current electrical reference — \_after* 7.1–7.3, as a
  measured comparison, since prior art's FD+AGGR also self-barged (its gain
  staging differed, so the comparison is not condemned in advance).

---

## 8. What "fixed" must mean

Settled-window numbers are necessary but no longer sufficient. Accept only:

1. Grok semantic proof: N ≥ 3 consecutive turns with exactly one
   `speech_started` per real user turn, **zero** speaker-only edges, zero
   playback purges without a confirmed interruption — across replies separated
   by both short (~1 s) and long (~30 s, speech-filled) gaps.
2. Waveform proof: settled gates green **and** the new onset gate green on
   every far phase, including the variable-gap phases.
3. Double-talk phase unchanged or better (near-end gain/residual/degradation
   gates), because both fixes must be shown not to have bought onset quiet
   with near-speech destruction.
4. The E1/E2 falsifiers run once and their outcome recorded, so the mechanism
   claim in this review is either confirmed or corrected in evidence, not in
   prose.

---

## 9. Ranked next actions

1. **Idle-gate the AEC** (7.1) and A/B it with E3 — smallest change, largest
   correctness and CPU effect, directly attacks the verified mechanism.
2. **Onset-resolved evidence + onset gate in the waveform proof** (7.3.1–2) —
   removes the pass-while-failing hole before any tuning starts.
3. **Worker interruption corroboration** (7.2) — stops one leaked edge from
   killing a reply; independently valuable even after 1 lands.
4. **Run E1/E2** to pin the mechanism; adopt the onset post-suppressor only if
   E3 leaves bursts above the new gate.
5. **Gate/counter/comment hygiene** (7.3.4–6, 7.4) — fixes the false-failing
   near gate, exports dark clip counters, settles the codec-register unknowns
   (E5), and corrects stale comments before they mislead the next reviewer.
6. **Hold in reserve**: warm-reset adoption, volume 85, FD-engine comparison,
   Grok manual turn control — each contingent on the measurements above.
