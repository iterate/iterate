# Fable Max review: HAVPE XMOS AGC vs NS for production server VAD — 2026-08-02

Read-only review. Only this file was created; no source, hardware, deployment,
or evidence was touched. Sources, at exact revisions:

- iterate `c-capabilities`, snapshotted **2026-08-02 15:51:50 BST (14:51:50Z)**
  at HEAD `950e6e9ca`, with uncommitted modifications to
  `apps/kit/{scripts/prove-production-stackchan-grok.ts, scripts/install-userspace-worker.ts, src/device/kit-device-contract.ts, src/userspace/config-worker/{worker,providers,pcm-proxy}.ts}`
  (+tests) and four untracked files
  (`src/device/voice-pe-aec-assessment.ts`, `src/userspace/config-worker/server-vad-policy.ts`, +tests);
- `~/src/github.com/esphome/voice-kit-xmos-firmware` @ `ef04d4b59d1`
  (XU316 firmware v1.3.1; its fwk_voice submodule is **not checked out** —
  AGC/AEC/IC/NS numeric parameters below were read from the pinned SHA
  `xmos/fwk_voice@8b80d3cf` upstream and are labelled **C-pin**);
- `~/src/github.com/esphome/home-assistant-voice-pe` @ `7f6c0b726`,
  `~/src/github.com/esphome/esphome` @ `31f4b4d00`, `~/esp/esp-idf` v5.4.2;
- retained runs under `apps/kit/evidence/home-assistant-voice-preview-edition-production-grok*`
  (eleven directories — see the race note below) and the StackChan anchor
  manifest `apps/kit/evidence/stackchan-production-grok-20260802-final/2026-08-02T08-54-57-839Z/manifest.json`.

Labels: **C** confirmed in local first-party source at the cited lines;
**C-pin** confirmed at the pinned upstream submodule SHA; **M** measured from
retained run artifacts; **H** hypothesis/inference.

> **Race note — the question was overtaken mid-review.** The prompt describes
> ch0=AGC and "the immediately proposed experiment" of switching to NS. While
> this review ran, the implementing agent landed the NS tap (commit
> `950e6e9ca`, 14:32Z), flashed it, and retained **three new runs**:
> `-ns` (14:34:47Z), `-ns-vad-floor` (14:39:11Z), `-ns-fixed-gain`
> (14:48:29Z). `providers.ts` changed threshold policy twice during the
> review window (0.85 profile → 0.1 flat at 14:38:16Z file time), and
> `voice-pe-aec-assessment.ts` on disk is a **post-run rewrite** of the
> assessment that produced the reviewed failure (its run-era far-end filter is
> unrecoverable: untracked file, overwritten, no git history). Every verdict
> below states which state it applies to.

## Executive verdict

**The NS direction was right; the experiment as proposed ("keep VAD threshold
0.85 initially") was refutable in advance from in-house anchors and did in
fact fail twice on hardware before being corrected; the state the tree
reached during this review — NS tap + worker-side fixed ×16 uplink gain +
threshold 0.1 — is the correct minimal configuration and is now physically
validated end-to-end except for one STT-homophone oracle word.** Root cause
is fully confirmed at source and in measurement: the uplink tap ended in
fwk_voice's `AGC_PROFILE_ASR` — initial gain +54 dB, max +60 dB, adaptation
gated on voice-likeness (which residual TTS echo satisfies), and loss
control **disabled** (`lc_enabled = 0`) even though the pipeline plumbs the
AEC's echo-correlation metadata straight into it (**C**/**C-pin**, §2.1). An
adaptive gain whose job is to drag whatever it hears toward −3…0 dBFS
erases the level distinction between near-end speech and far-end residue by
construction; measured, it amplified echo-only windows a median 158× and
ambient a median 267× against 93× for real speech (**M**, §1.3). No VAD
threshold can separate signals the AGC has re-normalized to the same level:
echo retriggers occurred in **every HAVPE run that ever played audio, at
threshold 0.1 and 0.85 alike**, including the program's only green manifest
(**M**, §1.4). The honest-metric question resolves the same way: with AGC on
ch0 no channel-ratio statistic is truthful (the per-window "gain" swings
64–812×); with NS on ch0 the raw/clean pair is same-scale for the first
time, and the newest run measures echo residual at the NS tap at mean-abs
0–15 — the identical acoustic moment that retriggered VAD through AGC at
mean 1,021–1,064 (**M**, §1.5). What remains before a green manifest is a
robust spoken oracle word, an explicit "no unexpected provider turns" gate,
a long-playback echo census, and provenance/assessment hardening (§8).

## 1. What the evidence actually shows

### 1.1 Run ledger (all 2026-08-02, UTC; all **M**)

| #   | run label                         | start | DAC vol | ch0 tap | VAD thr              | outcome                                                                                                                                                                                                                                                       |
| --- | --------------------------------- | ----- | ------- | ------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `production-grok`                 | 10:27 | +24 dB  | AGC     | —                    | died early: "Network connection lost", no provider session                                                                                                                                                                                                    |
| 2   | `current`                         | 11:32 | +24 dB  | AGC     | 0.1                  | fail: barge-in phrase not retained; **920 clipped Mac samples**; 3 echo turns                                                                                                                                                                                 |
| 3   | `0db`                             | 11:38 | 0 dB    | AGC     | 0.1                  | **PASS (only one)** — but AEC gate waived (`requiredForThisRun:false`, 0 samples), STT "independent-stt-provisional", and it contains an unflagged trailing echo turn "Interruption test complete."                                                           |
| 4   | `measured-aec`                    | 11:52 | 0 dB    | AGC     | ?                    | **no artifacts at all** (no failure/manifest/network/provider JSON) — the label promises a measurement that does not exist                                                                                                                                    |
| 5   | `post-move`                       | 12:35 | 0 dB    | AGC     | 0.1                  | fail: worker unreachable 67.9–75.9 s, PCM generation lost; first run with two-tap windows                                                                                                                                                                     |
| 6   | `clean-network`                   | 13:48 | 0 dB    | AGC     | 0.1                  | fail: "Far-end echo suppression was **−36.08 dB**" (equal-gain division defect, §3.1); loud-room contamination                                                                                                                                                |
| 7   | `clean-network-fixed`             | 14:02 | 0 dB    | AGC     | 0.1                  | fail: VAD latched **once for ~95 s transcribing a live German room conversation** (1 start / 0 stops, 73 transcript revisions); 0 downlink                                                                                                                    |
| 8   | `xmos-vad` (the reviewed failure) | 14:17 | 0 dB    | AGC     | **0.85**             | fail: see §1.2 — 6 VAD edges for 3 intended utterances; aborted by the AEC far-end selector                                                                                                                                                                   |
| 9   | `-ns`                             | 14:34 | 0 dB    | **NS**  | 0.85                 | fail **deaf**: 4,772 lossless frames, uplink peak 557, **0 speech starts**                                                                                                                                                                                    |
| 10  | `-ns-vad-floor`                   | 14:39 | 0 dB    | NS      | **0.1**              | fail **still deaf**: 4,773 frames, peak 581, 0 speech starts — the threshold lever is exhausted at xAI's documented floor                                                                                                                                     |
| 11  | `-ns-fixed-gain`                  | 14:48 | 0 dB    | NS      | 0.1 + **worker ×16** | **all gates pass except one**: 3/3 intended turns, 0 echo retriggers, honest AEC gate green (3.56 dB), digital clean, response RMS 25.6× baseline; Mac STT heard "production audio **tone** one" for "turn one" → transcript-match gate failed on a homophone |

Volume history: runs 1–2 ran the AIC3204 DAC at stock's 100 % endpoint
(+24 dB, register 0x41=0x30, commit `4d7c67c3b`); the +24 dB run clipped
(peak 32,380, 920 clipped Mac samples) and "made Grok transcribe its own
speaker output almost verbatim"; commit `591c39d77` (12:26Z) pinned 0 dB
(0x41/0x42=0x00), the loudest unclippable setting
(`firmware/platforms/iterate_voice_pe_audio/voice_pe_hardware_config.c:43-49`, **C**).

### 1.2 The reviewed `xmos-vad` failure, reconstructed (**M**)

Session config as acked by xAI (`provider-events.jsonl` seq 4,
`session.updated`): `server_vad {threshold 0.85, prefix 400 ms, silence
1000 ms}`, `enable_noise_suppression: true` (provider-side NS does not
remove intelligible echo), 16 kHz binary PCM both ways, `grok-transcribe`
input transcription, model `grok-voice-think-fast-2.0`.

The prompt's narrative — one unrequested `speech_started` after the
barge-in — **understates the failure**. The journal (99 events) holds **six**
`speech_started` edges for **three** intended utterances:

| edge | at (14:17/18:…) | what it was                                                                                                                                                                | input transcript                                                                                                       |
| ---- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| #1   | 50.671          | intended turn-1 prompt                                                                                                                                                     | "Reply exactly. Production audio turn one is clear and audible." (plus room-chatter mis-hearings "The holiday dates.") |
| #2   | 57.156          | prompt tail/room noise (before any downlink existed — not echo)                                                                                                            | same text re-completed                                                                                                 |
| #3   | 18:02.714       | **unrequested echo of turn-1 TTS**, mid-playback                                                                                                                           | "Production audio turn one is clear and audible." → spurious `response.created` 18:04.006                              |
| #4   | 18:04.488       | intended story request                                                                                                                                                     | "…Tell a long story about a blue robot…"                                                                               |
| #5   | 18:13.903       | **echo-opened segment that the intentional barge-in then rode**: fired 36 ms after `response.done`, while story audio played, transcribing story echo before the Mac spoke | "Once upon a time, in a quiet workshop. Stop and reply exactly. Interruption test complete."                           |
| #6   | 18:20.481       | **pure unrequested echo of "Interruption test complete."** — the flagged echo turn; never `speech_stopped`; last journal events                                            | "Interruption test complete."                                                                                          |

Distinction the prompt asked to preserve, sharpened: in this run the
categories physically merged — the _intentional_ barge-in (#5) landed inside
a VAD segment _opened by echo_, so its committed input item carries story
echo as a prefix. Only run 11 separates them cleanly (three edges, each
transcribing exactly one intended phrase, no echo prefixes, **M**).

Consequences inside the run: every `speech_started` fires a hardware purge
(worker terminal: `playbackInterruptionsRequested/Completed: 6`;
`pcm-proxy.ts` `#handleServerVadSpeechStarted` discards the reservoir and
requests one physical purge, **C**). Of 27.14 s of generated speech, 18.90 s
(604,920 B) were discarded at interruptions and only ≈8.2 s played; turn-1
playback was truncated at 3.20 s of 4.93 s **by the echo of turn-1 itself**
(#3). The echo problem is therefore not merely "an extra turn at the end":
it self-interrupts legitimate playback, creates spurious responses, and
contaminates intended turns' input items.

Transport was clean: device-sent bytes equal worker-received bytes exactly
in both directions (1,580 × 640 B up, 413 × 640 B down), zero
reconnects/drops/socket errors, provider journal contiguous 1..99, capture→
uplink ≤103 µs; network classification `audio-invalid` records that audio
gates, not the network, failed the run (**M**). The prompt's "1,553 uplink
frames" is the digital-assessment interval; the terminal counter is 1,580
(teardown timing, no loss).

The run was aborted by a thrown error from the AEC far-end selector —
"No speaker-active raw/processed AEC window was observed."
(`prove-production-stackchan-grok.ts:621`) — which is an artifact of the
run-era assessment, not of the echo or the room (§3.2).

### 1.3 The two channels, measured (**M**)

Per-second stride-8 windows (`KitRawCleanAecMetrics`, raw = ch1
`PIPELINE_STAGE_NONE` = physical mic 1, clean = ch0 = AGC tap; window
truth for "speaker active" is the device's own `playbackContentSamples`):

- Echo-only playback windows (seq 42–45, 53–55, 61–62): raw peaks 182–269,
  raw mean-abs 7–32; clean peaks 9,107–29,116, clean mean-abs 1,021–4,381.
  The prompt's figures verify exactly, provided seq 56 is excluded — that
  window (raw mean 70, peak 456) is **double-talk** (the barge-in phrase over
  story playback), not echo.
- Near-end speech windows (playback = 0): raw mean 43–82, clean mean
  2,313–8,497.
- clean/raw mean-abs ratio by class: near-end speech median **93×**,
  echo-only median **158×**, ambient median **267×** (max 812×). The gain is
  largest exactly where the input is quietest — the AGC normalizing
  everything toward its target band. After the conversation ended (uplink
  frozen), ambient windows crawl from clean mean 573 to 4,851 over ~7 s with
  raw mean 2–7 — an idle room raised to speech-like levels.
- Raw-channel absolute calibration sanity (**H**): a MEMS PDM mic at
  −26 dBFS/94 dB SPL puts conversational speech near −55 dBFS RMS ≈
  mean-abs ~60 in int16 — the measured 43–82 is a _normally calibrated_
  acoustic front end, not a broken one. It only looks quiet next to
  full-scale expectations; bridging that calibration to ASR level is
  precisely the job stock delegates to AGC (or, for its wake path, to a
  fixed ×4 — §2.2).

### 1.4 Echo retriggers are threshold-independent on the AGC tap (**M**)

Unrequested `speech_started` edges transcribing the device's own TTS
occurred in `current` (thr 0.1: three), `0db` (thr 0.1: three, including a
trailing "Interruption test complete." identical to the reviewed one),
`clean-network` (thr 0.1: two, plus eight VAD cycles on room speech), and
`xmos-vad` (thr 0.85: three). Raising the threshold 0.1 → 0.85 changed
nothing about echo and only made the device harder to trigger legitimately.
At 0.1 the AGC tap also produced the ~95 s latched ambient utterance
(run 7) — quiet room conversation streamed and transcribed continuously —
the AGC failure mode with the worst privacy character, and the motivation
for the worker's new 60 s speech watchdog
(`pcm-proxy.ts` `SERVER_VAD_MAXIMUM_SPEECH_MS`, **C**).

### 1.5 The post-review NS runs close the causal chain (**M**)

- NS tap, native level: uplink speech peaked 557 (0.85 run) / 581 (0.1
  run) with mean-abs ~60–80; **zero** VAD edges across ~4,770 lossless
  frames in each. xAI's server VAD behaves as an absolute-level gate across
  three orders of magnitude of this program's data (fired at clean mean
  ~8,500 and at echo mean ~1,021 under 0.85; fired at mean 810 and not at
  466 under 0.1 on StackChan; deaf at mean ~70 under both). Threshold has
  no remaining headroom below 0.1 (xAI documented floor).
- NS tap + worker ×16 (+24.1 dB) + 0.1: three edges for three utterances,
  each input transcript exactly the intended phrase with no echo prefix;
  playback windows show NS-tap echo residual at **mean-abs 0–15** (the
  "Interruption test complete." echo that fired VAD through AGC at mean
  1,021–1,064 measures 0–1 here); double-talk windows preserve near-end
  speech at ≈ unity (raw 49→clean 48; raw 63→clean 81). At the provider,
  residual ×16 ≤ ~240 sits under the StackChan 466-no-fire anchor while
  speech lands at mean ≈1,150–1,300 — inside the proven trigger envelope.
  The first two playback windows also record the AEC converging on its
  first-ever reference (residual 11→15→5→3→…→0 mean), after which
  residual stays at the floor through all later playbacks — the AEC is
  healthy (**M**).

## 2. Q1 — root cause, and was NS-without-AGC the right smallest experiment?

### 2.1 Confirmed mechanism: `AGC_PROFILE_ASR` on the uplink tap

The XMOS pipeline is one mono chain AEC → IC → NS → AGC; the per-channel
"stage" is a cumulative tap depth, re-read every 15 ms frame
(`voice-kit-xmos-firmware/src/ffva/src/main.c:170-204`, **C**). The AGC is
initialized with `AGC_PROFILE_ASR`
(`modules/audio_pipelines/reference/fixed_delay/audio_pipeline_t0.c:146`,
**C**) whose parameters at the pinned fwk_voice SHA are (**C-pin**,
`modules/lib_agc/api/agc_profiles.h`):

- initial gain 500 (**+54.0 dB**), `max_gain` 1000 (**+60.0 dB**), min 0;
- `adapt = 1`, `adapt_on_vnr = 1` — adaptation runs when the VNR judges the
  frame voice-like; **residual TTS echo is voice-like**, so echo actively
  drives adaptation;
- peak-target band 0.70–0.9999 FS; gain slews +1.56 dB / −1.21 dB per
  15 ms frame;
- **`lc_enabled = 0` with every `lc_*` parameter zeroed** — the loss-control
  machinery that would suppress gain during far-end activity is switched
  off, even though this very pipeline computes and passes `aec_corr_factor`
  and `max_ref_energy` into the AGC's metadata each frame
  (`audio_pipeline_t0.c:127-129`, **C**). Nothing else downstream is
  echo-aware: the IC adapts on VNR (freezes on speech-like residual, and as
  a 2-mic spatial canceller has no echo-specific rejection; the
  `ref_active_flag` field exists in the frame struct but is never written
  or read — `audio_pipeline_dsp.h:50`, **C**), and the NS is an MCRA
  stationary-noise suppressor that passes speech-like residue (**C-pin**).

So the observed behavior is the designed behavior of this profile: any
quiet window — echo residue or ambient — is regenerated toward the target
band at up to 60 dB. The measured per-class gains (93×/158×/267×, §1.3)
sit inside the profile's [0, +60 dB] envelope. For a provider VAD that
gates on absolute input level plus speech-likeness, an _intelligible_ echo
re-normalized to speech level is indistinguishable from speech; the
observed 100 % playback-retrigger rate follows.

### 2.2 First-party precedent supports the NS tap

Stock HAVPE uses the AGC tap only for its half-duplex STT phase, which
never listens while the device's own TTS plays; the only stock consumer
that must survive echo — the always-on wake-word engine — runs on
**channel 1 = NS with a fixed host-side ×4 (+12 dB) gain**
(`home-assistant-voice.yaml:1706-1711` `gain_factor: 4` vs `:1798-1808`;
defaults `voice_kit/__init__.py:86-91`, **C**), and its predecessor did the
same (`amplify_shift: 2` on the comm channel, `git show f643d03^`, **C**).
The vendor's own answer to "echo-exposed listener" is NS + fixed gain, not
AGC. (Caveat, **H**: the wake engine is a keyword detector, far more
echo-tolerant than a server VAD, so this is precedent for the tap choice,
not proof of VAD behavior — which is why the census in §4 still matters.)

### 2.3 The competing candidates, dispositioned

| candidate                      | verdict                                                       | evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| I2S reference format/amplitude | **refuted** (**C**/**M**)                                     | The AEC reference is the same electrical line the DAC listens to — the XMOS never re-transmits playback (i2s1 TX commented out, `main.c:207-211`; DAC parallel on the XMOS-clocked bus); our TX is wire-identical to stock (16-bit LJ in 32-bit slots @48 kHz slave, `voice_pe_pcm_format.c:23-36`, stock `i2s_audio_speaker.cpp:640,660`); playback was audible and exactly transcribed (run 11: response RMS 25.6× baseline). Malformed reference and clean audible playback cannot coexist on this topology.                                              |
| fixed 40 ms mic delay          | **refuted as a defect** (**C**)                               | `appconfINPUT_SAMPLES_MIC_DELAY_MS 40` delays the _mics_ (not the ref) inside the XMOS (`app_conf.h:47-51`, `audio_pipeline_t1.c:64-107`) — a causality margin, stock-tuned for exactly this hardware path, well inside the AEC's 150 ms tail (10 phases × 240 samples, `audio_pipeline_dsp.h:19-22`). Our ESP32 adds only 62.5 µs (interpolator). Note it _does_ skew raw-vs-clean windows by ~40 ms+pipeline latency, because the NONE tap bypasses the delay (`main.c:171-173,189-191`) — an assessment caveat, not an audio defect.                      |
| wrong channel interpretation   | **refuted** (**C**/**M**)                                     | Boot writes ch0/ch1 taps and **fails closed on read-back mismatch** (`voice_pe_audio_owner.c:389-434`, commands `{241,0x30/0x40,1,stage}` `voice_pe_hardware_config.c:97-163`); this also closes the XMOS-boot-default trap (XMOS defaults ch1=**AEC**, not NONE — `configuration_servicer.c:19-20` — and taps are volatile across the reset the ESP32 pulses every boot). The near-end simultaneous-window ratio (~104×) and the AGC's slew signature in the clean channel confirm which channel is which.                                                  |
| speaker routing / volume       | **refuted as root cause** (**C**/**M**)                       | Volume is a DAC-register affair pinned at 0 dB since 12:26Z; +24 dB made everything worse but 0 dB still echoed through AGC. Playback loud and clean in run 11 (25.6× baseline RMS).                                                                                                                                                                                                                                                                                                                                                                         |
| AEC adaptation state           | **refuted as primary; bounded residual caveat** (**C**/**M**) | The XMOS pipeline has no stream lifecycle: `aec_init` runs once at boot, I2S runs continuously, no control command resets DSP state (**C**). Run 11 shows convergence within ~2 s of first reference and a stable floor afterwards (**M**). Residual caveat (**H**): each barge-in purge briefly `i2s_channel_disable`s the slave TX (`reset_playback_state`, `voice_pe_audio_owner.c:755-797`), blanking the reference line for a moment — six such blanks in the reviewed run; worth keeping in mind if a future census shows brief post-purge echo blips. |
| raw mic "suspiciously quiet"   | **explained, not a defect** (**C**/**H**)                     | No gain or shift exists anywhere on the raw path in the XMOS app (**C**; the one unverifiable link is the decimator scaling inside the absent `esphome/xmos_fwk_io` submodule); the absolute level matches standard MEMS calibration arithmetic (§1.3). Stock's ×4 wake-path gain corroborates "hot-side-down by design".                                                                                                                                                                                                                                    |

### 2.4 Verdict on the proposal

Directionally correct and now vindicated; as-specified, unsound. Dropping
AGC removes ~40–57 dB from the only signal the provider VAD sees, and the
program already owned the two anchors that predict deafness: StackChan's
proven trigger at clean mean 810 under threshold 0.1, and this run's speech
at raw-scale mean ~82. "NS, keep 0.85, rerun production" burned a flash and
two runs to learn what the anchors already said (runs 9–10). The smallest
_sound_ experiment was NS **plus a fixed, measured makeup gain** at an
unchanged threshold of 0.1 — which is what the tree converged on (worker
×16, `server-vad-policy.ts:29-31`) and what run 11 validates. The
`voice_pe_hardware_config.c:74-77` comment ("provider-side input gain can
be tuned independently") promised a knob that does not exist in the xAI
session surface; the deliverable turned out to be worker-side PCM
multiplication, and the comments in both files should now say so (§6).

## 3. Q2 — what metric honestly proves AEC, and which gate selected double-talk

### 3.1 With AGC on ch0: nothing is honest

The channels are intentionally unequal-gain
(`kit-device-contract.ts`, `KitRawCleanAecMetrics` docstring), and the
run-history shows both failure modes of pretending otherwise:

- Direct division (run 6): "Far-end echo suppression was **−36.08 dB**" —
  the assessment reported the AGC's gain as negative AEC.
- Gain normalization against one near-end calibration window (runs 7–8):
  assumes the ch0 transfer is a constant. Measured, it is 64–812×
  window-to-window (§1.3); replaying the reviewed run's own windows through
  the current formula yields **+0.47 dB or −5.6 dB depending only on which
  full-playback window the tie-break picks** (**M**). Under an adaptive
  60 dB-range gain the statistic has no stable sign, let alone magnitude.

The only honest statements possible through an AGC channel are behavioral:
transcripts of echo (existence proof of leakage) and VAD edge counts. Both
existed in every AGC run and neither was gated (§3.3).

### 3.2 The gate that could only be satisfied by double-talk, and the abort

The reviewed run was aborted by the run-era far-end selector finding zero
windows despite ten playback-active windows (five at full coverage
16,320/16,320). The run-era filter is unrecoverable (untracked file,
since overwritten), but its behavior is bracketed by the artifacts: it
discarded playback windows whose **raw**-channel energy was too low —
`clean-network`'s far-end window with raw mean 102 qualified, `xmos-vad`'s
maximum playback-window raw mean of 70 did not, so its floor lay in
(70, 102] (**M**). On this hardware, echo-only windows measure raw mean
7–32; the only windows that can clear a raw-energy floor ≥~70 during
playback are those where **someone is speaking over the playback** — i.e.
the gate structurally selected near-end double-talk (seq 56, raw mean 70,
is the harness's own barge-in over the story) or nothing. It found nothing
and threw, aborting the run mid-teardown (`prove-production-stackchan-grok.ts:621`,
**C**). A far-end-selection gate whose satisfying condition is "the
experiment is contaminated" is the exact defect the question asked to
locate.

The rewritten on-disk selector (`voice-pe-aec-assessment.ts:103-109`)
correctly switched to playback accounting (`playbackContentSamples ≥ 8,000
&& rawMeanAbsolute > 0`) — its docstring even names the old failure —
but it still has **no double-talk exclusion**: seq 43, 44, 54, 55, 62 all
saturate `playbackContentSamples` at 16,320 and tie; the winner is decided
by stable-sort order (earliest sequence). In the reviewed data that luckily
lands on a genuine far-end window (43); one slot of different timing and
the barge-in double-talk window (55/56) becomes "the" far-end evidence.
The harness knows exactly when it played `near-end-*.aiff` through the Mac
(`playMacSpeech`, `prove-production-stackchan-grok.ts:816-819`) and already
timestamps every AEC sample (`:220-226`); none of that reaches the
assessment (**C**).

### 3.3 The honest metric under NS, and what run 11 already shows

With ch0=NS and ch1=NONE both channels are fixed-gain for the first time,
and the existing window stream becomes a true same-scale instrument:

- **Far-end residual ratio**: median of `cleanMeanAbsolute/rawMeanAbsolute`
  over **all** full-coverage playback windows that do **not** overlap a
  harness speech interval (±1 window margin) — not a single tie-picked
  window. Run 11's qualifying windows give clean 0–15 vs raw 1–22, with
  the only ≥1.0 ratios in the first two windows of first-ever convergence.
- **Near-end unity check**: playback-quiet speech windows, expect ratio
  ≈1 (measured 1.03) — this is now a _calibration verification_, not a
  gain estimate.
- **Double-talk preservation**: windows with playback ≥ half coverage AND
  harness-speech overlap, expect clean ≈ raw (measured 0.98 and 1.29) —
  the goal document's "<3 dB near-end damage" gate, finally measurable.
- **Behavioral echo gates** (stronger than any ratio, §4/§6): exact
  `speech_started` counts and no echo text in input transcripts.

Two residual honesty caveats to document in the assessment (both bounded):
mic 1 (raw) vs mic 0 (clean source) are different physical microphones,
and the NONE tap bypasses the 40 ms delay — so per-window ratios carry a
few dB of channel asymmetry and ~40–55 ms of edge skew; full-coverage
1.02 s windows over steady material absorb both. The 3 dB
gain-normalized gate is now meaningful, but it should be computed over the
window population and gated on tap identity (refuse to emit the statistic
at all when the configured stage is AGC — the tap is in the boot readback
and should ride into provenance, §6).

Also fix the near-end candidate floor: `cleanPeak ≥ 500`
(`voice-pe-aec-assessment.ts:69`) passed run 11 only because speech peaked
557/581 — ~1 dB of margin on the very configuration the file was rewritten
for. Under NS the near-end floors should derive from the measured NS-tap
speech envelope, not from AGC-era levels.

## 4. Q3 — the fewest-flashes deterministic discriminators

The original decomposition question ("is it the AGC, the ref, the delay,
the channels, adaptation?") is settled by source plus runs 9–11; no tap
ladder is needed for that anymore. What remains unmeasured, in order of
value per flash:

1. **Long-playback echo census — zero flashes, zero new firmware.** One
   server-VAD production-shaped run on the current build (NS, ×16, 0.1):
   prompt one story of 60+ s, then stay silent through the entire playback
   and 15 s beyond. Gates: exactly 2 `speech_started` for the session
   (prompt + nothing), zero edges while `playbackContentSamples > 0`, NS-tap
   residual population statistics retained. This converts run 11's 8 s of
   echo-clean playback into a claim with statistical weight, and it
   exercises the AGC-era failure signature directly. Stop condition: any
   echo edge → drop gain ×16→×8 (still ≥ mean 576 speech at the provider,
   above the 466 no-fire/810 fire anchors' gap) before touching anything
   else.
2. **Double-talk turn (already in the standard proof)** — the barge-in leg
   covers it; keep it after the census in the same session if possible.
3. **AEC decomposition ladder — only if 1 or 2 fails.** The tap is
   compile-time (`iterate_kit_voice_pe_xmos_uplink_stage()`; no runtime
   config path exists on the device control surface, **C**), so a ladder
   costs one flash per stage. One diagnostic flash with ch1=AEC (keeping
   ch0=NS uplink) yields same-scale NONE-vs-AEC… except NONE is then gone —
   so the practical pair is sequential runs ch1=NONE (existing data) and
   ch1=AEC (one flash), same canned far-end material, comparing window
   populations. Do not use `kit-pcm-mode = tone` for echo work: a
   stationary tone is exactly what the MCRA NS suppresses best and would
   overstate the pipeline (**C-pin** for NS character); use spoken TTS
   material.
4. **Not worth a flash now**: XMOS-side experiments (LC-enable rebuild,
   §8.7) or ESP32-side gain (worker gain is runtime and already proven).

## 5. Q4 — VAD profile and gain: the measured ladder

Every anchor this program owns, in one table (**M** throughout; xAI
threshold semantics per its OpenAI-compatible documentation family:
higher threshold ⇒ requires louder audio; xAI documents 0.1 as the floor
and 0.5/300/200 as defaults):

| uplink signal at provider                     | thr          | result                                      |
| --------------------------------------------- | ------------ | ------------------------------------------- |
| StackChan clean speech, mean 810              | 0.1          | fires (proven manifest)                     |
| StackChan AEC-mangled residual, mean 466      | 0.1          | does not fire                               |
| StackChan speech, peak 12,670                 | 0.5          | does not fire                               |
| HAVPE AGC ambient/echo, mean ~600–4,800       | 0.1          | fires continuously (95 s latch; echo turns) |
| HAVPE AGC intelligible echo, mean 1,021–4,356 | 0.85         | fires (3 echo turns)                        |
| HAVPE AGC speech, mean ~8,500                 | 0.85         | fires                                       |
| HAVPE NS speech, native peak 557/581          | 0.85 and 0.1 | deaf                                        |
| HAVPE NS ×16 speech, mean ≈1,150–1,300        | 0.1          | fires 3/3, zero false edges                 |

Ladder (each rung gated on the previous, no speculative tuning):

1. **Hold `{NS, ×16, 0.1, prefix 400, silence 1000}`** — the only
   configuration that has ever produced exact-count VAD edges on this
   hardware. Do not "try" 0.2/0.5: 0.5 is measured-deaf 12,670-peak
   StackChan speech, and HAVPE NS ×16 speech peaks ≈8,900.
2. Run the §4.1 census. Pass ⇒ freeze the profile and record it in
   provenance; the tuning phase is over.
3. Census failure mode A — any echo edge: **halve the gain (×8)**, keep
   0.1; speech mean ≈576 remains within ~3 dB of the proven 810 fire
   point while residual headroom doubles. If echo persists at ×8, the
   problem is no longer gain-shaped: go to §4.3 (AEC decomposition) — do
   not compensate with threshold.
4. Census failure mode B — missed real speech (VAD deaf on a legitimate
   prompt): raise gain ×16→×24 (+3.5 dB; clip onset moves to raw peak
   1,365 — check `uplinkClippedSamples` stays ≈0 for normal speech) before
   touching the threshold; the threshold's next stop (0.5) is measured-deaf
   far above this level.
5. Keep the 60 s speech watchdog regardless — it bounds the residual
   privacy/latch risk that no threshold can (**C**, `pcm-proxy.ts:53`).
6. Record in the artifact, per run: threshold, prefix, silence, gain
   multiplier, uplink tap, DAC volume (§6.3). The ×16 constant's
   derivation should be written where it lives (`server-vad-policy.ts`):
   _(strongest anchor)_ speech mean 72–82 ×16 ≈ 1,150–1,300 ≥ proven 810;
   residual ≤15 ×16 ≤ 240 < 466 non-fire anchor; clip onset raw peak
   2,048 vs measured speech peaks ≤581.

Clipping note: ×16 clips raw peaks >2,047; the loud-room German
conversation in run 7 hit raw 3,560 and would clip. The clip counter is
already computed and kept honest (counted only after a successful send,
`pcm-proxy.ts:758-781`, **C**); surface it in the digital assessment's
zero-tolerance list only as a _report_, not a gate — clipped loud speech
still trips VAD, which is the function being bought.

## 6. Q5 — defects, unsafe claims, missing tests, shortest cleanup

Ranked; "fix" is the shortest honest change, none applied by this review.

1. **No "unexpected provider turn" gate — the reviewed failure's defining
   symptom is invisible to every gate.** All worker-counter waits are
   `>=`/`>` and event checks are `some(...)`
   (`prove-production-stackchan-grok.ts:371-382,398-409,444-449,489-494`);
   6 edges for 3 utterances passed everything, and the run "failed" only
   via an unrelated selector throw. The only green HAVPE manifest (`0db`)
   contains the same trailing echo turn, unflagged — do not cite it as an
   echo-clean baseline. Fix: exact expected `speech_started` counts per
   phase, assert none while `playbackContentSamples > 0` windows are
   uncontaminated by plan, assert terminal `providerSpeechStarts ===
plan`, and assert each intended turn's input transcript contains its
   phrase and no provider-output text (the barge-in item's story-echo
   prefix in run 8 — and its absence in run 11 — is the cleanest signal
   this program has).
2. **Far-end selector: double-talk admissible, tie-order decisive**
   (§3.2/3.3; `voice-pe-aec-assessment.ts:103-109`). Fix: exclude windows
   overlapping harness speech intervals (the harness has them), aggregate
   over the qualifying population instead of picking one, and gate the
   statistic on tap identity (never emit through AGC).
3. **Provenance does not identify the experiment.** The label lives only
   in `--output-directory`; provenance carries device/project/routes only
   (`production-device-proof.ts:282-303`); the VAD numbers survive only
   because the journal happens to retain `session.updated` (they do — seq 4
   in every run with events — contra the folk claim that they are
   unrecoverable); tap, gain, DAC volume, worker commit, firmware hash are
   nowhere. Two files in this history are named after measurements they do
   not contain (`measured-aec`: no artifacts at all; `0db`'s pass waives
   AEC). Fix: extend provenance with `{runLabel, uplinkStage, dacVolume,
turnDetection: {threshold, prefixMs, silenceMs}, uplinkGainMultiplier,
workerCommitOid, firmwareDescribe, assessedAecFirstSequence}`.
4. **The run-era assessment was lost while under review.** The exact
   far-end filter that aborted run 8 is unrecoverable (untracked file
   overwritten within the hour; `server-vad-policy.ts`'s run-era profile
   name `xmos-aec-agc` survives only inside failure.json). Three
   uncommitted-policy states shipped to production within one afternoon,
   including ~10 minutes where `providers.test.ts` expected 0.1 while
   `providers.ts` sent 0.85. Fix: commit the worktree now (the standing
   backup discipline exists for exactly this), and treat "evidence-facing
   policy files are committed before a retained run" as a rule.
5. **Stale/overclaiming comments** (all one-line fixes): boot log
   hard-codes `"channel0=NS(AEC+IC+NS)"` independent of
   `iterate_kit_voice_pe_xmos_uplink_stage()`
   (`voice_pe_audio_owner.c:1223-1226`);
   `tests/voice_pe_pcm_format_test.c:110-112` still says ch0 is the
   AGC pipeline; `voice_pe_hardware_config.c:74-77` says "provider-side
   input gain" (no such knob exists — the mechanism became worker PCM
   multiplication); `providers.ts` threshold comment says the change
   arrives "without multiplying PCM" (true of the threshold, false of the
   session since `uplinkGainMultiplier` landed); `server-vad-policy.ts`
   cites a 581 peak where `providers.ts` cites 557 (two different runs —
   say which); `kit-device-contract.ts` describes ch0 as "AEC+IC+NS"
   (true today, but the contract should say "the configured stage tap"
   and point at provenance).
6. **Assessment reproducibility**: `aec.samples` retains the full timed
   array but the assessed slice boundary (`acceptanceAecIndex`) is
   unrecorded, and the 720-cap `shift()` silently invalidates the saved
   index on long runs (`prove-production-stackchan-grok.ts:225,343-346,597-600`).
   Fix: store the acceptance boundary as a _sequence number_ and slice by
   it.
7. **Near-end floors are AGC-era** (`cleanPeak ≥ 500` vs measured NS speech
   peaks 557/581 — ~1 dB margin; §3.3). Fix: derive from tap profile.
8. **`findLast` transcript selection**
   (`production-grok-provider-events.ts:144-146`) — an echo turn completing
   late substitutes its transcript into the acceptance check. Fix: select
   the `response.done` by correlated response id.
9. **Oracle phrase is homophone-fragile** (**M**, run 11: "tone one" for
   "turn one"; precedent: StackChan's "Stack Shannon"). Fix: keep strict
   matching, choose phonetically unambiguous oracle words (the StackChan
   remedy), never loosen the gate.
10. **Duplicated window machinery**: `voice_pe_audio_owner.c:291-364`
    privately reimplements windowing while including the tested shared
    `aec_signal_window.h` it doesn't use (dead include, untestable
    file-static logic). Fix: either use the shared component or delete the
    include and add a host test for the private rotation.
11. **Crash-before-assembly leaves nothing** (run 4 `measured-aec`: zero
    JSON). Fix: write a minimal failure.json skeleton at run start,
    overwrite at completion.
12. Minor: stride-8 peaks are lower bounds (document at consumers);
    `farEndEvidenceSettlingMs = 1_800` hard-codes the 1 s window length;
    `turnEvidence[0].workerActiveResponse` is always null; grammar nits in
    `metrics.h:174`.

Not defects, verified in passing: `evidenceAssemblyErrors` paths all set
`runFailure` (no vacuous pass there); interruption byte-ledger closes
exactly (27.16 s ≈ 8.26 played + 18.90 discarded); frame conservation is
byte-exact in both directions; the worker gain implementation keeps
device-level metrics pre-gain and only counts uplink peaks/clips after a
successful provider send (**C**/**M**).

## 7. Q6 — CPU/RAM/realtime audit of the recommendation

- **XU316**: zero delta. All pipeline stages execute every frame
  unconditionally; the per-channel stage is a pure output mux re-read each
  15 ms frame (`main.c:170-204`, tile task lists `audio_pipeline_t0.c:155-161`,
  `t1.c:154-159`, **C**). AGC→NS changes which slot is copied, nothing else.
- **ESP32**: zero delta. Identical rates, buffers, DMA geometry, task
  timing; the tap differs by one byte in one boot-time I2C write. Static
  memory at the NS build: ≈126 KiB internal DRAM (data+bss), 95.8 KiB
  IRAM, ~145 KiB PSRAM bss, ~720 KiB flash text (GNU ld map, **C**);
  capture→uplink latency measured ≤104 µs against a 100 ms gate (**M**).
  If a device-side gain were ever wanted it costs one saturating multiply
  on 16 k samples/s (~immeasurable on a 240 MHz LX7) — but the worker
  placement is better and already shipped.
- **Worker**: the ×16 gain is an in-place per-sample loop over each 640 B
  frame (~16 k multiplies+clamps/s per session) reusing the received
  buffer — no allocation, no queue, no added latency beyond the same
  `send()` call (`pcm-proxy.ts:753-781`, **C**). Threshold/gain changes are
  a worker redeploy; no reflash.
- **Realtime**: no change to frame pacing anywhere; the NS tap removes no
  stage from the XMOS pipeline, so end-to-end latency is identical; the
  62.5 µs interpolator latency and 40 ms XMOS mic delay are unchanged
  stock-shaped constants.

## 8. Ranked go/no-go checklist

1. **GO — keep the landed configuration**: ch0=NS, ch1=NONE, worker
   `uplinkGainMultiplier` ×16, VAD `{0.1, 400, 1000}`, DAC 0 dB. It is the
   only configuration with a measured 3-for-3 exact-turn run and
   floor-level echo residual (runs 9–11). Commit the worktree first —
   evidence-facing policy is currently untracked history.
2. **GO — add the unexpected-turn gates before the next retained run**
   (§6.1): exact `speech_started` counts, no edge during uncontaminated
   playback windows, input-transcript purity. These convert the entire
   failure class of today into regression tests; they would have failed
   every AGC run including the green one.
3. **GO — rerun the standard proof for the manifest** with a
   homophone-robust oracle word (§6.9). Run 11 failed on "tone/turn"
   alone; everything else was green.
4. **GO — long-playback echo census** (§4.1), zero flashes, and freeze the
   profile on pass; on echo edges drop gain to ×8 before anything else
   (§5.3).
5. **GO — provenance completeness** (§6.3) and the assessment double-talk
   exclusion + population aggregation + tap-identity gating (§6.2, §3.3).
6. **CONDITIONAL — AEC decomposition ladder** (one flash per tap, §4.3)
   only if the census or double-talk evidence degrades; today's data says
   the AEC converges in ~2 s and holds residual at the floor.
7. **NO-GO — XMOS firmware rebuild to enable AGC loss control.** It is the
   principled in-DSP fix (`lc_enabled` in the profile at
   `audio_pipeline_t0.c:146`, metadata already plumbed), but it needs the
   xcore toolchain, a DFU cycle, and a release pipeline to solve a problem
   the NS tap has already solved host-side. Keep as the recorded fallback
   if AGC is ever genuinely needed on the uplink.
8. **NO-GO — any further VAD-threshold tuning.** Both ends are measured
   dead: 0.85 is deaf-or-echoing depending on gain; 0.1 is the documented
   floor and works only inside the proven level envelope. Level placement
   (gain) is the lever; the threshold is settled.
9. **NO-GO — re-raising DAC volume above 0 dB** during this phase (+24 dB
   is measured-clipping and echo-amplifying), and **NO-GO — re-introducing
   any adaptive gain stage on the uplink** (device or worker). The entire
   failure class was an adaptive gain in the VAD's signal path.
10. **NO-GO — tone-mode echo experiments** (§4.3): the stationary-noise
    suppressor makes tones the one far-end signal that flatters the
    pipeline.

### External references

- xAI voice/agent API (server VAD, thresholds, session.update):
  https://docs.x.ai/docs/guides/voice and
  https://docs.x.ai/developers/model-capabilities/audio/voice-agent
- OpenAI-compatible server-VAD threshold semantics ("higher threshold
  requires louder audio"): https://developers.openai.com/api/docs/guides/realtime-vad
- LiveKit xAI plugin (documented defaults threshold 0.5 / prefix 300 /
  silence 200): https://docs.livekit.io/agents/models/realtime/plugins/xai/
- XMOS fwk_voice at the pinned SHA (AGC profiles, lib_agc/lib_ic/lib_ns):
  https://github.com/xmos/fwk_voice/tree/8b80d3cf684934f038b6ae3167a70cacfb6dd2c1
