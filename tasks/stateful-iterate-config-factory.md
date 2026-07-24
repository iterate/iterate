---
status: ready
size: medium
---

# Stateful iterate config factory

## Status

About 10% complete. The API, ownership, migration, artifact, and acceptance proof are grilled and recorded; implementation has not started. The goal is to move the seeded Todo runtime out of project config and into a self-contained `iterate/todo` package artifact without changing its route, auth, durable identity, stored rows, or UI.

## Why

The packaged GitHub AI linter proved that a config repo can import event-processing behavior from `iterate`. The next harder boundary is a stateful HTTP app: one npm-owned factory must carry a SQLite/sqlfu Durable Object and its browser client without asking config to host the source or install its runtime dependencies.

Decision trail: [stateful-iterate-config-factory.interview.md](./stateful-iterate-config-factory.interview.md).

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

- [x] Grill the API, package boundary, state model, and acceptance proof. *Recorded in the adjacent interview log.*
- [x] Replace the task stub with an implementation-ready spec and explicit guesses. *This file is the agreed Phase 2 handoff.*
- [ ] Add a failing package contract test for `TodoApp.create(env).fetch(request)`. It must assert a real `env.ITX.fetch` dispatch with a private stateful ref, `durableWorkerKey: "app-todo-live"`, and no config-owned Todo source paths.
- [ ] Add a failing build gate for the physical Todo worker artifact. It must reject unsupported bare imports and prove the prebuilt browser client is present.
- [ ] Add the public `iterate/todo` export and declaration/build entries.
- [ ] Move the Todo Durable Object, HTML, Cap'n Web API, and browser client under `packages/iterate/src/todo/`.
- [ ] Replace raw SQL with `sqlfu` definitions, migration, and typed queries while preserving the existing `todos(id, title, done, created_at)` table and rows.
- [ ] Build the browser client at package build time and make the Durable Object serve it at `/apps/todo/client.js` with the current JavaScript content type.
- [ ] Bundle the Todo worker's full runtime graph, including `sqlfu`, React, React DOM, Cap'n Web, and generated browser code, while leaving only supported workerd built-ins external.
- [ ] Update `apps/os/config-repo-template/worker.ts` to construct the packaged Todo and delegate after the existing member check; delete config-owned `apps/todo/`.
- [ ] Regenerate `config-repo-template.generated.ts` and update seeded file-tree assertions which currently require `apps/todo/client.tsx` and `apps/todo/server.tsx`.
- [ ] Keep `specs/seeded-apps.spec.ts`'s existing Todo assertions unchanged.
- [ ] Document the `iterate/todo` usage and its package/config ownership boundary.
- [ ] Run focused package tests, package build and artifact gates, template tests, typecheck, lint, format, and the relevant full test lanes.
- [ ] Deploy a preview and run the unchanged seeded Todo Playwright flow through real auth, ingress, WebSocket, Durable Object SQLite, mutation, and reload.
- [ ] Audit preview traces/logs for the Todo flow; classify or fix every error before calling the proof healthy.
- [ ] Update the separate `iterate/config` repo to consume the package artifact, preserving `app-todo-live`, or record a concrete stacked follow-up if the package artifact is not yet consumable.

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
- 2026-07-24: `grill-you` selected Todo as the smallest stateful proof and completed four decision rounds.
