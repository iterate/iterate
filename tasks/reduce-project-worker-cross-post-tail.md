---
state: todo
priority: high
size: medium
tags: [ci, e2e, performance, workers, streams]
---

# Reduce the cold project-worker cross-post delivery tail

The production-shaped e2e case `Project worker processEventBatch receives
events from every project stream and can cross-post` commits a unique worker,
appends to a fresh child stream, and proves the project-wide worker feed can
cross-post that event. Two consecutive preview workflows exhausted its
30-second public stream-wait deadline before passing on the repository's one
retry:

- PR #2251's final preview: 59.18 seconds across both attempts.
- PR #2253 Depot run `3jp43c0dbg`: 62.79 seconds across both attempts.

The durable cold-build handoff preserves the event, but the combined commit,
build, feed-delivery, and worker-start tail is too close to the former budget.
The e2e wait is temporarily 100 seconds so this substantial coverage remains
active without converting healthy delayed delivery into a retry.

## Work

- Record separate timings for repo commit, coordinator handoff, bundle cache
  lookup or build, feed redelivery, dynamic Worker startup, cross-post append,
  and feed acknowledgement.
- Correlate cold and warm samples with Worker traces and the existing build and
  stream telemetry under the normal fully parallel preview load.
- Remove the dominant cold-path or contention latency without weakening the
  fresh-worker and fresh-child-stream coverage.

## Exit criteria

- The case passes on its first attempt in at least 25 consecutive canonical
  preview runs.
- Its cold-path p99 delivery completes within 30 seconds with no unexplained
  errors, stalled feeds, duplicate processing, or leaked builds.
- Restore the public stream-wait deadline from 100 seconds to 30 seconds.
