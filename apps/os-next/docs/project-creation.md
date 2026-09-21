# Project creation

Design agreed on 2026-09-21; the bootstrap described below is not implemented yet.
Currently `session.projects.create()` registers a directory entry and returns its
root context. The project processor maintains catalogs; it does not seed a config
repository. New projects do not yet receive an editable website automatically.

The explicit-ingress runtime and hostname discovery were deployed on 2026-09-21.
`await itx.whoami()` returns `projectSlug` and, where project hosting is configured,
`projectUrl`. The bench project has been adopted explicitly: its config repo,
README, pinned ingress target and public website are working. This repair does
not implement the creation saga described below.

## Explicit repository and worker addresses

Use `itx.repos.get("/repos/config")`; do not introduce an `itx.repo` alias.
The repository contains `worker.ts` and a README describing the actual project
URL, file operations, and deployment behavior. Prompts should show the worker
specification directly:

```ts
const repo = itx.repos.get("/repos/config");
const { commitOid, paths } = await repo.listFiles();
const source = await repo.readFile("worker.ts");
const worker = itx.workers.get({
  source: ["itx", "repos", ["get", "/repos/config"], ["readFile", "worker.ts", { commitOid }]],
  cacheKey: commitOid,
});
```

`readFile(path, { commitOid })` reads the exact Git revision, even after main
advances. Use the same commit in the source expression and cache key. A cold
worker load then cannot fetch a different revision. The loader executes JavaScript
modules directly; a `.ts` filename does not transpile TypeScript. Probe the
candidate's `fetch` before activation, then fetch `projectUrl` and verify its
actual content before reporting publication.

Ingress is explicit configuration: `<project>.<base>` uses the full target expression
from `project/ingress-configured` on `/`; `<app>--<project>.<base>` uses
`itx.apps.<app>`. There is no default worker alias or automatic subscription.

```ts
const target = [
  "itx",
  "workers",
  [
    "get",
    {
      source: ["itx", "repos", ["get", "/repos/config"], ["readFile", "worker.ts", { commitOid }]],
      cacheKey: commitOid,
    },
  ],
];
await itx.cd("/").append(
  {
    type: "events.iterate.com/project/ingress-configured",
    payload: { target },
  },
  {
    type: "events.iterate.com/stream/subscription-configured",
    payload: { name: "config", target: [...target, "processEventBatch"], consumes: ["*"] },
  },
);
```

`target: null` disables ingress; the apex returns 404 until configured. Configuration
is durable and visible in the root log. Subscriptions on other contexts likewise
store their complete target (including `cd("/")` when executing at the root).
Loading a worker, creating a stream, or committing a file has no implicit routing
or subscription side effect. The saga will publish these configuration events
only after it has verified the candidate revision.

## Creation events

Follow the ownership and readiness boundary in
[`apps/os`'s project saga](../../os/src/domains/projects/project-processor-implementation.ts).
Names below omit `events.iterate.com/`.

| Event                        | Stream                            | Meaning                                                                        |
| ---------------------------- | --------------------------------- | ------------------------------------------------------------------------------ |
| `project/create-requested`   | `/`                               | Immutable creation intent: project identity, slug and pinned template version. |
| `repos/create-requested`     | `/repos/config`                   | Request the backing repository and initial files.                              |
| `repo/commit-completed`      | `/repos/config`                   | Initial files were committed; records the actual commit ID.                    |
| `repos/created`              | `/repos/config`, forwarded to `/` | Repository provisioning and the requested seed completed.                      |
| `project/ingress-configured` | `/`                               | Activate the loaded and successfully probed revision as the ingress worker.    |
| `project/created`            | `/`                               | Creation completed; references the opening request's offset.                   |
| `project/worker-updated`     | `/`                               | The initial worker revision is ready; identifies its commit.                   |

The API registers the project directory entry, then atomically appends the
creation intent and enables the project processor. By default it waits for the
matching terminal creation event. Disconnecting a caller does not cancel the
durable obligation.

The repository processor owns provisioning and seeding. Its current inline
`create()` needs durable recovery for this workflow. Repeated deliveries reuse
the backing repository and seed commit; they must not overwrite subsequent edits.
The template version is creation input, so a platform deployment cannot change
the seed halfway through recovery.

The project processor loads and probes the exact seeded worker revision before
activation. The root mapping, userspace feed configuration, `project/created`,
and initial `project/worker-updated` are appended atomically. `project/created`
is the first userspace lifecycle event; creation does not wait for userspace to
handle it. The saga installs explicit subscriptions starting at this boundary, so bootstrap
events are not replayed into newly installed code.

## Failure and recovery

Terminal repository or deterministic build failures become
`project/create-failed`, naming the creation-request offset, stage and error.
Transient failures remain pending for bounded, observable recovery. Retry limits
and exhaustion outcomes must be explicit in the implementation; pending must not
mean an unbounded retry loop.

Stable idempotency keys deduplicate consequences. Terminal events must match the
open creation intent and have authoritative provenance; an arbitrary or stale
birth-shaped event cannot complete creation. Recovery resumes from durable facts,
including after a seed push succeeded but its acknowledgement was lost.

## Subsequent edits and existing projects

Later config `repo/commit-completed` events trigger the same load/probe/activate
path, ending in `project/worker-updated` or `project/worker-update-failed`.
The last verified revision remains active when a candidate fails. Activation has
one owner: the project processor. `ConfigWorker` no longer follows commits or changes routing itself. Existing manually wired projects
need an explicit compatibility or adoption path during that transition.

The bench repair should enter this workflow, preserving `itx.voice`, other app
rules and existing files. A conflicting worker mapping or nonempty repository
must be inspected and adopted deliberately, never overwritten by the template.

Acceptance evidence covers fresh creation through the public API, file discovery,
real project-host HTTP responses, a config edit becoming visible, duplicate
requests, restart at each external-effect boundary, seed preservation, failure
and recovery, and absence of userspace execution before terminal creation.

## Rollout

The runtime removal is deployed. The production inventory covered 1,423 registered
projects and found no custom root mappings requiring adoption. Existing contexts
retire the exact former automatic `config` subscription once, recording its
removal durably; other subscriptions are preserved. New contexts receive none.
Historical events remain history; there is no compatibility alias.

The normal agent and voice backend prompts describe explicit publication, pinned
reads and public HTTP verification. Both the voice model and backend receive the
actual project identity and URL. Repo-based automatic publication and automatic
new-project bootstrapping remain work for the saga above.

Production verification used the deployed voice backend to publish an elephant joke,
then restore the user's newer chicken-joke request. Both turns fetched the public
page and verified HTTP 200 plus the requested text; each follow-up performed a new
fetch and returned `prj-kit-bench.iterate2.app`. The final processor had no pending
work. Releasing the backend's per-script ITX scope fixed a connection-cleanup warning;
the repeated proof produced no warnings or exceptions.
