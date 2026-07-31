# Autonomous M5StickS3 → Grok → speaker proof

This is a fresh direct-LAN physical run of the ordinary userspace `/pcm`
bridge. The harness remotely asserted the same push-to-talk capability used by
Button A, played a phrase from the Mac into the Stick microphone, sent the
Stick's PCM to `grok-voice-think-fast-2.0`, and played Grok's returned PCM on
the Stick.

Acceptance evidence:

- Grok transcribed the microphone input as “He's answer by saying exactly. The
  recorded network valid voice test passed.”
- Grok's response transcript was “Exactly, the recorded network valid voice
  test passed.”
- The host accepted 200 speaker frames and the device reported exactly 200
  accepted, submitted, and completed frames. Drops, flushes, playback
  failures, protocol failures, and terminal queue depths were all zero.
- `summary.json` conserves 279 microphone frames (178,560 bytes) and 200
  speaker frames (128,000 bytes), with SHA-256 hashes and a timestamped event
  timeline.
- `physical-network-validity.json` classifies the exact 10.9996-second audio
  interval as `valid`, with 12 device diagnostics observations, 33 independent
  device/router/worker reachability samples, no socket close, and no reported
  reason for invalidity.
- The nearby MacBook microphone recorded the room to `acoustic-room.wav`.
  OpenAI `gpt-4o-transcribe`, used only as an independent acoustic oracle,
  returned the Grok response sentence exactly. See
  `acoustic-transcription.json`.

This proves the autonomous remote-capability path and the physical speaker
output. It does **not** replace the remaining Button-A provenance proof, the
Captun/deployed-userspace proof, interruption/multi-turn acceptance, or the
later StackChan and Home Assistant Voice Preview Edition portability slices.
