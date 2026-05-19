---
state: done
priority: high
size: large
dependsOn: []
---

# Repos Vertical Slice

Build the first OS Repos slice: project-scoped Repos backed by Cloudflare
Artifacts, exposed through a capability, codemode, oRPC, and a small browser UI.

## Domain Model

- **Repo** is the OS domain object.
- **Cloudflare Artifacts** is the backing service, not domain language.
- A Repo is identified by Project ID plus Repo Slug.
- Repo Slug is project-local and uses lowercase letters, numbers, and hyphens.
- Repo Durable Object names use the normal structured name pattern:
  `{ projectId, repoSlug }`.
- Cloudflare Artifacts names are an internal safe projection, for example
  `${projectId}--${repoSlug}`.
- Repo stream path is derived from slug: `/repos/{repoSlug}`.
- Project identity comes from the stream namespace and capability props, not
  the Repo event payload.

## Repo Stream Processor

Add a Repo stream processor under `apps/os/src/domains/repos`.

Use inline event strings. Do not add a `repoEventTypes` object.

```ts
export const RepoStreamProcessorContract = defineProcessorContract({
  slug: "repo",
  version: "0.1.0",
  stateSchema: z.object({
    repo: z
      .object({
        defaultBranch: z.string().trim().min(1),
        remote: z.string().url(),
        slug: z.string().trim().min(1),
        token: z.string().trim().min(1),
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
        token: z.string().trim().min(1),
        tokenExpiresAt: z.iso.datetime().nullable(),
      }),
    },
  },
  consumes: ["events.iterate.com/repo/created"],
  emits: [],
  reduce({ state, event }) {
    switch (event.type) {
      case "events.iterate.com/repo/created":
        return { ...state, repo: event.payload };
    }
  },
});
```

Repo state is the reduced state from this processor. Do not use ad hoc DO
metadata fields as the product state.

## Durable Object

Update `RepoDurableObject` so it is the Repo handle.

V1 public handle surface:

```ts
getInfo(): Promise<RepoInfo>
```

Do not add separate public token, remote, clone, delete, or command methods.
`getInfo()` should be generous and return everything the UI or codemode needs:

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
};
```

Repo creation should:

- select the Repo Durable Object with `getInitializedDoStub({ allowCreate:
false, name })` and throw if it already exists
- select it with `getInitializedDoStub({ allowCreate: true, name,
initialState })` when it does not exist
- keep an authoritative already-created guard inside the Repo DO creation
  command because concurrent creates can race past selector preflight
- create the Cloudflare Artifacts repo
- mint one long-lived write token with `repo.createToken("write", ttlSeconds)`
- push a minimal README commit to the default branch
- append `events.iterate.com/repo/created`
- let the Durable Object catalog row appear

The initial README is deterministic:

```md
# {repoSlug}

Project: {projectSlug}
Project ID: {projectId}
```

Project Slug is human context; Project ID is stable identity.

## Capability

Create `ReposCapability`, bound with props:

```ts
{
  projectId: string;
}
```

Capability props always use Project ID. The project oRPC router already runs
under project-scope middleware from `projectSlugOrId`; it may pass Project Slug
as command input for README content, but Project Slug is not capability
authority.

Capability behavior:

- `create({ slug, projectSlug? })` returns the Repo Durable Object RPC stub
- `get({ slug })` returns the existing Repo Durable Object RPC stub
- `list()` reads the Durable Object catalog by Project ID only
- `executeCodemodeFunctionCall(...)` exposes `ctx.repos.create`, `ctx.repos.get`,
  and `ctx.repos.list`

`get` must not implicitly create or initialize a missing Repo. It should use
`getInitializedDoStub({ allowCreate: false, name })` and return not found when
the helper returns `null`. `create` should use the same helper with
`allowCreate: true` only after the missing-object path is established.

Codemode target:

```ts
await ctx.repos.create({ slug: "banana" }).getInfo();
await ctx.repos.get({ slug: "banana" }).getInfo();
```

## oRPC

Add project-scoped oRPC procedures as thin adapters around `ReposCapability`:

```ts
os.project.repos.list({ projectSlugOrId });
os.project.repos.create({ projectSlugOrId, slug });
os.project.repos.get({ projectSlugOrId, repoSlug });
```

Return serializable values:

- `create` calls capability `create`, receives the Repo stub, calls `getInfo()`,
  and returns `RepoInfo`
- `get` calls capability `get`, receives the Repo stub, calls `getInfo()`, and
  returns `RepoInfo`
- `list` returns only catalog-derived summary data; it should not fan out to
  each Repo Durable Object

No delete/remove in v1.

## UI

Routes:

```txt
/orgs/$organizationSlug/projects/$projectSlug/repos
/orgs/$organizationSlug/projects/$projectSlug/repos/$repoSlug
```

Add `Repos` to the project sidebar.

List page:

- use the simple sortable table pattern from Streams and Agents
- create Repo form asks only for slug
- build the form as a normal TanStack form with inline validation using
  `Field`, `FieldLabel`, `FieldDescription`, `FieldError`, and `Input`
- list data comes from catalog-derived summaries only
- do not show token or clone/push commands here

Detail page:

- call `getInfo()`
- show remote, default branch, token expiry, token, auth header, and concrete
  local Git commands for clone, commit, and push
- token/clone information only appears on this page

## Related Cleanup

Project lifecycle now uses:

- processor slug: `project`
- event type: `events.iterate.com/project/created`
- inline event strings in the processor contract and reducer

Keep that pattern for Repos and future domain processors.

## First-Party Artifacts Constraints

Cloudflare Artifacts docs currently confirm:

- each Artifacts repo is isolated and has its own Git history, remote URL,
  access tokens, and durable state
- repo names must start with a letter or digit, with only letters, digits, `.`,
  `_`, and `-` afterward
- `repo.createToken(scope, ttl)` accepts TTL seconds and returns `plaintext` plus
  `expiresAt`
- the docs do not currently state a maximum TTL
- local Git snippets should prefer `http.extraHeader="Authorization: Bearer
$TOKEN"` over embedding credentials in the remote URL
- Cloudflare recommends short-lived, least-privilege tokens, so the v1
  long-lived write token is an explicit prototype trade-off

## Implementation Decisions

- `RepoDurableObject.getInfo()` catches the Repo stream processor up and reads
  the reduced processor state.
- The initial README commit is pushed inside the Worker using
  `@cloudflare/shell`.
- The canonical capability export is `ReposCapability`. `RepoCapability` remains
  as a compatibility alias while provider wiring moves to the plural name.

Resolved nearby stream-path question: the Project Lifecycle Stream is root `/`.
Repo streams such as `/repos/{repoSlug}` are child streams inside the same
Project Stream Namespace.

## Acceptance Criteria

- A project user can create a Repo from the browser with a validated slug form.
- Creating an existing Repo fails clearly.
- The Repo list page shows catalog-derived Repo rows.
- The Repo detail page shows all `getInfo()` Git access information.
- The shown Git commands can clone locally, commit to README, and push.
- `ctx.repos.create({ slug }).getInfo()` works in codemode.
- `ctx.repos.get({ slug }).getInfo()` works in codemode.
- `ctx.repos.get({ slug })` for a missing Repo does not create a Repo.
- `events.iterate.com/repo/created` reduces to the state returned by `getInfo()`.
