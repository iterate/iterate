---
state: in-progress
priority: high
size: large
dependsOn: [os-codemode-to-itx-processor.md]
tags: [os, itx, orpc, cutover]
---

# Rip out oRPC from apps/os: itx serves everything

Plan and decisions: [itx oRPC replacement plan](../apps/os/docs/itx-orpc-replacement-plan.md).
Posture: immediate cutover, no back-compat, POC — `git revert` is the
rollback plan.

## Done

- **PR #1423** — dead surface deleted (`ping`, `test.*`, `streams.getState`,
  demo routes); itx react client library (`apps/os/src/itx/react/`: provider,
  query bridge, stream-tail multiplexer, `useStreamEvents`,
  `ItxActivityTail`); kernel `ItxStream.subscribe`; streams index page
  converted.
- Codemode → itx processor is `tasks/os-codemode-to-itx-processor.md`
  (separate effort; its oRPC procedures die there).

## Remaining

### Kernel hardening

- [ ] `ItxError { code, message, details? }` serialized across capnweb and
      rehydrated in the client core (codes: NOT_FOUND, FORBIDDEN, CONFLICT,
      BAD_REQUEST). UI conversion of mutating pages waits on this.
- [x] `getServerItx` — in-process handle for SSR loaders (resolveItx +
      accessForPrincipal via the shared access.ts boundary); isomorphic
      `getLoaderItx` + best-effort `prefetchItxQuery` seed the QueryClient
      with the same itxKey keys the browser uses (streams index wired; itx
      DECISIONS D18, PR #itx-server-handle).
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
      onto `useItxQuery`/`useItxMutation`/`useStreamEvents`; form zod moves
      into the form components
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
