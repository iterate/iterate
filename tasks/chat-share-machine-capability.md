---
status: in-progress
size: medium
---

# Chat mode: share the human's machine with the agent

## Status summary

Implemented and verified. The `iterate chat` TUI now **shares the human's
filesystem/machine with the agent by default** (session-scoped), and `/share`
widens that to the whole project. Live-verified against prod: both mounts land,
the Workspace-aligned method surface is invocable, and the plumbing (connect at
project scope → derive agent → mount on both scopes) works.

Design in one paragraph: a live capability at `itx.usersMachine` — an ephemeral,
session-scoped sibling of `itx.sandbox` (a real machine with a shell). On chat
start it's mounted on the **agent scope** automatically (a coding agent that
can't touch the filesystem makes no sense, so this is on by default, no command).
`/share` additionally mounts it on the **project root** so every agent in the
project can reach the machine while the CLI runs; `/unshare` narrows back. Both
mounts are `type: "live"` so **Ctrl+C revokes everything** (the stub dies with
the socket). Commands are `/`-prefixed, not `!` (on a CLI `!` means "run a shell
command").

Also lands a general agent-prompt fix so runtime-mounted capabilities are
discoverable at all (see below), and reshapes the capability to gel with the new
itx-v4 filesystem model.

One **pre-existing, unrelated** test failure remains on `main` — see notes.

## Design decisions

- **Default = session, `/share` = project.** Filesystem access is on from chat
  start, mounted on the agent scope (only the agent you're talking to). `/share`
  mounts on the project root too (all agents). `/unshare` revokes the project
  mount. Rationale: a CLI coding agent must be able to operate on the filesystem
  to be useful, so the useful default is "shared with this session"; "sharing"
  as a verb should mean the bigger thing — opening it to the project.
- **One socket, two scopes.** The `Agent` stub only exposes its own capability
  host; only `Project` can mount on the project root (`capabilityHosts.get("/")`).
  So the TUI connects at **project scope** and derives the agent from it
  (`project.agents.get(agentPath)`), holding both stubs on one socket.
- **Slash, not bang.** `/share` / `/unshare`, parsed in the composer and never
  sent as chat turns. Unknown `/…` inputs fall through to normal messages.
- **Capability shape gels with itx-v4.** `itx.usersMachine` is deliberately a
  sibling of `itx.sandbox` (live machine + shell), NOT of the durable stores
  (`itx.files` blob store / `itx.workspace` git-backed DO). So:
  - `exec(command, cwd?) → { stdout, stderr, exitCode }` — sandbox-shaped.
  - filesystem verbs copy **`itx.workspace`'s signatures** so agents transfer
    their workspace fluency: `readFile(path) → string | null` (null when
    missing), `writeFile(path, content)`, `edit({ path, oldString, newString,
replaceAll? })`, `readDir(dir?)` / `glob(pattern, cwd?) → file-info objects
{ path, name, type, size }`.
  - `notify(message)` — local-only desktop notification.
  - `readFile` refuses files > 1MB (throws) rather than silently truncating —
    a truncated read fed back into `edit`/`writeFile` would corrupt the file.
- **Discovery.** The agent prompt is static, so a mid-session mount is invisible
  unless the agent calls `__describe()`. A hard nudge in
  `agent-processor-contract.ts` (DISCOVERING THE SURFACE) tells the agent its
  surface changes at runtime, so it must `__describe()` before claiming it can't
  do something — a general fix for ALL runtime-mounted capabilities. (An earlier
  per-share announcement message was tried and removed in favour of this.)
- **Visibility & safety.** Every invocation surfaces as a TUI notice
  (`machine ← exec: …`) and the header shows `fs: session` / `fs: project`.
  ⚠️ POC still has **no per-command confirmation or allowlist** — the agent runs
  as the human. Deferred (follow-ups).

## Files

- `machine-capability.ts` — the live capability + `__describe` instructions/types
- `chat-slash-command.ts` (+ test) — `/share` / `/unshare` parsing
- `agent-connection.ts` — project-scope connect, session default mount,
  `shareWithProject`/`unshareFromProject`, re-provide on reconnect
- `agent-chat-terminal.tsx` — slash interception, default-share notice, invocation
  notices, `fs: session|project` header indicator
- `apps/os/src/domains/agents/agent-processor-contract.ts` — the discovery nudge

## Checklist

- [x] `machine-capability.ts`: Workspace-aligned surface (exec/readFile/writeFile/
      edit/readDir/glob/notify) + `instructions`/`types` + `onInvocation` hook
- [x] unit tests (write→glob→read→edit roundtrip; readFile null; readDir; exec)
- [x] `/share` / `/unshare` slash-command parsing, unit tested
- [x] `agent-connection.ts`: project-scope connect, always-on session mount,
      project mount toggle, re-provide both on reconnect
- [x] `agent-chat-terminal.tsx`: slash interception, default-share notice,
      invocation notices, `fs:` header indicator
- [x] agent-prompt discovery nudge (general fix)
- [x] merge latest `main`; reconcile with itx-v4 (types.ts → itx-api.generated.ts,
      reducer union drift, capability shape gels with files/workspace/sandbox)
- [x] verify end-to-end against a live agent (prod, admin secret): both mounts land,
      Workspace-style verbs invocable, revoke works
- [x] typecheck (iterate pkg — excluded from root typecheck by design) / lint /
      format / tests green

## Pre-existing issue found (NOT introduced here)

`agent-feed-model.test.ts > folds a chat round` fails on `main`, independent of
this branch: after `web-message-sent` the live activity no longer settles to
null. It failed even against the reducer from before the `stream-woken` commit,
so it's older/stale (likely a drifted event name). I keep the TUI's `FeedItem`
exhaustive over the (repeatedly drifting) reducer union, but do **not** touch the
reducer test semantics — that needs the feed-model author's intent. Flagged.

## Follow-ups (out of scope)

- Per-command approval mode or read-only default; allowlist config
- Scope `/share` to a named path or a subset of methods
- `edit` diff preview in the TUI before the write lands

## Implementation log

- (v1) `!share`/`!unshare`, agent-scope-only, object-arg surface. Verified on
  prod; exposed the static-prompt discovery gap → added the agent-prompt nudge,
  removed an announcement-message stopgap. Added the first-eval task.
- (v2, this pass) Merged 49 commits of `main` (itx-v4 engine). Reconciled: import
  path `types.ts` → `itx-api.generated.ts`; `FeedItem` made exhaustive over the
  new reducer union (`child-stream-created`, `stream-paused/resumed`).
- (v2) Redesigned per feedback: `/`-commands; filesystem shared **by default**
  (session/agent scope); `/share` widens to the project (project-root mount);
  Ctrl+C revokes all. One socket, two scopes (connect at project, derive agent).
- (v2) Reshaped the capability to gel with itx-v4: sibling of `itx.sandbox`,
  filesystem verbs copy `itx.workspace` signatures (positional, `readFile →
string|null`, `glob`/`readDir → file-info`), added `edit`.
- (v2) Live-verified the two-scope plumbing against prod with the admin secret.
