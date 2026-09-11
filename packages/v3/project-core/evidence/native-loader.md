# Native Worker Loader slice — 5 September 2026

The public contract now has `Scope.load(WorkerInput, exportName?)`. It accepts
native-shaped code directly; a repository, bundler and compiler are not
prerequisites. The context overwrites `env.ITX` and `globalOutbound` at the
native loading boundary.

```ts
using worker = await project.cd("/review").load({
  compatibilityDate: "2026-09-04",
  mainModule: "entry.js",
  modules: {
    "entry.js": `export default {
      fetch(request, env) { return new Response(env.GREETING); }
    }`,
  },
  env: { GREETING: "Hello" },
});
console.log(await (await worker.fetch(new Request("https://demo.iterate/"))).text());
```

## Red → green at the public boundary

The new test in [core.test.ts](../e2e/core.test.ts) first failed because loading
was missing. Returning the raw dynamic entrypoint then produced the real
native `DataCloneError`: dynamic entrypoints cannot transfer to another Worker.
The eventual typed `Scope.load()` test also failed before that method existed.

The minimal fix is `LoadedWorker`: a session-scoped RPC target which privately
retains the native WorkerStub and forwards `invoke(path, ...args)` and
`fetch(request)` from its owner. Disposal releases the held worker. A raw
WorkerStub or entrypoint is never claimed to be a Cap'n Web client stub.

The same test reproduced that transfer failure in the existing `workers.get`
source adapter. It now returns the same forwarding target. This establishes
that the returned handle is usable, not that any particular isolate was reused.
Workerd has an explicit test for this transfer restriction:
[worker-loader-test.js](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/api/tests/worker-loader-test.js#L75-L88).

## What the tests establish

- Custom `mainModule`, a `{ js }` module and an imported `{ text }` module run.
- Caller environment data reaches the worker, but caller-provided `ITX` does
  not replace contextual authority: the worker inspects `/review`.
- The cached-source adapter returns a working fetch handle across the real
  WebSocket → edge → Durable Object boundary.
- Public ingress, mounted-worker global fetch, and directly loaded-worker
  global fetch enter the same `mount/fetch` policy. Even an untyped input with
  `globalOutbound: null` is overwritten; the direct worker observes the
  policy's response header. The response body is consumed or cancelled.
- A compile-only contract check confirms pipelined `Scope.load().fetch()` is
  present in the public TypeScript type.

Native service/tail binding transport, every module kind, owner eviction, and
generalized loader-cache descriptors are not all proven by those cases.

## Local checkpoint

Final full network suite: **36/36 passed**, zero failures, skips or
cancellations, in **21,095 ms**, against local workerd on port 8799 with the
documented synthetic credentials. Typechecking, formatting and repository lint
pass. The counter reports **4,996 raw authored lines**, including tests, UI,
configuration and scripts.

The additions fit by sharing unchanged settings/MCP/session/read/commit test
fixtures and removing redundant source validation. Repositories now expose
files; the worker source adapter decides whether those files are executable
modules. No test cases were deleted and no executable implementation was moved
into excluded documentation.

The native input path uses uncached `LOADER.load()`. The narrower source
adapter uses `LOADER.get()` with deployment, contextual binding and source
revision identity. Typechecking dynamic source, bundling, and a separate
all-input build cache remain proposed in
[the build design](../notes/typed-surface-and-builds.md).

The same focused loader/fetch-policy cases pass **2/2** on preview version
`8ad69b0c-64a4-47dc-a9fb-61b62305144c`; their exact telemetry window contains
36 informational rows and no warnings or errors. Full remote-suite output was
lost and remains unconfirmed. Deployment results, including unresolved earlier
failures, are maintained in [preview.md](preview.md).
