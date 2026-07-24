---
status: complete
size: medium
---

# Stateful iterate config factory

## Status

Done. The package owns the complete stateful Todo runtime, the OS template and
real config consumer delegate to it, legacy rows survive the source swap, and
the final preview/browser/telemetry proof is healthy.

## Why

The packaged GitHub AI linter proved that a config repo can import event-processing behavior from `iterate`. The next harder boundary is a stateful HTTP app: one npm-owned factory must carry a SQLite/sqlfu Durable Object and its browser client without asking config to host the source or install its runtime dependencies.

## Public shape

```ts
import { TodoApp } from "iterate/todo";

export default class ProjectWorker extends IterateWorkerEntrypoint {
  #todoApp = TodoApp.create(this.env);

  async fetch(request: Request): Promise<Response> {
    // Config keeps hostname routing and project-member authorization.
    return this.#todoApp.fetch(request);
  }
}
```

`TodoApp.create(env)` exposes only `fetch(request)`. The dynamic-worker ref, dispatch header, class name, durable key, physical package entrypoint, sqlfu setup, HTML, and browser bundle are package details.

## Checklist

- [x] Replace the task stub with an implementation-ready spec and explicit guesses. *This file is the agreed Phase 2 handoff.*
- [x] Add a failing package contract test for `TodoApp.create(env).fetch(request)`. It must assert a real `env.ITX.fetch` dispatch with a private stateful ref, `durableWorkerKey: "app-todo-live"`, and no config-owned Todo source paths. *The red/green contract lives in `packages/iterate/src/todo/todo.test.ts`.*
- [x] Add a failing build gate for the physical Todo worker artifact. It must reject unsupported bare imports and prove the prebuilt browser client is present. *`check-todo-bundle.ts` first failed on the missing artifact, then caught an external `zod` leak before going green.*
- [x] Add the public `iterate/todo` export and declaration/build entries. *Package exports, publish exports, tsdown entries, and tsc declarations now expose only the factory.*
- [x] Move the Todo Durable Object, HTML, Cap'n Web API, and browser client under `packages/iterate/src/todo/`. *The config-owned three-file app was deleted after the package artifact built.*
- [x] Replace raw SQL with `sqlfu` definitions, migration, and typed queries while preserving the existing `todos(id, title, done, created_at)` table and rows. *The idempotent `20260718000001_create_todos` migration keeps the prior table shape.*
- [x] Build the browser client at package build time and make the Durable Object serve it at `/apps/todo/client.js` with the current JavaScript content type. *A browser-targeted tsdown pass is embedded as a string before the main dist clean.*
- [x] Bundle the Todo worker's full runtime graph, including `sqlfu`, React, React DOM, Cap'n Web, and generated browser code, while leaving only supported workerd built-ins external. *The 593 kB physical artifact passes the recursive import gate.*
- [x] Update `apps/os/config-repo-template/worker.ts` to construct the packaged Todo and delegate after the existing member check; delete config-owned `apps/todo/`. *The router now holds `#todoApp = TodoApp.create(this.env)`.*
- [x] Regenerate `config-repo-template.generated.ts` and update seeded file-tree assertions which currently require `apps/todo/client.tsx` and `apps/todo/server.tsx`. *The generated seed and unit/E2E tree assertions contain only the project-owned guestbook files.*
- [x] Keep `specs/seeded-apps.spec.ts`'s existing Todo assertions unchanged. *No changes were made to the Playwright acceptance flow.*
- [x] Document the `iterate/todo` usage and its package/config ownership boundary. *The package README shows routing/auth and states the durable/runtime boundary.*
- [x] Add a deployed migration spec which writes the legacy raw-SQL schema through config-owned source, swaps only the source to the package worker under `app-todo-live`, and reads the same row back. *`todo-package-migration.e2e.test.ts` went red on the package worker's missing `getTodos` RPC probe; the green preview run follows the new deployment.*
- [x] Run focused package tests, package build and artifact gates, template tests, typecheck, lint, format, and the relevant full test lanes. *Package build and 169 tests pass; root typecheck, lint, format, and test all pass.*
- [x] Deploy a preview and run the unchanged seeded Todo Playwright flow through real auth, ingress, WebSocket, Durable Object SQLite, mutation, and reload. *The final preview passed all 63 Playwright tests; the Todo flow passed in 19.6s, plus a separate headed rerun in 39.6s.*
- [x] Audit preview traces/logs for the Todo flow; classify or fix every error before calling the proof healthy. *The successful flow emitted 61 info events on worker version `963231ba-0acc-47e7-8763-915d3dbc9b03`, with zero error events; canceled outcomes were disposed WebSocket/fetch sessions.*
- [x] Update the separate `iterate/config` repo to consume the package artifact, preserving `app-todo-live`, or record a concrete stacked follow-up if the package artifact is not yet consumable. *The branch artifact typechecks in [iterate/config#19](https://github.com/iterate/config/pull/19), which deletes config-owned Todo source.*

## Invariants

- `todo` stays project-member-only and keeps its current host route.
- Durable identity remains `app-todo-live`; this is an in-place code change, not a fresh list.
- Existing rows remain readable and mutable after sqlfu records its migration.
- WebSocket upgrades travel through `env.ITX.fetch`, not Workers RPC.
- Config does not depend on `sqlfu`, React, the Todo browser code, or Todo server source.
- The package build fails if the Todo artifact leaks an unhandled runtime import.

## Guesses and assumptions

- A self-serving physical worker is the smallest honest proof that an npm-owned stateful app carries its entire runtime without config or monorepo source.
- Jonas named sqlfu because the intended proof includes a nontrivial transitive runtime dependency; raw SQLite alone would under-test it.
- The factory is the requested product API; a public `StatefulDynamicWorkerRef` would leak transport and deployment details.
- One production-shaped preview proof is more valuable than adding a second isolated workerd harness to `packages/iterate`.
- Generate or import the prebuilt client as a string module during the package build, keep `sqlfu` as a normal `iterate` runtime dependency, and preserve `/apps/todo/client.js`; these are reversible implementation choices.

## Out of scope

- A generic app registry or universal `{ fetch, processEvent }` framework.
- Extracting guestbook, the tasks proxy, stateless apps, or other config features.
- Changing Todo UX, adding list slugs/rename, or adopting the full `apps/tanstack` app.
- Resetting durable state or changing the Todo schema.
- Adding a new Workers test pool only for this package.

## Implementation log

- 2026-07-24: Started from merged `origin/main` after the packaged GitHub AI linter landed.
- 2026-07-24: Factory TDD proved the `env.ITX.fetch` lane and private `app-todo-live` ref.
- 2026-07-24: The artifact gate caught both the initially absent build and an external `zod` leak; the final worker bundles sqlfu, Cap'n Web, the migration, and the prebuilt browser client.
- 2026-07-24: Package build/typecheck/169 tests, config-template typecheck, and 11 focused OS template/seed tests pass.
- 2026-07-24: Root typecheck, lint, format, and full test pass. The first CI run also exposed and fixed an internal type accidentally exported to knip.
- 2026-07-24: A real deployed red migration spec proved the legacy SQLite row exists before the package source takes over; `getTodos()` is an internal RPC probe for the green half.
- 2026-07-24: The first browser preview found a bare `react/jsx-runtime` import in the standalone client. The existing Playwright spec reproduced the static Loading shell; bundling the JSX runtime and adding a no-bare-import client gate made the same deployed flow green.
- 2026-07-24: Final preview CI passed: all five deployed apps, 63 Playwright tests, 49 OS Vitest files, and the 12.9s exact Todo migration spec. The Todo browser trace contained no error-level events or failed outcomes.
