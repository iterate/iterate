# Pinned source → build cache → contextual load

Historical checkpoint, 5 September 2026: the first optional build adapter was
implemented and deployed at **5,241 combined authored lines**. The user later
clarified that the hard <5,000 budget covers implementation, not E2Es; the
current split and deployment checkpoint are in [README.md](../README.md).

## Public contract exercised

```ts
const result = await context.build.build({
  source: { repo: "site", revision }, // immutable file snapshot, not branch head
  options: { entryPoint: "src/main.ts", minify: true },
});
if (result.status === "rejected") {
  console.log(result.diagnostics);
} else {
  using worker = await context.cd("/review").load(result.code);
  console.log(await worker.invoke(["describe"]));
}
```

`src/build.ts` owns the request/result contract. `Context.build()` resolves
repository bytes. The separate RPC-only `src/bundler.ts` calls
`@cloudflare/worker-bundler@0.2.1`, with the workspace's existing pinned patch.
It has KV but no project/ITX binding and does not execute submitted modules.
`src/runtime.ts` injects ITX and the outbound Host only when loading the result.

The build key is SHA-256 of canonical `{ version, input }`, where `input`
contains **every resolved file byte and exposed option**, and `version` is the
deployed compiler Worker's version ID. That version identifies compiler/patch
bytes, schema and defaults. Successful code is cached in KV for 24 hours;
rejected builds are not cached. Identical snapshots from different repos may
share code. The cache entry is not a provenance receipt and contains no live
bindings. Concurrent misses may compile twice; KV is not a lock.

Native `load()` remains independently available without compiling anything.
Direct input uses uncached loading because opaque extra bindings cannot safely
be identified by arbitrary caller cache labels. The narrower existing `Source`
adapter still uses native `get()` with platform-known code and authority identity.

## Red → green through the network

The first `e2e/build.test.ts` case failed before implementation with a
`TypeError` when accessing the absent builder. It then passed against local
workerd, without mocking compilation, repo lookup, KV or loading.

The final two build cases prove:

- Pinned multi-file TypeScript, including a relative import, becomes executable
  native loader input. Changing `minify` changes the build key.
- The first request misses and the second hits KV; cached code loaded in the
  original context and `/review` observes the respective host's ITX path.
- Syntax errors, unresolved static imports and registry dependency requests
  return nonempty diagnostics and no code. Only the input repo commits appear
  in the event log: rejected builds do not execute or append application events.

Initially esbuild also logged expected source failures as errors. A private,
adapter-owned plugin sets esbuild's diagnostic log level to `silent`; its
structured diagnostics are still returned. Only recognized source diagnostics
are normalized. Unknown compiler exceptions still throw, rather than being
misclassified as source rejection.

Final local full suite: **38 passed, 0 failed/skipped/cancelled**, 31,450.744 ms.
TypeScript checking of the implementation and repository lint pass. The raw
size command correctly fails at 5,241. Source typechecking inside the dynamic
builder is a different, **not yet implemented** feature.

```sh
WORKER_BASE_URL=http://localhost:8799 \
  EGRESS_E2E_ADMIN_TOKEN=synthetic-egress-admin-token \
  pnpm --dir packages/v3/project-core test
```

These credentials are local synthetic fixtures, not preview credentials.

## Deployed proof and remaining limits

Focused preview tests pass **4/4** on core version
`69ebb66d-2ad8-4c19-aad3-0981629c542f` and bundler version
`9d8d36c3-08dc-4e20-bd7c-5c0c0489436e`. The run covers both new cases and the
existing direct native-loader/fetch-gate cases. See [preview.md](preview.md)
for exact resources, timings, warnings and the unresolved native cancellation
classification. No full 38-test remote run is claimed.

Not proved or implemented: compiler-version invalidation across deployments,
local hot-reload cache invalidation, binary build output, npm resolution with
integrity-pinned bytes, typechecking/generated ITX declarations, source maps
as app assets, build coordination, activation, or build-to-event provenance.
A successful bundle also does not guarantee Worker startup: runtime imports
and compatibility remain subject to the native loader's validation. None of
these missing features is hidden behind `build()` pretending to install code.
