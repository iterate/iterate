# StackChan accepted-uplink VAD replay — 2026-08-03

This is a bounded calibration experiment, not a physical AEC pass. It replays
the exact PCM that the production worker accepted from the physical StackChan
during the retained `2026-08-03T01-45-53-719Z` waveform run into the real
`grok-voice-think-fast-2.0` server-VAD path at fixed gains. Its purpose is to
separate “xAI cannot hear the post-AEC level” from transport failure before
changing firmware or repeating a room test.

## Result

| Source                                  |         Gain |   Peak |    RMS | xAI result                                                      |
| --------------------------------------- | -----------: | -----: | -----: | --------------------------------------------------------------- |
| near-only                               |  x4 (+12 dB) | 0.0507 | 0.0113 | No VAD edge before the bounded timeout                          |
| near-only                               |  x8 (+18 dB) | 0.1013 | 0.0225 | One VAD turn; transcript below                                  |
| near-only                               | x16 (+24 dB) | 0.2026 | 0.0451 | One VAD turn; same transcript                                   |
| far speech-shaped noise                 |          x16 | 0.9780 | 0.0826 | No VAD edge before the bounded timeout                          |
| double-talk                             |          x16 | 1.0000 | 0.1375 | No VAD edge before the bounded timeout                          |
| prior real speaker speech, old firmware |           x4 | 0.7037 | 0.0388 | **Three false VAD turns**; transcripts “Yeah”, “Stop”, and “Hi” |

Both successful near-only responses transcribed:

> Please verify that this nearby voice remains clear while the device speaker is

That is exactly the intelligible portion present in the 4.06-second retained
source; the physical fixture ended before the sentence completed. The x8
response started at 7.457 seconds and stopped at 7.542 seconds in the probe
clock. The x16 response started and stopped at 7.362 seconds. These timestamps
reflect the standalone probe's pre/post-roll and are not device-to-provider
latency measurements.

## Interpretation and limit

The production count failure at x1 was a level/VAD failure, not a network or
frame-conservation failure. The replay establishes x8 as the first tested rung
at which xAI recognizes the retained nearby speech. It also proves why that
rung cannot be deployed blindly. A separate, previously retained speaker-only
`aec-clean.wav` from the prior StackChan source tree contains real spoken
far-end output at device volume 100. At only x4, xAI opened three turns and
transcribed residual speech as “Yeah”, “Stop”, and “Hi”. Its original physical
assessment reported 18.64 dB ERLE and passed the old far-only threshold, yet it
is plainly unsafe for the actual provider contract after gain. A scalar ERLE
pass is therefore not a conversational AEC pass.

The current synthetic far/double-talk WAVs contain a few clipped outliers after
x16 amplification. More importantly, speech-shaped noise is not intelligible
speaker speech; its lack of a VAD edge does not contradict the false turns from
the real-speech fixture. Any production candidate must now pass both waveform
conservation and a speaker-only real-speech provider-edge gate.

The next discriminating step remains the physical waveform gate after flashing
the already-built `AEC_NLP_LEVEL_AGGR` image. Only that run can choose the
smallest safe production gain while preserving near speech and rejecting
speaker residue; the selected candidate must then replay actual speaker speech
without generating an xAI speech edge. This replay closes both the option of
simply repeating the current x1 count run and the option of adding unconditional
gain until nearby speech happens to trigger.

## Reproduction

The WAVs are 16 kHz mono signed PCM. They were created with SoX from the exact
accepted-uplink phase artifacts using `vol 4`, `vol 8`, or `vol 16`, then sent
in 20 ms chunks through the existing standalone real-xAI probe with server VAD
threshold `0.1` and one-second silence. The API key was supplied in memory by
Doppler's `APP_CONFIG_X_AI_API_KEY`; it is absent from every artifact.

The complete successful provider event/audio ledgers are retained as
`near-only-x8-response.*` and `near-only-x16-response.*`. Failed bounded probes
do not emit fabricated response ledgers. SHA-256 identities for the three
unamplified source PCM files and every generated WAV should be obtained with
`shasum -a 256` when promoting this experiment into a machine-readable
manifest; the source-of-truth physical manifest remains in the parent waveform
evidence directory.
