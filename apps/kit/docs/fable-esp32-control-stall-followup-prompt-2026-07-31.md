# Fable Max follow-up: persistent Cap'n Web response stall under clean PCM load

Continue the independent ESP32/ESP-IDF architecture review from:

- `apps/kit/docs/fable-esp32-receive-stall-research-2026-07-31.md`
- `apps/kit/docs/fable-esp32-receive-stall-reconciliation-2026-07-31.md`
- `apps/kit/docs/audio-streaming-problem-and-evidence-2026-07-30.md`

Do not edit implementation code. Read the current source rather than relying on
the earlier snapshot, especially:

- `apps/kit/firmware/platforms/iterate_esp_idf/itx_transport.c`
- `apps/kit/firmware/components/core/src/websocket_text.c`
- `apps/kit/firmware/vendor/capnweb/`
- `apps/kit/firmware/targets/m5sticks3/main/main.cpp`
- `apps/kit/src/device/bounded-capability-churn.ts`
- `apps/kit/src/device/local-device-peer.ts`
- `apps/kit/src/device/local-fetch-websocket-server.ts`
- `apps/kit/scripts/device-e2e.ts`

New physical evidence invalidated the simple four-slot-outbox explanation.
Changing only the M5StickS3 control outbox from four 2 KiB slots to eight moved
the deterministic one-at-a-time `getDiagnostics()` failure from about 4.1
seconds to 21.1 seconds, but did not eliminate it. At 20 calls/second the failed
run completed 370 calls, skipped 41 busy ticks, then one call exceeded its
one-second deadline. The secret-free control trace shows the request push/pull
for diagnostic call 374 but no resolution. PCM delivery and audible playback
remained clean until the harness deliberately aborted: 1,057 frames, 676,480
bytes, maximum bridge interarrival 34.7 ms, and no device playback incident.

The implementation is now adding _passive_ export of counters that already
exist: inbox/outbox current and high-water slots, producer backpressure,
published/consumed counts, control discards, and retained application-side
Cap'n Web failure status/generation. Do not merely recommend more telemetry or
a larger queue.

Independently answer:

1. Which exact protocol/lifecycle sequences can leave one Cap'n Web promise
   unresolved while later subscription traffic or a later generation remains
   live?
2. Is the borrowed one-shot diagnostic expression/release lifecycle relevant?
3. Could ESP-IDF's synchronous `esp_websocket_client_send_text(..., 250 ms)`,
   the four-message send burst, the 20 ms owner cadence, or socket callback
   scheduling create a cumulative rather than instantaneous capacity problem?
4. What materially simpler owner/transport architecture would make bounded
   progress obvious? Challenge the current two-ring design if warranted.
5. What smallest deterministic host tests would distinguish queue saturation,
   lost wakeup, lost pull/resolution, session teardown, and host-side proxy
   correlation defects?

Use ESP-IDF source/docs and relevant third-party source where useful. Rank
claims by confidence and cite concrete file/line or upstream source evidence.
Write the result durably to:

`apps/kit/docs/fable-esp32-control-stall-followup-2026-07-31.md`

Clearly separate observed facts, source-backed conclusions, and hypotheses.
Prefer architectural simplification over parameter tuning, but do not propose
moving PCM back onto Cap'n Web or adding blocking/logging to the audio path.
