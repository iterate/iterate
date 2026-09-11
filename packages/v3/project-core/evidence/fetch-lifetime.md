# Native fetch lifetime comparison — 5 September 2026

This records a public-seam diagnosis of native fetch cancellation rows, not a
new core API. The initial controls used unchanged core version
`c92cb530-0b2c-497d-b7b9-1c6eb89c62c0`; the deployed comparison below changes
only streaming ownership at the internal worker destination.

One synthetic context installs one policy. Both requests return the complete
`202 APPROVAL_REQUIRED` JSON; no external network effect is released.

```text
/direct -> policy -> NEXT network -> Context terminal
/nested -> policy -> NEXT worker -> app global fetch -> Host
        -> same policy -> NEXT network -> Context terminal
```

The first comparison ran at 12:41:40.213–12:41:40.495 UTC against project
`fetch-lifetime-mtodgosp-7dfc5d591682`:

| Path      | Client result     | Client wall | Ray                    |
| --------- | ----------------- | ----------: | ---------------------- |
| `/direct` | Complete 202 JSON |  110.513 ms | `a3654f3abb530035-LHR` |
| `/nested` | Complete 202 JSON |  169.421 ms | `a3654f3b4ee57a3e-LHR` |

The matching native invocation audit found:

| Carrier                          | Direct      | Nested             |
| -------------------------------- | ----------- | ------------------ |
| Outer default fetch              | `ok`, 55 ms | `canceled`, 127 ms |
| Internal-worker FetchDestination | —           | `canceled`, 98 ms  |
| App globalOutbound / Host.fetch  | —           | `canceled`, 68 ms  |
| Network FetchDestination         | `ok`, 25 ms | `canceled`, 30 ms  |
| Context terminal fetch           | `ok`, 11 ms | `ok`, 14 ms        |

Policy descriptor/offset RPCs and `FetchNext.to()` were `ok` in both paths.
The nested path therefore has **four** canceled response carriers, including
the default entrypoint, despite its fully consumed response. This is the
red-capable comparison; HTTP success alone would miss it.

## Reproduce through the actual public API

Run from `packages/v3/project-core` with `WORKER_BASE_URL=https://iterate2.com`.
The support module performs the ordinary demo login. Every run creates its
own context; it does not change another project's policy.

```js
import assert from "node:assert/strict";
import { call, browserHeaders, project, setting } from "./e2e/support.ts";

const id = project("fetch-lifetime");
const app = `export default { async fetch() {
  const response = await fetch("https://example.com/");
  return new Response(response.body, {
    status: response.status, headers: response.headers,
  });
} }`;
const policy = `export default { async fetch(request, env) {
  const url = new URL(request.url);
  const nested = url.hostname === ${JSON.stringify(id + ".iterate")} && url.pathname === "/nested";
  const target = await env.NEXT.to(nested
    ? { kind: "worker", source: { modules: { "main.js": ${JSON.stringify(app)} } } }
    : { kind: "network", approval: { approval: "required", expiresInMs: 60000 } });
  return target.fetch(nested ? request : new Request("https://example.com/"));
} }`;
await call(
  id,
  ["append"],
  [
    setting("policy", "mount/fetch", {
      kind: "worker",
      source: { modules: { "main.js": policy } },
    }),
  ],
);
console.log({ start: new Date().toISOString(), project: id });
for (const path of ["direct", "nested"]) {
  const response = await fetch(`https://iterate2.com/p/${id}/${path}`, {
    headers: browserHeaders,
    signal: AbortSignal.timeout(30000),
  });
  const body = await response.json();
  assert.equal(response.status, 202);
  assert.equal(body.code, "APPROVAL_REQUIRED");
  console.log({ path, ray: response.headers.get("cf-ray"), utc: new Date().toISOString() });
}
```

Earlier isolated controls are preserved in
[`project-core-ws-probe/README.md`](../../project-core-ws-probe/README.md).
Returned specialized Fetchers, a single fresh policy, finite DO response
transit, 202/409 responses and a real external GET were individually clean.
The subsequent two-policy probe, version
`98893e4b-4372-4ad9-858b-a8e9e0771430`, also returned complete 202 bodies with
all native events `ok` at 12:41:52.413–12:41:56.529 UTC. Re-entry alone is
therefore insufficient. The probe still differs in injected bindings,
descriptor reads and the terminal's request handling/durable audit work.
No exact native runtime cause or blanket benign classification is established.

## Narrow the actual-core comparison

The executable [`e2e/fetch-lifetime.ts`](../e2e/fetch-lifetime.ts) compares a
policy-local finite 202 with the real Context approval 202, through both
direct and nested routes. Nested cases separately pass the native Response
through or wrap its body without buffering:

```sh
WORKER_BASE_URL=https://iterate2.com node e2e/fetch-lifetime.ts
```

The six requests at 12:51:02.698–12:51:04.356 UTC all returned complete 202
JSON, and every native carrier/control RPC was `ok`. Their project was
`fetch-lifetime-mtodspls-bfefb35f582d`; no core code changed, and no external
request was released. This did not establish that any changed fixture detail
fixed the failure: the original unmodified fixture was then repeated.

### The same fixture is intermittently red

At 12:54:29.567–12:54:33.749 UTC, the original project/policy was called five
times per path, interleaved. All five direct calls were `ok`. Nested calls
were `ok`, `ok`, `canceled`, `canceled`, `ok`; each canceled call again had
four canceled response carriers, an `ok` Context terminal and a fully consumed
202 response. All 45 control RPCs were `ok`.

The two canceled outer rays were `a36562152a95ccc0-LHR` and
`a3656218ac13ccc0-LHR`, with traces
[`e339145c4cd70b1fbc2e6c23daf5b5c6`](https://dash.cloudflare.com/04b3b57291ef2626c6a8daa9d47065a7/observability/traces/e339145c4cd70b1fbc2e6c23daf5b5c6)
and
[`66dd3623fd2f7743fa20c9e497599968`](https://dash.cloudflare.com/04b3b57291ef2626c6a8daa9d47065a7/observability/traces/66dd3623fd2f7743fa20c9e497599968).
This is a nondeterministic response-forwarding lifetime failure, not a
persistent wrong-response bug. Single green probe calls cannot eliminate a
candidate cause. The isolated probe also became intermittently red when
repeated: baseline 6/10, dual app Host binding 7/10, dual policy Host binding
8/10 canceled; that small sample does not establish a binding effect.

### Retain streaming ownership, not the whole body

```sh
WORKER_BASE_URL=https://iterate2.com node e2e/fetch-lifetime.ts --forwarding
```

This runs ten interleaved requests per forwarding variant. It asserts full
client bodies, prints rays, and deliberately does **not** infer native success
from HTTP status. The 50-call run at 13:00:45.269–13:00:55.748 UTC used project
`fetch-lifetime-mtoe579x-c15ab3fece92` and unchanged core version c92.

| App forwarding                          | Canceled calls / 10 | Context terminal |
| --------------------------------------- | ------------------: | ---------------- |
| Return native Response                  |                   6 | 10 `ok`          |
| Wrap the same body in a Response        |                   4 | 10 `ok`          |
| `pipeTo()` retained by `waitUntil()`    |                   0 | 10 `ok`          |
| `pipeThrough(new TransformStream())`    |                   0 | 10 `ok`          |
| Read full `arrayBuffer()`, then respond |                   0 | 10 `ok`          |

Each canceled call had all four response carriers canceled. All 300 policy
control RPCs were `ok`, with no errors. The earlier 40-call run at
12:57:13.878–12:57:21.958 UTC gave raw 5/10, wrapper 3/10, retained pipe 0/10
and buffering 0/10. These are diagnostic counts, not estimated failure rates.

Public `readEvents()` checks at 13:02:16 UTC found exactly 40 and 50
`itx.system.egress.requested` records in the respective projects, one policy
installation each, and **zero** `itx.system.egress.released` records.

The candidate internal change is therefore the smallest streaming variant:

```js
const response = await child.fetch(request);
return response.body
  ? new Response(response.body.pipeThrough(new TransformStream()), response)
  : response; // preserve WebSockets and bodyless responses
```

Full buffering is a diagnostic control, not an implementation fallback.
`waitUntil()` is also unnecessary here: [Cloudflare's streaming guidance](https://developers.cloudflare.com/workers/runtime-apis/streams/)
keeps response streaming active while the response is being delivered. The
transform adds a streaming/backpressure hop and can change HTTP framing; it
must pass slow-reader, cancellation, fixed-length, compression and WebSocket
checks before acceptance. It does not explain or classify all old native
cancellations, including the separate build RPC rows.

### Source-backed scope of the explanation

At workerd revision `c4e03fa1d2a3f2607e2b79567076d5fdd5179d03`,
[`Response::send()`](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/api/http.c%2B%2B#L1235)
owns the response-body writer through a cancellable pump. The
[`WorkerEntrypoint` request lifecycle](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/io/worker-entrypoint.c%2B%2B#L515)
can release the JS I/O context before finishing deferred proxy work.
`pipeThrough()` starts a pipe whose rejection is handled by the Streams
machinery; stream errors still reach its readable response side. This supports
the ownership boundary tested above. The production HTTP `canceled` classifier
is not exposed by that source, so the exact native classification cause
remains unproven.

### Replay the native audit

Use the production account `04b3b57291ef2626c6a8daa9d47065a7` and the
Cloudflare Observability API. Do not filter out missing/default entrypoints:

```js
const response = await cloudflare.request({
  method: "POST",
  path: `/accounts/${accountId}/workers/observability/telemetry/query`,
  body: {
    queryId: "c92-forwarding-through-50",
    view: "events",
    limit: 1000,
    timeframe: {
      from: Date.parse("2026-09-05T13:00:43.269Z"),
      to: Date.parse("2026-09-05T13:00:57.748Z"),
    },
    parameters: {
      datasets: ["cloudflare-workers"],
      filters: [
        {
          key: "$metadata.service",
          operation: "eq",
          type: "string",
          value: "iterate-project-core-domain-poc",
        },
      ],
    },
  },
});
const rows = response.result.events.events.map((event) => {
  const worker = event.$workers || {};
  const request = worker.event?.request;
  return {
    entrypoint: worker.entrypoint || "default",
    type: worker.eventType,
    outcome: worker.outcome,
    url: request?.url,
    status: worker.event?.response?.status,
    rpc: worker.event?.rpcMethods,
  };
});
```

Group fetch rows by URL query, target hostname and entrypoint, then separately
group control RPCs by entrypoint/method/outcome. The exact service/time window
contains the controlled run; a project-only text filter would omit terminal
and control hops and cannot establish the complete result.

## Deployed destination-owned stream

Version `a5f2d85e-e134-4a19-8a90-8bdf628e4edd` applies the five-net-line
`pipeThrough` change in `FetchDestination.fetch()` only. The outer policy,
ordinary application code, Context terminal, caches and public API are unchanged.
WebSocket/bodyless responses bypass the transform. The isolated native probe
also preserves valid gzip and its decoded body; transformed length is unknown,
so an original `Content-Length` need not survive. It does not buffer whole bodies.

At **13:17:22.136–13:17:32.482 UTC**, the original, unchanged project
`fetch-lifetime-mtodgosp-7dfc5d591682` completed ten interleaved direct/nested
pairs, all with full 202 approval-required bodies. The native query for
13:17:20–13:17:35 (also widened to 13:17:00–13:17:55) returned **165 rows,
all `ok`**, including all ten nested outer requests, ten internal-worker
destinations, ten Host fetches and twenty Context terminals. No warning or
error log rows were returned. Representative nested trace:
[`0512ac6221cacabd06c4ac0a774c706b`](https://dash.cloudflare.com/04b3b57291ef2626c6a8daa9d47065a7/observability/traces/0512ac6221cacabd06c4ac0a774c706b).

That query is not a complete invocation count: it includes one login and lacks
one direct outer, two network destinations and three `FetchNext.to` rows
relative to the expected topology. Retrieval reports sample interval 1 and no
truncated rows; those facts do not fill the missing observations. The claim is
zero failures **among observed rows**, not complete telemetry delivery.

The full public run at **13:18:05.690–13:19:23.430 UTC** passed all 43 existing
tests; a newly added streaming test had a separate fixture error (object-style
`this.env`) and failed, so this was **43/44**, not a green full suite. In its
13:18:03–13:19:26 telemetry window, the old broad nested-carrier cancellation
cluster is absent. Remaining non-OK groups are 163 returned-target `Host.get`
teardowns, 131 explicit stream/socket disconnections, three fetch cancellations
(one explicit socket close and two bodies abandoned by the bypass fixture),
and six still-unexplained `Context.build` cancellations. The three deliberate
`Hello.boom` failures produce six error-level rows (outer 500 plus Context log);
15 processor-retry warnings belong to the intentional retry tests. The new
stream fixture does not explain those existing `/api` failure logs.

The retained public streaming guard installs a fetch policy and application,
reads the first literal chunk, then appends a release event before reading the
tail. It exercises this destination boundary, not `Scope.load().fetch()`.
It passes in the final **44/44** local run (34,341.280084 ms) and **44/44** public
run (38,183.850083 ms, 13:40:52.220–13:41:30.705 UTC) on core `f0032a5a`.
There are no failed, canceled or skipped tests. The separate
[build RPC investigation](build-rpc-lifetime.md) now has a matching reproduction
and a data-only scoped-disposal fix: all six build invocations finish `ok`.

The guard requests `Accept-Encoding: identity`. With the default request
encoding, local Wrangler delivered headers but withheld the five-byte first
chunk until the producer's five-second timeout; the same request passed on
the deployed edge. Changing only that request header passes locally too.
This identifies a local HTTP compression/proxy difference, not stale code or
a core buffering fallback. It does not assert low-latency compressed local
streaming. The probe's gzip body-integrity evidence is separate.

To verify that the test detects buffering at the intended seam, the root agent
temporarily replaced only `FetchDestination`'s transform with
`await response.arrayBuffer()` on the local server. The test failed with
`first response did not arrive before release` in 5,014.849042 ms. Restoring
the stream immediately passed in 45.269834 ms. The buffering control was
never deployed. The test uses rendezvous, not a latency performance threshold.
