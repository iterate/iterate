# Proof-of-concept plan: collaborative workspaces end-to-end

> **STATUS 2026-07-21: ALL FIVE PHASES PROVEN LOCALLY.** Worktrees:
> `iterate-collab-poc` + `tasks-collab-poc` (branch `collab-poc` in both, off
> origin/main, uncommitted). Results:
> - **Phase 0**: `tasks-collab-poc/scripts/dev-local.sh` boots platform +
>   vessel + header-stamping proxy in one command; board fully working
>   against local platform (project `collab-poc`, browser-verified).
> - **Phase 1**: `apps/os/src/domains/workspaces/collab-engine.ts` (~300
>   lines, @codemirror/collab rebase model, WAL-before-ack via DO SQLite
>   transactionSync) + `collab-engine.test.ts` fault harness — 11 tests green
>   incl. 5-seed fuzz with mid-run crashes. The harness caught 2 real bugs
>   (rebaseUpdates prefix-alignment; clientID casing). DO integration:
>   readFile/writeFile/edit route through live docs; gitStatus/gitCommit
>   barrier-settle; live-verified via itx CLI.
> - **Phase 2**: vessel `collab()` capability forwarding to the platform
>   workspace. Latency (local): hop (a) browser→vessel→workspace push p50
>   5ms / deliver p50 6ms; direct (b) p50 2ms. Both fine; (b) is the prod
>   answer. Session continuity across processes/restarts confirmed.
> - **Phase 3**: two real browser tabs (CM6 + @codemirror/collab page at
>   `/collab/<checkoutId>?path=...`) + agent via STANDARD `itx.workspace`
>   `readFile`/`edit` — all three writers converged; agent saw live
>   keystrokes in its read and its edit appeared live in both tabs.
> - **Phase 4**: `probe-board.mjs` — board seeded via workspace `glob`,
>   dirty via `gitStatus` (which settled an in-flight live edit), commit via
>   `gitCommit` carrying that edit, overlay cleared, commit on main. No
>   `meta.base`, no Y.Doc, no `listTaskFiles` anywhere on this path.

Goal (Jonas, 2026-07-21): "a minimum sort of proof of concept of all this somehow …
including through the extra hop of the tasks app. The task app doesn't have the
workspaces in it so it sort of needs to proxy to them. … It needs to be ergonomic to do
maybe somehow with a local app/os dev server and a local tasks dev server strung
together in just the right way."

Architecture under proof: Rev 3 of `session-mode-proposal.md` (per-file rebase engines in
the workspace DO, no Yjs, WAL-before-ack, WS hot path, streams for lifecycle).

## Local two-server harness (Phase 0 — wiring, no new product code)

- **apps/os dev server**: `pnpm dev` in `iterate/apps/os` (runs `tsx ./scripts/dev.ts`).
- **tasks dev server**: `pnpm dev` in `iterate/tasks` (vite dev) with `OS_BASE_URL`
  pointing at the local apps/os origin instead of `https://os.iterate.com`.
- Seed a local project; mint a local project-app-session token (same recipe as the prod
  probe in memory: HS256 with the local `APP_CONFIG_PROJECT_APP_SESSION_SECRET`, claims
  `{audience, exp, iat, projectId, type: "project-app-session", userId}`).
- Reuse/adapt `scripts/probe-rpc.mjs` to hit `http://localhost:<tasks-port>` with
  `x-itx-project-id` header + token — no config-repo proxy needed for local↔local (the
  proxy/captun `tasks-app-origin` dance is only for prod-domain → local-tasks).
- **Deliverable**: existing tasks board works fully against the local platform; one
  `scripts/dev-all` command (or documented two-terminal recipe) boots both with correct
  env; a seeded fixture project with a repo containing `tasks/` files.
- This phase has standalone value: it's the first time the vessel runs against a local
  platform at all.

## Phase 1 — collab engine slice (platform-side, no tasks app yet)

In `apps/os` workspaces domain: a per-file engine module (CM `ChangeSet` lane only) +
`collab.open(path)` / `push` / `pull` on the workspace RPC target + a hibernating-WS
endpoint on the workspace DO for fan-out. WAL table + snapshot rows + settle-to-overlay
through the existing write chain. Vendored `@codemirror/collab` server helper
(`rebaseUpdates`).

Test harness before any UI: vitest DummyServer-style multi-client convergence tests plus
the fault harness — kill the DO after each persistence boundary, duplicate/delay/reorder/
drop fan-out messages, assert: every acked op survives restart; all clients converge to
the fold of the log; `readFile` sees the live head; `gitCommit` settles exactly that head.

## Phase 2 — the tasks-app hop

The vessel gains `checkout.collab(path)` forwarding to the platform workspace (same
plain-data forwarding pattern as existing checkout ops; capnweb pipelining keeps it one
round trip). Two variants for the browser hot path:

- **(a) proxy hop** (PoC first): browser → vessel `/api` capnweb → platform workspace.
  Simple, measures the double-hop latency honestly.
- **(b) direct** (expected production answer): vessel mints/hands the browser a
  short-lived credential + URL for the workspace DO's WS endpoint; live traffic skips the
  vessel entirely. Prove after (a), compare latency.

## Phase 3 — humans + agent on one file

CM6 editor in the tasks sheet running `@codemirror/collab` through the Phase 2 path. Two
browsers typing concurrently + the agent probe script doing `readFile`/`edit`/`writeFile`
mid-typing (through the standard itx.workspace API). Assert: no lost keystrokes, agent
edit appears as a remote transaction (undo-safe), `edit` stale-match fails loudly when
racing, board reflects changes via `files-changed`/status.

## Phase 4 — checkout = workspace

Back a checkout with a real platform workspace: seed board via `glob` + frontmatter
parse, dirty badges via `gitStatus`, commit via `gitCommit`. Retires `meta.base` and
`listTaskFiles` on the PoC path. This is the convergence moment: the tasks app becomes a
thin surface over a platform workspace.

## Exit criteria / decision gates

- Fault harness green (Phase 1) before any UI work.
- Double-hop vs direct latency numbers (Phase 2) decide the production topology.
- Load probe: 10 clients typing + agent touching many closed files — DO CPU, op latency,
  WAL growth, cold-recovery time.
- Yjs re-entry gate (per Codex): only if bounded-offline recovery, long-lived anchors, or
  editor rebasing demonstrably can't meet requirements.

## Open questions being answered by the PoC

- Real latency of vessel-proxied vs direct WS hot path.
- Whether `publishVolatile` (non-journaled stream lane) is worth building vs direct WS.
- WAL/snapshot tuning (batch window, snapshot cadence) under real typing.
- How much of the engine can live in `WorkspaceCore` (host-agnostic, testable) vs the DO.
