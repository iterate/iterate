# Design 1: path is the physical context identity

This is the **strict fixed-identity fork**, not a requirement of Jonas's
path-first public naming preference. Public document paths may resolve within
one workspace owner, and private keys may preserve rename continuity without
exposing actor IDs. See the [path-first synthesis](../IDENTIFIERS.md).

This is the smallest alternative: a project context is exactly the canonical
`{projectId, path}` name used to derive its Durable Object. There is no stable
context ID, context-directory table, actor registry, or persisted generic
capability resolver. The authenticated root stub determines the project;
`cd()` is the only navigation operation inside it.

```ts
type ContextPath = readonly string[]; // validated segments; `..` never escapes root
type WorkerBuildOutput<T extends RpcTarget> = {
  readonly sourceHash: string;
  readonly export: string;
  readonly receipt: VerifiedBuildReceipt;
  readonly [workerType]: (value: T) => T; // invariant compile-time phantom
};

declare abstract class ProjectTarget extends RpcTarget {
  cd(path: ContextPath): ContextTarget;
  append(events: readonly EventInput[]): Promise<readonly EventRecord[]>;
  readEvents(query?: EventQuery): Promise<EventPage>;
  fetch(request: Request): Promise<Response>;
  readonly workers: WorkersTarget;
}
declare abstract class ContextTarget extends ProjectTarget {}
declare abstract class WorkersTarget extends RpcTarget {
  get<T extends RpcTarget>(output: WorkerBuildOutput<T>): T;
}
type Itx = RpcStub<ProjectTarget>;
```

The client gets an authenticated `RpcStub<ProjectTarget>`, then uses normal
capnweb calls and pipelining:

```ts
const billing = itx.cd(["accounts", accountId]).workers.get<BillingTarget>(BILLING);
const charged = await billing.charge(invoice);
```

`BillingTarget` is a server type extending `RpcTarget`; `Itx` is explicitly
the client-side `RpcStub<ProjectTarget>`. The synchronous-looking target
returns are capnweb shorthand, not by-value objects or an expression
interpreter. The dynamic build adapter produces the opaque,
signature-verified `WorkerBuildOutput<T>` after typecheck/bundle/declaration
validation. The Context verifies its receipt and configured grant before
loading; callers cannot forge an asserted build success or relabel build output as
another RPC interface.

## Internals deliberately hidden

The private routing function canonicalizes a path, unambiguously encodes the
project and segments, and calls `CONTEXT.idFromName(encodedName)`. It can
apply a small path-depth and segment bound before doing so. Workerd exposes `idFromName`, `get`, and
`getByName` directly ([types](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/types/generated-snapshot/index.d.ts#L648-L667));
Kenton clarifies that `idFromName` is a one-way hash rather than a lookup
([primary-source record](../../project-worker/research/kentonv/a-durable-objects.md#L102-L113)).

The outer worker/router authenticates a project and mints a scoped entrypoint
with `ctx.exports` props. It is not an address service: loaded code gets only
that entrypoint as ITX/global outbound. Cloudflare OS uses the same scoped
props pattern rather than handing code a raw namespace
([example](https://github.com/cloudflare/cloudflare-os/blob/81f3c5732bb8ea17dc75209eef9e521d571d50b1/packages/gatekeeper-context/src/library-gatekeeper.ts#L116-L145)).
No public URL is a capability: a URL can select a public app/fetch route, but
an external caller cannot spell `/cap/<path>` to reach an arbitrary context.

Live browser callbacks are absent from all persistent types. The edge owns a
capnweb callback; a tagged WebSocket pager lends a short-lived native wrapper
to the DO and drops it at quiescence/detach. Reconnect restores liveness, not
authority. Capnweb serialization duplicates a stub rather than persisting its
live endpoint ([source](https://github.com/cloudflare/capnweb/blob/bc4bc45a6f54b6a4ea211e746c4d545df0d8c1b3/src/serialize.ts#L621-L627)).

## The intentional rename trade-off

With this design, **rename is not transparent**. `/docs/handbook` and
`/docs/guide` are different physical DOs and hence different streams/state.
Choose one explicit user-space action:

1. **New object:** create `/docs/guide`, optionally copy/import selected
   history, and revoke/delete the old capability. Existing held stubs remain
   old until disposed.
2. **Forwarding alias:** leave a small configured app/route at the old path
   which forwards only the declared fetch/RPC interface to the new path. It is
   observable, revocable configuration—not a hidden identity migration.

If transparent rename with state continuity is a product requirement, reject
this design and select the actor/registry design. Adding a covert
`path → immutable ID` table here would erase its main simplicity.

## Acceptance: collaborative document then commit

A user-space document worker lives at the fixed context `/apps/handbook`; its
source definition is held in declared config. Collaboration is events in that
context's stream, and its worker returns a real `DocumentBranch` target. A
repo worker commits a resolved snapshot:

```ts
const document = itx.cd(["apps", "handbook"]).workers.get<DocumentTarget>(DOCUMENT);
const branch = document.open({ collaborator: "alice" });
const { revision } = await branch.apply({ range: [0, 0], insert: "Decision\n" });
const { commit } = await branch.commit({
  expectedRevision: revision,
  message: "Document decision",
});
```

This needs no document kernel, alias registry, or actor discovery: only a
fixed path, stream, typed loaded-worker target, and repository user-space
capability. Cloudflare OS independently distinguishes display-only streaming
edit previews from its durable edit row
([source](https://github.com/cloudflare/cloudflare-os/blob/81f3c5732bb8ea17dc75209eef9e521d571d50b1/packages/workshop-backend/src/code-preview.ts#L1-L5))
and commits an immutable file map via `writeFilesAsCommit`
([source](https://github.com/cloudflare/cloudflare-os/blob/81f3c5732bb8ea17dc75209eef9e521d571d50b1/packages/workshop-backend/src/git-store.ts#L189-L252)).

## Trade-offs

This is the deepest/smallest module: callers learn `cd`, stream verbs, fetch,
and typed loaded workers; the implementation owns routing and build receipt
verification. It is particularly suitable if paths are durable product
meaning, as in a small self-hosted project. It makes moves expensive and
cannot express a stable capability whose location changes. It should lose to
the recipe/alias or actor design if collaboration needs frequent moves,
long-lived cross-path references, or transparent rename.
