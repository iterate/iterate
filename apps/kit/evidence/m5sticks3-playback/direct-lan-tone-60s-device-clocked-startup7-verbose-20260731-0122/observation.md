# Instrumented one-minute startup-watermark pass

This was a no-flash physical M5StickS3 run against the exact device identity
`70:04:1d:d5:45:88` on `/dev/cu.usbmodem11201`. It used the correct
`ITERATE_KIT_VERBOSE_METRICS=1` switch and therefore preserved one-second
Cap'n Web capability/playback samples while requesting 60 seconds of 16 kHz
mono PCM16 deterministic tone with a seven-frame startup watermark.

The run passed:

- device accepted, submitted, and completed all 3,000 content frames;
- device consumed the EOS marker and reported no drop, flush, underrun,
  recovery, reset, protocol, lifecycle, stack, or driver incident;
- downlink high-water was six application frames and playback high-water was
  four DMA descriptors;
- exact host payload ownership peaked at 4,480 bytes / seven frames for the
  intended startup burst and returned to zero;
- maximum completed host send-callback latency was 1.758 ms;
- maximum host worker-to-device interarrival was 36.260 ms;
- the device's maximum complete-frame interarrival was nevertheless 90 ms;
- maximum receive-to-DMA-start age was 153 ms, which includes the explicit
  startup lead;
- minimum descriptor-reuse lead was 59.398 ms;
- minimum internal/DMA heap was 125,923 bytes;
- audio, PCM-network, control-network, and main stack headroom minima were
  6,652, 3,968, 960, and 2,392 bytes respectively;
- steady playback CPU samples were approximately 276–301 permille.

The Mac acoustic oracle observed a 59,955 ms active span, zero internal gaps,
zero phase discontinuities, and 45 ms missing relative to the requested
duration. Maximum phase-step error was 0.059753 rad.

The 90 ms device complete-frame interarrival maximum while the host stayed
below 36.3 ms is important. It shows that recoverable receive/parser delivery
pauses exist below the host pacer even in a passing run. The unchanged
`pcmNetworkMaximumWorkCycles` value does not identify whether the PCM task was
descheduled, repeatedly found no socket bytes, or read bytes without
completing a WebSocket message. The next instrumentation must distinguish
those states; this pass is not evidence to enlarge a queue.

SHA-256:

- `run.log`:
  `69523a6a38cd0243352d1e3d1306912fd95a6b6ce63bafaa4d8b89bac538563e`
- `microphone.pcm16le`:
  `ffd1204adfd6c52a3a3849e5c8842b7ce0667f8cb52652e0cbcd2ba3a51f90ec`
