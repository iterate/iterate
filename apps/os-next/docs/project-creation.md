# Project creation

Design agreed 2026-09-21; **the creation saga is not implemented**.
`session.projects.create()` registers a directory entry and returns its root
context. The project processor maintains catalogs but does not seed a config
repository or website. Explicit ingress and hostname discovery are deployed;
the manually repaired bench project does not prove fresh-project provisioning.

## Explicit publication

`await itx.whoami()` returns `projectSlug` and, when hosting is configured,
`projectUrl`. Use `itx.repos.get("/repos/config")`; no singular repository or
worker alias. Discover files with `repo.listFiles()`, then pin both source and
cache key to the returned `commitOid`:

```ts
const repo = itx.repos.get("/repos/config");
const { commitOid, paths } = await repo.listFiles();
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
// Probe this exact candidate before activation.
await itx.cd("/").append({
  type: "events.iterate.com/project/ingress-configured",
  payload: { target },
});
// Fetch projectUrl and verify its content before claiming publication.
```

The loader executes JavaScript; `.ts` does not imply transpilation. A cold load
must read the pinned revision even if the repository head advances.
The project apex uses the explicit ingress target; `target: null` disables it
and an unconfigured apex returns 404. `<app>--<project>.<base>` uses `itx.apps.<app>`.
Loading workers and committing files have no routing/subscription side effects.
Subscriptions use complete targets (including root navigation where needed).

## Proposed events and ownership

Follow the [OS project saga](../../os/src/domains/projects/project-processor-implementation.ts).
Event names below omit `events.iterate.com/`.

| Event                        | Stream                            | Meaning                                              |
| ---------------------------- | --------------------------------- | ---------------------------------------------------- |
| `project/create-requested`   | `/`                               | Immutable identity, slug and pinned template version |
| `repos/create-requested`     | `/repos/config`                   | Provision repository and seed files                  |
| `repo/commit-completed`      | `/repos/config`                   | Record actual seed commit                            |
| `repos/created`              | `/repos/config`, forwarded to `/` | Provisioning and seeding completed                   |
| `project/ingress-configured` | `/`                               | Activate the probed revision                         |
| `project/created`            | `/`                               | Terminal success, references creation-request offset |
| `project/worker-updated`     | `/`                               | Ready worker revision and commit                     |

The API registers the directory entry, atomically appends intent and enables
the project processor, then waits for the matching terminal event by default.
Caller disconnection must not cancel this durable work.

The repository processor owns provisioning/seeding. Its inline `create()` needs
durable recovery: reuse the repository and seed commit after redelivery, including
when a successful push lost its acknowledgement. Never overwrite subsequent
edits. Pin the template version in the request so deployment cannot change it
mid-recovery.

The project processor loads/probes the exact seed revision, then atomically
appends ingress, explicit userspace subscriptions, `project/created` and initial
`project/worker-updated`. `project/created` is the first userspace lifecycle event;
subscriptions start there, excluding bootstrap history. Creation does not wait
for userspace handlers.

## Recovery, edits and rollout

Deterministic provisioning/build failures emit `project/create-failed` with
request offset, stage and error. Transient retries need explicit bounds and an
exhaustion outcome. Stable idempotency keys deduplicate effects; only authoritative
terminal events matching the open intent can complete creation.

Later config commits use the same load/probe/activate flow, ending in
`project/worker-updated` or `project/worker-update-failed`. Keep the last verified
revision on failure. The project processor owns activation. Existing nonempty
repos and mappings require deliberate adoption, preserving files and app rules.

The deployed runtime retired only the exact former automatic config subscription;
custom subscriptions and historical events remain. An inventory of 1,423 projects
found no custom root mappings needing adoption. Agents now receive project identity
and explicit-publication instructions. Automatic repo publication and project
bootstrapping still require this saga.

Acceptance must cover fresh API creation, file discovery, real public HTTP,
subsequent edits, duplicate requests, restart at external-effect boundaries,
seed preservation, bounded failure/recovery and no premature userspace execution.
The bench proof published the requested joke, verified HTTP/content, returned the
hostname on a fresh follow-up and ended with no pending work or warnings/errors.
