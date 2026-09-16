---
status: ready
size: small
---

# Remove the scheduling pause test's network race

Status: cause identified; test ordering still needs a fix. No skip or retry policy was added.

`apps/os-next/e2e/scheduled-appends.e2e.test.ts` schedules `held` for 1.5 seconds from the client's clock, then reads its attribution, then pauses the stream. If creation plus the read takes longer than 1.5 seconds, the schedule legitimately finishes and `get("held")` returns null before the test pauses it.

Observed while validating #2665 on 2026-09-16, preview version `aca1c174-68c7-4556-b389-783966061dfd`: `pause holds a deadline until resume; session attribution names the definition's author` failed at line 108 with `Cannot read properties of null (reading 'source')` after 1,867 ms. That test was unchanged from main; it passed in the earlier full run and in the isolated rerun. The broader run had 48 passes and one opt-in skip.

- [ ] Establish the paused state with controlled ordering relative to the schedule definition, instead of requiring multiple network round trips to finish within 1.5 seconds.
- [ ] Preserve the attribution, pause/refusal, resume and exact-delivery assertions.
- [ ] Verify against a deployed worker with deliberately delayed client calls; do not solve this by increasing the deadline or adding retries.
