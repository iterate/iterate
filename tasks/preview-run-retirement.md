---
status: in-progress
size: large
---

# Stop finished test runs without erasing their preview deployment

Review branch, stacked on `codex/playwright-full-parallel` (PR #2659). No PR.
The first commit records the intended change; implementation and local proof follow.

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

- [ ] Choose and explain ownership propagation without changing project IDs.
- [ ] Implement the retirement decision and meaningful behaviour tests.
- [ ] Connect it to recurring DO work, including constructor rearming.
- [ ] Show test ownership registration and CI lifecycle wiring in the diff.
- [ ] Document containers, shared state and rollout limitations explicitly.
- [ ] Run focused tests, type checks and lint/format checks for changed code.
- [ ] Self-review the complete diff and publish a compare link, without a PR.

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

