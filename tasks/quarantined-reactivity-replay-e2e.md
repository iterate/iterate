---
state: todo
priority: high
size: small
tags: [ci, e2e, playwright, quarantine, flake, streams]
---

# Restore the quarantined reactivity replay E2E test

The Playwright test `reactivity page replays already appended events after
reload` is narrowly skipped after an unrelated project-creation flake made PR
#2169's exact-head preview proof red. The other reactivity tests remain enabled:
live append, batch append, cross-tab delivery, and processor push still cover
the page's subscription behavior.

## Evidence

At commit `d87b93807394754479ce49f0f6eff25bf6365041`, the
[preview run](https://depot.dev/orgs/0p91s0lz49/workflows/ltn0xz4mvt?job=8v5rwkpq6r)
failed the first attempt after 1.2 minutes with:

```text
stream-wait-timeout: Timed out waiting for stream event after 60000ms
(the public deadline expired while recovery re-armed one-shot waits).
```

The failure came from the shared `projects.get(slug).create()` readiness path,
which waits for `events.iterate.com/project/ready`; it happened before the
test could exercise its reload/replay assertion. Playwright's fresh-project
retry then passed in 13.5 seconds. Because a passed retry is failed proof, the
test is skipped instead of treating that retry as green.

The test body is byte-for-byte unchanged from `main`. This is another instance
of the concurrent-load stream waiter defect already tracked in
`tasks/streams-event-delivery-flake-under-concurrent-load.md`, not evidence of
a reactivity replay regression in PR #2169.

## Work

- Reproduce project creation under the normal fully parallel preview load with
  Playwright retries disabled.
- Correlate the timed-out project's root-stream journal, processor state, and
  Worker traces to determine whether `project/ready` was committed but missed
  by `waitForEvent`, or never committed.
- Fix the stream waiter or project bootstrap mechanism; do not add a retry,
  fallback, longer timeout, or shared-project test pool to conceal the defect.
- Remove this `test.skip` and prove the test passes on its first attempt at
  least 20 consecutive times under the normal preview concurrency.

## Exit criteria

- The test is restored with its original reload/replay assertion intact.
- The project-ready wait has no unexplained timeout or retry in the repeated
  preview proof, and corresponding traces show coherent final project state.
