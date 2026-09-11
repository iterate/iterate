# V4 compatibility with celld v0.4.1

Research date: 2026-09-07. Scope: the current local
`packages/v4/project-worker`, including dynamic code, processors, capabilities,
storage, connections, and deployment. This is source-based feasibility research,
not a successful port, runtime test, performance measurement, or production proof.

Update 2026-09-08: this preliminary assessment is superseded where contradicted by
the [executed V4 bring-up](../packages/v4/project-worker/docs/celld.md) and
[upstream roadmap/source follow-up](celld-upstream-roadmap-2026-09-08.md).
In particular, the Ed25519 compatibility inference below was disproved: the
Rust and Node APIs have verification support, but the Web Crypto API used by V4
lacks the required dispatch and raw-key import path. The direct compiler path
has now also been exercised successfully; see the bring-up report for its limits.

## Pin and verdict

Follow-up: the [beta/release/ref check](celld-globaloutbound-beta-check.md)
distinguishes supported `globalOutbound: null` from the unsupported Fetcher broker
and checks the public prerelease metadata and open feature request.

The inspected upstream is `denoland/celld` **v0.4.1**, commit
[`10cb1303dac710dcb3b557e318e08c855261f68b`](https://github.com/denoland/celld/tree/10cb1303dac710dcb3b557e318e08c855261f68b),
released on 2026-09-05 (checked 2026-09-07). GitHub identifies it as the
[latest release](https://github.com/denoland/celld/releases/tag/v0.4.1);
the checked main branch resolves to the same commit.

**Verdict: no — current V4's dynamic-worker/facet runtime will not work on this
release unchanged.** Every V4 load sends a non-null `globalOutbound` Fetcher and celld rejects
that option synchronously. Even after that blocker, celld cannot inject V4's `ITX`
capability binding into the child, and the required cross-isolate `RpcTarget` /
callback transport and pipelined capability paths are deliberately unimplemented.

The stream/reducer design is a much closer fit than the capability/execution
design. SQLite, alarms, KV, and hibernating WebSockets exist; loaders and facets
also exist, experimentally. Their existence does **not** imply support for V4's
particular composition. See the detailed runtime evidence below.

## Compatibility at a glance

| V4 requirement                                             | Assessment on this release                                          | Work needed                                                                            |
| ---------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Event log, atomic reducer/checkpoint, subscription cursors | Strong source-level fit with DO SQLite and synchronous transactions | Run the same rollback, restart, replay, and idempotency contracts on celld             |
| KV namespaces and crypto                                   | Primitives appear available                                         | Provision bindings; run V4 interoperability and size-limit tests                       |
| Context-owned processor facets                             | Experimental shape matches, but V4's ITX binding does not           | Fix capability/execution blockers, then prove facet lifecycle                          |
| Policy-brokered dynamic execution                          | Explicitly unsupported                                              | Upstream runtime support or a substantive alternate executor/egress bridge             |
| Live capabilities, callbacks, cross-isolate pipelines      | Explicitly unsupported                                              | Upstream support or an explicit capability transport preserving lifetime and authority |
| HTTP and WebSocket ingress                                 | Primitives available, exact application path unproven               | Test native streaming, upgrades, cancellation, close, and reconnect                    |
| Existing deployment configuration                          | Rejected                                                            | Separate celld build/deploy configuration and infrastructure                           |
| Existing Cloudflare data                                   | No documented direct DO migration path found                        | Fresh state, or a separately designed and verified application migration               |

## Persistence, lifecycle, and operational fit

V4 already concentrates its stream persistence behind
[`DurableObjectStorageSlice`](../packages/v4/project-worker/src/stream/stream-storage.ts#L6-L12):
SQL, a synchronous transaction, and scheduling an alarm. Its event rows and core
checkpoint commit together in
[`Stream.append`](../packages/v4/project-worker/src/stream/stream.ts#L388-L428).
Celld documents SQLite, transactions, and alarms, including rollback and
durability-gate behavior; its implementation defers transaction-local alarm
publication until the transaction boundary.
([storage implementation](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/storage.rs#L4065-L4169),
[transaction semantics](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/docs/cloudflare-compat.md#L64-L128))

The durability distinction matters: celld's documented acknowledged-write proof
uses object storage on one node, or fleet peers before bucket upload with multiple
nodes. Its guarantees depend on a correctly behaving object store and process
supervision. A local development run is not evidence for those guarantees.
([replication model](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/README.md#L26-L35),
[guarantee conditions](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/docs/guarantees.md#L3-L44))

V4's facet props are JSON identity data, which matches celld's restriction; its
`get`/`abort`/`delete` operations have corresponding experimental implementations.
This does not establish dynamic processor compatibility: the facet's ITX
capability still hits the blockers below. Root/facet eviction, source changes,
abort/delete, and independent checkpoint recovery remain acceptance tests.
([V4 facet startup](../packages/v4/project-worker/src/iterate-context-durable-object.ts#L762-L840),
[celld facet semantics](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/docs/cloudflare-compat.md#L177-L190))

V4's raw Ed25519 verification and AES-GCM secret handling appear covered by celld's
WebCrypto implementation. Known-signature and encrypted-secret fixtures should
prove interoperability, including tampered AAD/tag rejection and decrypt after
restart. This is a compatibility inference, not an executed crypto test.
([V4 provenance](../packages/v4/project-worker/src/provenance.ts#L268-L316),
[V4 encrypted policy](../packages/v4/project-worker/src/fetch/policy.ts#L95-L119),
[celld crypto source](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/js/crypto.rs#L1663))

WebSocket support must be tested through V4's actual HTTP-upgrade and session
paths. Celld has explicit connection ownership and input-queue rules; moving an
object between nodes requires client reconnection. Memory pressure can also
close parked sockets with 1012. Neither this nor a different native implementation
proves V4's previously investigated Cloudflare close failure is absent.
([socket implementation contract](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/docs/cloudflare-compat.md#L340-L367),
[pressure and hibernation behavior](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/README.md#L301-L356))

## Deployment is separate work

The checked-in [V4 Wrangler config](../packages/v4/project-worker/wrangler.jsonc)
contains unsupported celld deployment keys, including `build`, `workers_dev`,
`worker_loaders`, `version_metadata`, `exports`, and `observability`. Celld's
deployment allowlist rejects unknown top-level keys. V4 also uses `exports` to
declare a new SQLite class; celld consumes the SQLite class declarations in
`migrations.new_sqlite_classes` instead. A celld configuration therefore needs
translation, not just a different deploy command.
([accepted configuration](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/docs/cloudflare-compat.md#L477-L492),
[SQLite class processing](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/deploy.rs#L1566-L1580))

The adapter must supply stable deployment identities to V4 and its
[bundler](../packages/v4/project-worker/src/bundler.ts), prebuild the SDK/assets,
provision the KV namespaces and service bindings, enable the loader explicitly,
and arrange ingress/TLS. Workers AI requires an external backend if that surface
is retained; celld is not a managed inference platform. The existing runtime
bundler's WebAssembly and package-resolution path has **not** been run on celld.
No claim of full bundler or OAuth-provider compatibility is made here.
([loader opt-in](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/docs/cloudflare-compat.md#L159-L175),
[ingress and AI adapter](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/docs/cloudflare-compat.md#L35-L62))

Celld documents a KV bulk-import route, but this investigation found no direct
Cloudflare Durable Object SQLite migration route. Treat a trial fleet as fresh
state. Do not infer that Cloudflare IDs or a common object-store vendor make the
two durable histories interchangeable.
([celld KV tooling](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/README.md#L276-L282))

## Immediate, certain blockers

1. **`globalOutbound: itxEntrypoint` rejects every V4 worker load.**

   V4 constructs native loader code with both `env.ITX` and
   `globalOutbound` set to its context-specific Fetcher
   ([`worker-loader.ts:92-98`](../packages/v4/project-worker/src/context/worker-loader.ts#L92-L98));
   its confined source path does the same
   ([`worker-loader.ts:376-380`](../packages/v4/project-worker/src/context/worker-loader.ts#L376-L380)).
   celld accepts only absent (inherit) or `null` (deny) `globalOutbound`; any other
   value throws the exact error **`worker loader: globalOutbound broker is not
implemented yet`** ([implementation
   `js.rs:8617-8628`](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/js.rs#L8617-L8628)).
   Its explicit denial path has a different, working behaviour and message
   ([`js.rs:9308-9316`](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/js.rs#L9308-L9316)); it is not an equivalent to V4's policy-routing Fetcher.

2. **The child cannot receive V4's `env.ITX` service/capability stub.**

   V4 relies on `env.ITX.get()` to return the real context target
   ([`itx-entrypoint.ts:18-35`](../packages/v4/project-worker/src/itx-entrypoint.ts#L18-L35)).
   celld serializes loader `env` as JSON, with the source stating that capability
   stubs are not supported ([`js.rs:8599-8604`](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/js.rs#L8599-L8604)); the JS loader literally calls `JSON.stringify(config)` before the
   Rust loader receives it ([`harness.js:2800-2816`](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/js/harness.js#L2800-L2816)). Thus even a future removal of blocker 1 would not make the `ITX`
   Fetcher a usable child binding on this release.

3. **V4's cross-isolate live-capability design is unsupported.**

   `ItxEntrypoint.get()` returns an `IterateContext` `RpcTarget`, deliberately so
   loaded code can use dotted, pipelined handles ([`itx-entrypoint.ts:19-27`](../packages/v4/project-worker/src/itx-entrypoint.ts#L19-L27)). V4 also lends a `WorkersRpcTarget` that wraps a client callback/stub to its
   context DO ([`rpc-stub-relay.ts:39-67`](../packages/v4/project-worker/src/context/rpc-stub-relay.ts#L39-L67)), and its DO explicitly depends on a genuine pipelinable
   `RpcTarget` ([`iterate-context-durable-object.ts:568-579`](../packages/v4/project-worker/src/iterate-context-durable-object.ts#L568-L579)).

   celld's cross-isolate deserializer turns a transferred RPC stub into a stub that
   rejects with the exact error **`RPC stubs cannot cross isolate boundaries yet.`**
   ([`harness.js:3542-3564`](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/js/harness.js#L3542-L3564),
   [`harness.js:3608-3617`](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/js/harness.js#L3608-L3617)). That rules out the relay's native function/target return and callbacks across the loaded-worker boundary.

4. **Required cross-isolate pipelining is explicitly refused.**

   celld rejects multi-property calls on loaded workers with **`Pipelined property
paths on loaded workers are not supported yet.`**
   ([`harness.js:2726-2750`](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/js/harness.js#L2726-L2750));
   it gives the matching rejection for facets
   ([`harness.js:2081-2094`](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/js/harness.js#L2081-L2094)) and cross-script service bindings
   ([`harness.js:3806-3824`](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/js/harness.js#L3806-L3824)). V4's public host calls are flat at their final `WorkerEntrypoint` method
   ([`built-ins.ts:275-299`](../packages/v4/project-worker/src/context/built-ins.ts#L275-L299)), but the `ITX` scope and RPC-stub relay require the deeper capability paths,
   so flattening only the outer host door is insufficient.

## Supported subset / non-blocking facts

- celld does implement the basic experimental Worker Loader shapes: `load()`,
  named `get()`, `getEntrypoint()`, and `getDurableObjectClass()`
  ([`harness.js:2697-2818`](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/js/harness.js#L2697-L2818)). A standalone loaded worker using only JSON `env`, no outbound broker,
  and one flat entrypoint RPC method is consequently a plausible supported subset.
- `ctx.exports.Name({ props })` itself is implemented for exported
  `WorkerEntrypoint` classes: the stub carries props, creates the class with a
  context containing those props, and `ctx.props` is exposed by the event context
  ([`harness.js:3896-3933`](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/js/harness.js#L3896-L3933),
  [`harness.js:10877-10890`](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/js/harness.js#L10877-L10890)). This matches V4's loopback minting shape
  ([`itx-entrypoint.ts:49-57`](../packages/v4/project-worker/src/itx-entrypoint.ts#L49-L57)).
  celld reads only `args[0]?.props` when invoking that loopback stub
  ([`harness.js:3920-3933`](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/js/harness.js#L3920-L3933)); other instantiation options are ignored rather than validated.
- This is not merely a compatibility-page assertion: celld registers every module
  export whose prototype derives from `WorkerEntrypoint`
  ([`bootstrap.rs:833-839`](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/js/bootstrap.rs#L833-L839)). V4 exports `ItxEntrypoint` from its main worker
  ([`worker.ts:42`](../packages/v4/project-worker/src/worker.ts#L42)), so no separate V4 export-table declaration appears necessary for celld to expose the _local_ loopback entrypoint.
- Same-isolate `RpcTarget`/function lifting and receiver-side walking exist
  ([`harness.js:3315-3359`](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/js/harness.js#L3315-L3359),
  [`harness.js:3640-3685`](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/crates/celld/js/harness.js#L3640-L3685)). This does not rescue V4: the needed handoff crosses into separately loaded isolates.

## Hypotheses / scope limits

- No celld deployment or application-code change was made. The first runtime blocker
  is direct source control flow, so an execution is not needed to establish the
  current verdict. celld's own compatibility document independently lists these
  limits (globalOutbound Fetcher, loader capability env, paths, cross-isolate
  stubs), but the conclusions above are grounded in the runtime source rather than
  that page ([`cloudflare-compat.md:165-189`](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/docs/cloudflare-compat.md#L165-L189),
  [`cloudflare-compat.md:321-328`](https://github.com/denoland/celld/blob/10cb1303dac710dcb3b557e318e08c855261f68b/docs/cloudflare-compat.md#L321-L328)).
- A redesign could target the limited flat/JSON subset, but that would be a
  different V4 runtime: it would need an explicit egress protocol, a serializable
  ITX request protocol, and replacement semantics for callback/capability transfer.
  This report makes no claim that such a redesign is small or preserves V4 behavior.
- No committed v0.4.1 regression test was found for these exact gaps (source-tree
  scan for the error strings and test annotations); the implementation's explicit
  error paths above are the available primary evidence.

For the combined code/test recommendations, see the
[runtime portability plan](v4-runtime-portability-plan.md). No throughput or cost
conclusion follows from this research; those need a working port and measured,
production-shaped workloads with the same subscribers and durability conditions.
