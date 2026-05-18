# Repos and Cloudflare Artifacts preview verification

Date: 2026-05-11
Preview: `https://os.iterate-preview-2.com`

## Domain shape

Repos are OS domain objects backed by Cloudflare Artifacts. The public OS word
is `repo`; Cloudflare Artifacts are the current storage implementation.

Each repo is scoped by Project ID and slug. The Repo Durable Object owns the
repo state, but the state is reduced from repo lifecycle events. The creation
event type is `events.iterate.com/repo/created`; the project lifecycle processor
uses `events.iterate.com/project/created`.

The external API stays small:

- `GET /api/projects/{projectSlugOrId}/repos`
- `POST /api/projects/{projectSlugOrId}/repos`
- `GET /api/projects/{projectSlugOrId}/repos/{repoSlug}`

The oRPC layer is only an adapter. It resolves the project, constructs
`ReposCapability` with `{ projectId }`, then calls capability methods.

Codemode uses the capability directly:

```ts
const info = await ctx.repos.create({ slug: "banana" }).getInfo();
const existing = await ctx.repos.get({ slug: "banana" }).getInfo();
```

`getInfo()` is intentionally generous. It returns the remote URL, default branch,
write token, token expiry, and copyable Git commands needed to clone, commit, and
push.

## Cloudflare Artifacts deployment

The Artifacts binding must be configured in `apps/os/alchemy.run.ts`, not by a
post-hoc config transform. The generated Worker metadata should include:

```json
{
  "artifacts": [{ "binding": "ARTIFACTS", "namespace": "default" }]
}
```

Alchemy `0.83.3` did not emit Artifacts bindings in Worker metadata, so this
branch adds a small shared `Artifacts({ namespace })` helper plus a pnpm patch
for Alchemy's binding metadata and Wrangler JSON generation.

The deployed `os-preview-2` Worker settings were checked through the Cloudflare
API and include:

```json
{
  "name": "ARTIFACTS",
  "type": "artifacts",
  "namespace": "os-preview-2-repos"
}
```

## Runtime findings

Two live-preview failures shaped the final implementation:

- Returning a Durable Object stub directly from `ReposCapability.create()` made
  oRPC fail with `DataCloneError`. The oRPC procedures now call
  `createInfo()`/`getInfo()` and return plain data.
- Codemode also cannot rely on a raw Durable Object stub crossing every
  capability/session boundary. `ReposCapability.create()` and `get()` now return
  a tiny `RepoHandle extends RpcTarget` with `getInfo()`, backed by the Repo DO.
  This keeps the codemode surface as `ctx.repos.create(...).getInfo()` while
  avoiding raw DO stub serialization.

Cloudflare Artifacts token responses in preview returned the token as
`plaintext`/`token`, with the expiry embedded as `?expires=...`. Repo token
normalization now accepts both explicit expiry fields and that query parameter.

The repo list is still based on the Durable Object catalog, but it filters out
catalog rows whose Repo DO never reduced a `repo/created` event. This hides rows
left behind by failed first attempts.

## Live verification

Preview sync deployed OS commit `bb6500b` after the list hardening and this
document were committed. The final OS preview smoke passed against
`https://os.iterate-preview-2.com/`.

Direct repo API creation succeeded for slug `codex-artifacts-1778533765369` and
returned a Cloudflare Artifacts remote:

```text
https://cc7f6f461fbe823c199da2b27f9e0ff3.artifacts.cloudflare.net/git/os-preview-2-repos/proj__os__01krcc1gw2endaxnw129rdm4cm--codex-artifacts-1778533765369.git
```

Real local Git verification against that remote succeeded using the returned
`Authorization: Bearer ...` header:

```text
72cf67b Verify local push
db9bd65 Initial commit
```

Codemode creation was verified through
`POST /api/projects/haha/codemode-scripts` with a `repos` provider that called:

```ts
async (ctx) => {
  const info = await ctx.repos.create({ slug: "codemode-artifacts-1778534416072" }).getInfo();
  return {
    slug: info.slug,
    remote: info.remote,
    defaultBranch: info.defaultBranch,
    tokenExpiresAt: info.tokenExpiresAt,
    hasToken: typeof info.token === "string" && info.token.length > 0,
    hasCloneCommand: typeof info.git?.cloneCommand === "string",
  };
};
```

The codemode completion event succeeded and returned:

```json
{
  "slug": "codemode-artifacts-1778534416072",
  "defaultBranch": "main",
  "tokenExpiresAt": "2026-05-12T21:20:23.000Z",
  "hasToken": true,
  "hasCloneCommand": true
}
```

The codemode-created repo was then cloned and pushed from this machine with real
Git using the returned header credentials:

```text
d7f379f Verify codemode repo push
9662167 Initial commit
```

After deploying list hardening, `GET /api/projects/haha/repos` returned three
created repos and did not include the earlier failed `asdasd` catalog row.

Local checks run before commits:

```sh
pnpm --filter @iterate-com/os typecheck
pnpm --filter @iterate-com/os test
```
