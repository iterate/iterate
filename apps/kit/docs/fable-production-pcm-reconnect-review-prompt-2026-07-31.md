# Independent Fable Max review: production PCM reconnect and evidence seam

Work read-only in `/Users/jonastemplestein/.herdr/worktrees/iterate/c-capabilities`.
Do not edit implementation or tests. Write your complete durable report only to
`apps/kit/docs/fable-production-pcm-reconnect-review-2026-07-31.md`.

The M5StickS3 production userspace vertical slice has already passed once. A
fresh unattended proof on 2026-07-31 failed during a remotely held PTT turn:
the device discarded stale microphone frames at roughly 256 ms, deliberately
reset its PCM WebSocket generation, and reconnected while the control Cap'n Web
socket stayed healthy. The raw Grok event journal remained exact for the old
session (sequences 1..10); it contains no provider error. Wi-Fi remained up and
device/router/worker probes replied, though some RTT samples rose. The harness
currently preserves `provider-events.jsonl`, but its early failure branch does
not yet write the automatic exact-interval `network.json` classification.

Review the current code and retained failure evidence, especially:

- `apps/kit/evidence/m5sticks3-production-grok-raw-stream-check/`
- `apps/kit/scripts/prove-production-m5sticks3-grok.ts`
- `apps/kit/src/device/physical-network-run.ts`
- `apps/kit/src/device/physical-network-validity.ts`
- `apps/kit/src/device/production-grok-provider-events*.ts`
- `apps/kit/src/userspace/config-worker/{worker,pcm-proxy,provider-event-stream}.ts`
- `apps/kit/firmware/platforms/iterate_esp_idf/{pcm_transport,pcm_uplink_sender,pcm_uplink_conductor,websocket_connection}.c`
- the matching headers, host tests, firmware policy constants, and project docs.

Independently answer, with exact file/line/source evidence:

1. What is the smallest correct fix so every failed physical run gets an
   automatic durable attribution (`network-invalid`, `audio-invalid`, or
   `indeterminate`) without ever treating network invalidity as an audio pass?
2. Why did a 250 ms freshness breach destroy the Grok session rather than only
   discard stale unsent microphone data? Is that required by opaque TLS/TCP
   suffix semantics, or can the architecture be simplified without allowing
   stale speech to leak later?
3. Should the userspace `/pcm` Durable Object preserve one Grok provider
   session across a bounded device-side reconnect? If so, specify the tight
   identity, generation, timeout, interruption, and memory bounds; if not,
   explain the simpler recovery contract.
4. Audit raw provider-event capture: exact bytes/order, stream identity,
   continuity, bounded backpressure, secrets, and failure artifact usability.
5. Identify deletions or simplifications that materially reduce time to a
   reliable Stick proof. Avoid speculative platform work.

Rank findings by severity and distinguish must-fix-before-one-clean-rerun from
follow-up. Propose concrete red regression tests. Reconcile the retained
evidence rather than assuming a generic Wi-Fi failure. Finish with a short
action checklist for the primary agent. Do not commit or push.
