---
state: todo
priority: medium
size: medium
tags: [os, itx, workers, performance]
---

# Move itx source builds (esbuild.wasm) into a dedicated builder worker

After the per-DO worker split (worker-topology.md), the single biggest
remaining bundle weight in the itx-hosting workers (`os-*-itx`, `-project`,
`-agent`, `-mcp`, `-app`) is `@cloudflare/worker-bundler`'s 14MB
`esbuild.wasm`, pulled in by `src/itx/source-build.ts` via the dial
(`src/itx/dial.ts` → `resolveWorkerSource`). Each of those workers carries
the wasm module so it can build repo-sourced capabilities in-process.

Builds are stateless and already memoized by content key in the
`itx-build-cache` R2 bucket — a warm key never builds. The clean shape:

- a dedicated `os-<stage>-builder` worker owns `@cloudflare/worker-bundler`
  and exposes the build step over a service binding;
- `resolveWorkerSource` calls the builder when the R2 memo misses, then
  reads the built modules from R2 in the host worker as today;
- the itx-hosting workers drop the wasm (~14MB each) and the
  `worker-bundler` JS.

Wasm modules are cheap-ish at runtime (precompiled), so this is mostly
about upload size, deploy time, and keeping the per-worker bundles honest —
which is why it was deferred from the split PR rather than included.
