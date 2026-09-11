# Runtime seam

`runtime.ts` is the Cloudflare-only adapter. `loadWorker()` accepts native-shaped
worker input and injects the context's ITX and outbound Host. A policy load can
add `env.NEXT`; an ordinary app load cannot receive it accidentally. It leaves
native code/configuration validation to workerd. Direct public `Scope.load()`
calls use native uncached `load()`, so opaque bindings are not assigned invented
cache identities. A compiler or repository is not required.

`LoadedWorker` is the public RPC facade: native dynamic entrypoints cannot
transfer between Workers. This target privately retains the WorkerStub at its
owner and forwards `invoke()` and `fetch()`. It is disposable and session-scoped,
not a durable actor name or an owner-eviction recovery mechanism.

The separate `Source` adapter handles the narrower inline/pinned-repo format.
Repositories return ordinary files; this adapter validates executable modules.

`loadSource()` gives `WorkerLoader.get()` one stable identity:

```text
JSON([deployment version id, owning context + fetch continuation, content SHA-256 | immutable repo revision])
```

The loader owns isolate caching, without guaranteeing a warm isolate. An
inline source hashes a canonical module-name/content object; a repo source uses the immutable revision
already named by the event. A request ID, offset, timestamp, host incarnation,
or random nonce must never enter the identity: those create a billed dynamic
worker and a cold isolate per request. This narrower source format requires
`main.js` and fixes compatibility settings. Ordinary source loads bind
`env.ITX` and `globalOutbound` to the context's fetch-capable Host. The
installed fetch policy additionally binds `env.NEXT` to the static native
continuation for its current `policyOffset`; Node compatibility is explicitly
disabled. Direct native input can use other main-module names, native module
types, configuration and supported bindings.

## Native fetch continuation

The one `mount/fetch` policy is privileged executable configuration. It calls
the static loopback in two native steps, rather than an invented RPC dispatch:

```ts
const target = await env.NEXT.to({
  kind: "worker",
  source: docsSource,
  exportName: "Docs",
});
return target.fetch(request);
```

`FetchNext.to()` validates a bounded target descriptor and constructs static
`FetchDestination({ project, path, policyOffset, target })` props. The latter
checks the current setting offset on entry before it either starts loading a
worker source with the normal Host or emits the private network-terminal marker. The props carry
the source; no large source descriptor passes through an HTTP header. A native
Fetcher is required for WebSocket Responses, which cannot cross ordinary RPC
serialization even though normal Request/Response values can.

The normal Host strips private headers before Context sees a request. Only a
destination for `kind: "network"` introduces `x-core-terminal`, and Context
then calls `Egress.terminal()` with the target's approval and policy offset.
Thus application global fetch starts at policy again, while the selected
terminal does not recursively re-enter it. `NEXT` is not automatically
nontransferable: a privileged policy can intentionally delegate it.

For a network destination, Egress first finishes bounded request planning and
trusted secret injection; decrypted plaintext stays inside that injector and
is not returned to policy code. Context then synchronously asserts the current
`policyOffset`, atomically records/claims the one-shot attempt, and invokes
native fetch with no `await` between those operations. The Durable Object
output gate persists the claim before the request is sent ([DO output gate
ordering](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#supported-options-1);
[workerd native fetch path](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/api/http.c%2B%2B#L1710-L2021)).
It rejects an old **network-terminal** continuation before dispatch with
`FETCH_POLICY_CHANGED` (409). A worker target has only the entry check, not a
post-`loadSource()` revocation check. It cannot cancel an already dispatched request or open WebSocket;
`itx.system.egress.released` records the durable one-shot dispatch attempt,
not remote completion. Post-commit notification and the effect response are
awaited together only after dispatch starts.
Internal target loading only checks at continuation entry; revocation during
asynchronous source loading is not proven by the network-terminal regression.

`callTarget()` is the other physical seam. It walks an explicit typed member
path and calls the final member with its original receiver. workerd's hidden
`RpcPromise` and `RpcProperty` brands remain unawaited during that walk, so
native Workers-RPC promise pipelining stays one call chain. Ordinary promises
are awaited between members. Prototype and reserved member names are rejected
at use, rather than becoming a general capability-expression language.

The final native promise is retained until it settles. On rejection only,
`callTarget()` disposes that exact `RpcPromise` and rethrows the original error;
on success it does not dispose, because that could revoke returned capabilities.
This contains a reproduced native session-pipeline leak at this boundary, not
every arbitrary RPC call userspace might make. See the
[rejection differential and current acceptance](../evidence/loaded-worker-rejection.md).

There is no compiler or cache of build outputs inside this runtime adapter,
and no durable WorkerStub registry. The optional `Scope.build.build()` facet
resolves pinned repository files and calls the separate `bundler.ts` Worker.
That Worker caches successful code by resolved bytes, options and deployed
backend version; its result is inert input for `Scope.load()`. Repository
lookup belongs above compilation; authority is added only at loading. See the
[implemented build slice and remaining design](typed-surface-and-builds.md).
