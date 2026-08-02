# Fable Max review: HAVPE long-response downlink failure

You are an independent Claude Fable Max reviewer working read-only in
`/Users/jonastemplestein/.herdr/worktrees/iterate/c-capabilities`.

Investigate one bounded production failure and propose the smallest robust fix.
Do not edit production code, flash hardware, deploy, or alter git state. Write
your final report only to
`apps/kit/docs/fable-havpe-long-response-downlink-review-2026-08-02.md`.

## Measured failure

- Physical device: Home Assistant Voice Preview Edition, MAC
  `D8:3B:DA:46:20:34`, production project
  `prj_4f76ffe131f1495981afd65619f57914`.
- Session:
  `prj_4f76ffe131f1495981afd65619f57914:home-assistant-voice-preview-edition:d2a15a10-58c7-475b-9738-52b2df0ede86`.
- User asked Grok to count to 100. Durable provider events contain the complete
  transcript through 100 and `response.done` reports 75.4177 seconds of output
  audio. Grok generated the response correctly.
- The worker sent 1,534 20-ms frames (~30.68 s), then saw a device-originated
  abnormal close, code 1011, reason `WebSocket disconnected without sending
Close frame.` Its 90-second response reservoir reached 2,042,196 bytes and
  discarded 1,498,196 bytes only after the physical downstream disappeared.
- The device's cumulative diagnostics immediately after the failure reported
  downlink received 3,230, downlink dropped 1, depth 0, high-water 32,
  receive failures 1. The target's downlink SPSC ring has exactly 32 slots.
- In `pcm_transport.c`, a downlink `BACKPRESSURE` increments those failure/loss
  counters and deliberately tears down the PCM WebSocket generation. This is
  the leading attribution, but distinguish measurement from inference.
- Worker pacing reported zero lateness, catch-up, and egress overrun. The worker
  starts playout at 32 provider frames, primes 12 device frames, then sends one
  frame each 20 ms. Browser/Workers `WebSocket.bufferedAmount` stayed low.
- Nearby post-failure network probes were clean, but there was no exact
  interval-aligned network probe, so that historical acoustic run remains
  network-unknown rather than network-valid.

## Sources to inspect

- `apps/kit/src/userspace/config-worker/pcm-proxy.ts` and tests.
- `apps/kit/firmware/platforms/iterate_esp_idf/pcm_transport.c` and headers.
- `apps/kit/firmware/components/core/src/pcm_clock_playback.c`, PCM lane/ring,
  and their host tests.
- `apps/kit/firmware/platforms/iterate_voice_pe_audio/voice_pe_audio_owner.c`,
  format/config headers, and first-party ESP-IDF I2S driver source/docs/examples
  available locally or online.
- `apps/kit/firmware/targets/home-assistant-voice-preview-edition/main/main.c`.
- Relevant retained evidence and landing notes under `apps/kit/evidence` and
  `apps/kit/docs`.
- Relevant Home Assistant Voice PE/XMOS/ESP32-S3 first-party board sources.

## Questions

1. Explain how a nominal 20-ms worker clock and nominal 20-ms physical consumer
   can fill a 32-frame ring after ~31 seconds. Rank clock drift, TCP/TLS burst
   delivery, task starvation, I2S/DMA behavior, scheduler defects, and stale
   generation/state with concrete evidence and explicit uncertainty.
2. Propose at least three materially different fixes. Include one minimal
   landing fix and one principled architecture. Evaluate bounded latency, audio
   continuity, RAM, CPU, control-plane complexity, observability, and behavior
   under arbitrary long replies/reconnects/network recovery.
3. Identify simplifications and deletions. In particular, challenge whether
   open-loop cloud pacing plus an opaque device queue is the correct ownership
   model.
4. Specify red host tests that reproduce the failure with independent clocks,
   burst delivery, task stalls, loss, reconnects, and memory pressure. Tests
   must prove no unbounded backlog or silent data loss.
5. Specify the smallest exact physical evidence campaign needed after the fix,
   including per-second aligned device depth/high-water/failures, worker
   reservoir/pacing counters, network validity, provider lifecycle, and Mac
   acoustic capture/transcription of every number 1-100.
6. Review memory placement and whether a larger HAVPE ring is safe, but do not
   accept capacity growth as an indefinite-drift fix by itself.

Label claims as confirmed source (`C`), measured evidence (`M`), or hypothesis
(`H`). Reconcile first-party guidance against the existing design; do not
blindly recommend a rewrite. Focus on actionable near-term findings that reduce
time to a valid physical 1-100 proof.
