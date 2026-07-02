# itx-v4 → apps/os migration — progress report

_Branch: `itx-v4-os-replacement` · PR #1585 (draft) · preview slot: preview-2 · as of 2026-07-02_

## Goal

Replace the itx system and all domain implementations in `apps/os` with the
`apps/minimal-itx-v4` engine ("the next engine"), keeping product features
(custom hostnames, admin pages, REPL, examples, chat TUI, streams example app,
inbound MCP). Slack/Google/integrations are temporarily removed and return in
the final phase. Approved plan: `~/.claude/plans/nifty-juggling-candy.md`.

**Posture (locked):** security is explicitly out of scope (only invariant kept
is per-project confinement); everything resets (no data migration); one giant
PR; Playwright must stay green at phase boundaries; test frequently against the
local dev server and manually manage preview deploys.

**Strategy:** coexist-then-cutover. The next engine was transplanted _alongside_
the legacy stack (temporary `/api/itx-next` surface) so the old dashboard kept
working while the backend and then the frontend were moved over, minimizing the
window where anything is red.

## Where things stand

### Done & committed (6 commits on the branch)

| Commit    | What                                                                                                                                                 |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `9a2a56d` | **Slice A** — engine transplanted to `apps/os/src/next/`; 8 `-next-*` alchemy workers; coexistence lanes; engine e2e suites in `apps/os/e2e/engine/` |
| `2153c0b` | **Slice B.1** — real auth adapter (`src/next/auth.ts`)                                                                                               |
| `3bd877c` | **Slice B.2** — project create via auth worker + onboarding agent bootstrap                                                                          |
| `481a923` | **Slice B.3** — openai-ws provider ported verbatim                                                                                                   |
| `5eaa994` | **Slice C.1** — browser stream mirror ported to `src/next/domains/streams/client-libraries/`                                                         |
| `054a191` | **Slice C.2** — cutover core: itx-react, project server fns, CLI, inbound MCP, e2e test-support                                                      |

### In flight (uncommitted working tree — ~45 files)

- **apps/os frontend cutover** (mirror-view + REPL/examples agents' output): all
  stream/agent view components (`project-stream-view.tsx`, `agent-feed.tsx`,
  `stream-tree-browser.tsx`, `path-breadcrumbs.tsx`, `global-command-palette.tsx`,
  `reactivity.tsx`, admin streams, etc.) re-pointed at the next mirror + surface;
  REPL types/examples rewritten; `stream-navigation.ts`/`stream-switcher-dialog.tsx`
  moved off shared types; itx-react unit-test mock updated for the `authenticate()`
  pipeline. **Typecheck + apps/os unit tests green (441 passed).**
- **apps/streams-example-app refactor** (background agent just finished): worker
  re-exports the next `StreamDurableObject`; frontend on the next mirror; its
  vitest (20 passed) + Playwright (26 passed) green per the agent. **Not yet
  independently re-verified by me.**
- **Not yet committed or full-suite-verified together.** The last committed point
  (`054a191`) already swept in some agent output; the working tree is the rest.

### Not started

- **Phase 4** — dedicated alchemy/ingress rewrite for the final single-vs-multi
  topology (currently coexistence: `-next-*` workers beside legacy).
- **Phase 6** — examples matrix dispatchers (partially done by the REPL agent),
  full CLI matrix runtime.
- **Phase 7** — purge `packages/shared/{streams,callable,durable-object-utils}`
  (blocked until all legacy consumers are deleted at cutover-complete).
- **Phase 8** — the five-goal Playwright specs (signup, create-project,
  agent-chat) — feed testids just added; specs not written yet.
- **Phase 9** — endgame: delete `apps/minimal-itx-v4`, legacy `src/itx` +
  `src/domains`, workspace-wide green.
- **Phase 10** — chat TUI rebuild on the shared client stack.
- **Phase 11** — optional `DynamicWorkerRef` build/bundling (TS project workers).
- **Phase 12** — bring back Slack + Google + slack agent e2e.
- **Task #13** — custom hostnames + auth-worker `listAll`/`byHostname` + admin pages
  (deferred from Phase 3 per golden-path-first; parked with `TODO(task #13)`).

## Verified working (golden path)

Against the local dev server (`/api/itx-next`), the next engine end-to-end:

- Engine e2e suites: **56/56 against the deployed preview-2**; 50/56 vs local
  vite dev (6 known vite-dev-only capnweb/workerd env failures — see learnings).
- **Create project → onboarding agent greets unprompted** in ~9s (auth → bootstrap
  saga → repo seed → birth certificate → openai-ws → codemode → chat.sendMessage).
- **openai-ws is the live default provider** when the OpenAI key is present.
- **CLI**: `pnpm cli itx run --eval 'return await itx.whoami()'` → `"admin"`;
  `itx agent-smoke ... "Reply with exactly: pong"` → `pong` in 2.2s.
- apps/os unit tests: **441 passed / 2 skipped**; typecheck clean (non-quarantine).

## Key architecture decisions

1. **Coexistence via a parallel path, not a fork of routing.** The next engine
   serves capnweb at `/api/itx-next` (+ `/__itx_e2e` fixtures + `/prj_<id>`
   ingress); the os ingress/app workers forward those lanes to a dedicated
   `-next-api` worker (`src/next/ingress.ts`). Legacy `/api/itx` + dashboard
   stayed untouched through Slice A/B. At cutover, itx-react/CLI/server-fns were
   flipped to `/api/itx-next`; the final rename to `/api/itx` + legacy deletion
   is the endgame.
2. **All RpcTarget classes live in `src/next/rpc-targets.ts`** (per Jonas): the
   MCP/OpenAPI/capability-provision/stream-subscription/egress facades were
   consolidated there out of their domain files; domains keep only DO + entrypoint
   classes.
3. **`src/next` has its own `Env`** (`src/next/env.ts` + `nextEnv` accessor),
   deliberately decoupled from the legacy global ambient `Env`/`ctx.exports` types
   so the two stacks' types don't leak into each other during coexistence.
   `ctx.exports.ItxEntrypoint` is resolved structurally (`itxEntrypointBinding`).
4. **Auth adapter** (`src/next/auth.ts`): `authenticate()` lanes are
   `from-server-cookie` (admin cookie → iterate_session via auth-worker JWKS),
   `bearer`, `admin-secret`, and admin-gated `impersonate` (lets engine e2e
   exercise per-project confinement without minting real users — replaced the
   fake token/trusted-internal wire credential). `authenticate()` and
   `projects.get()` became **async** so the stale-claims directory fallback can
   run before the confinement assert.
5. **Stale claims solved in the adapter, not via refresh choreography.**
   `ensureCanAccessProject` consults the auth-worker project directory (cached)
   on a claims miss and widens the live context. Create widens the creating
   session immediately.
6. **os D1 is gone; the auth worker is the project directory.** Server fns read
   from session claims (fast path) + `project.bySlug` (miss). Create goes through
   the engine over a one-shot capnweb HTTP batch forwarding the caller's session
   cookie (user lane → `createForOrganization` → org grant → claims).
7. **Browser mirror = second host of the same engine.** The mirror keeps its
   event-table + derived-tables shape and runs real next-engine
   `StreamProcessor` contracts in the browser; announcement events preserved;
   OPFS cache bumped to v4 and writer locks `next-`prefixed so both engines
   coexist on one origin without collision.
8. **openai-ws ported verbatim** (WS Responses transport), not reduced to HTTP —
   per Jonas. Both providers guard on `state.llmProvider`; default computed in
   the project DO (openai-ws when key present, else cloudflare-ai).
9. **Static repo seed at create** (minimal's model): `AGENTS.md` + rewritten
   `ONBOARDING.md` are static strings in `PROJECT_REPO_INITIAL_FILES` — no base
   artifact, no separate seeding step.
10. **Quarantine over delete.** Old-surface suites (`itx-egress/extend/http/
mcp-auth/openapi/subscribe`, old `itx.e2e.test.ts`, legacy `agents.itx.e2e`,
    one streams-example legacy RPC test) moved to `test-quarantine/` with
    per-file headers + README cataloguing the path back; excluded from
    tsconfig/vitest. Nothing load-bearing deleted until the endgame.

## Learnings / difficulties

- **Workers RPC doesn't pipeline through unresolved returns.** In script isolates
  the examples had to `await itx.workers.get(...)` / `await itx.agents.get(...)`
  before calling methods, or they fail with `The RPC receiver does not implement
the method "X"`. Documented in the examples + matrix.
- **A masked `internal error; reference =` on repo-sourced project workers vs
  LOCAL vite dev.** The engine's own `itx.e2e` "create project + project worker
  fetch" and dynamic-worker examples fail identically against local vite dev but
  **pass against the deployed preview (56/56)**. Consistent with the known
  capnweb/vite-dev RpcTarget-identity class. Treat vite-dev-only engine failures
  as environmental; verify on preview. (6 local engine failures are all this
  class.)
- **Killing a backgrounded task that ran `pnpm dev restart` kills the dev
  server** (restart re-parents it into the task's process group). Start the dev
  server with `pnpm dev start --detach` as its own step; never wrap a restart in
  a long-lived background verification command. (This just happened — the dev
  server is currently down and needs a clean `pnpm dev start --detach`.)
- **The custom `no-raw-durable-object-binding-access` lint rule** has a path
  allowlist that had to be extended for `src/next/`.
- **`newHttpBatchRpcSession` is lint-banned** (`iterate/no-capnweb-http-batch`);
  the two legitimate one-shot request-scoped uses (project-create server fn,
  MCP `exec_js`) carry justified inline disables.
- **streams-example-app needed an `~/request-context.ts` shim** — the next auth
  graph type-imports os's RequestContext, whose TanStack `Register` module
  augmentations break the standalone app's program; a type-only slice shim
  (`src/os-shims/`) resolves it.
- **Preview deploy invocation**: needs `GITHUB_TOKEN` + running under
  `doppler run --project _shared --config prd` (semaphore lease). Preview-2 is
  leased to this PR.

## Immediate next steps

1. **Restart the dev server** cleanly (`pnpm dev start --detach`) — it's down.
2. Fast-fail verify the in-flight tree: typecheck → apps/os unit → a focused
   Playwright subset (dashboard + reactivity + one repl) against local dev.
3. Commit the frontend cutover + streams-example-app refactor.
4. Deploy preview-2, run engine + example-app suites against it.
5. Write the five-goal Playwright specs (Phase 8): signup (OTP 424242),
   create-project, agent-chat (feed testids `agent-feed-message[data-kind]` just
   added).
6. Then endgame slices (7/9) and the deferred phases.

## How to run things

```bash
# dev server (do NOT wrap a restart in a killable background job)
cd apps/os && pnpm dev start --detach

# focused engine e2e vs local dev
cd apps/os && doppler run -- pnpm exec vitest run --config e2e/vitest.config.ts e2e/engine/streams.e2e.test.ts

# vs deployed preview
cd apps/os && doppler run --config preview_2 -- ITX_BASE_URL=https://os.iterate-preview-2.com pnpm exec vitest run --config e2e/vitest.config.ts e2e/engine/

# onboarding smoke
cd apps/os && doppler run -- pnpm exec tsx e2e/engine/onboarding-smoke.ts

# preview deploy
GITHUB_TOKEN=$(gh auth token) GITHUB_PR_NUMBER=1585 doppler run --preserve-env --project _shared --config prd -- pnpm preview deploy
```
