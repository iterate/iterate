# Loaded-worker rejection: bounded local diagnosis

## Current finding — 5 September, local London time

The extra cancellation is reproducible without project-core, Capnweb, or a
dynamic loader: a DO calling a throwing static `ctx.exports` WorkerEntrypoint
also triggers it. The rejected native RPC promise retains its session pipeline.
Disposing that exact promise after rejection eliminates the cancellation in the
minimal fixture and the full-core mounted-method probe. Wrangler 4.129.0 also
reproduces the unmodified static fixture, so an upgrade alone is not a fix.

[`callTarget`](../src/runtime.ts) now retains the raw call result and releases
it only after rejection, using the native `RpcPromise` brand. It rethrows the
original error. Plain promises are untouched, and successful results are not
disposed because that would revoke returned capabilities.

```ts
const result = Reflect.apply(value, receiver, args);
try {
  return await result;
} catch (error) {
  if (result instanceof RpcPromise) result[Symbol.dispose]();
  throw error;
}
```

This is explicit resource-lifetime containment of a native defect, not an
error-envelope change or log suppression. It does not claim that every native
RPC call made inside arbitrary application source is covered by this boundary.

## Original observation, before cleanup

`mounted boom` is a public-network repro with no processor scheduler: a project
event mounts a loaded worker whose exposed method deliberately throws. The HTTP
request correctly receives the modelled `INTERNAL` result, but the local
Wrangler log can additionally contain the unrelated runtime cancellation:

```text
The Workers runtime canceled this request because it detected that your
Worker's code had hung and would never generate a response.
```

This is not the deliberate worker exception. The latter is an expected negative
fixture and is separately visible as `context request failed ... deliberate
failure`. The combined public suite was green (32 tests, 11.57s) after the
alarm repair, while its log after line 1664 still had seven hung cancellations,
15 explicit fixture failures, and no `NOSENTRY` warning. Counts are
concurrent-run observations, not a claim of one cancellation per rejection.

The mounted call travels through [`Context.invoke`](../src/worker.ts) to
[`callTarget`](../src/runtime.ts); `Context.request` catches the thrown worker
error and returns the ordinary `INTERNAL` result. No scheduler or retry path is
required for the mounted repro.

The final check gave the full worker a unique local name,
`iterate-project-core-lifecycle-local`, eliminating its duplicate dev-registry
registration with the tutorial server. Three calls still returned `INTERNAL`
and produced three extra cancellations. The concrete project was
`rejection-unique-a3a10e81-ca9d-44ab-96d0-f2388986d300`; its log is
`wrangler-2026-09-04_22-56-48_490.log`, cancellation lines 189, 216 and 243.
Duplicate worker-name registration is therefore not sufficient to explain it.

Minimal public-network setup, against a running local core:

```js
const project = `rejection-${crypto.randomUUID()}`;
async function call(method, args) {
  const response = await fetch(`http://localhost:8799/api?project=${project}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, args }),
    signal: AbortSignal.timeout(5_000),
  });
  return { status: response.status, body: await response.json() };
}
const source = `import { WorkerEntrypoint } from "cloudflare:workers";
export default class Fail extends WorkerEntrypoint {
  async boom() { throw new Error("fixture rejection"); }
}`;
await call(
  ["append"],
  [
    {
      id: "install",
      type: "itx.set",
      data: {
        key: "mount/failer",
        value: { kind: "worker", source: { modules: { "main.js": source } } },
      },
    },
  ],
);
console.log(await call(["failer", "boom"], [])); // 500 INTERNAL
// Inspect fresh runtime logs for the additional, unexplained cancellation.
```

## Correction: logging level invalidated the earlier clean reductions

The throwaway fixture lives outside the package at
`/tmp/project-core-worker-loader-repro` and was never deployed. Earlier runs
of bare native calls, a DO wrapper, a Capnweb import, the actual `runtime.ts`,
and the actual `Context`/`Host` appeared clean. **Those are withdrawn as
negative evidence:** they omitted `--log-level debug`, while the full-core
red run enabled it. The native exception diagnostics are verbosity-dependent.
An HTTP result and a sampled parent span with outcome `ok` do not establish
that a loaded child's RPC session completed without cancellation.

A paired rerun held the fixture constant: canonical DO name `fixture/`, one
HTTP append followed by three separate HTTP invokes, and the project-core
Wrangler executable (4.127.1). Only logging changed:

| Logging             | Public result                       | Native diagnostics                                                         |
| ------------------- | ----------------------------------- | -------------------------------------------------------------------------- |
| Default             | Three expected `INTERNAL` responses | Three explicit application failures; no visible native cancellation        |
| `--log-level debug` | Three expected `INTERNAL` responses | Three promise-rejection diagnostics and two extra async hung cancellations |

The retained logs are `paired-default-2026-09-05.log` and
`paired-debug-2026-09-05.log` under the fixture directory. Thus the actual
`Context` reduction **does reproduce**; the complete front door is not required.
The repository-root Wrangler is 4.93.0, but authoritative startup logs confirm
that both these runs and the earlier reductions used 4.127.1. A version mismatch
does not explain this pair.

A separate full-core run removed only the CPU/subrequest limits, used a unique
worker name and fresh state, and still produced three extra cancellations for
three rejected calls. Project: `rejection-e350eb16-bce7-451a-82a0-b1e38a95f572`;
log: `wrangler-2026-09-04_23-02-34_395.log`, cancellation lines 309, 336 and 363.
Neither the configured limits nor duplicate worker registration is necessary.

## What the sources support

The Capnweb import is not a global Worker class patch: its Workers entrypoint
stores `cloudflare:workers` in a private-symbol global so its own `RpcTarget`
can alias the native one. It does not replace `WorkerEntrypoint`, DO, or RPC
prototypes. See [the fork's injection module](https://github.com/iterate/capnweb/blob/ca3da33615370fb66c240a354df40ae39a399822/src/inject-workers-module.ts)
and [core selection](https://github.com/iterate/capnweb/blob/ca3da33615370fb66c240a354df40ae39a399822/src/core.ts#L30-L36).

Workerd intentionally gives dynamic worker code a weak re-entry callback so
retained entrypoint stubs do not keep a request/DO alive, and may recreate an
isolate when there is no active request. See
[WorkerLoader::get](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/api/worker-loader.c%2B%2B#L76-L100)
and [the isolate-lifetime comment](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/api/worker-loader.c%2B%2B#L102-L124).
There is a relevant fixed temporary-chain lifetime bug in
[workerd #6550](https://github.com/cloudflare/workerd/pull/6550). The final minimal
DO fixture retains the worker and entrypoint through the awaited call, yet
still reproduces. The static entrypoint control additionally shows that the
loader's temporary-chain lifetime is not necessary for this failure.

The cancellation string is emitted by workerd's pending-event hang detector,
not by the application error classifier ([source](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/io/io-context.c%2B%2B#L1583-L1593)). The historical seven cancellations were a release blocker, not accepted error noise.

## Minimal same-verbosity differential

All following runs use debug verbosity and three caught method rejections.
Logs and source/config snapshots are preserved under the temporary fixture
directory above; its owned server has been stopped.

| Native topology                                  | Rejected-promise disposal | Extra hung cancellations |
| ------------------------------------------------ | ------------------------- | ------------------------ |
| HTTP → Loader (no DO)                            | No                        | 0                        |
| HTTP → DO → Loader                               | No                        | 3                        |
| HTTP → DO → Loader                               | Yes                       | 0                        |
| HTTP → DO → static `ctx.exports.Fail`            | No                        | 3                        |
| HTTP → DO → static `ctx.exports.Fail`            | Yes                       | 0                        |
| Same static no-dispose fixture, Wrangler 4.129.0 | No                        | 3                        |

Corresponding files are `native-bare-debug-2026-09-05.log`,
`native-do-debug-2026-09-05.log`, `native-do-dispose-debug-2026-09-05.log`,
`static-loopback-baseline-debug-2026-09-05.log`,
`static-loopback-debug-2026-09-05.log`, and
`static-loopback-baseline-wrangler-4.129.0-debug-2026-09-05.log`.
The direct HTTP result does not prove absence of retained resources: its
caller context is short-lived, unlike the DO. No timing workaround was added.

The native mechanism matches the differential:

- [`callImpl`](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/api/worker-rpc.c%2B%2B#L423-L460)
  splits the Cap'n Proto call into a promise and a retained pipeline. Its
  success callback calls `resolve()`; rejection does not replace `Pending`.
- [`dispose()`](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/api/worker-rpc.c%2B%2B#L236-L255)
  drops the pending pipeline. The server session waits for its last capability
  through [`CompletionMembrane`](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/api/worker-rpc.c%2B%2B#L2155-L2165).
- The [header comment](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/api/worker-rpc.h#L250-L252)
  explicitly intends a rejected pipeline not to retain server work. The local
  DO differential violates that intended contract. Reject-only cleanup is
  therefore documented containment, not a newly invented application protocol.

## Full-core red/green acceptance probe

The public setup above was run with a fresh project and three `boom` calls.
In the same `wrangler-2026-09-04_23-02-34_395.log`, capture the starting byte
length before the requests, then assert against only the newly added log text:

```js
const fresh = (await readFile(log, "utf8")).slice(start);
const cancellations =
  fresh.match(
    /uncaught exception; source = Uncaught \(async\); stack = Error: The Workers runtime canceled/g,
  ) ?? [];
assert.equal(cancellations.length, 0, "Rejected RPC must not leave a hung child session");
```

Before the change, project
`rejection-regression-330a6318-8f11-447f-b33d-4b4bf540d00f` failed with
`AssertionError: 3 !== 0`. Afterwards,
`rejection-regression-b5c182e9-5951-4d87-a944-0ea9f076b8d4` passed with zero;
all six calls still returned the expected HTTP 500 `INTERNAL` contract.
This runtime-log assertion is local operational acceptance, not a portable
network test. The public suite's native-worker case now also performs three
deliberate method failures and a successful later call; its HTTP assertions
alone cannot prove resource cleanup.

The first complete suite after cleanup had no async hung cancellation but
failed a separate processor alarm race (31/32). That run is retained in
`wrangler-2026-09-04_23-13-24_288.log`, with failed project
`project-core-e2e-mtnklyvg-2f588fec400a` stuck at attempt 2. Fixing RPC lifetime
must not be presented as acceptance of that stalled durable state.

After the separate [alarm-ownership repair](alarm-ownership.md), a fresh full
suite passed 32/32 alongside five additional retry-stress runs. Its debug log
has 78 deliberate fixture exceptions and zero extra cancellations or alarm
mismatches. See [the current verification checkpoint](local-verification.md).
