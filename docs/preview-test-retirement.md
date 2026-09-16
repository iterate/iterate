# Preview test retirement — review implementation

Stop recurring test work without deleting its data or replacing the application
with a 503 worker. This branch is stacked on the Playwright parallelisation
work. **The workflow experiment is off. Do not enable it until the rollout
checks below are complete. No live environment was changed for this review.**

Start reading at
[`PreviewTestRuns`](../apps/os/src/domains/preview-test-runs.ts), then
[`PreviewTestRetirement`](../apps/os/src/domains/preview-test-retirement.ts).
The first owns a few KV records; the second is the DO's decision to stop.

## Identity

Auth still generates project IDs. DO names still look like
`prj_<uuid>.iterate/repos/config?branch=main`.

A query parameter is technically possible, but it is part of the object's
identity, not an annotation. A caller that omits `?testRun=…` reaches a different
object. Existing internal lookups repeatedly reconstruct names using just the
project ID and path. This draft stores ownership separately to avoid changing
all of those addresses and their propagation rules.

All consumers of one attempt share this descriptor:

```yaml
id: 2659/123456/2 # PR / workflow run / attempt; shared across shards
expiresAt: 1789567200000 # fixed deadline, currently the existing three-hour duration
```

CI passes it as `PREVIEW_TEST_RUN`. Test connections carry it in
`x-iterate-preview-test-run`. OS accepts it only after authentication, and only
on preview environments. Its root Stream records ownership before appending
the project creation request. This works whether OS or Auth allocated the ID
first. A root that has already begun a human project's creation rejects
relabeling. Its child DOs already know the unchanged project ID.

The streams playground has no Auth project objects. Its common test helpers
instead use the synthetic namespace `preview-test-2659-123456-2`, registered
once by prepare. Its Worker gets read access through the same slot's existing
`PROJECT_DIRECTORY` KV binding.

## What happens

| When                                               | Work                                                                                                             |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| First use, handover, expired lease, or legacy slot | Existing full erase, then deploy.                                                                                |
| Another run on the same live lease                 | With the experiment enabled and a matching protocol marker, keep existing data and deploy.                       |
| Prepare starts the test attempt                    | Retire the preceding attempt, publish the new descriptor, register the playground namespace. No DO enumeration.  |
| Tests create projects                              | Store project → run ownership before project bootstrap.                                                          |
| All app tests and browser shards have settled      | Write that exact run's retirement marker. Report collection runs alongside this. Leave the application deployed. |
| A retired object's next alarm fires                | Observe retirement, remember it in DO storage, delete its pending alarm, and return successfully.                |
| An old CI finalizer arrives late                   | It writes only its own run's marker. It cannot retire the newer run.                                             |
| CI is killed without teardown or another run       | The immutable run deadline eventually stops marked objects' recurring work.                                      |
| The environment lease is released or swept         | Existing full cleanup deletes accumulated data/artifacts and parks the Worker.                                   |

The KV records are intentionally small and retained until full erasure:

```yaml
ci:project:prj_<uuid>:
  runId: 2659/123456/2
  expiresAt: 1789567200000
ci:test-run:2659/123456/2:
  id: 2659/123456/2
  expiresAt: 1789567200000
ci:retired-test-run:2659/123456/2: retired
ci:current-test-run: 2659/123456/2
ci:retirement-protocol: v1:pr-2659
```

There is no renewable per-project lease. A fixed run deadline is the backstop
for a killed CI process. Beginning a run requires the existing preview
lifecycle lock. Finalizers only write per-run markers. Records must not expire
independently: losing an ownership record would make an old project look human-created.

## Which work stops

- **Streams:** skip constructor rearming and wake recovery; stop alarm-driven
  delivery/facet work. Once retirement is observed, late work cannot rearm it.
- **Schedulers:** stop alarm-triggered schedules and heartbeats.
- **Stateful Workers:** stop forwarding alarms into project code or accepting
  new alarm scheduling for retired test projects.
- **Sandboxes:** when idle expiry occurs, turn off test keepalive and continue
  the existing snapshot/shutdown path. Never suppress the SDK's shutdown alarm.
- **Shared build coordinators:** finish their finite build normally.

Finite work can finish. This is not a hard cancellation mechanism for running
scripts or containers with indefinitely busy commands. Retired test data stays
available; recurring behaviour in those projects stops. Fresh human-created
projects continue to work in the same deployment.

KV is eventually consistent: stopping is delayed by propagation and the next
alarm. A DO persists retirement locally so a later stale KV read cannot revive
it. The design does not promise an exact zero-cost timestamp.
[KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/#consistency).

## Before enabling

- [ ] Exercise browser signup against a preview. Root-stream tests cover
      Auth-first allocation and rejection of human-project relabeling; the live
      browser proof must also verify the ownership header reaches its WebSocket.
- [ ] Audit custom test clients and explicit playground project IDs. Common
      fixtures, CLI helpers and agent-smoke carry ownership; bypassing those
      helpers must not silently leave unmarked background work.
- [ ] Prove against a preview that an abandoned run goes quiet, including warm
      and cold Streams, Schedulers, stateful Workers and keepalive containers.
      Audit shared/global streams linked to test projects too; they are not retired
      by a project ownership marker.
- [ ] Verify two successive runs, a cancelled run, and a stale finalizer. Check
      traces and alarms as well as green tests. KV missing-value caches must only
      delay retirement, never retire current work.
- [ ] Prove full suites tolerate preserved Auth/global state. Bump the reuse
      protocol (or force a full erase) for incompatible retained storage changes.
- [ ] Measure the added KV lookups. Consider bounded caching if material;
      preserve the fixed expiry and durable retirement marker.

The experiment switch is `PREVIEW_TEST_RETIREMENT_EXPERIMENT` in
`.depot/workflows/preview-run.yml`. It forces all apps to deploy supporting code.
Ordinary runs retain the existing full erase. The new `ci-dispose` reads a
separately downloaded, attempt-checked plan, so report downloads cannot race
cleanup's choice of environment or mode.

The same switch deploys `PREVIEW_TEST_RETIREMENT=1` into preview Workers.
Without it, the new DO guards do no KV reads and test ownership headers are
rejected. Production never enables the guard.

For a controlled, already-leased preview, the small CLI uses the repo's
`trpc-cli` convention:

```sh
pnpm exec trpc-cli scripts/preview/test-runs.ts --help
# begin --env preview_N --id PR/RUN/ATTEMPT --expires-at <epoch-ms>
# retire --env preview_N --id PR/RUN/ATTEMPT
```

Neither command deploys, deletes objects, or deletes artifacts. `begin` retires
the previous test run, so the caller must own the slot and its lifecycle lock.
