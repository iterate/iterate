# V4 native WebSocket-close telemetry repro

## Status

This is a handoff for the remaining V13 release gate. It is not an acceptance
exception and does not authorize suppressing `exception` telemetry.

- Deployment: main `0b689aaa-a7ce-4b3e-af9a-44eebc9730ee`, Cloudflare account
  `04b3b57291ef2626c6a8daa9d47065a7`.
- Functional path: loaded worker `/expression` returns HTTP 101, echoes one
  benign synthetic message, and the client observes close code 1000.
- Telemetry path: parent/DO native upgrade spans report `exception` with empty
  `exceptions` and `logs` arrays.
- Canonical trace: [`32abc32a8523ee999c173456cac25efb`](https://dash.cloudflare.com/04b3b57291ef2626c6a8daa9d47065a7/observability/traces/32abc32a8523ee999c173456cac25efb).

The release condition is an identified native category plus coherent telemetry,
not a blanket waiver for WebSocket exceptions.

## Exact focused deployed repro

### Automated expected-failure regression

The isolated
[`native-websocket-close-telemetry.deployed.e2e.test.ts`](../packages/v4/project-worker/e2e/native-websocket-close-telemetry.deployed.e2e.test.ts)
now exercises one HTTP control and one WebSocket echo through the existing native
Worker → context DO → loaded WorkerEntrypoint fetch chain. Run from
`packages/v4/project-worker`:

```sh
doppler run --project project-v4 --config prd -- \
  env WORKER_BASE_URL=https://v4.iterate2.app WORKER_DEMO_LOGIN=1 \
  pnpm exec vitest run --config e2e/vitest.config.ts \
  e2e/native-websocket-close-telemetry.deployed.e2e.test.ts --retry=0
```

Only the outer native outcome assertion is `test.fails`. The ordinary setup hook
requires HTTP 200, successful echo, close 1000, unchanged deployment, the correct
outer native record, and empty exception/log arrays. Only `ok` and the known
`exception` category pass that guard. Missing telemetry, a new error category,
or broken client behaviour fails normally; `ok` becomes an unexpected pass, so
the quarantine must be removed when the failure is fixed.

The tail uses the existing Doppler Cloudflare credentials, filters to the observed
deployment version, and correlates a unique synthetic request path. Read-only
banner polling establishes tail readiness before the single WebSocket exchange.
Readiness and observation have separate 60-second deadlines; the tail is closed
and its own session deleted afterwards. No raw request headers, tail URLs, cookies
or arbitrary exception/log payloads are retained.

The first ordinary red assertion captured both native `exception` records at
15:09:13.980–981 UTC on 2026-09-06. Other attempts did not consistently receive the
DO record, so the automated regression asserts the independently failing outer
record only. The full parent/DO trace audit remains a separate unresolved release
gate. This is an explicit known-failure test, not acceptance of the native error.
The final outer-only test reported `1 expected fail` at 15:19:58 UTC. A temporary
assertion accepting the observed exception then correctly produced `Expect test
to fail`; after restoring the intended `ok` assertion, another run at 15:22:31
reported `1 expected fail`. A wrong-account setup control failed normally.

### Functional-only control

Run from `packages/v4/project-worker`. This uses a fresh synthetic `capcode`
context and the literal `hello-from-eyeball`; it does not upload user data,
modify a long-lived project, or retry.

```sh
WORKER_BASE_URL=https://v4.iterate2.app WORKER_DEMO_LOGIN=1 \
  pnpm exec vitest run --config e2e/vitest.config.ts \
  e2e/fetch-door-expression-http-and-websocket.e2e.test.ts \
  -t 'LOADED WORKER' --retry=0
```

The focused assertion is at
[`fetch-door-expression-http-and-websocket.e2e.test.ts:22`](../packages/v4/project-worker/e2e/fetch-door-expression-http-and-websocket.e2e.test.ts#L22-L39):
ordinary GET is 200; the WebSocket opens, echoes, and closes as 1000. Its
client helper sends one message then calls `close(1000, "done")`
([`client.ts:259`](../packages/v4/project-worker/e2e/support/client.ts#L259-L294)).

## Observations so far

1. The canonical public-matrix trace records its outer span at
   **2026-09-06 09:10:23.625 UTC** and DO span at **09:10:23.629 UTC**, for
   context `prj_capcode_mtplcrtm_0` and Ray ID `a36c571cadfc0ec9`.
   It is trace `32abc32a8523ee999c173456cac25efb`. The client-visible
   101/echo/1000 exchange succeeded, while native `/expression` upgrade spans
   reported `exception` without an exposed native error message. The distinct
   focused reproduction at **09:17:55–09:17:57 UTC** passed the same client
   assertions; its live tail showed both native outcomes as `exception` with
   empty `exceptions` and `logs` arrays. That is a separate trace window.

2. A manual-close A/B at **09:19:28–09:19:30 UTC** explicitly called
   `pair[1].close(e.code, e.reason)` from the accepted server pair's close
   handler. It did not change the client result or the empty native exceptions;
   the temporary fixture change was reverted. This A/B did not remedy the
   outcome; it does not establish the native cause.

3. A final server error/close-listener diagnostic at **09:25:40–09:25:42 UTC**
   again passed the exchange and left the native error outcome empty. Empty
   `exceptions`/`logs` do **not** prove that no JavaScript-side failure exists:
   they only prove that this telemetry representation did not expose one.

[The preview record](preview-proof.md) contains the versioned evidence and exact windows. Do
not mix teardown outcomes from provider-disposal tests into this repro.

## Safe tail workflow

Keep live tailing in a separately labelled diagnostic repetition; do not
introduce it midway through a controlled comparison. Capture the focused window
and correlate each repetition using its own context, timestamp and trace, not
the earlier canonical Ray ID.

For that separate diagnostic only, tail the exact worker
`iterate-v4-simplification` at V13 version
`0b689aaa-a7ce-4b3e-af9a-44eebc9730ee` for no more than 60 seconds. Apply an
allowlist before retaining any output: UTC, script name, outcome, URL
origin/path/context, and reduced `exceptions`/`logs`. Do **not** redirect raw
`wrangler tail --format json` to a file: raw records can contain sensitive
headers and metadata.

For that separate diagnostic only, start the allowlisted tail before one repro
and stop it immediately after. The required Cloudflare-internal request is:
classify the native exception for Ray `a36c571cadfc0ec9` at the canonical
09:10:23 UTC matrix exchange and explain why its spans are `exception` despite
the observed 101/echo/1000.

## Primary-source boundaries

The source audit used pinned workerd source
`c4e03fa1d2a3f2607e2b79567076d5fdd5179d03`. It supports the code-path
boundaries below; it does **not** identify the version of Cloudflare's deployed
native runtime.

- `web_socket_auto_reply_to_close` has been enabled by compatibility date since
  2026-04-07 ([flag](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/io/compatibility-date.capnp#L1509-L1512)); it automatically queues a reciprocal close
  ([implementation](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/api/web-socket.c%2B%2B#L1372-L1394)).
- The audit of the [proxy coupling path](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/api/web-socket.c%2B%2B#L547-L633)
  did not identify a supported compatibility-flag fix for this native outcome.
- A `DISCONNECTED` exception reported as `DEFERRED_PROXY` has a specific native
  outcome, `responseStreamDisconnected`,
  ([observer](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/io/observer.c%2B%2B#L62-L64)).
  The observed literal outcome is instead `exception`, so it cannot currently
  be classified as that known benign representation.

A possible double-report path exists: deferred proxy failure is reported then
re-thrown ([worker entrypoint](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/io/worker-entrypoint.c%2B%2B#L528-L532)); a later report with source `OTHER` could serialize a disconnect as
`exception`. This is a source-backed **hypothesis**, not the deployed cause.

## Resolution rule

Accept a normal close only if Cloudflare identifies a stable native outcome and
the trace uses it coherently. A narrow future predicate would at minimum require
GET `/expression`, 101, echoed synthetic payload, client close 1000, no exposed
JS exception, loaded-worker span `ok`, and the exact documented native close
outcome on proxy hops. Until then, `exception`, non-empty exception data,
overload, or an exception on the loaded worker remains a release-blocking error.
