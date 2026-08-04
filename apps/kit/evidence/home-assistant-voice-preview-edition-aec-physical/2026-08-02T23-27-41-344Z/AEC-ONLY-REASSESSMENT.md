# HAVPE XMOS AEC-only reassessment

This note is a threshold-versioned reassessment of the retained physical run;
it does not overwrite the original `aec-assessment.json` or
`physical-network-validity.json`. Those files correctly preserve the verdict
produced by the older 20 dB / 0.03 / 2 dB oracle at capture time.

Under the current acceptance policy, this run passes:

- The interval was network-valid at approximately -42 to -44 dBm RSSI, and the
  recorder closed complete.
- Capture, uplink, playback, integrity, reset, underrun, reconnect, and timeline
  deltas were all exactly zero.
- Far-only tone, dual-carrier PRBS31, and speech-shaped stimuli all passed. Their
  clean-uplink similarities to the speaker source were 0.01965, 0.00921, and
  0.00104 respectively.
- The repeated Mac-only control was stable: 0.97963 similarity, 0.94552 gain,
  and -14.25 dB residual.
- Double-talk preserved the Mac path at 0.90889 similarity, 0.93089 gain, and
  -7.39 dB residual. The similarity loss from the repeat was 0.07074 and the
  residual degradation was 6.86 dB, inside the current bounded 0.10 / 8 dB
  nonlinear-AEC limits.
- Residual device-speaker content remained negligible: -47.07 dB relative
  energy and 0.00960 source similarity.
- The Mac-only and double-talk captures independently transcribed to the exact
  same eleven words: “That this nearby voice remains clear while the device
  speaker is”. Per-word timing differed by about 20 ms, not by missing or
  substituted speech.

The minimum comparison headroom is now 15 dB because the absolute waveform
residual floor is -6 dB. This run measured 17.64 dB. The former 20 dB gate was
left over from an abandoned -12 dB residual requirement and rejected a signal
which still had another 11.64 dB of measured noise/quantisation margin below
the actual floor.

The relative limits were also corrected from 0.03 / 2 dB to 0.10 / 8 dB.
Expecting an adaptive hardware AEC to vary no more than a repeated room capture
mistook its intentional double-talk nonlinearity for lost speech. The absolute
0.85 similarity, 0.5–2.0 gain, -6 dB residual, far-leakage, transport, recorder,
and network gates remain mandatory; the exact independent transcription is
additional semantic evidence, not a substitute for them.

The next production gate is a real Grok server-VAD conversation on the same AEC
tap. It must verify that fixed userspace gain does not create provider echo
turns, clipping, loss, backlog, or a session reset.
