---
status: in-progress
size: small
---

# PostHog CI telemetry delivery is queryable

Status: The uploader now caps valid requests at 100 events as well as 5 MB, and focused tests/typecheck/lint/format pass. Retained evidence recovery and a canonical stacked preview remain.

- [x] Classify the missing telemetry without treating a green upload step as proof. *The clean `dea9870` artifact contained 7,922 complete events; four accepted 1–5 MB requests remained absent, while a paced 100-event deterministic replay became queryable.*
- [x] Bound each PostHog delivery batch by both encoded bytes and event count. *`postHogEventBatches` now enforces the existing 5 MB budget plus a 100-event cap.*
- [x] ~~Pace consecutive capture requests so a full CI artifact does not arrive as one event burst.~~ *An unpaced 7,976-event replay landed completely once requests were capped at 100 events, so a delay would add latency without evidence.*
- [x] Keep deterministic UUID replay and explicit delivery failure semantics intact. *Only request partitioning changed; stable event UUIDs and the three-attempt error path are unchanged.*
- [x] Prove the batching and pacing contract with readable unit tests. *A red test first reproduced the missing count boundary; 12/12 focused tests now pass, including invalid-limit checks.*
- [ ] Replay the retained clean preview artifact and require its finalizer plus both restored mobile specs in PostHog.
- [ ] Run the focused tests, typecheck/lint/format checks, and a canonical stacked preview.

## Implementation notes

- PostHog documents no event-count limit for `/batch`; request bodies must be below 20 MB. The existing 5 MB budget conforms to that API contract.
- The issue is downstream visibility under burst delivery, not an HTTP rejection: every request returned `200 {"status":"Ok"}`.
- Paced and unpaced 100-event replays used the artifacts' stable UUIDs and became queryable. Replay is idempotent and does not create duplicate facts; the unpaced control ruled out a timing delay.
- This work is stacked on `fix/preview-fixed-otp-rate-limit`, which is stacked on `fix/egress-approval-settlement-retry`, so its canonical preview can exercise the complete restoration path.
