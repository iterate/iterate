# Identifier prior art: keep the names apart

This is evidence and vocabulary, **not a selected identifier redesign**. Do not
let one string silently mean location, durable identity, authority, immutable
bytes, and a live RPC object. The clean room already separates `{project,path}`
([model.ts](../src/model.ts#L10-L23)), immutable repository revisions, and live
`Scope` capabilities ([worker.ts](../src/worker.ts#L24-L69)).

## Five different things

| Need               | Concrete form                              | Persist?      | Authority?      |
| ------------------ | ------------------------------------------ | ------------- | --------------- |
| Locator            | `{ project: "acme", path: "/agents/eng" }` | yes           | no              |
| Logical identity   | `{ project: "acme", id: "agt_01…" }`       | yes           | no              |
| Immutable revision | `{ repo: "config", revision: "a3…" }`      | yes           | no              |
| Authority          | `{ grantId: "g_01…", expiresAt }`          | recipe/record | yes             |
| Live execution     | Cap'n Web/Workers RPC stub                 | no            | yes, while live |

```ts
type SavedHandle = {
  locator: { project: string; path: string; member: string[] };
  grantId: string; // lookup/revocation point, not a URL secret
  sourceRevision?: string; // pin when code must be reproducible
};

async function restore(saved: SavedHandle, caller: Principal) {
  const grant = await grants.require(saved.grantId, caller, saved.locator);
  return contexts.open(saved.locator, grant); // fresh live capability
}
```

The saved value is a restoration recipe; the returned value is the
pipeline-friendly, connection-bound capability.

## Primary-source findings

### Live refs versus persistent refs

Cap'n Proto calls interface references first-class capabilities: they both
designate an object and confer permission. But a reference served by a lost
connection becomes disconnected. Its Level 2 persistent-capability support is
opt-in: the host application implements saving/restoration and may refuse a
capability. [Cap'n Proto RPC protocol](https://capnproto.org/rpc.html)

Kenton Varda states the sharper boundary: SturdyRef format and restoration are
tied to the host environment, so implementations should leave them to the
application. His restoration sequence is token lookup → requester verification
→ find/start grain → mint a **live ref**. [Kenton on sturdy references](https://www.mail-archive.com/capnproto%40googlegroups.com/msg00612.html)

Cap'n Web is an object-capability RPC system supporting references and promise
pipelining. Its disposal contract says ending a short-lived session implicitly
disposes stubs, and a lost connection breaks them. [Cap'n Web README](https://github.com/cloudflare/capnweb/blob/main/README.md) · [disposal docs](https://github.com/cloudflare/capnweb/blob/main/packages/docs/src/content/docs/concepts/disposal.md)

**Consequence:** preserve pipelines at the call boundary, but never claim
Cap'n Web itself gives persistent references. A project directory plus grant
check supplies the higher-layer restoration protocol.

### Actor identity versus activation address

Orleans gives every grain a user-defined type-plus-key identity and explains
that object references cannot be distributed identity because they are limited
to one process address space. Its directory maps stable grain identity to the
current activation, which may deactivate and later run on another silo.
[Orleans grain identity](https://learn.microsoft.com/en-us/dotnet/orleans/grains/grain-identity) · [grain directory](https://learn.microsoft.com/en-us/dotnet/orleans/host/grain-directory)

Cloudflare makes the routing analogue concrete: `idFromName()` maps a name to
a Durable Object ID and `get()`/ `getByName()` returns a callable stub. The
public Internet reaches a Worker first, not the DO directly. [DO namespace](https://developers.cloudflare.com/durable-objects/api/namespace/) · [DO ingress](https://developers.cloudflare.com/durable-objects/get-started/)

```ts
type AgentId = { project: "acme"; id: "agt_01J…" }; // durable domain ID
type Route = { project: "acme"; path: "/support/on-call" }; // directory alias
const agent = await directory.resolve(route); // Route -> AgentId -> activation
```

A path may remain the whole logical identity while paths are permanent. Add a
separate ID only when rename, alias, merge, or cross-project references have a
real lifecycle the path cannot express.

### Provenance: claim, revision, and observation differ

W3C PROV-DM defines an entity as a thing with fixed aspects; derivation is a
transformation, update, or construction of a new entity from another, with an
explicit revision subtype. [PROV-DM conceptual model](https://www.w3.org/TR/prov-dm/#conceptual-model) · [derivation terms](https://www.w3.org/TR/prov-dm/#derivation-terms)

```ts
const claim = {
  id: "evt_01…", // submitter retry identity
  provenance: {
    parents: ["evt_input_01…"], // asserted causal inputs
    producer: "processor:triage@config:a3…",
    signatures: [author, reviewer], // independent signed claims
  },
};
const execution = { source: { repo: "config", revision: "a3…" }, event: claim.id };
```

A signature witnesses a submitted provenance claim. Commit offset/time, policy
decision, and observed execution receipt are separate platform facts; do not
infer them from a route or place them in a producer string.

### URLs are transport locators, not universal authority

Cap'n Proto contrasts narrow object capabilities with path-string APIs, which
require an ambient filesystem plus authorization machinery. [Cap'n Proto RPC:
paths versus capabilities](https://capnproto.org/rpc.html#time-travel-promise-pipelining)
Cloudflare likewise places public ingress in a Worker. These can share spelling
without being the same thing:

```txt
https://acme.example.com/agents/eng   public ingress route
itx://acme/agents/eng                 display/debug locator, if adopted
DO name "acme/agents/eng"             private runtime route
grant g_01…                           permission checked by owner
```

A URL may choose an initial app. It must not by itself authorize privileged
methods. Egress is similarly a project-owned request gate: the final HTTPS
origin is validated after rewrite/substitution, not granted by a URL. Current
egress module enforces that separation ([egress.ts](../src/egress.ts)); full
front-door integration and deployment proof are tracked in the README.

## Local Cloudflare source patterns for path-first names

These are narrower than a new global registry proposal: they support keeping
`/path` as the public, file-like name while making the opened thing a scoped,
typed live capability.

### 1. A name can route an actor without becoming the actor's identity

Workerd's `idFromName(name)` deterministically returns the same DO ID for the
same name and class; `getByName(name)` is merely `idFromName()` followed by
`get()`. But the alarm scheduler carries the original name alongside an actor
ID explicitly because it is **not** part of equality or hashing. In other
words, a name is useful address metadata even inside a runtime whose actual
actor identity is opaque.

```ts
// Public, canonical project naming. It may be the whole domain identity.
const context = { project: "acme", path: "/agents/digest" };

// Private Cloudflare adapter detail, never stored in app events as its meaning.
const stub = env.CONTEXT.getByName(`${context.project}:${context.path}`);
```

This is the right default for the clean room: preserve `/agents/digest` as the
user-visible path and derive a private DO name from it. Introduce a separate
logical ID only when a concrete rename/alias/cross-project lifecycle demands
that old and new paths refer to a different stable thing.

Sources: [`DurableObjectNamespace::idFromName()` / `getByName()`](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/api/actor.h#L211-L278), and [`ActorKey`: name is not part of actor identity](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/server/alarm-scheduler.h#L18-L45).

### 2. A slash path is particularly good for scoped, owned children

Kenton's facet design uses hierarchical names: a child `foo` of the root and
its child `bar` have true path `foo/bar`. A facet cannot reach siblings unless
its common parent explicitly passes a reference. The root namespace owns child
cleanup; deleting the root deletes descendants. That is a strong precedent for
`/context/processors/digest` as a _scoped subresource_, not a globally callable
actor identifier.

```ts
// The parent owns the lifecycle and delegates a narrow typed capability.
const digest = ctx.facets.get("processors/digest", () => ({
  class: ctx.exports.DigestProcessor({ props: { contextPath: "/" } }),
}));
await digest.processEvent({ afterOffset: 41, throughOffset: 60 });
```

Do not mint a dynamic DO namespace for every project path. Use an ordinary
context DO for a public context path; use a parent-owned facet path only when a
child needs independent storage/code/lifecycle. The latter is deliberately not
a name users resolve from outside the parent.

Sources: [Kenton's facet specification: hierarchical names, parent-mediated
sibling access, and transitive lifecycle](../../project-worker/research/kentonv/a-facets.md#L8-L33); the checked-out runtime's [`DurableObjectClass` has no callable surface except passing it to `ctx.facets.get()`](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/api/actor.h#L424-L456).

### 3. A factory creates a typed live handle from narrow scope data

Workerd intentionally refuses to serialize an unspecialized `ctx.exports`
loopback binding. A caller first invokes it with `props`, producing a scoped
Fetcher/RPC capability that it may pass onward. Cloudflare OS uses the same
shape: its scheduler resolves an account driver by a name but passes a
workspace-scoped gatekeeper session/callback capability, not a namespace.

```ts
// Name selects a context; props select the authority and interface it receives.
const project = ctx.exports.ProjectEntrypoint({
  props: { project: "acme", path: "/agents/digest", grant },
});
const itx = project.get(); // a typed, live scope; it pipelines normally
```

So `/path` can be the stable public name while `ProjectEntrypoint({ props })`
is the capability factory. This is cleaner than putting a bearer grant inside
the path or using paths as an unscoped dynamic method language.

Sources: [workerd loopback specialization and intentional non-serialization](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/api/export-loopback.h#L15-L105); [Cloudflare OS scheduler's named account driver plus scoped session](https://github.com/cloudflare/cloudflare-os/blob/81f3c57/packages/gatekeeper-scheduler/src/scheduler.ts#L220-L273).

### 4. File handles make the useful analogy—and its limit—plain

Workerd's VFS `FileSystemHandle` carries a file-URL locator. It validates the
location when a handle is created, then checks the underlying entry again on
every operation because deletion/modification can make it invalid and later
valid again. Two handles are the same entry when locator and kind agree.

```ts
const file = await root.getFileHandle("config.json"); // typed operational handle
await file.createWritable(); // checked at use time
```

Treat `/foo` similarly as a path lookup that returns an operational capability:
normalization and initial scope check happen when opened, but revocation/config
is checked at the owning context when an authority-sensitive operation happens.
Unlike a filesystem handle, an ITX capability is also authority, so never make
a raw path string interchangeable with a live reference.

Source: [workerd filesystem handle locator and per-operation validity rule](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/api/filesystem.h#L227-L259).

### 5. Keep TypeScript shape and runtime validation as complementary layers

Cap'n Web stubs intentionally look like they have every property at runtime;
TypeScript supplies autocomplete/type errors, while an unknown remote property
fails only when awaited. Cap'n Web explicitly says it currently has no runtime
type checking and recommends validation such as Zod for attacker-controlled
values.

```ts
const scope: RpcStub<ProjectItx> = await open("/agents/digest");
await scope.processEvent(zProcessRange.parse(input));
```

This supports a path-first public model without returning to untyped string
expressions: generated/declared `ProjectItx` types make normal calls ergonomic;
the actual path resolution, contracts, and schemas remain runtime checks.

Sources: [Cap'n Web stubs and compile-time member knowledge](https://github.com/cloudflare/capnweb/blob/bc4bc45a6f54b6a4ea211e746c4d545df0d8c1b3/README.md#L235-L245) and [its runtime-validation warning](https://github.com/cloudflare/capnweb/blob/bc4bc45a6f54b6a4ea211e746c4d545df0d8c1b3/README.md#L478-L484).

## Decision tests

1. Can a saved value reopen after the RPC session dies? Specify directory,
   caller authentication, revision pin, and revocation check.
2. Does changing `/support/on-call` rewrite old events or pinned executions?
   It should only alter current directory resolution.
3. Can a reader name exact bytes and policy used? Require revision plus durable
   commit/receipt facts.
4. Can a leaked URL invoke privileged methods? If yes, call it a bearer
   capability and give it explicit expiry/revocation.
5. Can `open().child().run()` still pipeline? It should: restore/check once,
   then use the fresh live capability.

## Sources and local context

- [Cap'n Proto RPC](https://capnproto.org/rpc.html)
- [Kenton Varda on sturdy references](https://www.mail-archive.com/capnproto%40googlegroups.com/msg00612.html)
- [Cap'n Web README](https://github.com/cloudflare/capnweb/blob/main/README.md) and [disposal](https://github.com/cloudflare/capnweb/blob/main/packages/docs/src/content/docs/concepts/disposal.md)
- [W3C PROV-DM](https://www.w3.org/TR/prov-dm/)
- [Orleans identity](https://learn.microsoft.com/en-us/dotnet/orleans/grains/grain-identity) and [directory](https://learn.microsoft.com/en-us/dotnet/orleans/host/grain-directory)
- [Cloudflare DO namespace](https://developers.cloudflare.com/durable-objects/api/namespace/)
- Existing exploration, not authority: [identifiers-recipes.md](identifiers-recipes.md)
