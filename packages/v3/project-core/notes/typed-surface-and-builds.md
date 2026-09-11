# Typed surface and dynamic-worker builds — Design B

Status: direct loading and the first optional bundler/cache slice are implemented.
The runnable core accepts native-shaped `WorkerInput` through `Scope.load()`,
as well as JavaScript modules or a pinned repository revision through the
source adapter. `Scope.build.build()` now bundles pinned TypeScript files and
retains inert outputs in KV. It does not yet type-check TypeScript, install
registry packages, generate contract declarations or activate built workers.

## Actual first build slice

```ts
const result = await context.build.build({
  source: { repo: "site", revision },
  options: { entryPoint: "src/main.ts", minify: true },
});
if (result.status === "built") {
  console.log(result.key, result.cache); // input digest; hit or miss
  using worker = await context.cd("/review").load(result.code);
  console.log(await worker.invoke(["describe"]));
} else console.log(result.diagnostics);
```

[`build.ts`](../src/build.ts) defines the facet and the serializable subset of
native bundler options: `entryPoint`, `target`, `minify`, `sourcemap`.
[`bundler.ts`](../src/bundler.ts) runs the pinned Cloudflare bundler in its own
RPC-only Worker. The context resolves an immutable repo revision into file
bytes; the compiler receives no project authority. Its independent KV key is
`sha256(canonical({ version: backendVersion, input: { files, options } }))`.
Source bytes include configuration and vendored dependencies; backend version
captures deployed dependency/patch bytes, defaults and cache schema. A cache
hit skips `createWorker()`, never `load()` or contextual authority injection.
Identical snapshots share output across repo names/commit messages. This cache
key is not a record of provenance; the caller retains its pinned source selection.

Only successful string-module bundles are cached, for 24 hours. KV is an
optimization, not coordination: different locations can miss and compile the
same input. Concurrent miss coalescing and a durable build queue are absent.
Registry installation is rejected until resolved dependency bytes/integrity
can participate in the key. Syntax failures and bundler warnings return
`{ status: "rejected", diagnostics }`; compiler crashes still throw. Source
diagnostics do not also enter runtime error logs.

A successful bundle is **not** a typecheck, a Worker startup guarantee, or an
authorization to install. The pinned bundler leaves runtime imports such as
`cloudflare:*`, `node:*` and dynamic imports for workerd to resolve; incompatible
flags or unavailable modules may still fail at `load()`/execution. Native
loader validation remains at that seam. These limits do not weaken direct
`WorkerInput`, which still supports native module types and bindings.

## Earlier interface exploration (not the shipped request type)

This is the flexible alternative for the interface comparison: a thin adapter
around Cloudflare's well-defined `WorkerLoaderWorkerCode`, rather than a new
universal worker-description language. It deliberately leaves a smaller,
common-case factory design to the other comparison.

## Facts that constrain the design

`WorkerLoader.get(id, callback)` caches by the caller's `id`; Cloudflare does
not promise a warm isolate, and the callback must return exactly the same
content for one ID. `load(code)` has no ID cache. The documented consequence is
to change the ID when code **or configuration** changes.
([Dynamic Workers API](https://developers.cloudflare.com/dynamic-workers/api-reference/))

The actual code type is `compatibilityDate`, optional flags/limits,
`mainModule`, `modules`, optional `env`, `globalOutbound`, and tail bindings.
([workerd declaration](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/types/generated-snapshot/index.ts#L4150-L4181))
At load time workerd serializes `env` (with a 1 MiB cap) and captures the
outbound/tail bindings. It cannot infer those capabilities into the `get()`
cache key. ([implementation](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/api/worker-loader.c++#L76-L123),
[binding capture](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/api/worker-loader.c++#L176-L211))

Therefore, calling `get(sameId, () => differentEnv)` is unsound: a reused
isolate retains the earlier capability binding. A loader key must contain
static code/configuration _and_ platform-derived identities for every captured
authority. It must never try to JSON-serialize a capability itself.

## Design B: three independent layers

```ts
// Immutable source selection; resolving a branch is outside this contract.
type RepoEntry = Readonly<{ repo: string; revision: string; entry: string }>;

// Adapter-owned validated data. Its exact fields belong to the selected bundler,
// rather than becoming a pretend platform-wide options language.
type BundlerOptions = Readonly<Record<string, Json>>;

type Bundler = Readonly<{
  id: string;
  revision: string;
  options: BundlerOptions;
}>;

// Same flat shape as native Worker Loader input. env.ITX is reserved.
type WorkerInput = Omit<WorkerLoaderWorkerCode, "env" | "globalOutbound"> & {
  env?: Record<string, unknown>;
};

type ContextBinding = Readonly<{
  project: string;
  path: string;
  continuation: "gate" | "terminal";
  hostVersion: string;
}>;
type BindingIdentity = ContextBinding | Readonly<{ authority: string; revision: string }>; // pinned authority, platform-issued

type BuildCacheInput = Readonly<{
  source: RepoEntry;
  bundler: Bundler;
  toolchain: Readonly<{ compiler: string; bundler: string }>;
  dependencyLock: string;
  contractRevision: string;
  runtimeConfiguration: Json;
}>;

// This is platform-owned data, constructed while it holds each capability.
// It is not a label a worker may supply to claim cache equivalence.
type LoaderCacheDescriptor = Readonly<{
  nativeCodeAndConfigurationDigest: string;
  // Every authority slot, including env.ITX, globalOutbound, other env and tails.
  bindings: Readonly<Record<string, BindingIdentity>>;
}>;
```

`RepoEntry + Bundler -> WorkerInput` is one optional bundler adapter.
It may use a source/build cache whose digest covers **all** `BuildCacheInput`.
The emitted worker input is its cache value, never an input to that lookup;
this avoids the circular claim that output modules select their own build.
That cache records where code came from; it is not the Worker Loader cache.
Equivalent output from two source revisions may share a loader isolate, while
the source/build cache still retains separate provenance.

The platform then passes the native input through, injecting its two confined
capabilities only at the final boundary:

```ts
async function loadPrepared(
  loader: WorkerLoader,
  prepared: WorkerInput,
  descriptor: LoaderCacheDescriptor | undefined,
  host: Fetcher,
) {
  const code: WorkerLoaderWorkerCode = {
    ...prepared,
    env: { ...prepared.env, ITX: host }, // ITX overwrites the reserved name
    globalOutbound: host, // same confined Context fetch capability
  };
  // `descriptor` exists only when the platform established every captured
  // binding identity and byte/module digest. Otherwise do not cache it.
  if (!descriptor) return loader.load(code);
  return loader.get(await sha256(canonical(descriptor)), () => code);
}
```

The illustration names `WorkerLoaderWorkerCode` directly so that native fields
remain visible. The production adapter validates source and bundler inputs
before this point. It permits legitimate native `env` bindings except `ITX`,
which the platform always overwrites, and it enforces `globalOutbound`.
This is the internal adapter, not a public method accepting an asserted
descriptor: snapshot input bytes first, derive their descriptor while holding
the actual bindings, and pass that exact snapshot to the loader callback.
The builder emits persistable data, not authority-bearing stubs; legitimate
extra bindings can be attached after building and before contextual loading.

`ContextBinding` is an identity descriptor, not a capability. Native `env`
accepts structured-cloneable data and supported service bindings; not every
arbitrary RPC stub or browser Cap'n Web stub is such a binding. Module buffers
need byte-aware hashing, and service/tail bindings cannot be JSON-hashed.
Cache only when the
platform created an exact descriptor for each held authority and a byte-aware
digest for modules/config.
An arbitrary caller label cannot grant, describe, or alias an authority. Use
native `load()` for call-scoped or unidentifiable bindings. Conversely, no code
may assume `get()` makes the same isolate durable or single-threaded.

## One fetch policy

Both `ITX` and `globalOutbound` are the same scoped `Host`, so public ingress,
ITX fetches and an app's ordinary `fetch()` enter stateless `routeFetch()`.
That function has one configuration: `mount/fetch`. Missing configuration is an
explicit `FETCH_POLICY_UNCONFIGURED` 404, not an implicit outbound default.

The installed policy is loaded with the ordinary Host plus `env.NEXT`, a
`FetchNext` static native Fetcher. Normal loaded applications receive only
the Host; they do not automatically inherit `NEXT`. In policy code:

```ts
const destination = await env.NEXT.to({
  kind: "network",
  approval: { approval: "required", expiresInMs: 60_000 },
});
return destination.fetch(request);
```

`to()` validates and size-bounds its target, then returns the static
`FetchDestination` export with serializable `{ project, path, policyOffset,
target }` props. It is intentionally a native Fetcher loopback rather than an
RPC method returning `Response`: WebSocket Responses must remain native. The
destination rejects a changed `mount/fetch` offset on entry. For a worker
target it then loads the selected source with the ordinary Host, causing later app fetches to
re-enter policy. For a network target it alone attaches the private terminal
marker; Context strips caller markers and `Egress.terminal()` enforces bounded
HTTPS, secret origin pins and approval. There are no `mount/app` or `egress`
settings. For a network terminal, planning and trusted secret injection finish
before Context synchronously rechecks `policyOffset`, atomically claims the
one-shot attempt, and starts native fetch with no intervening `await`. The DO
output gate persists the claim before sending. Therefore a **network**
continuation made stale before dispatch fails `FETCH_POLICY_CHANGED` (409); it
does not promise to cancel a request or WebSocket already dispatched. `released`
records that durable dispatch attempt, never remote completion. This final
check covers the network terminal. Internal worker loading checks
at continuation entry, without a claim of revocation during its async loading.

This is one executable, privileged routing policy, not a route-list DSL.
Privileged policy code may deliberately pass `NEXT` onward; the confinement
claim is only that ordinary apps are not given it by default. See the
[historical interface comparison](one-fetch-interface.md).

## What is proposed versus runnable

The direct loader is actual:

```ts
using worker = await context.cd("/review").load({
  compatibilityDate: "2026-09-04",
  mainModule: "entry.js",
  modules: { "entry.js": "export default { fetch() { return new Response('hello'); } }" },
});
console.log(await (await worker.fetch(new Request("https://demo.iterate/"))).text());
```

Internally `loadWorker()` injects the contextual Host and calls native
`LOADER.load()`. The public result is a disposable `WorkerTarget`, exposing
`fetch(request)` and `invoke(memberPath, ...args)`. Its owner retains the native
WorkerStub: raw dynamic entrypoints cannot transfer between Workers, and a
public-network test reproduced that native rejection before this forwarding
target was added. This is deliberately a session handle, not a durable actor
ID. Existing `workers.get` now returns the same usable target.
([workerd transfer test](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/api/tests/worker-loader-test.js#L75-L88))

The following richer capability was proposed. The first `build` method above
is implemented; `check` and activation remain proposed. These broad internal
identity descriptors are not fields callers must manufacture:

```ts
interface Builder extends RpcTarget {
  check(input: BuildCacheInput): Promise<Diagnostic[]>;
  build(
    input: BuildCacheInput,
  ): Promise<
    | { status: "rejected"; diagnostics: Diagnostic[] }
    | { status: "built"; code: WorkerInput; diagnostics: Diagnostic[] }
  >;
}
```

The emitted `WorkerInput` is a build output, not a Cloudflare Artifact. “Artifact” in
this project means the distinct Cloudflare Artifacts hosted-Git product only.
Installation/activation must be a separately authorized, durable configuration
operation; a successful bundle does not receive authority to run, read secrets,
or edit trust.

The earlier OS components demonstrate useful boundaries without being a copy
plan: [`worker-bundler.ts`](../../../../apps/os/src/worker-bundler.ts) produces
modules; [`build-key.ts`](../../../../apps/os/src/domains/workers/build-key.ts)
keys pinned repository input and options; the typecheck modules provide
diagnostics. Their historical `WorkerBuildArtifact` vocabulary is source
terminology, not the proposal's generic use of “artifact”.

## What the source adapter adds today

[`src/runtime.ts`](../src/runtime.ts) is intentionally smaller. `loadSource()`
accepts `{ modules }` or `{ repo, revision }`, demands `main.js`, hashes module
bytes for inline source, and uses `[VERSION.id, owner, revision]` as a loader
name. It fixes the compatibility date/flags and calls the same thin
`loadWorker()` authority-injection boundary. Direct `Scope.load()` calls use
uncached native loading, rather than pretending opaque bindings have a stable
cache identity. Neither path invokes a compiler or bundler.

That already has the correct single-host confinement shape. `owner` includes
the canonical project/context path and whether fetch is continuing below its
policy; `Host` points to the live Context DO, whose settings are read on each
request. This note does **not** establish a current host-configuration cache
bug. This source adapter does not itself invoke the separate builder. If a future
binding captures immutable authority/configuration rather than this live host,
it must obtain a platform-owned loader descriptor or use uncached `load()`.

## Acceptance tests once implemented

- For a cacheable prepared input, a different `ContextBinding` produces a
  different loader ID and sees only the new scoped ITX/fetch policy. Direct
  uncached input already proves contextual ITX injection.
- Two repo revisions that bundle to identical static code may share the loader
  cache but retain distinct source/build-cache records.
- Changing a compatibility flag, limit, module, or bundler option misses the
  appropriate cache; a warm isolate is never treated as guaranteed.
- Already tested: public ingress, mounted-worker global fetch, and directly
  loaded-worker global fetch traverse Context's single policy. Caller-supplied
  `globalOutbound: null` is overwritten too.
- A failed check returns diagnostics and cannot be activated; no skipped test
  stands in for that behavior.
