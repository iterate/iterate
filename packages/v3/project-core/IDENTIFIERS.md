# Identifiers without losing Cap'n Web

Three alternatives, grounded in [prior art](notes/identifiers-prior-art.md),
the [Docs/Tasks acceptance case](notes/userspace-app-assessment.md), and
[the typed build layer](notes/typed-surface-and-builds.md).
These are designs, not newly implemented interfaces. The spelling of methods
is negotiable; an ordinary TypeScript contract and real capability RPC are not.

**Current plan of record:** a context is exactly `{ projectId, path }`; paths
are the project-facing names, like files. Dotted ITX is a capability-routing
operation inside that context, not a universal resource directory: it resolves
a mounted worker or live stub, then forwards the remaining member path. The
physical built-ins remain explicit under `builtins`. Actor-first naming and
resource-facet interfaces below are optional explorations, not the recommended
core vocabulary. A path-first interface does not require paths to be eternal
internal identities or one Durable Object per path.

```ts
const review = project.cd("/workspaces/review");
await review.invoke(["docs", "open"], "notes.md"); // `docs` rewrites to its mount
await review.invoke(["builtins", "append"], event); // physical core operation
```

The filesystem analogy applies to naming, not to a required core `Document`
interface. A mounted app may return a live capability like an open file handle;
an inode-like key may remain private if that app needs rename/open-handle
continuity. A document path can resolve inside a workspace's existing state
owner; it need not allocate a DO of its own.

"Like a file" describes naming and opening, not a requirement that everything
implement byte-oriented `read()`/`write()`. A worker has methods; a secret is
write-only; a stream has ordered events. Most durable project resources have
names, but a callback, subscription or temporary edit session need not receive
a globally resolvable path just because it is a capability.

## The distinction that removes most of the confusion

```ts
const workspacePath = "/workspaces/review";
const documentPath = "/workspaces/review/notes.md";
const revision = { repo: "/repos/handbook", commit: COMMIT, file: "review.md" };
const appUrl = "https://docs--acme.iterate.app/w/review";

// A live capability obtained through an already-authorized project session:
const editor = project.docs.open(documentPath);
await editor.read();
```

The first two values are project names, the third selects immutable content,
and the fourth is a public HTTP door. `editor` is the live capability.
None of the four data values is automatically permission.
An explicitly designed bearer link can grant permission, but then it is a
credential with a lifetime and revocation policy, not an ordinary diagnostic URL.

An itx expression is different again: it describes **a computation**. The value
`"itx.workers.get(source).doSomething()"` is not a useful object ID: arguments
may create a new object, state can change, and `doSomething()` might have an
effect. Do not run that string merely to discover what it identifies.

## Optional application-layer resource facets

An application may choose typed factories without pretending a secret and a
document support the same operations. These are proposed app contracts, not a
replacement for context addressing and dotted mount routing:

```ts
await project.docs.open("/workspaces/review/notes.md").read();
await project.streams.open("/streams/review").append(noteCreated);
await project.repos.open("/repos/handbook").head();
await admin.secrets.put("/secrets/mail", writeOnlySecret);
const docs = project.open("/apps/docs");
await docs.open("/workspaces/review/notes.md").read();
```

This is one project namespace, with typed ways to open its entries. The secret
path does not imply a `read()` operation. These resource names are proposals;
the present core has context paths, not this complete filesystem interface.

An installed project's small declaration can type its named app mounts without
overloading a path-dispatch method:

```ts
interface Project extends RpcTarget {
  readonly docs: Docs;
  readonly build: Builder;
  context(path: `/${string}`): Context;
}
declare const project: RpcStub<Project>;
const text = await project.docs.open("/workspaces/review/notes.md").read();
```

For an arbitrary runtime string, use a typed factory such as `docs.open(path)`,
or a common resource handle with explicit, runtime-checked interface discovery.
Do not make `open<T>(path)` a promise that an unchecked string implements `T`.
Cap'n Web maps an RPC method through a conditional function type; TypeScript
therefore retains only the final signature of an overloaded method on an
`RpcStub`. `open("/apps/docs")` / `open("/apps/build")` overloads are not a
typed mount-dispatch mechanism. A non-overloaded method factory is equally
sound when a property is not the desired shape: `project.apps().docs()`.
The named-mount declaration is pinned to the installed config revision; a
changed mount must fail an incompatible open rather than silently reuse stale
types. Generating every possible file path is unnecessary.

For the smallest first version I prefer typed factories. The application owns
the meaning of its paths; a universal node registry is not needed:

```ts
abstract class WorkspaceDocs extends RpcTarget {
  abstract open(relativePath: string): Document;
}
abstract class Docs extends RpcTarget {
  abstract open(projectPath: `/${string}`): Document;
  abstract workspace(projectPath: `/${string}`): WorkspaceDocs;
}

// Same document, with an explicit base for the relative name:
await project.docs.open("/workspaces/review/notes.md").read();
await project.docs.workspace("/workspaces/review").open("notes.md").read();
```

These are proposed application contracts, not the current core's `cd()` rules.
An absolute path starts at the project root. A workspace-scoped relative open
rejects `../` escape rather than silently clamping it. `/apps/docs` names an
installed app mount; `/workspaces/review/notes.md` names its document. Neither
requires a separately addressable long-lived object or a new Durable Object.

Rename must be deliberate: a saved path re-resolves and can report `NOT_FOUND`
or `MOVED`. If a new resource occupies that path, an ordinary fresh open can
resolve the replacement: paths are current names, not permanent identities.
An existing handle may continue through a private row key, but it must never
silently retarget to the replacement; deletion and version conflicts still
reject later writes. A historical link pins both the path and revision.
Opening checks resolution authority; a returned handle carries its own allowed
operations. Knowing the path does not grant either authority.

```ts
const oldNote = project.docs.open("/workspaces/review/notes.md");
await oldNote.read(); // ensure the lookup has completed
// Another client moves it, then creates a different notes.md at the old path.
const currentNote = project.docs.open("/workspaces/review/notes.md");
await currentNote.read(); // the replacement at that name
await oldNote.read(); // the original, or an explicit invalidated-handle error
// Never the replacement merely because the handle was opened using that path.
```

Signed history preserves the names used at the time. A `document.moved` event
can explain a rename; it must not rewrite the path inside an earlier signed
approval. Current core signatures also bind the project/context name, so
relocating a whole context's signed log is a separate protocol, not a directory
update. [Concrete rename/provenance example](INTERESTING-IDEAS.md#14-review-links-can-pin-a-historical-view-of-a-path).

The filesystem analogy stops at content identity and authority. An event can
be named by `{ stream: "/streams/review", event: "review-42" }`, and a snapshot
by `{ repo: "/repos/handbook", revision: COMMIT, file: "notes.md" }`. Keep the
immutable selector explicit instead of hiding it in expression syntax. A held
handle can be narrower than the authority needed to resolve its path again.

## Alternative 1 (optional fork): permanent paths, no universal directory

[Full design](notes/identifiers-path-first.md).

```ts
const workspace = project.cd("/workspaces/review");
const app = workspace.load(DOCS_SOURCE);
await app.document("notes.md").read();
```

Paths are identity. `cd()` canonicalizes them into the runtime's private DO
name; HTTP URLs and source hashes stay separate. A worker returns normal
targets, not strings to be interpreted later. A saved reference is simply a
project, permanent context path and app-owned key.

This has the smallest interface and most direct implementation. It hides
runtime placement and native stub handling without inventing a directory for
every object. The cost is real: moving `/workspaces/review` creates another
context or requires explicit forwarding. It does not transparently preserve
identity. Choose it only if that is acceptable product behavior.

## Alternative 2 (optional fork): stable IDs; paths are aliases

[Full design](notes/identifiers-actor-first.md).

```ts
const ref = { project: "acme", id: "doc_7" };
const doc = project.documents.open(ref);
await doc.read();

await project.names.bind("/handbook/intro", ref);
await project.names.move("/handbook/intro", "/guides/start-here");
// ref still names doc_7. Existing events and references need no rewriting.
```

The directory handles identity and placement; app-specific factories determine
which interfaces can be obtained. A document can move while its comments and
review links still name it. Its reader, editor and approver can be different
capabilities to the same resource. Equal stable IDs do not imply equal authority.

This wins for independently living, movable objects. It introduces directory
consistency, deletion/tombstones, alias behavior and revocation semantics. A
universal `resolve<T>(anything)` merely hides those decisions and lets callers
assert arbitrary types. Prefer typed factories or runtime-validated interface
descriptors; TypeScript generics alone are not remote conformance checks.

## Alternative 3 (optional fork): persist typed recipes, use live targets interactively

[Full design](notes/identifiers-recipes.md).

```ts
const app = defineWorker({ source: DOCS_SOURCE, export: "Docs" });
const doc = defineDocument({ workspace: "/workspaces/review", file: "notes.md" });

// Stored configuration contains data, not a callback or executable expression.
await project.install({ name: "docs", app });
const editor = project.docs.open(doc);
await editor.read();
```

Recipes describe reconstruction: which immutable code, export and durable
state key produce the target. They are validated data whose authority comes
from the recipient's scoped project capability and installation policy.
Mutable branch/path recipes must be explicitly marked late-bound; a pinned
recipe must not quietly follow a new head.

This is a good fit for configuration, routes and processor subscriptions. It
hides loading/reconnection without a global registry for every returned object.
Its limitation is that a recipe cannot serialize any arbitrary live callback.
Making recipes into a general call AST would bring back an expression language
and its effect, resource-limit and versioning problems.

## Recommendation: context paths and mount rewrites

Use `{ projectId, path }` as the sole core context address. A dotted ITX call
first resolves its longest configured mount; that mount can be a worker source
or a live lent stub, and receives the remaining member path. `builtins` is the
explicit escape to the context's physical operations. Keep typed resource
facets and reconstruction recipes behind those mounted applications when they
earn their complexity. Do not require a public stable ID beside every path, and
do not confuse lookup with allocating a new state owner.

```ts
type ContextAddress = { projectId: string; path: `/${string}` };
declare const review: RpcStub<Scope>; // address: { projectId: "acme", path: "/workspaces/review" }

await review.invoke(["docs", "open"], "notes.md");
await review.invoke(["builtins", "append"], event);
```

Mounted applications decide what their remaining path/member means. A typed
factory such as `docs.open(path)` is optional app ergonomics; if one later
offers a single `open(path)`, it must use a checked common interface rather
than `open<T>(path)`. Keep actual HTTP URLs for transport and ingress/egress
routes, not as a second project namespace exposed to every app.

`RpcTarget`, `RpcStub`, and leaf data types above are declaration shorthand.
Runtime targets must be actual classes extending `RpcTarget`, not plain objects
that merely satisfy a TypeScript interface. Abstract target classes can share
the public contract with the concrete implementation, as `src/types.ts` does.
The complete public contract belongs in one module shared by callers, runtime
implementations and network E2Es. Mounted apps contribute their own small
contracts. A build checks against the chosen contract revision; execution
validates wire input and supplies only the allowed live capabilities.

The provider must explicitly support restoring a saved reference. Cap'n Proto
calls persistent capabilities an opt-in higher protocol level; this is not a
feature we can assume Cap'n Web implements for us.
[Cap'n Proto RPC](https://capnproto.org/rpc.html),
[Cap'n Web reference and pipeline model](https://github.com/cloudflare/capnweb#rpcpromiset).

## Five less-obvious ideas worth trying

1. **A capability can have an address without having a globally meaningful identity.**

   ```ts
   const form = doc.startEdit(); // temporary edit session
   const saved = await doc.ref(); // durable document, not the session
   ```

   Reconnecting can reopen the document while honestly losing the unfinished
   transaction. Never auto-retry an uncertain commit just because lookup succeeded.

2. **Pin a route to both a target and a revision of its meaning.**

   ```ts
   const target = { document: savedRef, expectedGeneration: 3 };
   // If the path was deleted/re-created, reject rather than approve its replacement.
   ```

   This matters for an approval that waits overnight while a route changes.

3. **Make links to observations, not just live objects.**

   ```ts
   const link = { document: savedRef, atCommit: COMMIT, event: "review-42" };
   ```

   A review link can show precisely what someone approved, even after editing
   continues. Location, content revision and event provenance now cooperate.

4. **Treat path names like a working directory, not a bearer capability.**

   ```ts
   const restricted = project.docs.forWorkspace("/workspaces/review");
   await restricted.open("notes.md").read();
   // restricted.open("../../secrets") must be rejected at the owner.
   ```

   Narrow capabilities make relative names useful without giving every app a
   project-wide string resolver.

5. **Name code by bytes and its interface by a versioned contract.**

   ```ts
   const installed = { source: DOCS_SOURCE, contract: DOCS_CONTRACT_HASH };
   ```

   Identical source can yield different bundles under different dependencies;
   identical interfaces can have different implementations. A contract hash
   is a declaration identity, not proof of compatible behavior or safety.
   `DOCS_SOURCE` pins a repo revision and entry path; bundle hashes identify
   derived build output. “Artifact” is reserved for Cloudflare Artifacts,
   which can back the project repo abstraction.

## Before choosing, run this one application all the way through

Two users open one document, edit concurrently, reconnect, see the same result,
commit a snapshot, rename the document, and open an old review link. A denied
user cannot obtain an editor by copying its URL. A stale client receives an
explicit conflict. A new config build does not change which bytes a previous
signed approval authorized. This scenario differentiates the designs more
usefully than counting how many strings share a URL parser.
