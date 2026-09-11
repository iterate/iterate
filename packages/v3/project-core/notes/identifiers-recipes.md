# Design 3: typed capability recipes, not expression strings

This is a deliberately different option from an actor registry and from a
path-first object tree. A **recipe** is serializable data that says how the
runtime can construct a capability; it is not a capability, a bearer URL, or
an executable `itx.foo.bar()` string. A **grant** is the separate durable
decision that permits that construction at one project/context location.

This preserves the settled constraints: one Context DO owns the stream;
context paths are project-local rather than host-directory state; edge-held
capnweb callbacks are live only; and a user project can use the core without
an always-on control plane. See [session history](session-history.md) and
[the current-core cut](current-core.md#recommended-primary-architecture).

The primary constraint is a small, ordinary, statically type-testable
TypeScript interface in the style of Cloudflare OS. `itx.workers.get(...)` is
only an illustrative spelling, not a compatibility requirement. Dynamic
source checking, module bundling, and app building must layer behind that
interface as one replaceable build adapter and remain credible within the
under-5k primary-core budget.

## Interface

```ts
type ContextPath = Brand<string, "ContextPath">;
declare const recipeType: unique symbol;
declare const verifiedBuild: unique symbol;
type Alias<T> = { readonly name: string; readonly recipe: Recipe<T> };

// Location / construction data only. These values may be stored in config.
type RecipeData =
  | { kind: "context"; path: ContextPath }
  | { kind: "worker"; source: Source; export: string; props: Json }
  | { kind: "document"; repo: string; path: string; ref: "head" | CommitId };
// The invariant phantom is compile-time only; recipe() is the sole constructor.
type Recipe<T> = RecipeData & { readonly [recipeType]: (value: T) => T };

// Persisted receipt data is verified by the root, never trusted from a caller.
type BuildReceipt = {
  builderKeyId: string;
  source: Source;
  contentHash: string;
  bundle: { modules: readonly string[]; format: "worker" };
  declared: { export: string; rpcMethods: readonly string[] };
  signature: string;
};
type VerifiedBuildOutput<T> = BuildReceipt & { readonly [verifiedBuild]: T };

// The only root-owned durable records. `grant` is checked by the Context DO;
// it is never inferred merely because a caller can spell `recipe`.
type Binding<T> = { alias: string; recipe: Recipe<T>; grant: GrantPolicy };

declare abstract class ItxTarget extends RpcTarget {
  readonly workers: WorkersTarget;
  readonly documents: DocumentsTarget;
  context(recipe: Recipe<ContextTarget>): ContextTarget;
}
declare abstract class WorkersTarget extends RpcTarget {
  get<T extends RpcTarget>(recipe: Recipe<T>): T;
}
declare abstract class DocumentsTarget extends RpcTarget {
  open(recipe: Recipe<DocumentTarget>): DocumentTarget;
}
declare abstract class DocumentTarget extends RpcTarget {
  open(input: { base?: CommitId; collaborator: string }): DocumentBranch;
}
declare abstract class DocumentBranch extends RpcTarget {
  apply(change: TextChange): Promise<{ revision: string }>;
  commit(input: { message: string; expectedRevision: string }): Promise<{ commit: CommitId }>;
}
type Itx = RpcStub<ItxTarget>;
```

`Brand`, `Source`, `Json`, `CommitId`, `GrantPolicy`, `Context`, and
`TextChange` are ordinary local types, not runtime registries. A project
declares aliases with a typed helper:

```ts
const aliases = defineAliases({
  handbook: document({ repo: "product", path: "docs/handbook.md", ref: "head" }),
  editor: worker({ source: repo("config", CONFIG_COMMIT), export: "Editor", props: {} }),
});
```

`recipe<T>()` gives a literal its invariant compile-time target type; callers
cannot freely relabel `Recipe<A>` as `Recipe<B>`. `defineAliases()` produces
checked data for a `bindings.configured` event; the root Context persists
`{ alias, recipe, grant }`. The build adapter emits a signed `BuildReceipt`.
The root verifies its signer and that source, content hash, bundle, export, and
declared RPC method list agree before it brands a `VerifiedBuildOutput<T>`
and allows the recipe to resolve. This is also the runtime declared-interface
check: a recipe cannot select an undeclared export/method just because its
TypeScript phantom said it could. The Context accepts the verified build output
only if a separate grant permits it. Thus a successful build does not acquire
authority, and revoking authority does not invalidate the immutable build output. Config
TypeScript refers to `aliases.handbook`, not to an expression string, and
ordinary code still gets native RPC ergonomics:

```ts
const itx: Itx = await connectedItx();
const editor = itx.workers.get(aliases.editor.recipe);
const document = itx.documents.open(aliases.handbook.recipe);

// `open()` returns an RpcTarget, so this starts before waiting for the open
// reply; capnweb/workerd pipeline the call in the normal way.
const branch = document.open({ collaborator: "alice" });
const { revision } = await branch.apply({ range: [0, 0], insert: "Decision\n" });
const { commit } = await branch.commit({
  expectedRevision: revision,
  message: "Document decision",
});
await editor.recordCommit({ document: aliases.handbook.name, commit });
```

One possible adapter spelling is `itx.workers.get(args).doSomething()`, but
the interface decision is the typed construction data and returned target, not
that particular noun chain. It does **not** turn every string into a method
lookup. Promise pipelining is a property of the returned RPC target, not of
the stored recipe: capnweb explicitly batches/pipelines
dependent calls ([primary README](https://github.com/cloudflare/capnweb/blob/bc4bc45a6f54b6a4ea211e746c4d545df0d8c1b3/README.md#L415-L455)).

The document example is a meaningful acceptance case, not a new kernel
primitive. A user-space document worker owns collaboration and its stream;
the repository worker commits an immutable snapshot. Cloudflare OS makes the
same durability distinction in its workshop: streaming edit previews are
display-only while the durable edit is a change row
([`code-preview.ts`](https://github.com/cloudflare/cloudflare-os/blob/81f3c5732bb8ea17dc75209eef9e521d571d50b1/packages/workshop-backend/src/code-preview.ts#L1-L5)),
and its Git store turns a file map plus parent/author/message into a commit
([`git-store.ts`](https://github.com/cloudflare/cloudflare-os/blob/81f3c5732bb8ea17dc75209eef9e521d571d50b1/packages/workshop-backend/src/git-store.ts#L189-L252)).

## What stays hidden

The Context module resolves a recipe only after loading its binding and grant.
It maps a context recipe to its private DO route, obtains a worker through the
loader cache, verifies its build receipt/declaration, creates a `ctx.exports` entrypoint with the resolved props, and
passes the same scoped entrypoint as the loaded worker's ITX/fetch authority.
The caller sees none of the DO ID, loader cache key, `ctx.exports` binding,
or rename redirect.

This is a deep module seam: callers learn three nouns and `workers.get`; the
implementation absorbs authentication, alias validation, DO routing, loader
caching, revocation, and error classification. No general `resolve(string)`,
`actor(id)`, or “call this AST” interface is exposed. A context-path table is
the one necessary project-root catalog; it maps _contexts only_, so it is not a
universal actor/capability registry.

`ctx.exports` is a good internal construction mechanism, not the public
identifier scheme. Workerd specializes loopback capabilities with `props`
and deliberately makes unspecialized loopback stubs non-serializable
([source](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/api/export-loopback.h#L13-L66)).
Cloudflare OS similarly mints a gatekeeper entrypoint with scoped props
([source](https://github.com/cloudflare/cloudflare-os/blob/81f3c5732bb8ea17dc75209eef9e521d571d50b1/packages/gatekeeper-context/src/library-gatekeeper.ts#L116-L145)).

## Lifecycle, URLs, migration, and live values

- **Location is not authority.** `itx://<project>/context/<path>` can be a
  display/debug URL and a public app URL can select the initial app, but neither
  is a bearer capability or a public `/cap?path=` escape hatch. The normal
  authenticated introduction gives the caller a project-scoped `Itx` stub;
  resolving its recipe performs the grant check in the owning DO.
- **Persistence and reconnect.** Persist recipes/bindings and stream state,
  not a stub. After eviction or reconnect, the Context recreates a fresh DO
  stub/entrypoint from the same binding. This follows workerd's rule that an
  RPC stub must not keep a DO awake (the primary commentary is collected in
  [`a-rpc-stubs-lifecycle.md`](../../project-worker/research/kentonv/a-rpc-stubs-lifecycle.md#L1-L14)).
- **Rename/move.** A root `context.moved { from, to, contextKey }` event changes
  the small context-path table atomically. Recipes naming `from` should fail
  with `CONTEXT_MOVED` plus the new display path, rather than silently retarget;
  aliases can be explicitly migrated in the same configuration revision.
  Private `contextKey`/DO identity remains stable, so stream state does not
  move. This costs one local map but avoids deriving permanent physical
  identity from a mutable path.
- **Live callback.** A capnweb callback, WebSocket, and pager key are a live
  lease, never a `Recipe`. A durable binding may name the policy that permits
  a callback, but the edge re-lends a fresh wrapper after reconnect and removes
  it on detach/revocation. Serialization duplicates ownership rather than
  making a live endpoint durable ([capnweb serialization](https://github.com/cloudflare/capnweb/blob/bc4bc45a6f54b6a4ea211e746c4d545df0d8c1b3/src/serialize.ts#L621-L627)).

## Trade-offs against an actor registry

The gain is that a persisted program is inspectable JSON with a very small,
typed vocabulary; static config catches bad source/props shapes, the build
adapter can be tested through its deployed public protocol, and ordinary
interactive calls remain real capnweb calls. A rename does not invalidate
physical state, and no guessed stable actor ID grants access.

The price is indirection: every durable reference must be one of the recipe
variants, and adding a genuinely new durable kind requires a schema/config
change. That is intentional friction: it prevents the expression language
from quietly becoming a universal object graph. An actor registry wins if
arbitrary third-party objects truly need global, durable, discoverable names;
the clean-room constraints instead favor project-confined contexts, repos, and
loaded workers. This design should be rejected if users must persist an
unknown live callback or freely serialize any object graph—those requirements
would demand a different capability/lifecycle model, not an enlarged recipe.
