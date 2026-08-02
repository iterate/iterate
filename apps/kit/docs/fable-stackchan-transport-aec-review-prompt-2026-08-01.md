# Fable review: StackChan realtime transport and shared AEC architecture

Perform a bounded, read-only, max-effort architecture and code-quality review of
the current `c-capabilities` worktree. Do not edit files, flash hardware, deploy,
or run commands that mutate state. Your output must be a concise final report
with evidence and actionable recommendations.

Apply a thermo-nuclear maintainability standard: look specifically for a
"code-judo" restructuring that deletes concepts, branches, queues, or wrapper
layers while preserving behaviour. Do not spend the review on names or style.

## Immediate production goal

Land the physical StackChan vertical slice before starting Home Assistant Voice
Preview Edition:

- StackChan uses local AEC and continuous full-duplex capture.
- Grok `grok-voice-think-fast-2.0` uses server-side VAD.
- Returned PCM is played immediately and loudly enough for a nearby Mac mic.
- Barge-in/interruption works without stale playback.
- Audio never accumulates delay: stale capture is dropped and a degraded socket
  is replaced in bounded time.
- Device metrics and exact transport/network errors make every failed run
  attributable.
- M5StickS3 retains its already-landed push-to-talk policy.
- The shared core and userspace `/pcm` path should be reused by StackChan and
  HAVPE, but device DSP/hardware adapters may differ. HAVPE's XMOS hardware owns
  its local AEC; do not force the CoreS3 DSP implementation onto it.

The current physical StackChan run reached the real production userspace worker
and Grok. Provider keepalives remained healthy, but device uplink repeatedly
filled a 32-frame queue, discarded stale epochs, and eventually reconnected:
roughly 62 in-place freshness recoveries, queue high-water 31, 1,930 dropped
uplink frames, max local acceptance age 627 ms, and a WebSocket close 1006 after
about 128 seconds. The firmware currently loses the underlying socket/TLS error
behind a high-level `esp_transport_read()` result of `-1`. A just-fixed edge
case allows freshness recovery when the producer already emptied the epoch.

## Review these local sources

- `apps/kit/firmware/components/core/src/pcm_uplink_sender.c`
- `apps/kit/firmware/components/core/src/pcm_uplink_conductor.c`
- `apps/kit/firmware/components/core/src/pcm_websocket.c`
- `apps/kit/firmware/components/core/src/pcm_playback_interruption.c`
- `apps/kit/firmware/platforms/iterate_esp_idf/pcm_transport.c`
- `apps/kit/firmware/platforms/iterate_esp_idf/websocket_transport.c` and nearby
  ESP-IDF transport implementation files
- `apps/kit/firmware/targets/stackchan/main/main.c`
- `apps/kit/firmware/targets/stackchan/main/stackchan_audio_owner.*`
- shared CoreS3 audio-owner/AEC sources and tests
- `apps/kit/src/userspace/config-worker/pcm-proxy.ts`
- `apps/kit/src/userspace/config-worker/providers.ts`
- relevant tests under `apps/kit/firmware/tests` and config-worker tests
- prior report:
  `apps/kit/docs/fable-shared-aec-server-vad-review-2026-08-01.md`

Compare the implementation against exact first-party source/docs/examples,
including the matching local ESP-IDF 5.4.2 checkout at
`/Users/jonastemplestein/esp/esp-idf`, Espressif ESP-TLS/tcp_transport/lwIP and
FreeRTOS guidance, M5Stack CoreS3 BSP/codec sources, and Home Assistant Voice PE
XMOS/ESPHome architecture. Use web research only for primary upstream sources
when it materially answers a question.

## Questions to answer

1. What is the smallest correct state machine for bounded realtime uplink
   freshness and socket replacement? Specify an elapsed-time invariant and
   whether a successful send should reset escalation. Avoid retry-count policy
   tied to scheduler speed.
2. Which exact ESP-IDF APIs and fields should be captured before transport
   teardown to distinguish peer FIN, socket errno, TLS failure, Wi-Fi outage,
   parser/protocol failure, and local backpressure? Cite source paths/symbols.
3. Is the sender/conductor/transport layering helping, or can a materially
   simpler ownership boundary remove branches or duplicated recovery logic?
4. Could synchronous userspace forwarding or WebSocket scheduling create the
   observed device-side backpressure despite healthy provider keepalives? Give
   a falsifiable test, not speculation.
5. What minimal AEC metrics actually falsify "AEC works" on StackChan without
   inflating hot-path work or callback payloads? Identify metrics common enough
   for StackChan and HAVPE and those that must remain adapter-specific.
6. Audit task priority/core affinity, DMA/ring sizing, memory placement, codec
   configuration, and logging. Flag anything inconsistent with first-party
   realtime audio practice or likely to starve Wi-Fi/TCP.
7. Propose deletions/refactors that improve time-to-goal now. Separate blockers
   for the next physical StackChan run from deferred cleanup.

For every high-confidence finding, include: severity, exact evidence, the
failure it explains or prevents, the smallest change, and a regression-test or
physical falsification. Explicitly say when evidence is insufficient. Do not
recommend an architecture rewrite unless it measurably reduces the immediate
path to a stable StackChan conversation.
