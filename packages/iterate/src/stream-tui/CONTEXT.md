# Stream TUI

This folder contains the modules behind the published `iterate chat` OpenTUI
agent chat CLI. The TUI is a thin terminal client on the shared itx client
stack: it holds one `Agent` capability from `connectItx`
(apps/os/src/client.ts), folds the agent stream with the SAME shared
reducer the web feed uses (`planAgentUiOps` from
`@iterate-com/ui/components/events/agent-ui-reducer`), and sends user messages
through `agent.sendMessage`.

## Language

**Agent Chat TUI**:
The terminal UI for one conversation with one project agent: live feed plus a
composer.

**Agent Feed Model**:
The pure Module that folds stream event batches into settled conversation
items plus the streaming live activity. In-memory node sibling of the browser
mirror's agent-ui processor — same reducer, no SQLite, no processor host.
_Avoid_: bespoke event interpretation, per-client reducers

**Agent Connection Module**:
The Module that owns credentials resolution, `connectItx`, the live
`stream.subscribe`, sends, and reconnect-with-replay. Replay overlap is safe
because the Agent Feed Model dedupes by offset.

**Feed Format Module**:
The pure Module that phrases feed items for the terminal, rhyming with the web
feed ("Ran code 2× · 1 request · 7.4s").

**OpenTUI Adapter**:
The entrypoint (`agent-chat-terminal.tsx`) that translates Module outputs into
`@opentui/react` elements and owns terminal runtime state only.

**Pilotty Command Module**:
The pure Module that builds repeatable `pilotty` command invocations for
agent/manual terminal automation.

**Terminal Behavior Spec**:
A checked-in black-box test that launches the Agent Chat TUI and asserts
user-visible workflow behavior. Lives in `apps/os/e2e/tui-test/` (Microsoft
TUI Test through the real `iterate chat` command).
_Avoid_: browser spec, unit test, renderer invariant

**Pilotty Session**:
A named managed PTY session used by a manual terminal automation run.
_Avoid_: tmux pane, shell session

## Relationships

- The OpenTUI Adapter renders exclusively from the Agent Feed Model snapshot
  plus the Agent Connection status; it never interprets raw events itself.
- The Agent Connection Module hands every delivered batch to the Agent Feed
  Model and reads its `lastOffset` as the resume cursor on reconnect.
- Terminal Behavior Specs launch the real `iterate chat` command through a PTY
  against a disposable project (see apps/os/e2e/tui-test/run.ts).

## Rules

- Keep OpenTUI imports in the Adapter; Modules stay renderer-agnostic.
- Reuse os source and shared packages for itx types and reducers — no
  bespoke stream client, no local event-type switch statements beyond the
  shared reducer.
- Prefer unit tests for Modules and Terminal Behavior Specs for workflows.
- In `pilotty`, flags go before positionals: `pilotty spawn --name stream-tui
node packages/iterate/bin/iterate.js chat ...`.
- The legacy stream-browser TUI is parked in
  git history (the pre-itx-v4 stream-browser TUI) — reference only.
