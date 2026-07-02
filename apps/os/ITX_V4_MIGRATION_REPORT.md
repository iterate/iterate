# itx-v4 → apps/os migration — progress report

_Branch: `itx-v4-os-replacement` · PR #1585 · preview slot: preview-2 · as of 2026-07-02_

## Goal

Replace the itx system and all domain implementations in `apps/os` with the
itx-v4 engine (developed as `apps/minimal-itx-v4`, transplanted to
`apps/os/src/next/`), keeping product features (project hosts, admin pages,
REPL, examples, chat TUI, streams example app, inbound MCP). Slack/Google were
temporarily removed and return in the final phase. Approved plan:
`~/.claude/plans/nifty-juggling-candy.md`.

**Posture (locked):** security explicitly out of scope (only invariant kept is
per-project confinement); everything resets (no data migration); one giant PR;
Playwright green at phase boundaries.

## Where things stand

### Done (all committed, CI green)

| Phase                                                                                                                                             | State         |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| Slices A–C (transplant, auth adapter, create+onboarding, openai-ws, browser mirror, core cutover)                                                 | done          |
| Frontend cutover + streams-example-app on the engine                                                                                              | done          |
| Traffic flip: `/api/itx` is the engine's; coexistence path deleted                                                                                | done          |
| Phase 4: final 10-worker topology (ingress, app, api + 7 engine DO workers); legacy stack deleted; D1/queue/R2 gone                               | done          |
| Phase 6: examples matrix — browser, node, **cli**, run-script, project-worker runtimes                                                            | done          |
| Phase 7: `packages/shared/{streams,callable,durable-object-utils}` deleted (events components vendor their fold locally; apps/os owns StreamPath) | done          |
| Phase 8: five-goal Playwright specs (signup / create-project / agent-chat + repl + reactivity)                                                    | done          |
| Phase 9: `apps/minimal-itx-v4` deleted; knip/tsconfig hygiene; workspace green                                                                    | done          |
| Phase 10: chat TUI rebuilt on the shared engine client stack                                                                                      | done          |
| Project directory: auth-worker `internal.project.bySlug` + `PROJECT_DIRECTORY` KV cache (primed at create)                                        | done          |
| Phase 12: Slack + Google on the engine                                                                                                            | **in flight** |

### Verified (2026-07-02)

- Engine e2e: **56 passed / 2 skipped vs deployed preview-2** on the final
  topology; examples matrix **27/27** across all runtimes vs preview-2.
- Root Playwright: **21/21** vs local dev (incl. real-OTP signup, fresh-user
  create-project, agent-chat).
- Golden path on preview-2: CLI create → onboarding greeting → `agent-smoke`
  returns `pong`; `<slug>.iterate-preview-2.app` serves the project worker
  (200); preview smoke incl. MCP 401 + resource-metadata contract.
- Chat TUI: headless data-layer smoke + real-PTY lane green.
- PR CI: lint-typecheck, test, generate, autofix, Preview deploy + e2e (full
  preview suite incl. `pnpm spec`), artifact.ci — all pass.

## Key architecture decisions

1. **`/api/itx` is the only engine door** (`authenticate(credentials) → ItxRoot`);
   the dedicated api worker also serves the admin-cookie bridge, worker-hosted
   e2e fixtures, the `/prj_<id>` path lane, and project platform hosts.
2. **All RpcTarget classes live in `src/next/rpc-targets.ts`**; domains keep
   only DO + entrypoint classes.
3. **`src/next` has its own `Env`** (`src/next/env.ts`); the ambient global
   `Env` covers only app + ingress workers.
4. **Auth adapter lanes:** `from-server-cookie`, `bearer`, `admin-secret`,
   admin-gated `impersonate`. Stale claims solved in the adapter (cached
   directory fallback + live-context widening at create).
5. **The auth worker is the project directory.** Create goes through
   `internal.project.createForOrganization` (auth mints `prj_` ids);
   `internal.project.bySlug` is the trusted service-token lookup. In front of
   it, the `PROJECT_DIRECTORY` KV namespace caches `slug:<slug>` → id and
   `project:<id>` → metadata (1h TTL, primed at create, negatives only
   memoized in-isolate — KV's 60s floor would break create-then-navigate).
6. **Browser mirror = second host of the same engine** (event table + derived
   tables, real `StreamProcessor` contracts in the browser host, announcements
   preserved).
7. **openai-ws ported verbatim**; provider default computed in the project DO.
8. **Quarantine over delete:** `legacy-quarantine/` holds the Slack/Google
   reference for Phase 12; `test-quarantine/` catalogues superseded suites.
   Both excluded from tsconfig/vitest/lint/knip and deleted at the very end.

## Learnings / gotchas (keep in mind when reviewing)

- **Local vite dev masks repo-sourced project-worker fetches** with
  `internal error; reference =` (capnweb RpcTarget-identity class). These paths
  pass against deployed previews — always verify there before treating as a
  regression.
- **Auth's `project.bySlug` is session-scoped** — service-token calls without
  `asUserId` get "Not authorized". That silently broke the fresh-user
  post-create navigation and slug-host ingress until `internal.project.bySlug`
  - the KV directory landed. If a directory read fails, check which lane it
    uses.
- **A fresh preview stage needs propagation time**: engine e2e run immediately
  after destroy+redeploy fails broadly (routes/workers still settling) and is
  clean minutes later. Don't diagnose the first run after a fresh-stage deploy.
- **Playwright `getByRole("button", {name: "Run"})` needs `exact: true`** —
  generated slugs containing "run" substring-match sidebar buttons.
- **Killing a backgrounded task that ran `pnpm dev restart` kills the dev
  server**; use `pnpm dev kill` + `pnpm dev start --detach` as separate steps.
- `newHttpBatchRpcSession` is lint-banned; the legitimate one-shot uses
  (project-create server fn, MCP exec_js) carry justified inline disables.

## How to run things

```bash
# dev server
cd apps/os && pnpm dev start --detach

# engine e2e vs local dev / preview
cd apps/os && doppler run -- pnpm exec vitest run --config e2e/vitest.config.ts e2e/engine/
cd apps/os && doppler run --config preview_2 -- env ITX_BASE_URL=https://os.iterate-preview-2.com pnpm exec vitest run --config e2e/vitest.config.ts e2e/engine/

# examples matrix (all runtimes)
cd apps/os && doppler run -- pnpm e2e:itx

# golden-path smokes
cd apps/os && doppler run -- pnpm exec tsx e2e/engine/onboarding-smoke.ts
cd apps/os && doppler run -- pnpm exec tsx e2e/tui-test/data-layer-smoke.ts

# preview deploy (semaphore lease held per PR)
GITHUB_TOKEN=$(gh auth token) GITHUB_PR_NUMBER=1585 doppler run --preserve-env --project _shared --config prd -- pnpm preview deploy
```
