# One fetch policy — 5 September 2026

This checkpoint replaces the two old `mount/app` and `egress` settings with
one executable `mount/fetch` policy. Those old settings now fail with
`FETCH_POLICY`; they are not silently migrated. A context without a policy
returns `404 FETCH_POLICY_UNCONFIGURED`.

## Interface exercised

```ts
// Source installed at mount/fetch. Both inbound and worker-originated requests
// enter this same function. `docsSource` is an ordinary Source descriptor.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname === "demo.iterate") {
      const docs = await env.NEXT.to({ kind: "worker", source: docsSource });
      return docs.fetch(request); // also preserves native WebSocket upgrades
    }
    if (url.origin === "https://api.github.com") {
      const network = await env.NEXT.to({
        kind: "network",
        approval: { approval: "required", expiresInMs: 60_000 },
      });
      return network.fetch(request);
    }
    return new Response("Denied", { status: 403 });
  },
};
```

The policy is privileged executable configuration. It alone receives `NEXT`
automatically; it may explicitly delegate capabilities. An ordinary app gets
contextual `ITX`, and its global `fetch()` re-enters the same policy. There is
no second app-route table or origin allowlist hidden in the terminal. Secret
values retain their independent exact-origin restriction.

`NEXT.to()` returns a specialized static loopback Fetcher. Its implementation
loads an internal dynamic worker locally; it never transfers that worker's
dynamic entrypoint. This is important for WebSockets: an ordinary RPC method
cannot serialize a WebSocket-bearing Response. See the checked
[workerd dynamic-entrypoint restriction](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/server/server.c%2B%2B#L5392-L5399)
and [Response serialization](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/api/http.c%2B%2B#L1351-L1378).

## Public red → green results

All observations below use HTTP/Cap'n Web/WebSocket, not private storage or
mocked loader calls. Local target: `http://localhost:8799`.

| Case                                                                           | Red                                                  | Green                                                                                |
| ------------------------------------------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------ |
| One policy selects internal/external destinations and carries a WebSocket echo | `INTERNAL` instead of `docs:one:undefined`           | Internal response, external approval, explicit denial, and `docs:collaboration` echo |
| Exact approval cannot authorize an identical request after policy replacement  | External `200` instead of `409`                      | `APPROVAL_MISMATCH`; no release event; new request has a new fingerprint             |
| Replacement while an outbound body is still arriving                           | `202 APPROVAL_REQUIRED` instead of `409` (27.038 ms) | `FETCH_POLICY_CHANGED`, no egress event (33.724 ms)                                  |

The streaming regression first had a fixture error (`ITX.append` instead of
`ITX.get().append`) and timed out; that run is not the product red result.
After correcting the fixture, the old implementation produced the explicit
202-versus-409 failure above. The original test held an HTTP upload open from
Node. On preview that upload reset without reaching the policy. The retained
fixture instead generates the controlled outbound stream inside the policy
worker: it observes the replacement through the public Scope and only then
closes the body. The test installs code and changes policy through public HTTP;
it does not access private storage or add a test hook to the kernel.

The revised fixture passed locally (41.413 ms). Temporarily removing only the
post-preparation freshness assertion made it fail with `202` instead of `409`
(42.513 ms); the assertion was immediately restored and never deployed disabled.
The same test passed on the existing preview in 1,006.289 ms (1,602.648 ms total).
This does not claim support for the original incomplete public upload path.

The terminal now prepares the body/hash/injected headers inside the trusted
injector, then checks the current policy. The check, atomic one-shot claim,
and native `fetch()` invocation have no intervening `await`. Durable Object
[output gates](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#supported-options-1)
hold the outgoing request until preceding writes persist. Audit publication
and processor notification are joined with the effect using `Promise.all`;
notification failure is not swallowed.

`itx.system.egress.released` means a durable one-shot dispatch attempt, not
remote receipt or successful completion. A failed network attempt remains
consumed. Policy replacement does not retract already-dispatched requests or
close existing WebSockets. The final freshness check is specifically in the
network terminal; internal loading is checked at continuation entry, not
proven revocable during asynchronous source loading.

## Current domain deployment — request-scoped HTTP workers

Current core `f0032a5a` passes 44/44 deployed public tests, including the new
policy-selected streaming rendezvous. Worker destinations forward non-null
bodies through `pipeThrough(new TransformStream())`; upgrades/bodyless responses
stay native. [fetch-lifetime.md](fetch-lifetime.md) records the repeated native
cancellation comparison and the local buffering mutation that the guard rejects.
The separate [build RPC cancellation](build-rpc-lifetime.md) is fixed by scoped
disposal of the data-only result pipeline, with all six native build calls `ok`.
The c92 measurements below are the earlier fresh-loading checkpoint.

The separate domain stack at `https://iterate2.com` now uses fresh loading
for **all HTTP** at both policy and destination boundaries:

```ts
const worker = await loadSource(target.source, {
  ...sharedLoadOptions,
  cache: false,
});
return worker.getEntrypoint(target.exportName).fetch(request);
```

This preserves native response streams and WebSockets without buffering or
retrying. Mounted RPC/processor workers still use the named cache, and inert
build output retains its independent KV cache. It is a deliberate runtime
reuse tradeoff, not another fetch policy or a new public API.

Version `c92cb530-0b2c-497d-b7b9-1c6eb89c62c0` passed **43/43** public tests,
including hostname ingress, at 12:21:14.546–12:22:05.779 UTC in
50,948.657125 ms, without retries or skips. The earlier named-HTTP version
failed twice when the test moved from platform hosts to the custom zone, with
a native clone-deserialization exception. The controlled fresh-loading
comparison passed; it does not establish V8's internal cause. See
[domain-preview.md](domain-preview.md) for the exact failures, comparison,
and operational telemetry acceptance.

## Earlier dev-account candidate — public tests pass, telemetry caveat remains

Candidate version `6e72d24a-caad-49a4-aedf-1b187fd639cc` deploys the narrow
native-WebSocket experiment. Its only source-loading change is a private fresh
selection for an upgrade in both `routeFetch()` and `FetchDestination`:

```ts
const options = { ...sharedLoadOptions };
if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") options.cache = false;
const worker = await loadSource(target.source, options);
```

That leaves ordinary HTTP/RPC loading cacheable and leaves the independent
build KV untouched. It is motivated by probe `c3a1f50b` (direct named `.get()`
and a held stub red; `.get(null)` clean), not a proven native-runtime cause.
The focused candidate run passed **2/2** from 11:42:58.632–11:43:13.991 UTC in
**15,331.430125 ms**; the non-hostname full suite passed **42/42**, no retries
or skips, from 11:44:04.142–11:45:17.823 UTC in **73,644.275334 ms**.

Those results do not yet make the runtime operationally clean: the bounded
full-run telemetry has no exception/hung/reset/never-response outcome, but
218 cancellations remain unclassified (153 `Host.jsrpc`). Hostname ingress is
also absent from this acceptance: its source is deployed with the intentionally
unroutable `project-core.invalid` base, and no DNS was written. See
[preview.md](preview.md) for the complete telemetry classification and the
historical failed version.

## Previous preview status — not accepted

The red→green cases above remain local behavioral evidence. They are not a
claim that the current deployed runtime is healthy. Preview version
`3fb575ba-31c2-410a-8faf-802126770dd6` completed its full public suite on 5
September with **38 passed, 3 failed and 1 cancelled of 42** in
**68,219.849875 ms**. The cancellation was this area's WebSocket case at 30
seconds. A later focused one-fetch/fault run passed **2/2**, but that does not
explain the full-run cancellation or persistent native WebSocket exceptions,
including trace `c2d8c6b3b54d30520dc756c8b2974f84`. See [preview.md](preview.md)
for the exact time window and the separate approval/processor failures.

Hostname ingress was local-only and absent from that historical preview. The
later domain deployment above has its own DNS and network evidence.

## Previous local checkpoint

```sh
WORKER_BASE_URL=http://localhost:8799 \
  EGRESS_E2E_ADMIN_TOKEN=synthetic-egress-admin-token \
  pnpm --dir packages/v3/project-core test
```

**41 passed, zero failed/skipped/cancelled**, **23,195.777 ms** with the retained
worker-controlled stream fixture and the clean WebSocket-close assertion. Type checking
and lint pass (zero warnings/errors). The original counter reported **5,435 raw
authored lines**, including E2Es. The user subsequently clarified that the hard
<5,000 target applies to implementation, not E2Es; `pnpm size` now reports and
enforces that split. No tests or behavior were removed to hide the growth.
The latest [internal simplifications](core-simplification.md) also retain
explicit processor supersession and removal checks.

The public preview result belongs in [preview.md](preview.md); these local
results do not explain earlier preview failures or native cancellations.
