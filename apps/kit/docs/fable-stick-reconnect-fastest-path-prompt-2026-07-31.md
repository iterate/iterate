# Fable review: fastest correct Stick reconnect path

Work in `/Users/jonastemplestein/.herdr/worktrees/iterate/c-capabilities`.

This is a bounded independent review. Do not edit implementation or test files.
Write the final report to
`apps/kit/docs/fable-stick-reconnect-fastest-path-review-2026-07-31.md`.

## Immediate production symptom

The M5StickS3 is physically reachable at `192.168.1.210` and its stable USB
identity is `70:04:1D:D5:45:88`, but after moving between Wi-Fi locations the
production project currently reports no capability at
`kit.m5sticks3.getDiagnostics`. The firmware has independent Cap'n Web and raw
PCM WebSockets. Both are intended to reconnect indefinitely with bounded,
observable state and without retaining stale audio.

The current production userspace worker uses the same worker origin for `/api`
(reverse-proxied Cap'n Web) and `/pcm` (the device audio lane). A worker
`ctx.abort()`/`kill()` deliberately forces both connections to replace. Prior
physical evidence shows transient connection cycling and that a userspace PCM
session's Cap'n Web callback subscription can become stale after the control
connection reconnects.

## Review task

Inspect the current source and tests, especially:

- `apps/kit/firmware/components/core/src/itx_mount.c`
- `apps/kit/firmware/platforms/iterate_esp_idf/itx_transport.c`
- `apps/kit/firmware/platforms/iterate_esp_idf/pcm_transport.c`
- `apps/kit/firmware/platforms/iterate_esp_idf/websocket_connection.c`
- `apps/kit/firmware/targets/m5sticks3/main/main.cpp`
- `apps/kit/src/userspace/config-worker/pcm-proxy.ts`
- `apps/kit/src/userspace/config-worker/worker.ts`
- the matching C and TypeScript tests
- `apps/kit/docs/physical-device-voice-goal.md`
- `/Users/jonastemplestein/src/github.com/iterate/stackchan` only where it has
  useful reconnect/audio precedent; do not inherit its accumulating queues.

Propose the shortest production-shaped route that makes these invariants true:

1. A Wi-Fi outage/location move always converges back to one mounted capability
   and one PCM session without reboot or human input.
2. A control-session replacement cannot silently strand the userspace device
   event subscription.
3. A PCM-session replacement cannot replay old microphone or speaker audio.
4. Every failure/retry is bounded and diagnostically attributable.
5. Audio work remains higher priority and is never delayed by control recovery.

Aggressively identify deletions and simplifications, especially duplicated
liveness, ping/pong, callback, retry, or generation state. Distinguish facts
proved from source from hypotheses needing a test. Give 3 materially different
design options, rank them for time-to-vertical-proof and long-term clarity, and
name the public-seam regression tests that should fail before each recommended
fix. Do not propose a broad rewrite unless the source proves the current shape
cannot meet the immediate gate.

Keep the report concise enough to act on immediately. End with a checklist of
near-term actions versus explicitly deferred cleanup.
