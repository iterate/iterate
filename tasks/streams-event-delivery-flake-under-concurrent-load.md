---
state: todo
priority: medium
size: medium
tags: [streams, e2e, preview, flake]
---

# Stream event delivery flakes under concurrent e2e load

Found 2026-07-02 while parallelizing preview e2e (PR #1589). With the OS e2e
suites running tests concurrently against a preview slot (~20-40 in-flight
tests, each its own fresh project), individual tests intermittently hit:

```
Error: Timed out waiting for stream event after 120000ms (saw 0 events; recent types: none).
```

Two observed instances, different tests, same signature:

- Depot CI validation run (16:11Z): `itx.e2e.test.ts > Worker expression
capabilities dispatch nested RpcTarget paths` — server-side
  `stream.waitForEvent` saw zero events for 120s.
- GHA run 28604947078 (16:20Z): `itx.e2e.test.ts > Project egress substitutes
path-addressed secrets...` — attempt 1 timed out the same way; the vitest
  retry (fresh project) then found `secrets.list()`-adjacent agent stream
  EMPTY (`expected [] to deeply equal [ObjectContaining...]`), so the wedge
  outlived one project's lifetime.

Events appended to a fresh project's streams were either not persisted or not
delivered to `waitForEvent`/processor subscriptions. Smells adjacent to
[incident: local dev stream push wedge] and [incident: slack router dropped
forward] — subscription/registration racing DO wake, but on a deployed
preview slot, triggered by load.

No worker-side error events in the otel dataset for the windows (preview
sampling is sparse). Repro direction: run `pnpm e2e` with `CI=true` (enables
`sequence.concurrent`, maxConcurrency 6) against a preview slot repeatedly;
the flake showed up ~2 of 6 suite runs at maxConcurrency 10, less often at 6.

Mitigations in place (PR #1589): vitest `retry: 1` in CI, maxConcurrency
lowered 10 → 6. Neither fixes the underlying delivery race.
