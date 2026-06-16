# Repos Domain

Repos are OS project-scoped versioned file trees backed by Cloudflare
Artifacts. A Repo is identified by `{ projectId, path }`, where `path` is the
project-local stream path, for example `{ projectId: "proj_123", path:
"/repos/project" }`.

The Artifacts repo name is a derived implementation detail. Do not persist,
route, or display it as Repo identity.

## Files

- `durable-objects/repo-durable-object.ts` — `RepoDurableObject`: Artifacts
  backing storage, on-demand token minting, hosted `repo` stream processor.
- `entrypoints/repo-capability.ts` — `ReposCapability` worker entrypoint plus
  the `RepoHandle` RpcTarget returned to callers.
- `stream-processors/repo-stream-processor.ts` — the `repo` processor contract
  and pure reducer.
- `repo-durable-object-name.ts` — Repo Durable Object name helper; callers pass
  `{ projectId, path }`.
- `repo-artifact-name.ts` — derived Artifacts repo names from Repo references.
- `project-repo.ts` / `iterate-config-base-seed.ts` — project repo path and
  base-repo seeding.

## Stream and processor

Each Repo's event stream is its Repo path inside the project. The project repo
uses `/repos/project`; another repo could use `/repos/customer-sites/site-a`.

The `repo` processor is a pure projection of durable lifecycle facts. It has no
side effects.

```ts
repo: {
  defaultBranch: "main",
  path: "/repos/project",
  remote: "https://...",
  tokenExpiresAt: null,
}
```

`events.iterate.com/repo/created` records the durable repo facts. Token
plaintext is deliberately not in the stream or reduced state. `RepoInfo` mints
a short-lived Artifacts token on demand when callers need Git access.

## Durable Object surface

`RepoDurableObject` uses the canonical Durable Object name encoding:

```ts
getRepoDurableObjectName({ projectId: "proj_123", path: "/repos/project" });
// "proj_123:/repos/project"
```

Public RPC methods:

- `createRepo(input)` — creates an empty Artifacts repo, or forks one when
  `input.source.kind === "artifact-fork"`, then appends
  `events.iterate.com/repo/created`.
- `getInfo()` — returns `RepoInfo`; throws if the Repo has not been created.
- `refreshWriteToken()` — compatibility surface that returns freshly minted
  `RepoInfo`; no token is stored in Durable Object storage.
- `commitFiles`, `readFiles`, `listFiles`, `readTree`, `headOid`, and
  `readLog` — workspace-free Git operations backed by on-demand credentials.
- `getArtifact()` — returns the raw Cloudflare Artifacts repo handle.
- `requestStreamSubscription(args)` — stream subscription plumbing for the
  hosted processor.

`RepoInfo` contains `path`, `remote`, `defaultBranch`, a freshly minted `token`,
token expiry, Git command snippets, and username/password credentials.

## Capability

`ReposCapability` (`WorkerEntrypoint`, props `{ projectId: string }`) is the
shared surface for UI, oRPC, and itx:

- `create({ path })` / `get({ path })` — return a `RepoHandle`.
- `createInfo({ path })` / `getInfo({ path })` — return
  serialized `RepoInfo`.
- `ensureProjectRepoInfo()` — create-or-read `/repos/project`.
- `list()` — reads the project processor's reduced child-stream state and
  filters out repos whose stream has not completed `repo/created`.
- `call(input)` — itx path-call dispatch for the methods above.

Selection uses the repo Durable Object namespace with `name` always derived
from `{ projectId, path }`.

The project itx context exposes the capability as `itx.repos`. The repo
dashboard routes (`src/routes/_app/projects/$projectSlug/repos`) call
`itx.repos.list()`, `itx.repos.create(...)`, and `itx.repos.getInfo(...)`
directly through the itx React hooks.

## The project repo

Every Project gets `/repos/project`, created during project creation as a fork
of the global base Repo reference `{ projectId: null, path:
"/repos/iterate-config-base" }`. The fork follows normal Repo lifecycle and
records `repo/created` in `/repos/project`.

The base artifact is seeded from `apps/os/iterate-config-repo`:

```sh
pnpm cli artifacts seed-config-base
doppler run --project os --config dev_jonas -- pnpm cli artifacts seed-config-base
```

## Notes

- Repo identity is the `{ projectId, path }` tuple. Avoid extra names for the
  same thing.
- Durable token storage was removed. Git access mints a token when needed.
- Product routes use a catch-all under `/repos/*` so Repo paths with nested
  segments remain addressable.
