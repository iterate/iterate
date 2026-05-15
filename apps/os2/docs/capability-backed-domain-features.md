# Capability-backed domain features

Use this pattern when adding an OS2 project-scoped domain that should be
available both through the browser/API and through codemode.

## Rule

Put domain behavior in a project-bound capability first. Make oRPC a thin adapter
around the capability. Let codemode call the capability directly when live
Workers RPC handles matter.

## Shape

1. Define the domain language in `apps/os2/CONTEXT.md`.
2. Add a domain folder under `apps/os2/src/domains/{domain}`.
3. Add a `README.md` that names the smallest useful vertical slice.
4. Model project ownership with capability props:

```ts
{
  projectId: string;
}
```

5. Put collection behavior on the capability.
6. Put long-lived object behavior on a Durable Object when the feature needs a
   live handle or durable local state.
7. Make project oRPC procedures call the capability rather than duplicating
   lifecycle logic.
8. Register the capability as a codemode Tool Provider when scripts should use
   it.

## Collection semantics

Do not let selector methods create durable product state by accident.

Prefer:

```ts
await ctx.things.create({ slug });
await ctx.things.get({ slug }).getInfo();
```

Avoid:

```ts
await ctx.things.get({ slug }); // creates if missing
```

Creation should be an explicit capability operation. Selection should fail when
the object does not exist.

## Discovery

Use the Durable Object catalog for queryable discovery of initialized objects.
The catalog is a mirror for lists and existence checks, not the source of truth.
When a domain object is backed by a lifecycle Durable Object, prefer
`getInitializedDoStub({ allowCreate, name })` as the selection primitive:

- `allowCreate: false` selects an existing initialized object and returns `null`
  when no lifecycle catalog row exists
- `allowCreate: true` initializes lifecycle state when missing and returns the
  live RPC stub

Use `allowCreate: false` for `get`-style selectors. Use `allowCreate: true`
only in explicit creation commands. If duplicate creation must be rejected, keep
an object-local creation guard as well because selector preflight is not a
transaction across concurrent callers.

Use the Durable Object for durable object-local state and the project event
stream for lifecycle facts that should be visible across the product.

When defining stream processor contracts, put durable event type strings inline
in the `events` object, `consumes`, `emits`, and reducer. Do not add a separate
`eventTypes` object just to avoid repeating the string inside one processor
definition.

## oRPC

External project APIs should stay narrow and shaped for browser/API needs:

```ts
os.project.{domain}.list(...)
os.project.{domain}.create(...)
os.project.{domain}.get(...)
```

Do not add oRPC methods only so codemode can reach a capability method. Codemode
can use the capability directly.

## Codemode

If a capability returns a live handle, that handle's public methods become the
codemode API. Prefer a tiny `RpcTarget` wrapper when the underlying implementation
is a Durable Object stub: Cloudflare Workers RPC can pipeline calls through an
`RpcTarget`, while a raw Durable Object stub is not a reliable return value across
every capability/session boundary.

Internal lifecycle helpers should be private or reached through a separate
control surface, not exposed on the handle.

## Repos example

Repos follow this pattern:

- `ReposCapability` is bound to one Project ID.
- `os.project.repos.*` is an adapter around `ReposCapability`.
- `ctx.repos.create({ slug })` explicitly creates a Repo.
- `ctx.repos.get({ slug })` selects an existing Repo and returns a tiny Repo
  handle backed by the Durable Object.
- `ctx.repos.get({ slug }).getInfo()` reads Repo details, including the remote
  Git URL backed by Cloudflare Artifacts.
- The Repo detail UI shows clone/push commands from `getInfo()`.
