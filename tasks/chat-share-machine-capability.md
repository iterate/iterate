---
status: in-progress
size: small
---

# `!share` in chat mode: session-scoped local-machine capability

## Status summary

POC implemented and green (new tests + typecheck + lint pass). `!share`/`!unshare`
work in the chat composer; the live capability (exec/readFile/writeFile/glob/notify)
mounts on the agent's scope and re-provides across reconnects. Not yet driven
end-to-end against a live agent (needs a running `pnpm dev` + doppler). One
**pre-existing, unrelated** test failure found on `main` — see notes.

## Goal

While chatting with an agent via `iterate chat` (the OpenTUI terminal app), typing
`!share` should provide the agent a **live capability** that lets it interact with
the user's machine — for exactly as long as the chat session is connected. `!unshare`
revokes it. This mirrors the spirit of Slack's `!debug` bang command: a magic message
prefix that does something mechanical instead of becoming an LLM turn.

The transport already exists: the TUI holds an `Agent` capnweb stub
(`apps/os/src/itx-client.ts` → `agent-connection.ts`), and `Agent` exposes
`provideCapability` (`apps/os/src/types.ts` ~line 486). A `type: "live"` capability
is held in-memory by the capability host and calls route back over the provider's
WebSocket, failing `"offline"` when it drops — exactly the right lifetime semantics
for "my laptop, while I'm in this chat".

## Decisions (assumptions marked ⚠️)

- **Interception point**: `!share` / `!unshare` are intercepted in the TUI composer
  (`agent-chat-terminal.tsx` `submit`) and never sent as chat messages. Result is
  shown via the existing `notice` header slot. ⚠️ Unknown bang commands (e.g. `!foo`)
  fall through and are sent as normal messages — the Slack-side compiler has richer
  behavior (`itx.` expression eval) that we're not replicating here yet.
- **Mount path**: `["usersMachine"]` on the **agent scope** (the `Agent` stub's
  `provideCapability` mounts on the agent's own capability host). Agents call
  `itx.usersMachine.exec({command: "ls"})` in codemode. ⚠️ Chose agent scope over
  project scope on purpose: you're sharing with the agent you're talking to, not
  every agent in the project.
- **Capability surface** (all methods take a single object arg, return JSON-safe
  values):
  - `exec({command, cwd?}): {stdout, stderr, exitCode}` — shell out (`sh -c`),
    output truncated to keep payloads sane.
  - `readFile({path}): {content}` — utf8.
  - `writeFile({path, content}): {bytesWritten}`
  - `glob({pattern, cwd?}): {matches}` — passthrough for `fs.promises.glob`.
  - `notify({message}): void` — macOS `osascript` notification, best-effort no-op
    elsewhere.
- **Visibility**: every incoming invocation is surfaced in the TUI as a notice
  (e.g. `machine ← exec: ls ~/src`), so the user can see what the agent is doing
  on their machine in real time.
- **Safety**: ⚠️ POC has **no confirmation prompt or allowlist** — `!share` prints
  a clear warning that the agent can now run arbitrary commands as you. Per-command
  approval / read-only mode is explicitly deferred (see follow-ups).
- **Reconnects**: `agent-connection.ts` re-dials on broken sessions. The live stub
  dies with its socket, so when the connection re-establishes and sharing is active,
  the TUI re-provides automatically (a newer mount at the same path shadows the old
  record).
- **Session end**: on quit, best-effort `revoke()` so the durable capability record
  doesn't keep advertising a dead machine. Also revoked by `!unshare`.
- **Home**: `packages/iterate/src/stream-tui/machine-capability.ts` (capability
  factory, runtime-agnostic-ish but runs under Bun like the rest of the TUI) +
  wiring in `agent-chat-terminal.tsx` / `agent-connection.ts`.

## Checklist

- [x] `machine-capability.ts`: capability factory (`exec`, `readFile`, `writeFile`,
      `glob`, `notify`) with `instructions`/`types` strings for `__describe`
      discovery, and an `onInvocation` hook for the TUI notices _(machine-capability.ts)_
- [x] unit test for the capability methods (tmpdir roundtrip: write → glob → read;
      exec echo; truncation) _(machine-capability.test.ts)_
- [x] bang-command parsing for the composer (`!share` / `!unshare`), unit tested
      _(chat-bang-command.ts + .test.ts)_
- [x] `agent-connection.ts`: expose provide/revoke on the connection + re-provide
      on reconnect while sharing is active _(shareMachine/stopSharingMachine + provideMachine() in establish())_
- [x] `agent-chat-terminal.tsx`: intercept bang commands, warning + status notices,
      invocation notices _(submit() interception + onMachineInvocation notice)_.
      Revoke on quit is best-effort via the existing `connection.dispose()` on
      process exit — the live stub dies with the socket regardless.
- [ ] verify end-to-end against local dev (`pnpm dev`): `!share`, ask agent to
      `itx.usersMachine.glob(...)`, watch it run _(not done — needs running dev
      server + doppler; deferred to reviewer / follow-up)_
- [x] typecheck / lint / format / new tests all pass

## Pre-existing issue found (NOT introduced here)

While running the package suite I found `agent-feed-model.test.ts > folds a chat
round` failing on `origin/main`, independent of this branch. After
`web-message-sent` the live activity no longer settles to null. I confirmed it
fails even against the reducer from _before_ the recent `stream-woken` commit
(`34f48c4f`), so it's an older stale test (likely a drifted event name), not
caused by that commit or by this work. I fixed the _typecheck_ siblings of the
same drift in `agent-chat-terminal.tsx` (a new `stream-woken` item kind and a
removed `"waiting"` activity status) because they block compiling this package —
but I deliberately did **not** touch the reducer test semantics, as that's a
separate concern needing the feed-model author's intent. Flagged for the user.

## Follow-ups (out of scope)

- Per-command approval mode or read-only default; allowlist config
- Share on the project scope (`!share --project`) or to a named path
- Surface shared-machine status in the chat header, not just notices
- Slack `!share`-alike? (doesn't make sense there — no user machine attached)

## Implementation log

- (start) Spec committed before implementation, per worktreeify flow.
- Implemented the capability factory, bang parser, connection wiring, and TUI
  interception. New tests green; package typecheck/lint/format clean.
- Fixed two pre-existing typecheck errors in `agent-chat-terminal.tsx` from the
  `stream-woken` reducer drift (needed to compile the package).
- Found + attributed a pre-existing unrelated feed-model test failure on main
  (see section above); left it untouched.
