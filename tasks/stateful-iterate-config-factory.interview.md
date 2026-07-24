# Interview: stateful iterate config factory

## Q1 — How should the npm-owned stateful app ship its browser client? — 2026-07-24T12:11:52Z

I've grounded myself in both the merged precedent (`GithubAiLinter`) and the current Todo implementation. Here's the key finding that shapes everything downstream:

**`GithubAiLinter` proves the `createWorker` boundary, but has no HTTP surface at all** — its DO (`packages/iterate/src/github-ai-linter/configured-worker.ts`) never overrides `fetch`; it's pure stream-processor plumbing. Todo needs `fetch` to serve HTML, a `/api` WebSocket (Cap'n Web), *and* a browser JS bundle.

Critically, **`createWorker` and `createApp` are different code paths in OS**, and only `createApp` supports browser assets:

- `WorkerBundlerCreateWorkerOptions` (`apps/os/src/domains/workers/schemas.ts:97`) — has `files`, `entryPoint`, `virtualModules`. No `client`, no `assetConfig`.
- `WorkerBundlerCreateAppOptions` (`schemas.ts:107`) — has `client`, `assetConfig`, `assets`. OS's `worker-runner.ts:150` only runs the separate asset-serving dance (`env.WORKER_BUNDLER.handleAssetRequest`) when `"createApp" in ref.source`.

Today, Todo's `client.tsx` is dynamically esbuild-bundled per-project by OS's `createApp` path from raw repo source, and served by OS's own asset handler — completely outside the DO. If we move Todo to the `createWorker` shape (prebuilt npm entry point, like the linter), **we lose that asset pipeline entirely** — there is no field to hand it a client bundle.

### Question

To prove the harder boundary, I think the config-owned Todo app must give up `createApp`'s free asset-serving and instead have the **package pre-build the browser client bundle at `iterate`'s own build time (via tsdown/vite), inline it as a string constant into the compiled `configured-worker.mjs`, and have `TodoApp#fetch` serve that string directly** for the `/apps/todo/client.js` route — bypassing OS's asset pipeline (`assetConfig`/`assetManifest`/`client`) altogether, the same way `configured-worker.mjs` already self-contains its runtime deps via tsdown's `alwaysBundle`.

Do you want this "DO serves its own inlined client bundle" approach, or is there a different mechanism you have in mind for shipping the browser asset from an npm-owned app (e.g., keep using OS's `createApp`/asset pipeline for the client half only, while the server DO moves to `createWorker`)?

## A1 — 2026-07-24T12:11:52Z

Yes: make the package artifact self-contained and have the Durable Object serve its prebuilt browser bundle. Do not retain a hybrid `createApp` dependency on config-owned client source; that would fail the boundary Jonas wants to prove. Preserve the current URL and UI behavior, but package the client as an implementation detail of the physical worker artifact. [guess: a self-serving artifact is the smallest honest proof that an npm-owned stateful app brings its whole runtime without pulling config or monorepo source into the build.]

---

## Q2 — Should the extracted Todo adopt sqlfu or preserve raw SQL? — 2026-07-24T12:13:44Z

Found something material: `apps/tanstack/src/todo-list.ts` is an **existing sqlfu-based DO Todo implementation** already in this monorepo — schema, migrations, and typed queries all declared via `sqlfu`'s `defineConfig`/`sql` tag, versus the config-template Todo's raw-SQL version. `sqlfu` is an ordinary external npm dependency (`"sqlfu": "0.1.1"` in `apps/tanstack/package.json`, not a workspace link), so it's bundleable into `configured-worker.mjs` the same way the linter's `tsdown.config.ts` bundles `minimatch`/`yaml`/`zod`.

### Question

Jonas's ask explicitly frames the harder case as "SQLite/sqlfu," and the dossier flags `apps/tanstack/src/todo-list.ts` as reference material — not just the config-template's raw-SQL version. I recommend the extracted package's `TodoApp` **adopt `sqlfu`** (schema + migration + typed queries) instead of porting the raw `ctx.storage.sql.exec` calls verbatim, modeled closely on the tanstack example. This makes `sqlfu` a new bundled runtime dependency of `iterate` (added to `tsdown.config.ts`'s `alwaysBundle`/`onlyBundle` list for the todo entry), and is a more honest proof of the "SQLite/sqlfu" case than copying the current raw-SQL constructor.

Do you want the extraction to adopt `sqlfu` for schema/migrations/queries, or keep the current raw `ctx.storage.sql.exec` calls as-is and treat "SQLite" (not `sqlfu` specifically) as the proof point?

## A2 — 2026-07-24T12:13:44Z

Adopt `sqlfu`. Preserve the existing `todos` table and column layout exactly, and make the initial `create table if not exists` migration safe for Durable Objects that already contain rows under the current raw-SQL implementation. Bundle `sqlfu` into only the physical Todo worker artifact; config should not add it as a dependency. [guess: Jonas named sqlfu because the intended proof includes a nontrivial transitive runtime dependency, so raw SQLite alone would under-test the boundary.]

---

## Q3 — Should config consume a plain worker ref or an app factory? — 2026-07-24T12:15:51Z

Confirms the naming convention: `./github-ai-linter` maps to `./src/github-ai-linter/index.ts`, built into a dedicated `dist/github-ai-linter/index.mjs` entry. A `./todo` subpath following the same shape is the natural fit.

### Question

Todo has no per-install configuration (no `policyVersion`/`rules` equivalent), unlike `GithubAiLinterConfig`. The config-repo-template already has an established convention for this exact situation — `apps/guestbook/ref.ts` exports a plain `guestbookAppRef: StatefulDynamicWorkerRef` constant (no factory, no config) that `worker.ts` imports and passes straight to `fetchDynamicWorker`.

I recommend mirroring that shape: add `iterate/todo` as a new package export (`src/todo/index.ts`, built to `dist/todo/index.mjs`) exporting a plain constant `todoAppRef` — className `"TodoApp"`, `durableWorkerKey: "app-todo-live"` (preserving the exact existing durable identity), `source: { createWorker: { entryPoint: "node_modules/iterate/dist/todo/configured-worker.mjs", files: {...} } }`. Config's `worker.ts` would `import { todoAppRef } from "iterate/todo"`, keep doing its own project-member auth check exactly as today, then call `this.fetchDynamicWorker(req, todoAppRef)` — no `.create()`-style factory function, since there's no config to close over.

Do you want this plain-constant `todoAppRef` shape (matching `guestbookAppRef`'s existing convention), or do you want a `Todo.create()`-style factory for API symmetry with `GithubAiLinter` even though it would take no meaningful arguments?

## A3 — 2026-07-24T12:15:51Z

Use a factory. Jonas explicitly described config importing a factory which yields app behavior, and the merged linter establishes `Thing.create(env, config)`. Add `TodoApp.create(env)` returning an object with `fetch(request)`, and keep the dynamic-worker ref and physical entrypoint private. Do not add a dummy `processEvent`; the returned surface should contain only behavior the Todo owns. Keep project-member authorization and the `x-iterate-app` route decision in config, then delegate the accepted request to `#todoApp.fetch(req)`. [guess: the factory is the product/API proof being requested; exporting a platform ref would prove artifact loading but leak transport and deployment details into every config consumer.]

---

## Q4 — What test split should prove the package and real SQLite behavior? — 2026-07-24T12:19:40Z

Confirmed across the monorepo: nowhere does a vitest suite spin up a real workerd/Durable-Object/SQLite runtime — `apps/os` and `apps/tasks` both run plain Node vitest with a `cloudflare:workers` shim for pure unit tests. `packages/iterate` is the same (plain vitest, no `@cloudflare/vitest-pool-workers`). Real DO+SQLite+WebSocket behavior is proven exactly once, for real, by `specs/seeded-apps.spec.ts`'s "the seeded todo app authenticates a real project member" test — a full Playwright run through real auth, real ingress, real Durable Object storage, asserting on `heading "Todo"`, `label "New todo"`, `button "Add"`, `Mark ${title} done/not done` checkboxes, and durability across reload. That test is also the one place today asserting the `x-content-security-policy: default-src 'none'` overlay behavior for the pre-auth response.

Also found: `apps/os/e2e/vitest/project-ingress.e2e.test.ts:180-181` and `apps/os/src/domains/repos/config-repo-template.test.ts:36-47` both hard-assert `apps/todo/client.tsx`/`apps/todo/server.tsx` exist in the seeded file tree — these **will need updating** once those files are deleted from the template.

### Question

Given no package in this repo tests real DO/SQLite behavior in isolation, I recommend **not** adding `@cloudflare/vitest-pool-workers` (or any workerd test pool) to `packages/iterate` for this task. Instead:

1. `packages/iterate/src/todo/todo.test.ts` — shallow, plain-vitest contract test for `TodoApp.create(env).fetch()`, mirroring `github-ai-linter.test.ts`'s style: assert it forwards to `env.ITX.fetch` with the correct `x-iterate-worker-dispatch` header/ref shape (fake `env`, no real DO).
2. `packages/iterate/scripts/check-todo-bundle.ts` — mirroring `check-github-ai-linter-bundle.ts`, walks the built `configured-worker.mjs` and fails if any import isn't `cloudflare:workers` or bundled-in, proving the artifact (including the inlined client bundle) is self-contained.
3. Update `config-repo-template.test.ts` and `project-ingress.e2e.test.ts`'s file-tree assertions to drop the deleted `apps/todo/*` paths.
4. Treat `specs/seeded-apps.spec.ts`'s existing todo test as the acceptance criterion — write (1)+(2) first (red, since `iterate/todo` doesn't exist yet), implement until green, then run the Playwright spec to confirm it's still green with zero assertion changes (proving behavior is byte-for-byte preserved).

Do you want this split (shallow package-level contract tests + the existing Playwright spec as the real behavioral proof), or do you want me to add real DO/SQLite test infra to `packages/iterate` itself so the sqlfu migration/queries get isolated coverage without going through OS at all?

## A4 — 2026-07-24T12:19:40Z

Use the recommended split. Do not add a second Workers test runtime just for this extraction. The package contract test should prove factory dispatch and that config source is absent from the ref; the bundle gate should prove no unsupported imports and that the browser asset is present. Keep the existing seeded-app Playwright assertions unchanged as the end-to-end state, SQLite, auth, WebSocket, and reload proof. Run that proof against a preview deployment, and audit its traces/errors as required for an operational change. [guess: one production-shaped proof is higher-value and lower-maintenance than a new isolated workerd harness which would duplicate the only environment that actually composes OS, auth, dynamic-worker build, and Durable Object identity.]

---

## Phase 1 complete — 2026-07-24T12:22:33Z

The interviewer found no remaining product-level branch:

- package-owned, self-serving browser bundle
- `sqlfu` persistence with a compatible migration
- `TodoApp.create(env).fetch(request)` as the public API
- package contract and bundle gates plus unchanged preview Playwright behavior

Implementation-level build details remain intentionally delegated to Phase 3.
