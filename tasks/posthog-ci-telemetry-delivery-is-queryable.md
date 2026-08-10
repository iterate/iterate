---
status: in-progress
size: small
---

# PostHog CI telemetry delivery is queryable

Status: The retained evidence is complete and PostHog accepts the requests, but multi-thousand-event bursts can remain unqueryable while paced 100-event replays land. The delivery boundary and replay proof remain to implement.

- [x] Classify the missing telemetry without treating a green upload step as proof. *The clean `dea9870` artifact contained 7,922 complete events; four accepted 1–5 MB requests remained absent, while a paced 100-event deterministic replay became queryable.*
- [ ] Bound each PostHog delivery batch by both encoded bytes and event count.
- [ ] Pace consecutive capture requests so a full CI artifact does not arrive as one event burst.
- [ ] Keep deterministic UUID replay and explicit delivery failure semantics intact.
- [ ] Prove the batching and pacing contract with readable unit tests.
- [ ] Replay the retained clean preview artifact and require its finalizer plus both restored mobile specs in PostHog.
- [ ] Run the focused tests, typecheck/lint/format checks, and a canonical stacked preview.

## Implementation notes

- PostHog documents no event-count limit for `/batch`; request bodies must be below 20 MB. The existing 5 MB budget conforms to that API contract.
- The issue is downstream visibility under burst delivery, not an HTTP rejection: every request returned `200 {"status":"Ok"}`.
- A 100-event replay used the artifact's stable UUIDs and became queryable. Replay is idempotent and does not create duplicate facts.
- This work is stacked on `fix/preview-fixed-otp-rate-limit`, which is stacked on `fix/egress-approval-settlement-retry`, so its canonical preview can exercise the complete restoration path.
