---
state: todo
priority: high
size: large
tags: [os, workers, dynamic-workers, sandboxes, build-pipeline]
---

# Build dynamic workers in a sandbox container (kill esbuild-wasm)

Replace the in-workerd bundler (`@cloudflare/worker-bundler`, esbuild-wasm)
with real `npm install` + a real bundler running inside a **sandbox container
per project, hardcoded at `/sandboxes/cloudflare/builder`** — an ordinary
project sandbox, addressed like any other. The Worker Loader serving path,
the KV artifact store, build keys, budgets, and the building-page contract
all stay exactly as PR #1612 shipped them — only the build backend changes.

## Why

The in-workerd build path is a permanently incomplete reimplementation of
node dependency resolution, patched dep-by-dep as the template grows:

- 4 pnpm patches on `@cloudflare/worker-bundler@0.2.1` (extensionless legacy
  `main`, virtual-module self-import fallthrough, `conditions` passthrough,
  require-condition for require-kind imports) — see `pnpm-workspace.yaml`.
- A hand-maintained 31-entry node-builtin shim list in
  `src/domains/workers/materialize.ts` (dual bare/`node:` spellings), needed
  only because _bundled ESM output_ can't leave bare `require("util")`
  external. Every new template dependency is a potential new patch.
- esbuild-wasm is 13.9MB raw / 3.76MB gzip in the builder script.
- The JS npm installer re-resolves semver on every cold build — no lockfile
  support, so the same build key can yield different bytes over time.

A real toolchain deletes all of that: every dependency pnpm/npm can resolve
just works, lockfiles become possible, and the wasm leaves the codebase —
which also means **PR #1636's single-worker world needs no builder sidecar at
all** (the sandbox container is already part of its deploy model).

## Design

### Topology: the builder worker dies

`resolveThroughBuilder` (`src/domains/workers/worker-loader.ts`) already
resolves the file snapshot and passes files by value (PR #1612's final shape).
Instead of `env.BUILDER.build(...)`, it drives the project's builder sandbox:

```
resolveWorkerSource (worker worker / monolith)
  └─ memo → KV → on miss:
       sandbox = env.SANDBOX.getByName({projectId, path: "/sandboxes/cloudflare/builder"})
       writeFile source files → exec install+bundle → readFile outputs
       → KV artifact write (same store, schema-version bumped) → artifact
```

Deleted: `src/workers/builder.ts`, `builder-entrypoint.ts`, the `BUILDER`
binding, the builder entry in `engineWorkerNames`, `materialize.ts`'s bundler
call + shim list, the worker-bundler dependency and all 4 patches.
`WORKER_BUNDLER_VERSION` is replaced by `BUILD_TOOLCHAIN_VERSION` (below).

### Trust model

The builder is an ordinary project sandbox at a well-known path — no
reserved-path machinery, no special identity rules. **Whoever can see a
project is trusted**: project code and project users can exec into
`/sandboxes/cloudflare/builder` like any other sandbox, and that's fine
within the project.

The one cross-project consequence: runtime-built artifacts must be keyed
per project (add `projectId` to the build key for container-built
artifacts), because a project-trusted principal can influence its own
builder's output and content-addressed keys would otherwise be shared.
Fresh-seed dedup — the reason keys are content-addressed today — is
covered by deploy-time template seeding instead (trusted CI builds the
one shared artifact; see below), so nothing of value is lost.
`--ignore-scripts` stays regardless: build INPUTS should not execute code
during a build the platform runs on the project's behalf.

### Build recipe (inside the container)

Per cache-miss, in `/build/<buildKey>/`:

1. `writeFile` each source file from the by-value map (tens of files; batch
   as a tar stream later if profiling says so).
2. If `package.json` exists:
   `npm install --ignore-scripts --no-audit --no-fund --omit=dev`
   with `npm_config_cache=/build/.npm-cache` (shared per container — warm
   rebuilds skip the registry).
3. Bundle. Recommended: generate a minimal `wrangler.build.jsonc`
   (`main` = entryPoint, our pinned compatibility date + `nodejs_compat`) and
   run `wrangler deploy --dry-run --outdir dist` — wrangler's bundling is the
   canonical nodejs_compat pipeline (builtin externalization, CJS-require
   interop, unenv aliases) that production workers get, so the shim list has
   no replacement to maintain. Fallback documented: direct
   `esbuild --bundle --format=esm --conditions=workerd,worker` + alias flags.
4. `readFile` the emitted modules → `WorkerBuildArtifact` (same shape), KV
   write from the ORCHESTRATOR (the container never holds KV credentials).
5. `rm -rf /build/<buildKey>` in a finally; keep the npm cache.

Warm-rebuild optimization (later): key `node_modules` dirs by package.json
hash and symlink into build dirs — user-code-only edits then rebuild in ~1-3s
without touching npm at all.

### Image and toolchain versioning

`apps/os/sandbox/Dockerfile` gains `RUN npm i -g wrangler@<pin> esbuild@<pin>` (node
24 + npm are already in the base image). Build keys include a new
`BUILD_TOOLCHAIN_VERSION` constant — bumped when the toolchain pins change,
deliberately NOT the image digest (routine base-image security rebuilds must
not mass-invalidate every artifact).

Instance type: `lite` (256MiB) is tight for npm+esbuild; plan on `basic`
(1GiB). NOTE: `instanceType` is per container app, i.e. per DO class — it
applies to user sandboxes too. Either accept `basic` for all sandboxes or
measure whether the template build fits in `lite` first.

### Exec budgets vs caller budgets

The exec calls carry their own `timeout` (e.g. 120s install + 60s bundle) —
a hard bound on container work, independent of the caller's `buildBudgetMs`
race (which keeps working unchanged: past budget the caller serves the
building page while the orchestrator's `waitUntil` lets the build finish into
KV).

Concurrent builds of one key still converge on the idempotent KV write; two
builds of different keys in one container run in separate `/build/<key>`
dirs and share the npm cache (a win, not a hazard).

### Local dev (the crux — no Docker required)

Containers stay off by default locally (`OS_SANDBOX_CONTAINER_LOCAL_DEV`).
The local build path runs the SAME recipe on the host toolchain:

- The vite dev server registers a node-side dev-only endpoint
  (`/__dev/worker-build`): tmp dir, same `npm install --ignore-scripts`,
  same pinned wrangler dry-run bundle, returns the module map.
- `resolveThroughBuilder` in local mode fetches that endpoint instead of
  dialing the sandbox (workerd can fetch the dev origin).
- Versions come from the repo's own devDependencies, pinned to match the
  image; `BUILD_TOOLCHAIN_VERSION` keys the artifacts, so version drift is
  visible, not silent.
- The local vitest e2e lane uses the same host path (CI runners have node).

Explicitly rejected: keeping esbuild-wasm as a local fallback — two
resolution semantics is exactly the drift class content-addressing exists to
prevent, and keeping the wasm forfeits most of the point.

### Eager builds + deploy-time seeding (bundled in)

Two additive pieces make the building page a rarely-seen safety net:

- **Eager on commit**: `RepoDurableObject.commitFiles`/`edit` already update
  the durable head cache synchronously and know `{commitOid, contentHash}` —
  a `ctx.waitUntil` fires the default project worker build so browser-facing
  cold builds vanish for the lane that shows the building page.
- **Deploy-time template seeding**: the template's build key is fully
  deterministic (contentHash of the seeded repo × options × toolchain
  version), so OS's own deploy (real node, native toolchain, zero wasm) can
  prebuild the template artifact and write it to the env's KV — fresh
  projects then never build at runtime at all. MUST share the
  `workerBuildKey` module with the deploy script (no reimplementation).

### Failure modes

- Container unavailable / regional capacity → build error → building page +
  retry; builds are idempotent and content-addressed. No wasm fallback.
- Container restart mid-build → exec fails → caller retry (same idempotence).
- npm registry egress moves from worker fetch to container egress (billed,
  negligible); the persistent npm cache REDUCES registry exposure vs
  today's per-build re-download.
- A 60s build on `basic` costs ~$0.0005 — cost is noise.

## What stays untouched

Worker Loader serving, `loadResolvedWorker` cache keys, the loader-ready
inline fast path (run-script never touches containers), stateful facets +
stale-while-rebuild, `buildBudgetMs`/`WorkerBuildInProgressError`/building
page, `KvWorkerBuildArtifactStore` (schema version bumped once), build-key
discipline (`contentHash` dedup), and the e2e suites (they assert behavior,
not the build backend — `worker-build.e2e.test.ts` should pass unchanged
against deployed envs).

## Sequencing

1. Eager-on-commit builds + deploy-time template seeding (independent,
   lands on the wasm pipeline too, immediately shrinks building-page
   exposure).
2. Sandbox build backend + local host-toolchain path + reserved sandbox
   path + image pins, replacing the wasm in one clean break (no dual
   backend), schema version bump.
3. Delete: worker-bundler dep + patches + shims + builder worker + BUILDER
   binding. If #1636 lands first, step 2's orchestrator goes in the monolith
   and no builder sidecar ever exists; if #1612's builder sidecar is live,
   step 3 removes it.

## Open questions

- `instanceType` is per-class: bump all sandboxes to `basic`, or measure the
  template build in `lite` first?
- Wrangler dry-run vs direct esbuild: verify wrangler's `--outdir` module
  layout maps cleanly onto the loader module map (additional modules, wasm
  passthrough), and pin the minimal generated config.
- Batch file transfer (tar stream via `writeFile` + `exec tar -x`) — needed,
  or are per-file `writeFile`s fine for template-sized inputs?
- Should the builder sandbox also serve `npm install` for the two-tier
  dependency-layer design if that lands later? (The container is the natural
  "heavier, realer environment" that design wants for rare layer builds.)
