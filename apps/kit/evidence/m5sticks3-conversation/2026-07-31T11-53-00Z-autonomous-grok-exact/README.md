# Autonomous M5StickS3 → userspace → Grok → speaker proof

This is the first run whose pass gate uses exact, response-specific frame
conservation rather than merely checking that playback counters increased.
The harness remotely invoked the mounted `pushToTalk.start` capability, played
the prompt beside the Stick through macOS `say`, kept microphone frames flowing
while held, and remotely invoked `pushToTalk.stop`.

Grok transcribed the complete prompt and returned `The autonomous device test
is working.` The userspace `/pcm` boundary observed 128 returned frames; the
device accepted, submitted, and completed exactly the same 128 frames. Drops,
flushes, playback failures, protocol failures, and residual queue depths were
all zero. The preceding failure mode—12 frames played and 34 silently
flushed—therefore cannot satisfy this gate.

The local WebSocket bridge closed normally after the completed verdict. Its
largest returned-frame interarrival was 90.661 ms, while the configured eight-
frame Stick lead maintained exact playback. The run did not start the full
device/router/worker reachability monitor, so its network classification is
honestly `indeterminate`; clean bridge evidence is not relabelled as the
stronger automatic network-validity proof.

Machine-readable counters and the explicit verdict are in `result.json`.

The secret-free command shape was:

```sh
doppler run --project voice --config dev -- env \
  ITERATE_KIT_PYTHON=/Users/jonastemplestein/.espressif/python_env/idf5.4_py3.14_env/bin/python \
  ITERATE_KIT_VOICE_PHRASE='Please say one short sentence confirming the autonomous device test is working.' \
  pnpm device:e2e -- \
    --port /dev/cu.usbmodem11201 \
    --build-directory firmware/targets/m5sticks3/build \
    --direct-lan-host 192.168.0.169 \
    --direct-lan-port 58685 \
    --no-flash --voice --exit-after-remote-proof \
    --remote-hold-ms 250 --mount-timeout-ms 180000 \
    --device-clocked-downlink --device-clocked-startup-frames 8
```
