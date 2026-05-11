# Repos Domain

Repos owns OS2 project-scoped versioned file trees.

A Repo is identified by Project ID and Repo Slug. In v1, Cloudflare Artifacts is
the backing storage service, but the OS2 domain should expose Repos rather than
Cloudflare Artifacts concepts.

## V1 target

The smallest useful slice is:

- list Repos for a Project
- create a Repo with a project-local slug
- open a Repo detail view
- show Repo details, especially the Git remote URL
- show clone/push instructions with the Repo's initial write token
- expose the same Repo operations to codemode through `ctx.repos`

## Routes

Use Project-local Repo routes:

```txt
/orgs/$organizationSlug/projects/$projectSlug/repos
/orgs/$organizationSlug/projects/$projectSlug/repos/$repoSlug
```

The detail route param is the Repo Slug. Do not put Cloudflare Artifacts names
or Durable Object names in user-facing URLs.

Add `Repos` to the project sidebar as a normal project section, linking to the
Repo list route. No count or status badge is needed in v1.

The create Repo form asks only for a slug. Build it as a normal TanStack form
with inline validation using the OS2 `Field`, `FieldLabel`, `FieldDescription`,
`FieldError`, and `Input` components. Use lowercase letters, numbers, and
hyphens. Do not add name, description, template, GitHub URL, or visibility in
v1.

Each Repo has a project-local stream path:

```txt
/repos/{repoSlug}
```

That stream records durable Repo lifecycle facts, such as Repo creation and
backing storage details. UI state does not belong in this stream.

The stream path is derived from the Repo Slug. Do not store it as separate Repo
identity.

## Stream processor

Repo state should be the reduced state from a `RepoStreamProcessor`, following
the same shape as `ProjectLifecycleProcessorContract`.

V1 events:

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

The created event records the initial Repo facts, including the Git remote and a
long-lived write token. The processor reduces that event into the current Repo
state, and `RepoDurableObject.getInfo()` should return that reduced state plus
any command snippets derived from it.

Do not add a separate `repoEventTypes` object. Put event type strings inline in
the contract object, `consumes`, and reducer. Repeating the durable event string
inside one processor definition is preferred over indirection.

## Names

Use a structured Durable Object name for OS2 identity:

```ts
{
  (projectId, repoSlug);
}
```

Use a Cloudflare Artifacts-safe projection internally because Artifacts names are
restricted to letters, digits, `.`, `_`, and `-`, starting with a letter or
digit:

```ts
artifactName = `${projectId}--${repoSlug}`;
```

The Artifacts name is implementation state. Ordinary product language should
stay on Project ID and Repo Slug.

## Capability first

Repo behavior should live in `ReposCapability`, bound with props:

```ts
{
  projectId: string;
}
```

Project oRPC procedures should be thin adapters around that capability. Codemode
should use the same capability directly so it can return live Durable Object
handles without expanding the oRPC surface area.

Keep capability props to stable Project ID. The project oRPC router already runs
under project-scope middleware from `projectSlugOrId`, so it may pass route
display context such as Project Slug as explicit command input when needed, but
that should not become capability authority.

Expected shape:

```ts
await ctx.repos.create({ slug: "banana" }).getInfo();
await ctx.repos.get({ slug: "banana" }).getInfo();
```

`create` is the explicit creation path and should throw if the Repo already
exists. `get` should select an existing Repo and must not implicitly initialize a
new Repo Durable Object.

## Durable Object handle

`ctx.repos.get({ slug })` should return the Repo Durable Object RPC stub itself.
That means public methods on `RepoDurableObject` are the codemode Repo handle
API. Keep that method surface intentionally small.

V1 handle methods:

```ts
getInfo(): Promise<RepoInfo>
```

Do not add separate public token, clone, or command methods in v1. `getInfo()`
is the only public Repo handle method and should return everything needed by the
UI or codemode caller. Internal lifecycle helpers should not be public methods
on `RepoDurableObject`.

## oRPC adapter

The external project API should stay close to the capability:

```ts
os.project.repos.list({ projectSlugOrId });
os.project.repos.create({ projectSlugOrId, slug });
os.project.repos.get({ projectSlugOrId, repoSlug });
```

Use oRPC for browser/API access and capability calls for codemode. Do not route
codemode through oRPC just to reach Repos.

Capability methods may return live Durable Object RPC stubs. oRPC procedures
must return serializable values, so `os.project.repos.create(...)` should call
the capability, receive the Repo Durable Object stub, call `getInfo()`, and
return that RepoInfo.

The Repo detail UI should show the information returned by `getInfo()` and
concrete local Git commands for clone, commit, and push.

The Repo list page should follow the simple sortable table pattern used by the
project Streams and Agents pages. Keep it catalog-only: show the Repo slug and
whatever timestamps/metadata are available from the Durable Object catalog. Do
not call into each Repo Durable Object to fetch remote, default branch, token, or
commands for the list page. Token and clone/push commands belong only on the
Repo detail page.

`getInfo()` should be generous. It is the single public info surface for the Repo
handle, so include raw Repo state plus derived local Git access details:

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

Cloudflare Artifacts exposes Git access through the returned `remote` URL and
token. Prefer command examples that use Git's `http.extraHeader` bearer-token
form so the token does not need to be embedded in the remote URL.

First-party Artifacts docs currently matter to the v1 shape:

- each Artifacts repo is isolated and has its own Git history, remote URL,
  access tokens, and durable state
- Artifacts repo names must start with a letter or digit, and remaining
  characters may only be letters, digits, `.`, `_`, or `-`
- `repo.createToken(scope, ttl)` returns a structured token result with
  `plaintext` and `expiresAt`
- Git access should prefer `git -c http.extraHeader="Authorization: Bearer
$TOKEN"` over embedding credentials in the remote URL
- write tokens can clone, fetch, pull, and push

Cloudflare recommends short-lived, narrowly-scoped tokens. The v1 OS2 prototype
intentionally stores one long-lived write token in Repo state so browser UI and
codemode can show a complete clone/push workflow without token refresh yet. That
trade-off should be revisited before making Repos broadly available.

## Iterate config repo

Every newly created Project should get an accompanying Repo with slug
`iterate-config`. This Repo is the project-local configuration tree, not a
special Cloudflare Artifacts concept.

The `iterate-config` Repo is created by the Project Durable Object during
Project creation. It is forked from the base Cloudflare Artifacts repo named
`iterate-config-base`; the fork then follows normal Repo lifecycle rules and
records `events.iterate.com/repo/created` in `/repos/iterate-config`.

The base repo is populated from the checked-in holder directory:

```txt
apps/os2/iterate-config-repo
```

Run the seed script from `apps/os2` with Cloudflare credentials and the exact
Artifacts namespace configured in `alchemy.run.ts`:

```sh
pnpm artifacts:seed-config-base -- --namespace <worker-name>-repos
```

The holder must contain `iterate.config.jsonc`. The file can stay a placeholder
until project config semantics exist.

## Discovery

Use `getInitializedDoStub({ allowCreate, name })` as the selector for Repo
Durable Objects. The helper owns lifecycle startup and the lifecycle catalog
preflight:

- `allowCreate: false` returns `null` when no initialized Repo DO exists
- `allowCreate: true` initializes lifecycle state when missing and returns the
  live Repo DO RPC stub

The Durable Object catalog remains useful for queryable lists, but callers
should not hand-roll a separate catalog lookup just to select a Repo.

Recommended semantics:

- `create` first calls `getInitializedDoStub({ allowCreate: false, name })` and
  throws if a Repo already exists. It then calls
  `getInitializedDoStub({ allowCreate: true, name, initialState })` and invokes
  the Repo DO's creation command. The creation command still needs a durable
  already-created guard because two callers can race past the selector preflight.
  It creates/attaches Cloudflare Artifacts backing storage, creates a minimal
  initial commit on the default branch, mints the initial long-lived write
  token, appends a Repo lifecycle event, and lets the catalog row appear.
- `get` calls `getInitializedDoStub({ allowCreate: false, name })` for the
  `{ projectId, repoSlug }` Repo and returns not found when the helper returns
  `null`.
- `list` reads lifecycle catalog rows by Project ID and returns only
  catalog-derived summary data.

Cloudflare Artifacts `create()` returns an initial token, but the documented
`create()` options do not include a TTL. Use `repo.createToken("write", ttl)` at
Repo creation time for the token stored in Repo state. The Artifacts docs expose
TTL in seconds and do not currently document a maximum. Use one far-future
constant for the prototype rather than exposing token refresh in v1.

New Repos created from scratch should not start empty. Create a minimal initial
commit on the default branch so clone and push instructions can use ordinary Git
commands. `RepoDurableObject` owns this v1 behavior directly: after creating the
Cloudflare Artifacts repo and minting the long-lived write token, it pushes a
minimal README commit before appending `events.iterate.com/repo/created`.

Forked Repos, such as `iterate-config`, inherit their initial tree from the
source Artifact and therefore should not receive the README bootstrap commit.

Initial README content should be deterministic:

```md
# {repoSlug}

Project: {projectSlug}
Project ID: {projectId}
```

Project Slug is human context; Project ID remains the stable identity. Project
identity belongs to capability props and the stream namespace, not the
`events.iterate.com/repo/created` payload.

Most durable repo state should stay in Durable Objects where practical. D1 is
for queryable projections, routing lookup, and cross-object indexes.

Cross-domain imports deserve care: these domains may become separate packages in
the future, which would make dependencies explicit.

## Open implementation questions

- Should `RepoDurableObject.getInfo()` read persisted processor-runner state,
  replay `/repos/{repoSlug}` on demand, or call a shared helper that hides that
  choice?
- Should the initial README push use plain Git commands in a temporary checkout,
  or direct in-Worker Git operations through `@cloudflare/shell`/isomorphic-git?
- Should the local class/export currently named `RepoCapability` be renamed to
  `ReposCapability` to match the domain language?
- Is eventual catalog visibility acceptable immediately after `create`, or must
  the list page show the new Repo synchronously?
