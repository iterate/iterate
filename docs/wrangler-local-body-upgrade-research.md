# Local request-body failure research

**Parked on 6 September at the owner's direction.** V4 acceptance concerns
deployed behavior only; this tooling investigation is not a release gate.

This note concerns only the local `createTestHarness()` E2E failure: a finite,
chunked `POST /api` is classified as `413`, and a later new WebSocket upgrade
can receive HTTP `500`. It is not evidence of a production Workers failure.

## Concrete upstream match

[workers-sdk #15203](https://github.com/cloudflare/workers-sdk/issues/15203)
is an open upstream report (15 August 2026) for local Wrangler: a body-bearing
POST routed through static assets can eventually produce `500`, connection
resets, and an unusable local server. Its reduction says that removing either
the body or `assets` avoids the failure. It was reported with Wrangler 4.123.0,
Miniflare 5.20260811.1-alpha, and workerd 1.20260811.1. The report also notes
an already-open runtime WebSocket shortly before the failure. Its primary
reduction targets an asset path which answers before consuming the body, so it
is a close local-proxy/body-lifecycle match, not proof that `/api` has the same
root cause.

[workers-sdk PR #15207](https://github.com/cloudflare/workers-sdk/pull/15207)
(open and unmerged as of 2026-09-06) identifies a client disconnect while a
request body is uploading as `Network connection lost`. Its proposed Wrangler
fix keeps that ProxyWorker failure request-scoped rather than making the whole
local dev session fatal. The PR reports its assets-plus-POST workload surviving
6,000 requests after the change. This is directly relevant because
`createTestHarness()` creates a normal primary `DevEnv` and waits for its proxy
to be ready; only auxiliary workers use `NoOpProxyController`
([test-harness source](https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/src/api/test-harness.ts)).

The local diagnostic package is Wrangler 4.129.0, which declares Miniflare
5.20260903.0-alpha and workerd 1.20260903.1. That is newer than #15203's
reported dependency set, but the proposed #15207 fix was still unmerged at the
time of this investigation; no fixed-version claim is warranted.

Reading the actual PR diff at head
`f3fe15df1ba5679dc73792262312e0d0def3999c` narrows that claim further: its
runtime change replaces fatal controller-event dispatch with request-error
logging. It does not change request-body cancellation, fetch forwarding, or the
response returned to the affected request. Our failing upgrade is itself a new
request, and a later dense-frame upgrade can still succeed in the same test
file. Keeping the dev process alive is therefore not sufficient acceptance for
our failure. The patch has not been applied as a V4 fix.

## Matched V4 evidence

The retained public regression now runs 32 sequential cycles; ten under-sampled
the observed cycle-21–23 failure. On 6 September the unchanged local harness
failed at cycle 23, while the same 32-cycle test passed on the deployed version
ten. The [preview record](preview-proof.md#local-loop-minimization) includes the
exact no-edit reproduction command and timestamps.

The actual five-test admission file and full two-worker SOLO harness reproduced
the 500 at cycle 21 when its diagnostic loop was raised from 10 to 50. Omitting
only the main worker's assets configuration then passed three 50-cycle boots;
restoring assets reproduced the same 500 at cycle 21 on the first boot. All
temporary settings were removed. This is stronger evidence for the local
assets boundary than the separate standalone client, whose cleanup ordering
was not identical. It is not permission to remove V4's asset serving.

Further matched cuts kept that same harness and client. A guard-direct wrapper
omitting dashboard routing and session allocation still failed at cycle 21;
restoring the original main failed identically. Adding `Connection: close` only
to the temporary Wrangler ProxyWorker's downstream POST headers also left the
failure unchanged. So did `run_worker_first: ["/api"]`, which retains assets
but bypasses the router's `ASSET_WORKER.unstable_canFetch` lookup. All diagnostic
changes were removed.

A corrected failure-only dispatcher observer captured the actual 500 body:
`Error: Network connection lost.` at Miniflare's entry worker, where
`await service.fetch(request)` rejects. The ordinary admission cases still
passed, including both successful WebSocket upgrades and coded closes. This
locates the error at the downstream service boundary, not solely in Undici's
non-101 handling. It does not identify which downstream stage failed.
[Primary entry-worker source](https://github.com/cloudflare/workers-sdk/blob/main/packages/miniflare/src/workers/core/entry.worker.ts).

## Existing upstream history and boundary

A runtime-marked cut now distinguishes the actual served proxy from the router.
The ordinary proxy fallback failed at cycle 23 with its POST response marker
asserted; pointing the actual served fallback directly at Router passed three
32-cycle boots with that marker absent. The asset/router services stayed enabled.
Removing only the proxy constructor wrapper, forwarding it directly to User,
replacing its module with minimal fetch forwarding, and adopting Router's
compatibility settings each still failed at cycle 23. Markers verified all
modified fetch paths; a startup marker also verified the settings block.
The [dated record](preview-proof.md#local-loop-minimization) preserves the
artifacts and excludes an earlier invalid dev-registry-only cut. This narrows
the served boundary, not yet the native body-lifetime mechanism; all diagnostic
changes were restored.

A later probe disambiguated the two Miniflare runtimes. Only the main runtime's
logs reach the test harness's `getLogs()`; the outer ProxyController has its
own logger. Capturing both showed the failing upgrade enter the outer proxy,
whose network fetch rejected with `Network connection lost.` before the main
entry worker ran. Its abort signal was false at the catch. The first 23 upgrades
completed both chains with `101`. The earlier entry-worker stack can therefore
come from the outer entry, not the assets pipeline. The assets-dependent
differential remains real, but may affect the outer TCP/body lifecycle.
[ProxyController configuration](https://github.com/cloudflare/workers-sdk/blob/1394867d1dc357d9bddabf8c16aede47d052fb18/packages/wrangler/src/api/startDevWorker/ProxyController.ts#L60-L188),
[downstream fetch](https://github.com/cloudflare/workers-sdk/blob/1394867d1dc357d9bddabf8c16aede47d052fb18/packages/wrangler/templates/startDevWorker/ProxyWorker.ts#L158-L205).

An observer bridge at that exact TCP hop made 32 cycles pass on 64 fresh
connections: each POST received `413` and a main-side FIN, then the upgrade
opened a new connection and received `101`. This is not yet a transparent
observation: default Node half-close handling plus counterpart destruction
can alter native connection reuse. Its green result therefore cannot prove
the original failure mechanism. The [dated record](preview-proof.md#local-loop-minimization)
preserves the artifact and this limitation.

A second bridge used explicit half-open sockets and natural FIN propagation,
with no counterpart destruction on normal close. It also passed 32 cycles
on 64 fresh connections, with absent POST/`413` connection headers and
main-side FIN before outer-side FIN. That removes the hard-close confound,
not the scheduling perturbation from inserting a TCP hop; the original
failure has still not been captured at socket level.

A non-interposed process/socket observer did preserve the original failure
at cycle 23 / 6,219 ms. Its roughly 100 ms samples remained flat (main: 50
numeric descriptors, two TCP sockets; outer: 16, three). Immediately after
failure and before teardown, the main listener was still owned/alive and a
fresh direct HTTP request returned `200`. This argues against accumulating
descriptors or a dead listener, but does not identify which connection the
failed upgrade used. All observation hooks were removed; see the same dated
record for artifacts and sampling limits.

Workers SDK previously added request-body-draining middleware in
[PR #5106](https://github.com/cloudflare/workers-sdk/pull/5106), explicitly as
a workaround for local `Network connection lost` errors from unconsumed POST
bodies. The current source still installs it for bundled development workers
unless `WRANGLER_DISABLE_REQUEST_BODY_DRAINING` is set. This establishes that
the body-drain boundary is known local-runtime risk, but does not make an
application-side cancellation correct or harmless by itself.

[workerd #6774](https://github.com/cloudflare/workerd/issues/6774) is excluded
from the diagnosis: it concerns an already-open outbound Durable Object
WebSocket after a streaming _response_ drains, rather than a new inbound
upgrade after a refused request body.

## Native forwarding boundary

### The header experiment did not disable KJ pooling

The inspected workerd revision pins Cap'n Proto/KJ at
`59cc025fa0c04d083aafb57604a28e72eb506037`.
[Dependency pin](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/build/deps/gen/deps.MODULE.bazel#L28-L34).
KJ explicitly overrides caller-supplied connection headers during serialization.
Ordinary requests supply an empty `Connection` override; WebSocket requests
set it to `Upgrade` themselves. Thus setting `Connection: close` in the
temporary ProxyWorker's JavaScript request headers is not a demonstrated
no-pooling control. Its negative result cannot rule out pooling. A connection
trace is needed to establish the actual wire behavior.
[Serialization contract](https://github.com/capnproto/capnproto/blob/59cc025fa0c04d083aafb57604a28e72eb506037/c%2B%2B/src/kj/compat/http.h#L459-L464),
[request overrides](https://github.com/capnproto/capnproto/blob/59cc025fa0c04d083aafb57604a28e72eb506037/c%2B%2B/src/kj/compat/http.c%2B%2B#L5634-L5664),
[upgrade overrides](https://github.com/capnproto/capnproto/blob/59cc025fa0c04d083aafb57604a28e72eb506037/c%2B%2B/src/kj/compat/http.c%2B%2B#L5736-L5772).

KJ defaults to a five-second client idle timeout and a five-second server
pipeline timeout. Its refused-upload grace is one second / 64 KiB, a different
clock. The network client's pool reuses available connections for upgrades as
well as ordinary requests. These facts make a pool-lifetime probe specific,
but the matching cadence alone is still not causal evidence.
[Timeout defaults](https://github.com/capnproto/capnproto/blob/59cc025fa0c04d083aafb57604a28e72eb506037/c%2B%2B/src/kj/compat/http.h#L1063-L1066),
[server grace](https://github.com/capnproto/capnproto/blob/59cc025fa0c04d083aafb57604a28e72eb506037/c%2B%2B/src/kj/compat/http.h#L1216-L1225),
[upgrade pool](https://github.com/capnproto/capnproto/blob/59cc025fa0c04d083aafb57604a28e72eb506037/c%2B%2B/src/kj/compat/http.c%2B%2B#L6248-L6268).

The inspected workerd network service and HTTP listener do not override those
timeout defaults. This verifies the configured clocks, not which clock, if
any, causes this failure.
[Network client settings](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/server/server.c%2B%2B#L2392-L2412),
[HTTP listener settings](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/server/server.c%2B%2B#L6489-L6499).

### Asset service body forwarding

The assets RPC proxy's `fetch` is an actual HTTP-forwarding method: it calls
`ROUTER_WORKER.fetch(request)`. Its constructor's JavaScript `Proxy` only
forwards _unknown_ members to `USER_WORKER`; that unknown-member branch is not
used for `fetch`. [Pinned source](https://github.com/cloudflare/workers-sdk/blob/1394867d1dc357d9bddabf8c16aede47d052fb18/packages/miniflare/src/workers/assets/rpc-proxy.worker.ts#L24-L27)

The router's exported default is `RouterInnerEntrypoint`; `RouterOuterEntrypoint`
is documented there as unused. A matching `run_worker_first` route still calls
`USER_WORKER.fetch(request)`, so it removes the asset-lookup branch, not the
native Router-to-user forwarding hop. [Pinned source](https://github.com/cloudflare/workers-sdk/blob/1394867d1dc357d9bddabf8c16aede47d052fb18/packages/workers-shared/router-worker/src/worker.ts#L49-L53)

workerd's generic fetch path pumps the request body in background specifically
to permit a response before upload completion, and treats a disconnected body
write as non-fatal so the server response can still be returned. [Pinned source](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/api/http.c%2B%2B#L1644-L1675)

Therefore, an early `413` can coexist with still-live forwarded body pumps
through the proxy/router chain. That is a lifecycle mechanism worth testing,
not a demonstrated cause of this `500`. Likewise, the roughly five-second
cadence is correlation only: no timer responsible for it was identified in
these sources.
