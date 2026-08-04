# StackChan AEC/double-talk current-state review

Use Claude Fable with maximum effort. Work read-only except for writing the
final report to
`apps/kit/docs/fable-stackchan-aec-double-talk-current-review-2026-08-03.md`.
Do not modify firmware or tests.

We need the fastest technically sound route to production-quality, local AEC
and server-side VAD on M5Stack CoreS3/StackChan. Inspect current source, the
exact ESP-IDF 5.4.2 / ESP-SR 2.4.7 sources and first-party documentation, the
prior art at `/Users/jonastemplestein/src/github.com/iterate/stackchan`, and the
durable reports already under `apps/kit/docs/`. Do not repeat old advice without
checking it against the current code and the newest measurements.

Current implementation and evidence:

- `apps/kit/firmware/platforms/iterate_core_s3_audio/core_s3_audio_owner.c`
- `apps/kit/firmware/components/core/src/aec_capture_bridge.c`
- `apps/kit/firmware/components/core/src/aec_reference_scaler.c`
- `apps/kit/firmware/components/core/src/aec_uplink_selector.c`
- `apps/kit/evidence/stackchan-analog-reference-voip-20260803/2026-08-03T18-00-26-107Z`
- `apps/kit/evidence/stackchan-production-grok-receipt-fix-20260803/2026-08-03T18-19-08-334Z`

The new physical analog speaker-divider reference (TDM slot 1, scaled x8)
improved far-only residuals to about -42 dBFS tone, -45 dBFS PRBS and -47 dBFS
speech. Yet deterministic double-talk fails: near similarity about 0.832, near
gain about 0.583, residual-to-near about -8.21 dB, and far residual energy about
-12.47 dB. In a real production barge-in run, far-only suppression was about
10.24 dB and the near-only clean/raw energy ratio reached 4.0. Grok therefore
retained imperfect near speech and response/self-talk could open server VAD.

Answer, with source citations and exact current-code references:

1. Is ESP-SR VOIP AEC being fed the required channel order, frame size, sample
   format, reference amplitude, and timing? Identify any violated first-party
   precondition.
2. Does the physical divider need a different fixed scale, polarity, DC/highpass
   treatment, delay alignment, or use of another TDM tap? Propose a measured
   calibration ladder, not guesses.
3. Is VOIP AEC the right primitive for double-talk here, or would ESP AFE
   FD_HIGH_PERF / a different ESP-SR API materially improve near-speech
   preservation? Give measured CPU/internal-RAM/PSRAM consequences for ESP32-S3.
4. Find any current code path that can feed stale/misaligned reference, apply
   nonlinear gain, select an inappropriate output stage, or corrupt near speech.
5. Give no more than three ranked implementation options. For each, state the
   smallest decisive test and the explicit rollback/kill criterion.

Prioritize deletions and simplifications. Reject any blanket speaker-active mute
or server-side gate: genuine simultaneous near speech must survive and self-talk
must not reach Grok.
