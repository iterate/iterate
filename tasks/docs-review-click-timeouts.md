---
status: ready
size: medium
---

# Diagnose Docs review click timeouts

The long Docs review spec still runs and reports outcomes, but its `createFlake`
pattern now also accepts one-second `locator.click` timeouts, as requested in
PR #2659. The cause is unresolved; no timeout or retry budget was increased.
Collaborative undo remains a separate, ordinary test.

- [x] Capture the observed failures. *Three different clicks reached an existing control but timed out waiting for visible/enabled/stable; see runs below.*
- [x] Keep the failures measured without blocking the parallelisation PR. *Only this spec's existing `createFlake` regex was widened to `locator.click: Timeout 1000ms exceeded`.*
- [ ] Reproduce the rendering/stability stall in a focused browser check.
- [ ] Fix the cause and demonstrate repeated real passes before removing the click-timeout alternative.

## Evidence

Test: `review a workspace document in the seeded Docs app`, in
`specs/seeded-apps.spec.ts`.

| Run | Failed click | Evidence |
| --- | --- | --- |
| `fr1lf3l0rs` | Add document comment | [First overlapping-shard run](https://depot.dev/orgs/0p91s0lz49/workflows/k5cpm0mmc6) |
| `tn30j8m4l6` | `.cm-content`, immediately after deliberate socket closure | [Shard 5](https://depot.dev/orgs/0p91s0lz49/workflows/gvmj0bcqjj?job=1crv2hqkd5) |
| `gmgqhwwnkh` | Rich editing, after reconnect/edit/persistence assertions passed | [Shard 5](https://depot.dev/orgs/0p91s0lz49/workflows/5r4l2fjxmp?job=mng6fns66d) |

The latter two runs used unchanged head `6073fa182`. Traces show the helper's
visibility/enabled checks completed in milliseconds, then the click spent its
full 1000ms waiting for stability. Sampled shard CPU around the repeat failure
was 7–21% of 16 cores. A local two-page/100-click check, both immediately and
with tracing after 31 seconds idle, did not reproduce it. Neither the traces
nor the CPU samples establish a root cause. Each failed shard retains its
trace and screenshots in its `preview-ci-playwright-5` artifact.

The broader pattern permits any one-second click timeout in this review spec,
not just the three recorded selectors. That is explicit coverage debt. Other
error types and the wrapper's whole-test watchdog still fail CI.
