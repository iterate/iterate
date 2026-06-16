# Repos Domain

Repos are OS project-scoped versioned file trees backed by Cloudflare
Artifacts. A Repo is identified by Project ID and Repo Slug; the Artifacts name
is the internal projection `${projectId}--${repoSlug}` (`repo-artifact-name.ts`).
Product language and URLs stay on Project ID and Repo Slug, never Artifacts or
Durable Object names.

## Files

- `durable-objects/repo-durable-object.ts` — `RepoDurableObject`: lifecycle,
  Artifacts backing storage, token storage, hosted `repo` stream processor.
- `entrypoints/repo-capability.ts` — `ReposCapability` worker entrypoint plus
  the `RepoHandle` RpcTarget returned to callers.
- `stream-processors/repo-stream-processor.ts` — the `repo` processor contract
  and pure reducer.
- `artifacts.ts` — Cloudflare Artifacts binding helpers, token minting, remote
  URL derivation, initial README push.
- `project-repo.ts` / `iterate-config-base-seed.ts` — the project repo
  slug (`project`) / base-artifact constants and the base-repo seeding
  script.
- `repo-errors.ts` — error classifier helpers
  (`isRepoAlreadyExistsError`, ...).

UI routes: `/projects/$projectSlug/repos` and
`/projects/$projectSlug/repos/$repoSlug` (detail param is the Repo Slug).

## Stream and processor

Each Repo has a project-local stream at `/repos/{repoSlug}` (stream namespace =
Project ID) that records durable lifecycle facts. The `repo` processor is a
pure projection of those facts; it has no side effects. The actual contract:

```ts
export const RepoStreamProcessorContract = defineProcessorContract({
  slug: "repo",
  version: "0.1.0",
  description: "Tracks Repo lifecycle facts and Git access state.",
  stateSchema: z.object({
    repo: z
      .object({
        defaultBranch: z.string().trim().min(1),
        remote: z.string().url(),
        slug: z.string().trim().min(1),
        tokenExpiresAt: z.iso.datetime().nullable(),
      })
      .nullable()
      .default(null),
  }),
  initialState: { repo: null },
  events: {
    "events.iterate.com/repo/created": {
      description: "A Repo was created and its initial Git access details were recorded.",
      payloadSchema: z.object({
        defaultBranch: z.string().trim().min(1),
        remote: z.string().url(),
        slug: z.string().trim().min(1),
        tokenExpiresAt: z.iso.datetime().nullable(),
      }),
    },
  },
  consumes: ["events.iterate.com/repo/created"],
  emits: [],
});
```

The write token is deliberately NOT in the stream or reduced state. The
`repo/created` payload carries only `defaultBranch`, `remote`, `slug`, and
`tokenExpiresAt`; the token plaintext lives in `RepoDurableObject` storage
(`repo.writeToken`, `repo.writeTokenExpiresAt`). Keep it that way: stream
events are widely readable and replayable.

## Durable Object surface

`RepoDurableObject` uses a structured name `{ projectId, repoSlug }`, registers
catalog indexes on both fields, and hosts the `repo` processor via
`createStreamProcessorHost`. Its public RPC methods:

- `createRepo(input)` — creates the Artifacts repo (or forks one when
  `input.source.kind === "artifact-fork"`), mints a write token
  (`REPO_WRITE_TOKEN_TTL_SECONDS`, currently one year), pushes an initial
  README commit for from-scratch repos (forks inherit their tree), stores the
  token in DO storage, then appends `events.iterate.com/repo/created`.
- `getInfo()` — returns `RepoInfo` (below); throws if the Repo has not been
  created.
- `refreshWriteToken()` — mints a fresh write token, stores it (and its
  expiry) in DO storage, returns updated `RepoInfo`.
- `commitFiles({ branch?, message, changes, author? })` — commits an array of
  file writes/deletes to a branch (default branch unless specified) and
  pushes. See "Workspace-free git operations" below.
- `readFiles({ branch?, paths, encoding? })` — reads files from a branch;
  missing paths come back with `content: null`.
- `listFiles({ branch? })` — lists all file paths on a branch.
- `readLog({ branch?, depth? })` — commit log, newest first.
- `getArtifact()` — returns the raw Cloudflare Artifacts repo handle.
- `requestStreamSubscription(args)` / `afterAppend(input)` — stream
  subscription plumbing for the hosted processor.

`RepoInfo` (actual shape):

```ts
type RepoInfo = {
  defaultBranch: string;
  git: {
    authorizationHeader: string;
    cloneCommand: string;
    commitExampleCommand: string;
    pushCommand: string;
    remote: string;
  };
  readmePath: string;
  remote: string;
  slug: string;
  token: string;
  tokenExpiresAt: string | null;
  credentials: { username: string; password: string };
};
```

`git.*` are derived shell snippets using Git's
`http.extraHeader="Authorization: Bearer $TOKEN"` form so the token is not
embedded in the remote URL. `credentials` is the username/password form of the
same token (`username: "x"`).

## Workspace-free git operations

`commitFiles`, `readFiles`, `listFiles`, and `readLog` operate directly on the
backing git remote without a Workspace. Each call clones into a throwaway
in-memory filesystem (`@cloudflare/shell` `InMemoryFs` + isomorphic-git), does
its work, and for commits pushes back. The plumbing lives in
`apps/os/src/domains/repos/repo-git.ts`.

The most common operation is committing an array of files to a branch (the
default branch unless specified):

```ts
await repo.commitFiles({
  message: "Update config",
  changes: [
    { path: "iterate.config.jsonc", content: "{...}" },
    { path: "assets/logo.png", content: "<base64>", encoding: "base64" },
    { path: "old-file.txt", delete: true },
  ],
});
```

Deletes are serialized as `{ path, delete: true }`; writes as `{ path, content,
encoding? }`. Writing identical content or deleting an absent path is a no-op —
when nothing actually changes, no commit is created and the result has
`noChanges: true`. Committing to a branch that does not exist yet creates it
off the default branch. The Durable Object serializes commits per repo, and the
write token is refreshed once automatically on an auth failure.

## Capability

`ReposCapability` (`WorkerEntrypoint`, props `{ projectId: string }`) is the
itx surface for repos. It is also exported under the alias `RepoCapability`.
Methods:

- `create({ slug, projectSlug? })` / `get({ slug })` — return a `RepoHandle`
  RpcTarget exposing `getInfo`, `refreshWriteToken`, `commitFiles`,
  `readFiles`, `listFiles`, `readLog`, and `getArtifact`. `create` throws if
  the Repo already exists; `get` never implicitly initializes a Repo DO.
- `createInfo` / `getInfo` — same, but return serialized `RepoInfo`.
- `ensureProjectRepoInfo({ projectSlug })` — create-or-read the project's
  `project` Repo.
- `list()` — reads D1 lifecycle catalog rows by the `projectId` index, then
  filters out rows whose DO exists but was never fully created.
- `call(input)` — itx path-call dispatch for the methods above.

Selection uses `getInitializedDoStub({ allowCreate, namespace, name })`;
`allowCreate: false` returns `null` when no initialized Repo DO exists.

The project itx context exposes the capability as `itx.repos`. The repo
dashboard routes (`src/routes/_app/projects/$projectSlug/repos`) call
`itx.repos.list()`, `itx.repos.create(...)`, and `itx.repos.getInfo(...)`
directly through the itx React hooks.

## The project repo

Every Project gets a Repo with slug `project`, created by the Project
Durable Object during project creation as a fork of the Cloudflare Artifacts
repo `iterate-config-base` (`ensureProjectRepoInfoForProject`). The fork
follows normal Repo lifecycle and records `repo/created` in
`/repos/project`.

The base artifact is seeded from the checked-in holder directory
`apps/os/iterate-config-repo` (must contain `iterate.config.jsonc`):

```sh
# from apps/os, in the Doppler config that owns the environment
pnpm cli artifacts seed-config-base
doppler run --project os --config dev_jonas -- pnpm cli artifacts seed-config-base
```

Pass `--namespace <worker-name>-repos` only when the namespace cannot be
inferred from the Doppler config.

## Notes

- The one-year write token is a deliberate prototype trade-off so UI and
  itx get a complete clone/push workflow; revisit before making Repos
  broadly available. `refreshWriteToken` exists for recovery from expiry.
- D1 holds the queryable Repo catalog (lifecycle rows indexed by `projectId`
  and `repoSlug`); everything else durable lives in the Repo DO and its
  stream.
