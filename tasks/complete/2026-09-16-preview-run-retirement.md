---
status: complete
size: large
---

# Stop finished test runs without erasing their preview deployment

Review branch, stacked on `codex/playwright-full-parallel` (PR #2659). No PR.
Review implementation complete: run ownership, DO retirement, container idle shutdown,
and an opt-in CI path are implemented and locally checked. The experiment remains
off pending live quieting, client-coverage and retained-state proof; see
`docs/preview-test-retirement.md`. No live environment was changed.

## Request

Separate stopping recurring test compute from deleting persistent data. Leave
the deployed application usable after tests. Let finite in-flight work finish.
Delete accumulated data/artifacts when the environment lease is released,
expires, or changes owners, rather than on both sides of every test run.

Keep Auth-generated project IDs unchanged. Investigate DO query parameters
versus separately stored project/run ownership; prefer the smallest design
that cannot silently lose ownership when one DO addresses another.

## Proposed behaviour

- Every test consumer in a preview attempt shares one run identity, including
  all Playwright shards, app tests and preparation smoke tests.
- Test-created projects are marked before their background work starts.
  Human-created projects and shared/global resources are not retired with tests.
- Streams, Schedulers and stateful Workers stop recurring work for retired
  runs. Stream initialization must not rearm a retired object's alarms.
- Containers retain their shutdown machinery. Retirement must not turn off
  an alarm responsible for stopping a container; shared finite builds may finish.
- Finishing a run changes a small control record, without listing every DO or
  deleting its data. Old finalizers cannot retire a newer run.
- Cancellation is covered by the next run and the environment lease expiry
  backstop; a successful post-test finalizer is not the sole cost guarantee.
- Routine pre/post full erasure can be skipped only for an environment using
  the new protocol. Handover, legacy state and incompatible schemas still
  require an explicit reset.

## Scope and proof

- [x] Choose and explain ownership propagation without changing project IDs. _KV ownership keyed by Auth-generated ID; root Stream serialises registration before birth. Query-name alternative is explained in the design note._
- [x] Implement the retirement decision and meaningful behaviour tests. _PreviewTestRuns covers predecessor retirement, stale finalizers, expiry and immutable ownership._
- [x] Connect it to recurring DO work, including constructor rearming. _Stream, Scheduler and StatefulWorker guards; the real Stream fixture proves retirement survives eviction and rejects late rearming._
- [x] Show test ownership registration and CI lifecycle wiring in the diff. _Authenticated test header, root birth registration, shared attempt plan, optional same-owner preservation and ci-dispose._
- [x] Document containers, shared state and rollout limitations explicitly. _The design note lists live acceptance checks; sandbox idle expiry disables test keepalive without suppressing SDK alarms._
- [x] Run focused tests, type checks and lint/format checks for changed code. _Runtime tests and preview tooling tests pass; OS, streams, scripts, shared and spec type checks pass. CLI help and changed-file lint/format checked._
- [x] Self-review the complete diff and publish a compare link, without a PR. _Reviewed ownership/identity races, initializer rearming, artifact-download races, expiry and default-off gating; compare against codex/playwright-full-parallel._

This is a review implementation, not an instruction to change live previews.
Full cleanup remains the default until the new path has deployed evidence
that abandoned work goes quiet and tests remain isolated. Any experimental
switch and remaining deployment proof must be visible in the final report.

## Implementation log

- Base: `bd8611b46` on `codex/playwright-full-parallel`.
- Existing names include project ID and resource path. Query properties are
  supported, but most internal lookups reconstruct names without forwarding
  properties. Adding a run query parameter only at initial creation is unsafe.
- `Auth.mintProjectId()` owns normal project IDs; this branch will preserve it.


- Chose stored ownership rather than changing names: every internal caller already carries the project ID. Root-stream registration also supports Auth-first signup and refuses to relabel a born human project.
- Control records use per-attempt retirement markers instead of a mutable timestamp cutoff, so stale finalizers cannot retire a newer attempt. A fixed deadline handles cancellation without a subsequent run.
- CLI imports exposed an existing Node strip-types incompatibility in `CloudflareApiError`; replaced constructor parameter properties with equivalent fields.
