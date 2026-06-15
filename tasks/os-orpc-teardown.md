---
state: in-progress
priority: high
size: large
dependsOn: [os-codemode-to-itx-processor.md]
tags: [os, itx, orpc, cutover]
---

# Rip out oRPC from apps/os: itx serves everything

Plan and decisions: superseded by [itx-next.md](../apps/os/docs/itx-next.md)
(the oRPC replacement plan doc was deleted).
Posture: immediate cutover, no back-compat, POC — `git revert` is the
rollback plan.

## Done

- **PR #1423** — dead surface deleted (`ping`, `test.*`, `streams.getState`,
  demo routes); kernel `ItxStream.subscribe`; streams index page converted.
  (Its react client library — provider, query bridge, stream-tail
  multiplexer, `useStreamEvents` — was superseded by the one-hook layer and
  deleted in PR #1472.)
- **PR #1472** — subscriptions carry reduced state (`events: false`
  state-only mode, initial push, `ItxStream.onStateChange`; DECISIONS D20)
  and the browser layer collapsed to the one-hook model: `useItx` /
  `connectItx` (later unified into `apps/os/src/itx/itx-react.tsx` in #1478,
  DECISIONS D21 — one socket per context in a module Map, Suspense until
  connected, no SSR, no reconnect machinery; reads ride TanStack Query via
  `useItxQuery`). Streams tree/detail, breadcrumb navigators, and
  `ItxActivityTail` converted.
- Codemode → itx processor is `tasks/os-codemode-to-itx-processor.md`
  (separate effort; its oRPC procedures die there).

## Remaining

### Kernel hardening

- [x] `ItxError { code, message, details? }` serialized across capnweb and
      read back duck-typed in the client core (codes: NOT_FOUND, FORBIDDEN,
      CONFLICT, BAD_REQUEST, INTERNAL; `onSendError` tags everything else
      INTERNAL) — **PR #1456**, see `apps/os/src/itx/errors.ts` and
      DECISIONS.md D18. UI conversion of mutating pages is unblocked.
- [x] ~~`getServerItx` — in-process handle for SSR loaders~~ (built in PR
      #1457, itx DECISIONS D19) — **superseded by the one-hook
      simplification (PR #1472, DECISIONS D21)**: itx components never SSR,
      so the SSR door, the isomorphic loader accessor, and the query-cache
      prefetch were deleted.
- [ ] Org-membership `itx.projects.create` (org claims on the handle runtime;
      replaces the admin-only path for the dashboard create flow).

### Surface parity (typed facades on the handle; wiring, not logic)

- [ ] `itx.secrets` (list/get/upsert/remove, redaction moves with it)
- [ ] `itx.integrations` (connections + start-OAuth returning redirect URL;
      callback routes stay plain HTTP; redirect-URI derived from config, not
      the request — verify on a preview)
- [ ] `itx.project.hostnames` (updateConfig/customHostnameStatus/ensure)
- [ ] `itx.agents` (list, presets, sendMessage; runtime state via
      reduced-state views)
- [ ] `itx.mcp.listSessions`
- [ ] slug lookup + pagination metadata on `itx.projects` for non-admins

### Convert all consumers

- [ ] Remaining dashboard routes (~12 routes + `create-project-form` +
      `lib/project-route-query.ts` / `cache-created-project-queries.ts`)
      onto `useItx` (DECISIONS D21): `ssr: false` (or `<ClientOnly>`), a
      Suspense boundary, then call the handle directly — subscriptions
      (`onStateChange`/`subscribe`) for live data, awaited calls into
      component state for one-shots, no query cache; form zod moves into the
      form components
- [ ] e2e `test-support/os-client.ts` helpers (`createProject`,
      `readProjectStreamUntil`, `streamProjectEventsUntil`) onto `connectItx`
      / `ItxStream.subscribe`; migrate the e2e files
- [ ] CLI: `pnpm cli itx run <file|-e>` wrapping `POST /api/itx/run`
      (identical from curl), `pnpm cli itx call <path...>` sugar; discovery =
      `itx.describe()`; `packages/shared/src/apps/cli.ts` untouched
      (auth/semaphore still use it)
- [ ] MCP: `run_itx_code` tool on the project MCP server (depends on the itx
      processor task)

### Delete

- [ ] `apps/os/src/orpc/`, routes `api.$.ts` / `api.orpc.$.ts` /
      `api.orpc-ws.ts`, `apps/os-contract`, `@orpc/*` deps,
      `createTanstackQueryUtils` usage, the crossws/NitroWebSocketResponse
      upgrade branch in worker.ts
- [ ] Plain `/api/health` (+ `/api/public-config` if anything needs it)
- [ ] Doc sweep: CLAUDE.md "Talking to OS", apps/os/AGENTS.md, architecture
      docs, doppler-backed-scripts (all reference `cli rpc` / `/api/orpc`);
      worker.ts header comment
- [ ] Observability: wide-event log at `/api/itx` connect before prod cutover

## Acceptance

- No `@orpc/*` in apps/os's dependency tree; `apps/os-contract` deleted.
- Every dashboard page works over itx (click-through on a preview), e2e
  green, CLI run-code path documented.
- worker.ts reads: infra → ingress → itx connect → TanStack app.
