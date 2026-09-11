---
state: active
priority: high
size: small
dependsOn: []
---

# Preview-only capability-provider Pager lifetime reproduction

`capability-provider-pager-lifecycle-repro.ts` creates one short-lived live
client capability with a single `health()` method, calls it sequentially from a
second session, waits for the normal Pager idle turn, and disposes the provider
project/session. It uses a random client path and writes the exact timestamps,
provider invocation count, and cleanup boundary to `/tmp`.

Run from the repository root against the owned preview fixture project:

```bash
PROJECT_ID=prj_d5139a9e1afd4a9688d9d006e5d6f6f6 \
  doppler run --project os --config preview_6 -- \
  pnpm exec tsx tasks/capability-provider-pager-lifecycle-repro.ts
```

It has no board, audio, voice-provider, or production dependency. The provider
handle is disposed at the end; verify `itx.clients.list()` reports the generated
path as `connected: false` after the run.

## Contract under test

The provider Pager exists to release ordinary RPC references while idle. The
parent emits an `idle` Page in `CapabilityProviderPagers.#release()` after the
provider invocation settles; relay `#handlePage()` is required to dispose the
returned short call leg. The two-second pause is only a distinct event-loop
window for that already-required `idle` Page; it is not an assumed acceptable
lifetime.

Expected trace result: each `StreamDurableObject.activateLiveCapability` and
`invokeLiveCapability` span ends after its own completed `health()` call, before
provider-session disposal. Query the run window with
`$workers.event.rpcMethods.0` set to each method.

## Initial result: red

2026-09-10 preview6 run `1990c29a-8f54-430a-9105-7e5a289b5faf` called one
provider `health()` method 12 times strictly sequentially. Every invocation
returned successfully in 94–228 ms and the provider counter reached exactly
12. The temporary client was later observed disconnected.

`/tmp/preview-capability-lifecycle-activation-traces.json` and
`/tmp/preview-capability-lifecycle-invoke-traces.json` each contain 12 spans
for the run. Their derived starts match the individual calls, but every span
ended together at 08:26:54.397Z, about 30 ms after deliberate provider-session
disposal and more than two seconds after the final successful call. No Durable
Object reset occurred; all outcomes were `ok`. This is a retained result/call-leg
lifetime defect in the ordinary capability path. It does not by itself attribute
the production HAVPE reset or latency symptom.

### Primitive control: green

A second preview6 run, marker `c38c3f5d-6ff1-42d4-8716-3d69baba9f9d`, returned only
integers 1 through 12 from the same provider method. All 12 activation spans
ended with their respective calls in 45–66 ms
(`/tmp/preview-capability-lifecycle-primitive-activation-traces.json`). This
rules out a missing normal `idle` Page as the sole explanation and isolates the
retention to object-valued return ownership. It still does not assign the
separate HAVPE reset or latency incidents to this defect.

### Outer ownership fix: 100-call green

2026-09-10 preview6 version `85151b9c-c149-4baf-80c5-00410badaea5` ran the
same object-valued probe for its bounded maximum of **100** strictly sequential
calls (`af90f904-ce16-4d7d-a1e2-7787419c0765`). The provider served exactly 100
calls. Each of the 100 `activateLiveCapability` spans ended `ok` in 29–48 ms
(p50 33 ms; p95 39 ms); the 100 `invokeLiveCapability` spans ended `ok` in
36–57 ms (p50 41 ms; p95 48 ms). All ended during their own calls, before the
two-second idle/cleanup boundary. The client catalog recorded the generated
path disconnected after teardown.

Evidence: `/tmp/preview-capability-lifecycle-object-outerfix-100.json`,
`/tmp/preview-capability-lifecycle-outerfix-100-activateLiveCapability.json`,
`/tmp/preview-capability-lifecycle-outerfix-100-invokeLiveCapability.json`, and
`/tmp/preview-capability-lifecycle-object-outerfix-100-cleanup.json`.

The probe deliberately caps `CALLS` at 100 so a bounded regression check cannot
turn into an unbounded preview load test.

### Nested callable guard: functionality preserved; lifetime unresolved

The DTO result fix is intentionally narrow. It copies and releases only a
recursively plain container of arrays, plain objects, and primitive values. A
function, RPC-like `dup()` value, `Symbol.dispose` value, cyclic graph, or any
container containing one is returned unchanged and is not disposed by the
helper. Both the inner Pager relay and the outer public capability RPC target
call that same helper.

Preview6 version `85151b9c-c149-4baf-80c5-00410badaea5` tested this negative
branch with two returned plain containers, each holding a nested callable
`child.ping` and a callable `callback` (`79378176-30c2-4ba1-8c70-1a3b6a4c9197`).
Both callables remained usable for two calls after their parent result had
returned (8/8 tagged replies). The caller explicitly released each container,
callable, and disposable call-result wrapper, then the temporary client was
observed `connected: false` after cleanup.

This is a **functionality/no-premature-disposal** proof only. The two native
`activateLiveCapability` and `invokeLiveCapability` legs ended at session
cleanup, about two seconds after the explicit caller releases, rather than at
those releases. Nested callable result lifetime is therefore unresolved and is
not covered by the DTO-result fix. Do not generalize the 100-call plain-object
green result to capability-bearing result graphs.

Evidence: `/tmp/preview-capability-nested-return-guard-final.json`,
`/tmp/preview-capability-nested-return-final-handles-activateLiveCapability.json`,
`/tmp/preview-capability-nested-return-final-handles-invokeLiveCapability.json`,
and `/tmp/preview-capability-nested-return-final-cleanup.json`.
