# Project core architecture

This is an architectural PoC, not a compressed production-auth or document
product. Its acceptance criterion is a stable, small set of modules and
interfaces: when a public contract test exposes a missing behavior, the next
implementation can deepen the appropriate module without reshaping callers.
A future test must fail for a real missing behavior; it is not evidence if it
is skipped, simulated outside the public seam, or weakened to fit the current
implementation.

**Actual** below means runnable code under `src/`. **Proposed** means a useful
contract example only. In particular, `doc.open()` does not exist today.

## Implemented interface and layers

```text
HTTP/MCP adapters -> Scope (typed Cap'n Web client surface)
  -> Context Durable Object (one canonical project/context path)
    -> Stream transaction (events, settings, trust, live subscribers)
       -> repository / processor / mounted-worker / egress applications
    -> confined Worker Loader (only a scoped Host capability)
HTTP app traffic -> stateless routeFetch() -> installed fetch-policy worker
  -> Context only for policy state and the private terminal
```

| Module                                                                                                   | Actual interface and responsibility                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`src/types.ts`](src/types.ts)                                                                           | `ScopeTarget` is the public capability surface: `cd`, `invoke`, `append`, `readEvents`, `inspect`, `load`, `provide`, `subscribe`, and `fetch`. It validates pages and inspection values at the typed edge.                                                                                                                                                                                    |
| [`src/worker.ts`](src/worker.ts), [`src/ingress.ts`](src/ingress.ts), [`src/routing.ts`](src/routing.ts) | The stateless front door handles HTTP/RPC/MCP/session routing. The ingress adapter resolves deployment-configured hostnames to an opaque project id and an optional app hint, then `routeFetch()` loads and invokes the one installed fetch policy. `Context` owns durable state, stream/repository/processor composition, lending, and the private egress terminal—not policy HTTP responses. |
| [`src/stream.ts`](src/stream.ts)                                                                         | The transaction seam: validated/idempotent append, offsets, settings, policy recheck, replay, WebSocket page/ACK lifecycle, and synchronous application of derived state. It alone writes trust settings.                                                                                                                                                                                      |
| [`src/signatures.ts`](src/signatures.ts)                                                                 | Validates bounded event input, canonicalizes its signed claims, verifies plural Ed25519 provenance, and separates that from the platform receipt (`context`, `offset`, `time`, verification at a policy offset).                                                                                                                                                                               |
| [`src/repositories.ts`](src/repositories.ts)                                                             | Event-applied immutable file-map commits and repository heads; repository paths/revisions are distinct from context paths.                                                                                                                                                                                                                                                                     |
| [`src/runtime.ts`](src/runtime.ts), [`src/processors.ts`](src/processors.ts)                             | Native-shaped worker input plus contextual bindings; a separate cached inline/pinned-repository source adapter. Session-scoped execution handles forward from their owner. Configured `processEvent(event)` workers have persisted, at-least-once cursor/retry progress.                                                                                                                       |
| [`src/egress.ts`](src/egress.ts), [`src/lending.ts`](src/lending.ts)                                     | The terminal outbound-fetch/secret/approval gate, and temporary live-capability lending. Neither is a general identity or document store.                                                                                                                                                                                                                                                      |
| [`src/auth.ts`](src/auth.ts), [`src/mcp.ts`](src/mcp.ts)                                                 | A deliberately limited email-entry browser session plus OAuth-protected `/mcp` demo; the MCP adapter maps one `iterate` tool to configured capability methods. The email proves only a submitted string, not membership or privacy.                                                                                                                                                            |

The resolved context address is a canonical, slash-delimited **context** name;
`ContextPath` itself also accepts relative input to `cd()`. Neither is
a filesystem API or a promise that each project path owns a process. The
public path-first direction and its capability-handle distinction are recorded
in [IDENTIFIERS.md](IDENTIFIERS.md); the concrete current surface remains
`Scope.cd()` and `Scope.invoke()`.

### Configured hostname ingress (actual PoC)

`src/ingress.ts` is a stateless, deployment-owned adapter: `PROJECTS` maps a
lowercase platform slug to the opaque project id that names the context, and
`CUSTOM_HOSTNAMES` maps an exact lowercase registered domain to that id. It is
not a directory DO, DNS control plane, or proof that a caller owns a domain.
For a local dashboard at `http://localhost:8799`, `demo.localhost:8799` and
`docs--demo.localhost:8799` select the configured `demo` project; the latter
supplies a derived `docs` app hint. A whole slug wins before the `--` split, so
hyphenated slugs remain valid. A configured `customer.example` similarly
accepts `anything.customer.example` as its one-label app form.

```ts
// Deployment-owned routing data; no entry per app is necessary.
CUSTOM_HOSTNAMES: { "customerdomain.com": "project-acme" }
// docs.customerdomain.com        -> { projectId: "project-acme", app: "docs" }
// preview-123.customerdomain.com -> { projectId: "project-acme", app: "preview-123" }
// customerdomain.com             -> { projectId: "project-acme", app: null }
```

All three enter `routeFetch(request, env, ctx, { project: "project-acme", path: "/" })`
with the original URL. The policy can inspect `request.url` and the derived
`x-iterate-app` hint. An explicit exact custom-host registration wins over the
wildcard fallback; wildcard means one DNS label here, not arbitrary nested TLS
names such as `a.b.customerdomain.com`.

Production needs an unused domain's DNS and Worker route to deliver the
wildcard hostnames to this worker; configuration maps alone do neither.
Ingress strips caller-supplied `x-core-*`, `x-itx-*`, and `x-iterate-*` hints,
then derives its own app hint after selecting the context. It is **routing, not
project authentication**: host-routed policy fetches currently do not enter the
dashboard email-session wrapper, and demo email identity asserts neither
membership nor privacy. A future project-auth flow must bind credentials to
the resolved project and exact host origin; it must not treat a hostname as an
authorization claim or broaden a cookie across project/app hosts.

## Plan of record: contexts, physical built-ins, and dotted calls

**Keep `project id + context path` as the address.** `cd()` is navigation, not
an actor/resource factory: a context can hold events, settings, mounted
capabilities and app state without claiming that every path is a durable object
or a document. New application modules (Docs, Tasks, builds) attach to this
address and the stream; they do not replace it with a new resource ontology.

The clean-room predecessor's useful convention is retained: `builtins` is the
physical, unrewritable root, while short dotted names are a convenient logical
surface. In the current core this is already a small, real mechanism rather
than a proposed compatibility layer:

```ts
// Actual today. `Scope` is a context scoped to one project id + path.
const review = context.cd("/review");
await review.append({ id: "note-1", type: "note.created", data: {} });

// Actual dynamic dispatch. Resolution uses the longest `mount/<dotted-prefix>`
// setting; `builtins` skips that lookup and reaches the physical implementation.
const repos = await review.invoke(["builtins", "repos", "list"]);
```

A mounted worker is configured with the actual typed method below, then called
through the same dynamic path:

```ts
// Actual. `provide()` stores the descriptor as an `itx.set` event.
using installed = await review.provide("summarize", {
  kind: "worker",
  source: {
    modules: {
      "main.js": "export default { async run(text) { return text.length; } }",
    },
  },
});
const length = await review.invoke(["summarize", "run"], "hello");
```

`provide()` also accepts a live `RpcTarget`: the context borrows it through
`lending.ts`, rather than serializing authority into the event. The event
stores only a client key. This is the right narrow seam for an eventual
ergonomic facade:

```ts
// Planned sugar only; it must compile to the actual calls above.
await itx.summarize.run("hello");
await itx.builtins.repos.list();
```

That facade may use the predecessor's dotted-path proxy and an explicit
expression/rewrite representation, but it must not add a second dispatcher,
persist live stubs, or make a path itself authority. Its tests should prove
that `itx.x.y(...args)` produces the same result/fault as
`scope.invoke(["x", "y"], ...args)`, while `itx.builtins.x` cannot be
redirected.

### Deliberate differences from the predecessor

The old `project-worker` had a richer expression language: durable prefix
rewrites, argument templates and masks, plus a prototype fallback that turned
an arbitrary dotted call into one `InvokeHandle.invoke(expression)` RPC. Its
physical built-ins and live-stub registry are useful precedents, but none of
that grammar, inspection surface, or automatic live-mount revocation is in
`project-core` yet. Today `Target` is deliberately only `worker`, `context`,
or `client`; `Context.invoke()` has a 16-hop guard and a physical `builtins`
escape, and `Scope.provide()` returns a disposable handle. The current direct
typed methods are also not privileged: `append()` reaches the same dispatch
path and can be shadowed by a mount; platform code uses its own physical
operations. Before exposing dotted sugar, add public tests for reserved-name
rules, longest-prefix precedence, live-handle expiry, and the exact
`builtins` fixed point. Do not claim old expression compatibility until those
behaviours exist.

## Examples for optional future applications

These are intentionally small _proposed_ application interfaces. They are not
core-freeze conditions and do not introduce a resource/actor model. When an
application is chosen, its first public-network test must fail for the named
missing behaviour—not be skipped or simulated outside the public seam.

### 1. Optional Docs/Tasks application: conditional collaboration and commit

```ts
// Proposed mounted application capability, not Scope today.
const doc = await itx.docs.open("/workspaces/review/tasks.md");
const base = await doc.read(); // { revision, text }
const result = await doc.commit({ base: base.revision, changes });
// { ok: true, revision } | { ok: false, current }
```

The first acceptance case is two writers at the same base revision: exactly
one commit succeeds, the other receives the current revision, and a reconnect
can replay the resulting document activity. The stream supplies ordered facts;
it does not itself supply a document compare-and-accept rule, CRDT/OT policy,
or a document handle. That is the missing deep application module described in
[the Docs/Tasks assessment](notes/userspace-app-assessment.md#path-namespace-is-not-workspace-content).

### 2. Typed dynamic worker and build

```ts
// Actual optional build adapter; native load() also works without it.
const input = {
  source: { repo: "docs", revision: commit },
  options: { entryPoint: "src/main.ts", minify: false },
};
const result = await context.build.build(input);
if (result.status === "built") {
  using worker = await context.load(result.code);
  await worker.fetch(new Request("https://demo.iterate/docs"));
}
```

The actual adapter resolves the pinned revision, passes files/options to a
stateless bundler Worker, and caches inert output in a separate KV namespace.
It returns syntax/resolution diagnostics but does **not** typecheck. ITX and
outbound authority are absent until `load()`. Backend identity is platform-owned,
not a caller-supplied toolchain label. The first slice accepts local dependency
bytes, not registry installation. Repo names are still simple names; the
path-first repo interface above remains a design direction.

The next acceptance case is `context.build.check(input)`: submit a worker
against the actual generated project contract and receive a diagnostic for a
misspelled member. That method, generated declarations and durable activation
remain proposed. Existing [`src/processors.ts`](src/processors.ts) can invoke
`processEvent`, but cannot activate this new build output yet. See
[typed-surface-and-builds.md](notes/typed-surface-and-builds.md).

The loader is useful **without** a repository, TypeScript, or a bundler:

```ts
// Actual Scope API: native WorkerCode fields, no build service required.
using worker = await context.cd("/review").load({
  compatibilityDate: "2026-09-04",
  mainModule: "hello.js",
  modules: {
    "hello.js": `export default {
      fetch(request, env) { return new Response(env.GREETING); }
    }`,
  },
  env: { GREETING: "Hello" }, // ITX is reserved and injected by context
});
const response = await worker.fetch(new Request("https://demo.iterate/"));
console.log(await response.text()); // Hello
```

The contextual loader owns `env.ITX` and `globalOutbound`; a builder cannot
choose their authority. Other native fields remain native fields, including
non-JavaScript module types and resource limits. Native service bindings are
capabilities, not JSON: only data and capabilities the transport and native
loader actually accept can cross that boundary.

HTTP policy/destination execution currently chooses a fresh native worker per
request; mounted RPC/processor execution retains named reuse. This private
loading choice preserves streaming and avoids reproduced native cached-worker
failures in the domain/WebSocket probes. It does not change `Scope`, the one
fetch policy, or the independent build cache. The performance tradeoff and
precise evidence belong in [the domain proof](evidence/domain-preview.md),
not in callers' API shapes.

An internal HTTP destination forwards a non-null response body through one
identity `TransformStream`, retaining its streaming lifetime without collecting
the body. Bodyless responses, including WebSocket upgrades, remain native.
The public rendezvous guard prevents replacing this with whole-body buffering;
unknown transformed length may change HTTP framing. See
[the response-lifetime comparison](evidence/fetch-lifetime.md).

The internal adapter returns a native `WorkerStub`. The public `Scope.load()`
returns a disposable `WorkerTarget` with `invoke(memberPath, ...args)` and
`fetch(request)`. Cloudflare rejects transferring a raw dynamic-worker
entrypoint to another Worker, so this small target retains its worker at the
owner and forwards calls there. It is a session handle, not a persisted worker
address or an assurance of surviving owner eviction. The public-network test
also exercises the existing `workers.get` source adapter through this facade.
([workerd transfer test](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/api/tests/worker-loader-test.js#L75-L88))

There are two independent identities:

```ts
buildKey = digest({ resolvedFiles, options, backendVersion }); // actual build cache
loaderKey = digest({ emittedCode, configuration, bindingIdentities });
```

These are identity equations, not instructions to JSON-stringify native
bindings. The build key contains inputs, never the as-yet-unbuilt output. It
can memoize a bundle in KV or another cache. The loader key identifies exact
module bytes/types, compatibility settings, limits, environment data, and the
meaning of **every** capability binding, including ITX, outbound, and tails.
Platform-owned binding descriptors can supply that identity; an opaque,
call-scoped capability with no stable identity instead requires uncached
native `load()`. A caller-provided label cannot prove two capabilities equal.
KV stores build results, not live Worker stubs or a promise of a warm isolate.

**Actual caching today:** arbitrary `Scope.load(code)` inputs use native
uncached `load()`. The narrower `Source` adapter fixes runtime configuration
and bindings, then uses `get([VERSION.id, contextAndContinuation, revision])`;
inline modules are content-hashed and repo revisions are immutable. There is
no generalized binding-identity registry yet. The optional bundler uses KV for
successful outputs, with a 24-hour TTL. Its version captures the deployed
compiler dependency/patch bytes and defaults; file bytes include any Wrangler
configuration. Identical snapshots can share a build regardless of repo name
or commit message. Build identity is not a provenance receipt: callers retain
their pinned source selection separately.

For example, two different source snapshots that emit identical code can miss the build cache
but reuse a loader identity **within the same binding context**. Identical
code loaded in `/reviews/alice` and `/reviews/bob` can share the compiled
bundle, but must not share an isolate holding Alice's ITX. A stable binding
to a live Context may continue consulting that Context's changing settings;
a pinned grant or policy snapshot must include its revision in its identity.
Cloudflare explicitly requires a new `get()` ID when its returned code or
configuration changes; it does not guarantee isolate reuse.
([Worker Loader API](https://developers.cloudflare.com/dynamic-workers/api-reference/))

### One installed fetch policy

`mount/fetch` is the one policy setting. Browser ingress and every loaded
app's `globalOutbound` both enter `Context.#routeFetch()` and therefore the
same privileged Worker. There is no `mount/app` setting and no separate
`egress` setting. With no `mount/fetch`, normal traffic receives
`FETCH_POLICY_UNCONFIGURED` (404); it does not fall through to the network.

The policy alone receives `env.NEXT`. It selects a target, awaits a **native
Fetcher**, then calls native `fetch()` on it:

```ts
type PolicyEnv = { NEXT: { to(target: unknown): Fetcher } };

export default {
  async fetch(request: Request, env: PolicyEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/docs/")) {
      const docs = await env.NEXT.to({
        kind: "worker",
        source: docsSource,
        exportName: "Docs",
      });
      return docs.fetch(request);
    }
    if (url.origin === "https://api.github.com") {
      const network = await env.NEXT.to({
        kind: "network",
        approval: { approval: "required", expiresInMs: 60_000 },
      });
      return network.fetch(request);
    }
    return new Response("No route permits this request", { status: 403 });
  },
};
```

`FetchNext.to()` creates a static `FetchDestination` loopback export. Its
serializable props retain the project, path, target and `policyOffset`; the
source is not smuggled through an HTTP header. The destination checks that the
installed `mount/fetch` offset still matches. A worker target is loaded with
the ordinary scoped Host, so its later global fetch re-enters the policy. A
network target alone adds the private terminal marker and calls
`Egress.terminal()`, which performs HTTPS, secret-origin, approval and
one-shot-effect checks. Hosts strip caller-supplied private headers.

The loopback is deliberately native: ordinary Responses can cross native RPC,
but a Response containing a WebSocket cannot. This is
`NEXT.to(target) -> await Fetcher -> target.fetch(request)`, not a hypothetical
`NEXT.dispatch()` RPC. The policy is privileged executable configuration;
ordinary applications are not automatically given `NEXT`, though privileged
policy code can deliberately delegate it. `policyOffset` binds destinations,
approvals and continuations to the installed policy revision. A worker target
checks the offset only on `FetchDestination` entry, before async source
loading; it has no later in-flight revocation proof. For the network terminal,
after request planning and trusted secret injection, Context synchronously rechecks that
offset, atomically claims the one-shot effect, and starts native fetch without
an intervening `await`. Durable Object output-gate ordering persists that claim
before sending. Thus a stale, not-yet-dispatched network continuation is
rejected with `FETCH_POLICY_CHANGED` (409). `released` means a durable dispatch attempt, not
remote completion: replacement cannot retract an already dispatched request or
an open WebSocket. Internal targets are checked at continuation entry; revocation
during asynchronous internal source loading is not proven. Historical alternatives remain in
[the routing comparison](notes/one-fetch-interface.md).

### Why this split, after comparing three interface shapes

A single `provide(path, sourceOrBuild)` hides the compiler but also hides the
build/load boundary and makes it hard to supply native loader inputs. A typed
`workers.at(path, source)` factory gives installed apps pleasant handles, but
is an optional path-oriented layer, not the lowest-level worker API. Explicit
`build(input) -> WorkerCode` followed by contextual `load(code)` preserves
both independent uses and both cache identities. The internal loader uses a
native `WorkerStub`; the public RPC boundary returns an owner-forwarded
`WorkerTarget`. Typed application factories can compose these seams.

### 3. Optional application path interpretation

```ts
// Proposed Docs capability, not open<T>() and not Context.cd().
const note = await itx.docs.open("/workspaces/review/notes.md");
await note.read();
```

The acceptance case renames a document, creates a replacement at the old path,
then proves a fresh open resolves the replacement while a held handle either
continues to the original private identity or fails explicitly—never silently
retargets. It also proves a path conveys no authority. This is why a generic
`open<T>(path)` is rejected: a TypeScript assertion cannot prove a remote
target has that interface. See [the identifier design](IDENTIFIERS.md#one-namespace-does-not-require-one-universal-object-type).

### 4. Provenance evidence rather than claimed identity

```ts
// Actual EventInput shape; proposed application convention for its meaning.
await context.append({
  id: "review-42",
  type: "review.approved",
  data: { document: "/workspaces/review/notes.md" },
  provenance: { parents: ["review-41"], signatures: [author, reviewer] },
});
```

The acceptance case verifies that changing the context, event claim, parents,
or producer invalidates a signature; a trust-setting change affects only later
receipts; and replay preserves the platform-observed offset/time separately
from the signers' claims. Those envelope mechanics are actual in
[`src/signatures.ts`](src/signatures.ts) and [`src/stream.ts`](src/stream.ts).
What remains proposed is an application mapping from signed keys to human or
project authority, and any platform-signed receipt. [INTERESTING-IDEAS.md](INTERESTING-IDEAS.md#6-separate-signed-claims-from-platform-observations)
keeps that distinction deliberate.

## Optional Docs application sketch

If a Docs application is added, it can be one mounted capability named `docs`.
It is not a member added to `ScopeTarget`, a new project resource, or a
precondition of the core plan. The dotted facade can make that capability
pleasant to call after it compiles to the existing `invoke()` seam:

```ts
type ProjectPath = `/${string}`; // runtime opening also validates canonical form
type Revision = string;
type DocumentState = { revision: Revision; text: string };
type Change = { from: number; to: number; text: string }; // UTF-16 offsets at base
type CommitResult = { ok: true; revision: Revision } | { ok: false; current: DocumentState };
abstract class Document extends RpcTarget {
  abstract read(): Promise<DocumentState>;
  abstract commit(input: { base: Revision; changes: Change[] }): Promise<CommitResult>;
}
abstract class Docs extends RpcTarget {
  abstract open(path: ProjectPath): Document;
}
```

For the first Docs implementation, `commit` is a conditional text edit, not a
claim to implement CRDT merging. Non-overlapping ordered edits are interpreted
against exactly `base`; stale edits return a conflict. A later live-edit
session can evolve this application without changing context addressing,
stream APIs, or the capability dispatcher. Paths have only the application
meaning Docs gives them; held-handle semantics are likewise an application
choice, never an ambient project-resource law.

**Artifact means Cloudflare Artifacts only:** its hosted Git repositories can
back the lightweight project `repos` facet. The current SQLite file-map repo
implementation demonstrates the repo interface; it is not Cloudflare Artifacts
and does not yet implement Git interoperability. This follows the distinction
already recorded in [OS's source-address design](../../../apps/os/docs/itx-later.md#one-source-address--the-repo-is-the-artifact-wrapper).

An eventual application authentication adapter can supply an already scoped
context capability; it does not need a universal project-resource type:

```ts
interface AccessGate {
  context(request: Request): Promise<Scope | Response>;
}
// A real test, once that application module exists:
declare const docs: Docs;
const note = await docs.open("/notes/plan.md");
const base = await note.read();
const attempts = await Promise.all([
  note.commit({ base: base.revision, changes: [{ from: 0, to: 0, text: "A" }] }),
  note.commit({ base: base.revision, changes: [{ from: 0, to: 0, text: "B" }] }),
]);
assert.equal(attempts.filter((result) => result.ok).length, 1);
```

No caller can manufacture that authority by sending an email, a project path,
or a `Principal` JSON object. The current demo login intentionally does not
implement membership. Signed producer claims remain separate from any later
platform-observed receipt.

## Frozen core direction and remaining proofs

The core plan of record is frozen around canonical `project + context path`,
the physical `builtins` fixed point, durable longest-prefix mounts, and one
dispatch seam (`Scope.invoke()`, with a future dotted facade compiling to it).
It needs no generic `Project`, `open<T>()`, document/resource identity system,
or actor-per-path rule.

The next core proofs are narrow: reserved-name/fixed-point behaviour,
longest-prefix and hop-limit routing, live-lend expiry, direct native loading
with scoped ITX, build/cache identity, and the one fetch policy. Docs conflict
editing, held-document handles, and membership/grant semantics become
application-specific public contracts only if those applications are built.
Do not answer a missing proof by adding broad compatibility layers; deepen the
existing module at its public seam and record operational proof separately.
