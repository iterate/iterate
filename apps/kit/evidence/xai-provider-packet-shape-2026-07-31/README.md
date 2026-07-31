# xAI provider packet-shape regression evidence

A longer joke response had closed the physical Stick PCM generation after the
first words. This direct `grok-voice-think-fast-2.0` probe demonstrated why:
xAI returned 148,222 bytes of valid even-length PCM in seven arbitrary
WebSocket messages, including one 73,400-byte message. The former 64 KiB
message guard was therefore a local proxy defect, not malformed provider PCM.

`result.json` is the captured packet trace. `run.mts` reproduces the probe with
`XAI_API_KEY` injected from Doppler. The literal seven-message sequence is also
used by `device-pcm-proxy.test.ts` to prove the bounded userspace reservoir can
conserve the whole response even when the runtime dispatches every already-
generated message in one task turn.
