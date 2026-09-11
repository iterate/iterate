# project-core WebSocket boundary probe

Diagnostic-only Worker for comparing the same public WebSocket echo across an inline handler, a
Worker Loader child, and a static native loopback Fetcher followed by that child. It is not a
project-core runtime, does not share its bindings, and is intentionally outside its source budget.

Run `WORKER_BASE_URL=https://<worker>.workers.dev pnpm probe` after deployment. It proves the public
echo and close lifecycle only; it is not sufficient to detect the native exception. Pair it with a
delayed Workers telemetry query over the probe's invocation window. Each route uses a fresh marker
query parameter, although telemetry redacts UUID query values, so route, timestamp, and expected
native invocation count identify each exchange.

## Recorded comparison

On 2026-09-05 at 10:51:28–10:51:30 UTC, deployed version
`0eaa843c-5e9e-49d9-b19a-b05cdb7c12a7` passed every public echo and normal-close assertion. This
is the delayed-telemetry result from account `376ef7ed81b0573f93524de763666c15`:

| Route                 | UTC event time    |                    Expected telemetry records | Outcome          | Trace                              |
| --------------------- | ----------------- | --------------------------------------------: | ---------------- | ---------------------------------- |
| `/rpc-policy-loader`  | 10:51:30.316–.329 |        2: public fetch + `ProbeContext.jsrpc` | both `ok`        | `b3e6ce8466279d8235f2fe50115232f1` |
| `/do-loader`          | 10:51:29.709–.711 |              2: public fetch + `ProbeContext` | both `exception` | `9b6962700f903955486c4004690c91f9` |
| `/do-loopback-static` | 10:51:29.944–.980 | 3: public fetch + `ProbeContext` + `Loopback` | all `exception`  | `7090dada1618e090eadceddf0065342e` |
| `/do-loopback-loader` | 10:51:30.135–.139 | 3: public fetch + `ProbeContext` + `Loopback` | all `exception`  | `5c06574e45f00e8628e7655f760f0515` |

The Worker Loader child does not emit a separate Workers event row in this probe; direct `/loader`
likewise yielded only its public fetch row. The loopback-static control's `Loopback` record includes
the native cancellation message that it had hung and would never generate a response.

The query was a `POST` to
`/accounts/376ef7ed81b0573f93524de763666c15/workers/observability/telemetry/query` with:

```json
{
  "timeframe": { "from": 1788605340000, "to": 1788605580000 },
  "view": "events",
  "limit": 100,
  "parameters": {
    "datasets": [],
    "filters": [
      {
        "key": "$metadata.service",
        "operation": "eq",
        "type": "string",
        "value": "iterate-project-core-ws-probe-b6f58624"
      }
    ]
  }
}
```

The candidate asks the Context only for `{ source: string }` over Workers RPC, then the stateless
front Worker calls `LOADER.load(...).getEntrypoint().fetch(request)` and returns the upgrade itself.
No WebSocket response crosses `ProbeContext.fetch`.

## Policy capability topology control

On 2026-09-05 at 11:23:51.976–.987 UTC, version
`e1eadd0c-9b84-4925-8a2e-9e955593df24` ran two self-contained echoes. Both clone the request at
the public and destination boundaries; both policy Workers clone and annotate it. The `NEXT` path
also passes a worker-source descriptor to `NEXT.to()`, which returns a static destination Fetcher
with that descriptor in its construction props.

| Route                     | Native chain                                                                               | Expected records                                      | Actual outcome and traces                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `/core-chain-next`        | static front → dynamic policy → `FetchNext.to()` RPC → static `Destination` → dynamic echo | 3: public fetch, `FetchNext.jsrpc`, destination fetch | all `ok`: `18e2b81267d0e0ddc7e77441860ae95a`, `94103361203e79fb1b6d0b31212b8d1f`, `108c6d1bc7d1f3bbe34f73df0c841240` |
| `/core-chain-destination` | static front → dynamic policy with directly injected static destination → dynamic echo     | 2: public fetch, destination fetch                    | both `ok`: `b8c8568ec3ba7b864227d9632a11354c`, `c13aab469fb32e1a9c9795d6874e51b3`                                    |

Each route passed the public echo and client-initiated close code `1000`; the delayed
`cloudflare-workers` query (same account, service, and request shape above; timeframe
`2026-09-05T11:23:00Z`–`11:25:00Z`) returned only these five `ok` rows and no errors or
cancellations. This rules out the capability-return and nested dynamic-child topology alone as the
cause of project-core's preview exception. It does not reproduce project-core's policy snapshot,
cache owner, or full confinement logic.

## Policy-offset RPC control

On 2026-09-05 at 11:27:03.851–11:27:04.334 UTC, version
`0a067056-9348-4373-8118-b677fe078d81` repeated both policy topology routes, but made each static
`Destination` await `ProbeContext.fetchPolicyOffset()` immediately before loading the dynamic echo.
That is the relevant data-RPC ordering in project-core's `FetchDestination.fetch`; it is not a
`DO.fetch` upgrade hop.

| Route                     | Expected records                                                            | Actual `ok` trace IDs                                                                                                                |
| ------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `/core-chain-next`        | 4: public fetch, `FetchNext.jsrpc`, destination fetch, `ProbeContext.jsrpc` | `37314d7280f427462716f69d655bbadc`, `8c44ccf2daf833ac1e1f49612e7a47ff`, `733ddd3e5e042b21540b5094ba2c2558` (destination and Context) |
| `/core-chain-destination` | 3: public fetch, destination fetch, `ProbeContext.jsrpc`                    | `c760c01485553c97c6bbb8c140902191`, `3e4f82eb578dee6ff6f2a661567e6404` (destination and Context)                                     |

Both public exchanges echoed and closed with code `1000`. A delayed `cloudflare-workers` query
over `2026-09-05T11:26:50Z`–`11:27:30Z` returned exactly those seven rows, all `ok`, with no error
or cancellation row. The query was the same POST endpoint and service filter shown above, with
`datasets: ["cloudflare-workers"]` and `limit: 1000`. Therefore the policy-offset data RPC itself,
including its position before Loader fetch, is not sufficient to reproduce the core preview fault.

## Stable Loader cache control

On 2026-09-05 at 11:32:55.575–11:32:57.841 UTC, version
`ce62df1e-da84-4a0d-a145-4bdf3e82612a` changed only the destination's child creation from
`LOADER.load()` to `LOADER.get()`. Its key is the stable tuple
`[VERSION.id, "comparison:itx", "echo-v1"]`, mirroring project-core's deployment, context-owner,
and revision identity. The first public exchange completed before two more were started together.
All three echoed and client-closed with code `1000`, but delayed telemetry is red:

| Exchange        | Public trace                       | Destination trace                  | Context RPC               | Outcome                     |
| --------------- | ---------------------------------- | ---------------------------------- | ------------------------- | --------------------------- |
| completed first | `9f84065ca1fb279fbda6b1a6e481caba` | `1c45022085da35ac580b259ae95c3c89` | `ok` on destination trace | both fetch rows `exception` |
| concurrent A    | `dedb5269375072fe3b7d6e8d819035b3` | `550ae1eee6a7cc50a1fa3e42c794beb1` | `ok` on destination trace | both fetch rows `exception` |
| concurrent B    | `304dc8430b4c4d02bdd0b18893933687` | `6efb17efb683ec898e36571041fb453c` | `ok` on destination trace | both fetch rows `exception` |

The `cloudflare-workers` query over `2026-09-05T11:32:00Z`–`11:34:00Z` returned exactly 12 rows:
three public fetch, three `FetchNext.jsrpc`, three destination fetch, and three
`ProbeContext.jsrpc`. All six RPC rows were `ok`; all six fetch rows were `exception`. No request
was canceled. A trace-scoped all-dataset query returned no richer exception body. This reproduces
the core's native exception classification with the smallest known extra variable: `WorkerLoader`
cache retrieval on a WebSocket-returning loaded worker. It does not establish whether the platform
or a missing application lifecycle rule is at fault.

## Named-cache minimization

On 2026-09-05 at 11:37:19.278–11:37:20.972 UTC, version
`c3a1f50b-4817-4d22-87c5-4979e7fab18f` made three one-variable comparisons. All public probes
echoed and client-closed with `1000`.

| Route                          | Only changed variable                                                            | Telemetry result                                                                                                                                                   |
| ------------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/cached-loader`               | static front directly calls named `LOADER.get(...).getEntrypoint().fetch()`      | sole public fetch is `exception`: `807075c3c164f410411ea6bdc52c5902`                                                                                               |
| `/core-chain-cached-held-next` | named-cache policy route retains `WorkerStub` through `await entrypoint.fetch()` | public `ec4c2f728b418cdf0b0167a484daaea5` and destination `922ef4a050d7d74867e74d7ec3bf049f` are `exception`; Context and `FetchNext` RPCs are `ok`                |
| `/core-chain-anonymous-next`   | identical policy route uses `LOADER.get(null, () => code)`                       | public `2c435c6740fcb10e05c0df4e129f97d7`, destination/Context `85dafc0c414c699231ac0a6c6cd47878`, and `FetchNext` `af635cf97d6d2fe861430321f94ebe9a` are all `ok` |

The delayed `cloudflare-workers` query over `2026-09-05T11:37:00Z`–`11:38:30Z` returned these
nine rows only: two `exception` fetch rows for the held named cache, one direct named-cache
`exception`, and six `ok` RPC/fetch rows for the anonymous control. There were no cancellations.

Workerd's `WorkerLoader::get()` builds `makeReentryCallbackWeak` for both named and null calls
([`worker-loader.c++` lines 76–99](https://github.com/cloudflare/workerd/blob/main/src/workerd/api/worker-loader.c%2B%2B#L76-L99)); the
only tested difference is the non-null name passed to `loadIsolate`. `load()` instead materializes
and owns a cloned dynamic source first (lines 102–123). This is evidence that named Loader caching
is sufficient for the fault when the loaded child returns a WebSocket upgrade. The null-name
control does not show ordinary HTTP caching is unsafe, nor prove a precise internal `loadIsolate`
defect; it supports excluding only named cache reuse from this upgrade path.

## HTTP outbound capability lifetime

On 2026-09-05, this probe added an HTTP-only differential: every client request consumes the
complete exact response body, and the dynamic child optionally calls `fetch()` through an injected
static `Outbound` Fetcher. It has no WebSocket, Durable Object, timer, or approval path. The
public assertion loop completed at 11:59:43.220–11:59:50.605 UTC on version
`b44df88c-8a08-4daf-9d0f-88089fb05dbd`.

| Route                                  | Dynamic child                     | Cached Loader entry | Delayed outcome |
| -------------------------------------- | --------------------------------- | ------------------- | --------------- |
| `/http-static`                         | no                                | no                  | `ok`            |
| `/http-loader`                         | finite local body                 | no                  | `ok`            |
| `/http-cached-loader`                  | finite local body                 | named               | `ok`            |
| `/http-outbound-loader`                | finite body via `globalOutbound`  | no                  | `ok`            |
| `/http-outbound-cached`                | finite body via `globalOutbound`  | named               | **`canceled`**  |
| `/http-policy` / `/http-policy-cached` | policy → destination → local body | no / named          | `ok` / `ok`     |

The canceled public trace is `e4f1c0ee10d618867ff04d12e67688f7`; its corresponding `Outbound`
request is `ok` (`90a5939696ceec7bef7e385c326f3fb5`). This is a red-capable reproduction of the
same shape as project-core's `Host.jsrpc` cancellation: it does not depend on a client abort or an
unread body.

Version `7e32a943-c572-4e33-be73-1147b16c9848` then changed only the owner behavior. It compared
the same named outbound worker returned directly against an owner which awaits and consumes that
response before returning a replacement finite response. At 12:01:59.800–12:02:03.639 UTC both
clients received `200 outbound-http`, but telemetry was different:

| Route                        | Public outcome | Trace                              |
| ---------------------------- | -------------- | ---------------------------------- |
| `/http-outbound-cached`      | `canceled`     | `b6671cac715f83404aa95a0eb1f2a234` |
| `/http-outbound-cached-held` | `ok`           | `008b11f1c3ddfaaf628cbb980d6c04e4` |

The held variant is diagnostic, not a runtime remedy: reconstructing a response after `text()`
would destroy project-core's streaming semantics. Workerd converts `globalOutbound` to a
subrequest channel while building a `DynamicWorkerSource` (`worker-loader.c++` lines 185–201).
`load()` materializes and owns that source before registering its clone callback (102–123), while
named `get()` retains a weak caller-context reentry callback (76–99). These probes establish a
lifetime-sensitive named-cache + outbound-capability interaction, but do not by themselves assign
the underlying runtime defect.

Two further controls on version `eea1bfcb-daff-4dd9-b972-6ce063843467` ran at
12:07:41.855–12:07:47.165 UTC. Every public client consumed exact `200 outbound-http` bodies.

| Route                           | Changed variable                                                 | Delayed public outcome | Trace                              |
| ------------------------------- | ---------------------------------------------------------------- | ---------------------- | ---------------------------------- |
| `/http-outbound-cached`         | named cache + static export outbound                             | `canceled`             | `16dace0e22d6b5039862c209c09210f7` |
| `/http-outbound-cached-copy`    | return `new Response(response.body, response)` without buffering | `canceled`             | `17badd4fbd34c47563af83839898cb30` |
| `/http-outbound-anonymous`      | `LOADER.get(null, …)` with same static export outbound           | `ok`                   | `2b85a8925274024facbcf20c2c7c15a1` |
| `/http-outbound-service-cached` | named cache + true static service binding to `Outbound`          | `canceled`             | `71fa4ae6f6cb4d8305299937e9e1f18a` |

The static service binding is declared in this probe's own Wrangler config and targets the same
worker's named `Outbound` entrypoint; Wrangler confirmed it as a Worker binding, not a
`ctx.exports` loopback. Its matching outbound invocation is `ok`
(`9fd9598bcc09fbcbe9a6ed45c20e6c99`). Therefore copying response metadata cannot repair the
outcome, `get(null)` is clean for HTTP as it was for WebSockets, and the problem is not specific to
the lifetime of an export-created Fetcher. The public body and terminal outbound effect complete;
these controls do not establish any subsequent durable-state abandonment.

### RPC target disposal classification

Version `8a3d30f5-ac8e-44cf-a889-f5abe6eb4d7b` compared a dynamic child which obtains a
`RpcTarget` from static `CapabilityHost.get()`, awaits `target.ping()`, and returns a finite
`200 itx-http` response. At 12:11:37.262–12:11:37.514 UTC, both fresh `load()` and named `get()`
public fetches were `ok`, but their otherwise-successful `CapabilityHost.jsrpc` calls were
`canceled`: fresh `a8f0fae596923094ec6094f9fe51464c`, named
`d3323d38375f4829e41499040f317f97`.

Version `728e7b9e-ab5f-4735-a8d2-09128b9fb734` changed only the child to call
`target[Symbol.dispose]()` after the awaited `ping()`. At 12:14:35.175–12:14:39.799 UTC both
public fetches again returned and consumed exact `200 itx-http`; this time their
`CapabilityHost.jsrpc` outcomes were `ok`: fresh `0233452f419c3def30fc236326f4bbaf`, named
`80e6a460616893c8fa79f53739a618c6`. Thus the cancellation group includes an ordinary undisposed
returned-capability lifetime in this exact `get()` shape. It does not establish that every
project-core `Host.jsrpc` cancellation is harmless: call-path equivalence must be checked before
filtering or reclassifying a production signal.

### Returned static Fetcher control

Version `63fc8c03-3607-44e5-be1d-b57e74d8864e` tested a fresh dynamic child that awaits a
specialized static `Fetcher` and returns its finite response without buffering. The Fetcher was
either injected directly or returned by `FetcherHost.get()` over RPC. At
12:29:25.343–12:29:30.994 UTC, direct, returned, and returned-plus-explicit-`Symbol.dispose`
calls each returned and consumed `200 fetcher-http`; their `StaticTarget.fetch` and
`FetcherHost.jsrpc get` events were all `ok`. A returned baseline target trace is
`81b4023bdbc627c61150e290b84049d0`; its `get` trace is
`1437a45fb48199c0ca28e52218ff27bd`.

Version `90bced2b-20ea-4237-9710-5938bc54cfe8` narrowed this to project-core's policy expression:
a fresh dynamic policy executes `return (await env.NEXT.to(target)).fetch(request)`, while the
control uses the same policy with a directly injected specialized destination. At
12:31:09.616–12:31:12.525 UTC both clients consumed exact `200 child-http`; `FetchNext.jsrpc to`,
`ProbeContext.jsrpc fetchPolicyOffset`, and each `Destination.fetch` event were `ok`. The
returned-destination trace is `f6e2771255daf3ac03e644cb5a67fc1e`; direct destination is
`c37d2c41b1232154d7556597dced9aa2`. Thus a returned static Fetcher and an unbuffered finite
response are not sufficient to explain project-core `FetchDestination.fetch` cancellation rows.
Those need matching external-terminal, fault, or outer-response evidence before classification.

### Durable Object terminal-response transit

Version `5d7fd27f-b174-4271-a1ab-985426236bf5` added the missing terminal hop. `Destination.fetch`
first performs its offset RPC, then calls `ProbeContext.fetch`; the Context returns either a finite
local response or forwards unbuffered to the static `Outbound` entrypoint. Each terminal was
called both directly from the static front and through fresh dynamic policy → `NEXT.to()` →
`Destination` → Context. At 12:34:39.901–12:34:40.787 UTC every client fully consumed its exact
body and every event was `ok`:

| Terminal                        | Direct trace                       | Policy → destination → Context trace |
| ------------------------------- | ---------------------------------- | ------------------------------------ |
| local `terminal-local`          | `73b3bd4e2758363d1be94451aa29e58b` | `9b6d93724bb4ddfe4aa9bb7b92185e73`   |
| static outbound `outbound-http` | `cdbff4708de85de2ff453a7ec9ef6997` | `c3d847d366127bbc274c95bd280a23ba`   |

The policy traces include `FetchNext.jsrpc to`, `ProbeContext.jsrpc fetchPolicyOffset`,
`Destination.fetch`, and the Context fetch; the outbound policy trace also contains the terminal
`Outbound.fetch`. No buffering, external network, error response, or persistent side effect is
in this control. Thus finite DO response transit is not sufficient to explain a canceled
`FetchDestination.fetch` record; pending, fault, actual external-response, or outer-response
behavior remains distinct.

### Status and external terminal controls

Version `fb4c3bac-91c5-4cd1-a5f0-6da7ae628974` ran six final requests at
12:38:07.678–12:38:08.606 UTC: each terminal was invoked directly and through fresh dynamic
policy → `NEXT.to()` → `Destination` → Context. Every public response body was fully consumed.

| Terminal                                                  | Direct                             | Policy path                        |
| --------------------------------------------------------- | ---------------------------------- | ---------------------------------- |
| `202 terminal-accepted`                                   | `e35cb2a4a2f8f6b47cc526c1d68aa2f4` | `7f9e041fe50aac0db0ac7fa04caa5427` |
| `409 terminal-conflict`                                   | `407c86872d2955d1511e1a057a58fcc6` | `3363e0a7df4c9995c653b32fe14bf423` |
| `200 Example Domain` from `fetch("https://example.com/")` | `44285858c65e808e50bc7f9faebfe794` | `20937273192d7f750f46806fa826c408` |

All reported events were `ok`, including each policy `FetchNext.to`, Context offset RPC, Context
terminal fetch, and `Destination.fetch`. The external control intentionally forwards its response
body without buffering; it establishes only a successful GET to `example.com`, not an egress
approval policy. Together with the prior finite-terminal controls, this exhausts this probe's
requested differentiators. No more probes should be read as evidence unless separately requested.

### Fresh reentrant policy chain

Version `98893e4b-4372-4ad9-858b-a8e9e0771430` tested the remaining topology
from the core egress fixture: static front → fresh policy 1 → destination 1 →
fresh dynamic app → injected `ReentryHost.fetch` → fresh policy 2 → destination
2 → Context local terminal. The dynamic app awaits global `fetch()` and returns
`new Response(response.body, { status: response.status, headers: response.headers })`
without buffering; the public client fully consumed its response. The terminal
returned `202 terminal-accepted`, so this control does not introduce an
external-network variable.

At 12:41:52.413–12:41:56.529 UTC the reentrant route and the existing
single-policy `202` comparison both returned their exact terminal body. After
the ingestion delay, every event was `ok`:

| Path             | Relevant traces                                                                                                                                                                                                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| single policy    | `FetchNext.to` `a7b3ca99b01b52cfcbfc24e0669f0699`; destination, offset, and Context terminal `1cf440e52ee7c874f2f706459873cf11`                                                                                                                                                                                                                   |
| reentrant policy | outer `to` `559f1556a7c0dfe8cb1c976a806f3fd8`; destination 1 and offset `7389c22525554cfe2849943b713db34b`; `ReentryHost.fetch` `83782a99847ebd57e9d1fe16d6fb8dc3`; inner `to` `86f6f3ee6d04126c38796fd26ebf352e`; destination 2, offset, and Context terminal `319806c224d4001a2c7795f941ca8fc3`; outer front `f160041605d9fc5b484b904743ad0e0d` |

Fresh policy reentry through an injected global fetch capability is therefore
not sufficient by itself to produce a canceled native outcome. This does not
classify the project-core cancellations: its matching red control has another
load-bearing response-carrier or Context-routing difference.

### Interleaved reentry rate

Version `c93d68d3-1215-4e6a-ae44-3e445f5ba208` adds the same static
`ReentryHost` as both `globalOutbound` and `env.ITX` independently for the
loaded app or policies. This is the dual injection made by project-core's
`loadWorker`; neither control reads `ITX`. At 12:55–12:56 UTC, ten requests of
each route were interleaved. Every one returned and fully consumed exact
`202 terminal-accepted`; all 30 terminal `ProbeContext.fetch` records were
`ok`. Native response-carrier outcomes were nevertheless intermittent:

| Route                      | Front / ReentryHost  | Destination rows      |
| -------------------------- | -------------------- | --------------------- |
| baseline reentry           | 4 `ok`, 6 `canceled` | 8 `ok`, 12 `canceled` |
| app dual Host injection    | 3 `ok`, 7 `canceled` | 6 `ok`, 14 `canceled` |
| policy dual Host injection | 2 `ok`, 8 `canceled` | 4 `ok`, 16 `canceled` |

Each request has two `Destination.fetch` rows, so its counts are double the
front count. This short run establishes an intermittent minimal repro for the
response-carrier outcome, not a causal difference between binding shapes: all
three routes cancel sometimes, and the sample is too small to compare rates.

### Response-owned pipe-through control

Version `0b7bdcbd-105d-4857-bb41-8bc3fc0c000a` adds a separate static
Destination route which awaits the fresh app response and, only when it has a
body, returns:

```ts
new Response(response.body.pipeThrough(new TransformStream()), response);
```

It does not use `waitUntil`, buffering, a catch, or a replacement proxy. A
bodyless `101` response is returned unchanged. The public `pump` script ran at
13:02–13:04 UTC: ten finite reentrant `202` responses, a fully consumed
two-chunk slow response, a second slow response whose reader paused for 750 ms
after its first chunk, a client abort immediately after the first chunk, and a
WebSocket echo followed by client close code `1000`.

The ten finite responses were all `ok` (front 10, `ReentryHost` 10,
Destination 20, terminal Context 10). Both fully consumed slow responses and
the socket route were also `ok`. The deliberate abort instead produced exactly
one canceled carrier chain—front 1, `ReentryHost` 1, Destination 2, terminal
Context 1—with no exception outcome. This is an intentional transport abort,
not a swallowed background rejection. The delayed-reader case establishes that
the transformed stream still completes after a slow consumer; it is not a
throughput or memory-bound measurement.

### Fixed-length gzip response

Version `3983143c-e1de-466a-bd6b-7c50b52e984d` makes the terminal's 37-byte
pre-compressed `terminal-accepted` fixture explicit with `encodeBody: "manual"`,
`content-encoding: gzip`, and `content-length: 37`. The `pump` script then made
both an untransformed reentrant route and the pipe-through route with raw Node
HTTPS requests at 13:10 UTC. With `accept-encoding: identity`, both routes
returned the decoded 17-byte text and no encoding or length header. With
`accept-encoding: gzip`, both returned a valid 37-byte gzip member that decoded
to the same text. The untransformed route retained `content-length: 37` and the
fixture's exact bytes; the pipe-through route retained gzip semantics and the
37-byte body but had no `content-length` header.

That header difference is the expected consequence of making the body a new
stream: a transformed stream has no statically known length. The test treats it
as a wire-framing difference, not as response corruption or a license to
invent a length. `pump` completed successfully after asserting all of those
conditions, the slow-consumer and abort cases, and the bodyless WebSocket path.

### Plain-data nested RPC settlement control

Version `ff7855ef-f8e5-402b-9f75-e0c9a91cedaf` isolates a separate native-RPC
lifetime issue. It is diagnostic-only and is not a project-core implementation.
`BuildValue` is exactly `{ marker: "plain-build-data", value: 1 }`: it has no
capability, stream, `Response`, or other owner-sensitive value. A loaded child
receives a native `BuildScope`, or the matching Cap'n Web `Scope.build.build()`
facet, and gets that data through `ProbeContext`; the service route adds a
second native RPC to static `BuildService.build()`.

The three arms differ only in what happens to the first settled native RPC
promise: return it directly, `await` it, or dispose it in `finally` after the
await. Disposal is deliberately tested only for this cloneable data result.
It is not evidence that disposing a promise returning a capability or stream is
safe.

| Public shape                              | Source                                                 |      Direct |     `await` | settled plain-data dispose |
| ----------------------------------------- | ------------------------------------------------------ | ----------: | ----------: | -------------------------: |
| native loaded child → `BuildScope`        | `ProbeContext.buildService()` → `BuildService.build()` | 20 canceled | 20 canceled |                      20 ok |
| Cap'n Web WebSocket `Scope.build.build()` | `ProbeContext.build()`                                 |        5 ok |        5 ok |                       5 ok |
| Cap'n Web WebSocket `Scope.build.build()` | `ProbeContext.buildService()` → `BuildService.build()` |  5 canceled |  5 canceled |                       5 ok |

The native run was at 13:36:26.163–13:36:29.296 UTC. All 60 public HTTP
responses were fully consumed and exactly matched `BuildValue`; all 60
`BuildService.build` rows were `ok`. The Cap'n Web run was at
13:40:55.3–13:41:01.3 UTC, using `PROBE_COUNT=5 pnpm build-rpc`; every one of
its 30 WebSocket RPC calls returned the exact value and each client session was
disposed. Its 30 `/capn-build` fetch rows were `ok`, while the service arm's
`ProbeContext.buildService` rows were, in order: direct canceled at
13:40:58.969–59.731, awaited canceled at 13:40:59.901–13:41:00.620, and
disposed ok at 13:41:00.865–13:41:01.707. Its 15 `BuildService.build` rows
were all `ok`.

Both results used a delayed `POST` to
`/accounts/376ef7ed81b0573f93524de763666c15/workers/observability/telemetry/query`,
dataset `cloudflare-workers`, service filter
`iterate-project-core-ws-probe-b6f58624`, `view: "events"`, and `limit: 1000`.
The retained query IDs and windows are `build-rpc-nested-capnweb`
(`13:36:20Z`–`13:36:35Z`) and `capn-build-discrete-arms`
(`13:40:45Z`–`13:41:15Z`). `BuildHost.get` itself can be canceled when its
returned native target is released; that distinct target-lifetime row is not
used to classify the plain-data result rows above.
