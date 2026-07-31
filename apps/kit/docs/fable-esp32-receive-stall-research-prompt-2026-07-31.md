# Fable Max follow-up: explain the physical ESP32 receive stall

Act as an independent embedded real-time audio and ESP-IDF/lwIP reviewer. Work
in `/Users/jonastemplestein/.herdr/worktrees/iterate/c-capabilities`. Do not
edit implementation code. Write your complete, source-cited report to:

`apps/kit/docs/fable-esp32-receive-stall-research-2026-07-31.md`

The current physical M5StickS3 result is deliberately narrow:

- audio is PCM16 mono, 16 kHz, one exact 640-byte / 20 ms WebSocket message;
- the device has a dedicated PCM socket and a Core 0, priority-5 network task;
- the audio owner is Core 1, priority 19;
- the host emits one frame every 20 ms after a seven-frame startup watermark;
- application and driver queues are fixed and freshness bounded;
- the host owns each exact payload until the Node `ws.send()` callback;
- one 60-second run completed 3,000/3,000 frames with a zero-gap Mac acoustic
  recording;
- two other runs failed closed at 24.864 and 26.664 seconds with exactly eight
  frames / 5,120 payload bytes and eight callbacks outstanding, whose oldest
  ages were 156.661 and 159.296 ms;
- raw `bufferedAmount` was 5,152 bytes in both cases (the extra 32 bytes are
  WebSocket framing);
- before the latter stall, completed callbacks were at most 1.051 ms and host
  interarrival at most 34.552 ms;
- the configured lwIP TCP receive window is 5,760 bytes and receive mailbox is
  six;
- the bridge correctly closes instead of retaining stale speech. We will not
  simply increase the 160 ms budget.

Read at least:

- `apps/kit/docs/audio-streaming-problem-and-evidence-2026-07-30.md`
- `apps/kit/docs/fable-audio-review-reconciliation-2026-07-30.md`
- `apps/kit/firmware/platforms/iterate_esp_idf/pcm_transport.c`
- `apps/kit/firmware/platforms/iterate_esp_idf/websocket_connection.c`
- their headers, metrics, sdkconfig, target task setup, and relevant tests
- the local ESP-IDF source selected by the target build, including
  `esp_transport`, `esp_transport_ws`, lwIP socket/TCP receive paths, Wi-Fi task
  priorities/core affinity, TCP window/mailbox behavior, and FreeRTOS
  scheduling at `CONFIG_FREERTOS_HZ=100`
- M5Stack/M5Unified device/driver code where it can affect Core 0 scheduling
- credible third-party ESP32 real-time audio/WebSocket implementations or
  ESP-IDF issues that provide materially relevant prior art

Do not merely review line style. Answer these architectural questions:

1. What distinct mechanisms could make a nonblocking device reader stop
   advancing the peer's TCP receive window for roughly 160 ms while a repeat
   passes?
2. Which existing metric or smallest new bounded metric can distinguish each
   mechanism on the next run without serial logging or perturbing audio?
3. Is the current polling loop (`receive burst -> bounded uplink -> receive`,
   then a 10 ms idle notification wait) the simplest robust design? Compare it
   with socket readiness/select, a blocking read with bounded timeout, separate
   RX/TX tasks, event callbacks, and other materially different designs.
4. Are task priority/core placement, lwIP receive mailbox/window sizes, or
   ESP transport WebSocket parsing likely causal, and what source evidence
   supports or contradicts each hypothesis?
5. What is the smallest red-first off-device and physical A/B sequence that
   localizes the fault without creating another queue or hiding it?
6. Where is the current implementation tying itself in knots, and what
   simplification would delete the most policy while preserving freshness,
   interruption, reconnect, diagnostics, CPU, and RAM requirements?

Rank hypotheses by evidence, explicitly state uncertainty, give exact
file/line or upstream source references, estimate RAM/CPU implications, and
separate safe diagnostic changes from speculative fixes. Reconcile with the
clean minute and the two failures; do not blindly assume either the firmware or
host is at fault.
