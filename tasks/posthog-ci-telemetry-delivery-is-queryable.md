---
status: in-progress
size: small
---

# PostHog CI telemetry delivery is queryable

Status: The uploader now caps requests at 100 events / 5 MB, spaces them by 500 ms, and marks retained CI artifacts for ordered migration processing. Focused checks pass; a canonical stacked preview still needs to prove natural PostHog visibility.

- [x] Classify the missing telemetry without treating a green upload step as proof. *The clean `dea9870` artifact contained 7,922 complete events; four accepted 1–5 MB requests remained absent, while a paced 100-event deterministic replay became queryable.*
- [x] Bound each PostHog delivery batch by both encoded bytes and event count. *`postHogEventBatches` now enforces the existing 5 MB budget plus a 100-event cap.*
- [x] Pace consecutive capture requests so a full CI artifact does not arrive as one event burst. *An isolated unpaced replay landed, but simultaneous production-shaped unit/preview finalizers remained absent; requests now start 500 ms apart, proven through a real local capture server.*
- [x] Route retained CI artifacts around PostHog spike detection. *PostHog's documented `historical_migration` request flag now asks ingestion to process these completed artifacts in order; a real capture-server test proves every request carries it.*
- [x] Keep deterministic UUID replay and explicit delivery failure semantics intact. *Only request partitioning changed; stable event UUIDs and the three-attempt error path are unchanged.*
- [x] Prove the batching and pacing contract with readable unit tests. *Red tests first reproduced both the missing count boundary and a 4 ms burst; 13/13 focused tests now pass.*
- [x] Replay the retained clean preview artifact and require its finalizer plus both restored mobile specs in PostHog. *Three natural retry-zero run pairs and their complete finalizers are now queryable without duplicate facts.*
- [x] Run the focused tests, typecheck/lint/format checks. *13/13 tests pass, plus scripts typecheck, oxlint, oxfmt, and diff checks.*
- [ ] Run a canonical stacked preview and prove its natural upload is queryable without replay.

## Implementation notes

- PostHog documents no event-count limit for `/batch`; request bodies must be below 20 MB. The existing 5 MB budget conforms to that API contract.
- The issue is downstream visibility under burst delivery, not an HTTP rejection: every request returned `200 {"status":"Ok"}`.
- Paced and unpaced 100-event replays used the artifacts' stable UUIDs and became queryable. Replay is idempotent and does not create duplicate facts.
- An isolated unpaced control was insufficient evidence: the next production-shaped preview and unit uploads overlapped, returned success, and remained absent. The delivery contract therefore owns both count and rate.
- A second exact-head preview with the count cap and pacing also returned success but remained absent. PostHog documents `historical_migration` as the ordered ingestion path that does not trigger spike detection, so completed CI artifacts now use that explicit lane.
- This work is stacked on `fix/preview-fixed-otp-rate-limit`, which is stacked on `fix/egress-approval-settlement-retry`, so its canonical preview can exercise the complete restoration path.
