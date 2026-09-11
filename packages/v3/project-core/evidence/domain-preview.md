# Isolated domain preview — 5 September 2026

This is a separate production-account proof, not an update to the earlier
dev/preview experiment. Account: `04b3b57291ef2626c6a8daa9d47065a7`.

## Resources and deployment

The resource creation below is historical. Current core version is
`f0032a5a-cc05-4ee7-8016-c40452062dfb`; DNS, bindings, secrets and bundler are
unchanged. Its latest public run is **44/44**, no failed/canceled/skipped tests
or retries, 38,183.850083 ms at 13:40:52.220–13:41:30.705 UTC. The
13:40:50–13:41:34 telemetry window returned 1,871 rows on this version:

- 1,555 native `ok` outcomes, including all six `Context.build` calls.
- 164 canceled `Host.get` RPCs, the previously controlled returned-target
  teardown shape (not Host HTTP).
- 131 explicit stream disconnections: Context fetch 66, outer fetch 64,
  FetchDestination fetch 1.
- Three canceled fetches: Host 2 and FetchDestination 1, matching the explicit
  socket close and bypass fixture's abandoned response bodies.
- **Zero canceled Context build calls** after explicit scoped disposal of
  their settled, data-only RPC promises. The two await controls had failed;
  see [build-rpc-lifetime.md](build-rpc-lifetime.md).
- Eighteen console rows without a native outcome: three deliberate
  `Hello.boom` Context errors and fifteen processor-retry warnings. The three
  corresponding outer HTTP 500 invocations are also error-level, with native
  `ok` outcomes, and are already included above.

There are no additional native outcome classes: no exception, timeout,
CPU-limit or hung outcome, and no unexplained group in this bounded run.
The separate bundler service has six `ok` build RPCs and two library warnings
announcing that `createWorker` is experimental; it has no error logs or non-OK
outcomes. Its version remains `a3ac60c1-7243-474a-b61f-c2a0bf1a8da7`.
This is PoC acceptance, not a claim of production authentication or availability.
Example deliberate failure pair from the preceding 018 run:
[`8559b0c3cb0c23ff649e6a971592c33f`](https://dash.cloudflare.com/04b3b57291ef2626c6a8daa9d47065a7/observability/traces/8559b0c3cb0c23ff649e6a971592c33f).
The response forwarding fix and its exact red/green controls are in
[fetch-lifetime.md](fetch-lifetime.md).

### Original resource creation

- Core Worker: `iterate-project-core-domain-poc`, version
  `7c9f1dd2-5d74-4a45-b3ab-b3577aab3055`; deployed 12:02:20.055–12:02:43.343
  UTC, 33 ms startup, 893.07 KiB upload / 157.56 KiB gzip.
- Bundler Worker: `iterate-project-core-domain-bundler-poc`, version
  `a3ac60c1-7243-474a-b61f-c2a0bf1a8da7`; deployed 12:01:43.239–12:02:20.055
  UTC, 48 ms startup, 15,048.08 KiB / 3,912.38 KiB gzip.
- Wrangler created four routes. DNS propagation was separately checked through
  `1.1.1.1`; this document records only observed public requests, not an
  assertion about a resolver's general cache behaviour.

The read-only settings audit found only typed secret bindings `EGRESS_KEY` and
`EXPERIMENT_ADMIN_TOKEN` on core; no values were read. Core's `CONTEXT` is
independent namespace `4f0548b1bca44ffd8917610cbd5ec319` (not the old preview
namespace). `OAUTH_KV` is `c3c1fc8d184c4aff8c3c990c7c71c122`; `BUNDLER` is a
production service binding to the named bundler. The bundler has independent
build-cache KV `9c24bcdfb1404bdd845ee8a617aa137e` and `VERSION` only.

## Public hostname red result

The first public hostname run was approximately 12:10:58–12:11:04 UTC. Five
platform-host cases and the custom apex passed. The next case,
`https://anything.iterate.computer/notes?q=1`, returned Cloudflare 1101 / HTTP
500 at 12:11:03 UTC. Its fixture was intentionally simple: the installed fetch
policy called `env.ITX.get()`, then `scope.inspect()`, then returned JSON for
context, URL and app hint.

The exact Worker event is at 12:11:03.364 UTC, Ray
`a3652261de0b94a3`, request `0dbdeec420737889e061aab1a502303b`, outcome
`exception`, status 500, 18 ms wall / 2 ms CPU, on the stated core version.
Its trace is [a9189f2a199c4168713a325e62604529](https://dash.cloudflare.com/04b3b57291ef2626c6a8daa9d47065a7/observability/traces/a9189f2a199c4168713a325e62604529).
The exact exception is:

```text
Unable to deserialize cloned data due to invalid or unsupported version.
    at async routeFetch (worker.js:19450:12)
```

The correlated `Context.jsrpc` completed `ok` at 12:11:03.359 UTC. No failing
`Host.jsrpc`, reset, deployment/code-update, or native lifetime exception was
recorded in that chain. This establishes a deserialize failure after the
observed Context RPC and before an observed Host RPC; it does **not** establish
a native-lifetime cause.

The request deliberately supplied forged `x-core-terminal`, `x-itx-project-id`
and `x-iterate-app` headers. They reached request telemetry as hostile input;
the normal routing path strips and derives those headers. This run therefore
also does not prove that a forged header selected authority.

A second unchanged run on the preceding version also failed at 12:18:55 UTC:
the custom apex returned Cloudflare 1101 / HTTP 500, Ray
`a3652de5aa5ad88b`. It is retained as a separate red observation; it was not
treated as a retry or silently folded into the later green candidate.

## Fresh HTTP loader candidate

Version **`c92cb530-0b2c-497d-b7b9-1c6eb89c62c0`** changed only the two HTTP
`loadSource()` call sites (`routeFetch()` and `FetchDestination`) from named
cache reuse to private `cache: false` loading for every request. The prior
version used fresh loading only for WebSocket upgrades. Bindings, routes and
all other runtime code stayed unchanged. Deployment began at 12:19:48 UTC and
completed before 12:20:35 UTC; startup was 29 ms, upload 892.91 KiB / 157.54
KiB gzip.

The focused full-hostname public case passed **1/1** from
**12:20:35.420–12:20:38.512 UTC**, in **2,524.312292 ms** (**2,816.804084 ms**
test-process total). It includes the formerly failing
`anything.iterate.computer` request, now HTTP 200: 29 ms wall / 4 ms CPU,
trace `291de5d74f739bb4b9636f38085d9647`. This is a controlled red→green
result for fresh HTTP loading, not a general explanation of the native
serialization mechanism.

The read-only `cloudflare-workers` query scoped to this version and exact
window returned 44 rows: zero exceptions, resets or hung/never-response rows.
The nine successful policy HTTP requests had 24–46 ms wall time and 1–7 ms CPU;
their preceding `Context.jsrpc` operations were `ok` (4–12 ms wall, 0–1 ms
CPU). Each of those requests again has a separate `Host.jsrpc` outcome
`canceled` (nine rows, 11–18 ms wall, 1–4 ms CPU). Those cancellations persist
after the behavior fix, so they are not reclassified as harmless merely from
this result. Two intentional unknown-host requests returned 421 with zero wall
and CPU time.

## Host capability cancellation observation

`Host.get()` returns a fresh scoped `Scope` RpcTarget, while `Host.fetch()`
routes a request back through `routeFetch()` ([worker.ts](../src/worker.ts#L236)).
The runtime injects that Host as `ITX` and `globalOutbound` into every loaded
worker ([runtime.ts](../src/runtime.ts#L52)). Successful hostname cases in this
same short run showed outer HTTP 200, `Context.jsrpc` `ok`, then a separate
`Host.jsrpc` invocation with native outcome `canceled`. That shape is
consistent with teardown after a returned RpcTarget is no longer retained by
the request, and with the ordinary capability/session lifecycle; it is not a
proof of why the native runtime labels it canceled.

Do not generalize this observation: the red request had no observed
`Host.jsrpc`, and prior probes (`c3a1f50b`) found direct named `.get()` and a
held stub red while `.get(null)` was clean. The project therefore keeps native
cancellations unclassified until a bounded trace/reproduction identifies their
initiator and lifecycle contract.

## Full deployed suite: behavior green, telemetry classification incomplete

The same version completed the public **43/43** suite with no failures,
cancellations, skips or retries in **50,948.657125 ms**, from
**12:21:14.546–12:22:05.779 UTC**. A read-only query of the enclosing
12:21:10–12:22:10 UTC interval found no Worker `exception`, reset, or
hung/never-response outcome. Successful rows were: Context alarms 45,
Context hibernatable-WebSocket events 209, Context RPC 634, FetchDestination
fetches 29, Host fetches 15, and FetchNext RPC 51.

Outcome fields are not a substitute for log severity. The same interval has
three `error` logs, each `context request failed` from the fixture's deliberate
`Hello.boom` call and paired with its expected outer HTTP 500 response. It also
has 15 `warn` `processor delivery failed` logs from the deliberate processor
retry/delivery fixture. They are intentional test observations, separately
classified here rather than hidden by the outcome query.

The non-`ok` rows have three distinct explanations/statuses:

- **163 `Host.jsrpc` `get` cancellations** match the returned-RpcTarget call
  shape. A separate controlled probe (version
  `728e7b9e-ab5f-4735-a8d2-09128b9fb734`, traces
  `0233452f419c3def30fc236326f4bbaf` and
  `80e6a460616893c8fa79f53739a618c6`) called `get()`, awaited a finite target
  method, and returned HTTP 200. Omitting `Symbol.dispose()` recorded the same
  `*.jsrpc get` outcome as `canceled`; adding that explicit target disposal,
  with no other behavioral change, recorded `ok`. The c92 rows are therefore
  classified as un-disposed returned-target teardown, not failed application
  requests. This proof is deliberately limited to that event shape.
- **131 `responseStreamDisconnected` rows** are intentional stream/socket
  terminations: the 63 stalled readers each produce a default outer and
  Context row (126); the one-fetch relay socket produces a default outer and
  FetchDestination row (2); and the remaining three Context rows are the
  lending subscription-disposal paths. These are client/server stream closure
  outcomes, not error rows.
- **49 cancellation rows remain unexplained:** 10 default-entrypoint fetches,
  21 FetchDestination fetches, 12 Host fetches, and six `Context.jsrpc`
  `build` calls. The disposal control does not exercise these shapes.
  A second controlled probe (version `90bced2`) makes a fresh dynamic policy
  return `await env.NEXT.to(target).fetch(request)` and compares it with a
  direct specialized destination; all finite-200 public, policy RPC and
  Destination fetch rows are `ok` (traces
  `f6e2771255daf3ac03e644cb5a67fc1e` and
  `c37d2c41b1232154d7556597dced9aa2`). Returned-Fetcher lifetime is therefore
  not a sufficient explanation. Their public test requests completed
  successfully, but that is insufficient to normalize the native outcomes.
  This checkpoint is behavior-green, not telemetry-clean, until a bounded
  call-chain probe classifies those 49 rows.

These counts apply only to this exact service, version and interval; they do
not reclassify cancellations in earlier versions or other Workers.

### Subsequent topology reproduction is red

A later c92 public comparison holds the installed source, policy offset and
terminal outcome constant: direct `NEXT.to(network)` returns the expected 202
`APPROVAL_REQUIRED`, while nested `NEXT.to(worker)` has the child call global
`fetch(example.com)` and return a new Response around the same 202 body. The
direct chain is all `ok`. In the nested chain the policy/control RPCs and
Context terminal fetch are `ok`, but all four response carriers are
`canceled`: the default outer fetch, internal-worker FetchDestination, Host
fetch, and terminal FetchDestination. No network effect is dispatched. The
matching isolated topology probe is green, so returned-Fetcher teardown alone
is not an explanation. See the root-owned
[fetch-lifetime evidence](fetch-lifetime.md) for the exact rays and control.

## Query evidence

The red result came from a read-only `cloudflare-workers` query scoped to the
account, core service, core version and 12:10:58–12:11:05 UTC. A Ray-id needle
then correlated the exact event. The `otel` query for this trace returned no
rows, so absence of an OTel span is not treated as absence of the Worker event.
No rerun, deployment, DNS, route or runtime change was made for this audit.
