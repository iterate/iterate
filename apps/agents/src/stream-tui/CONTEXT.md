# Stream TUI

This folder contains the pure Modules behind `apps/agents`' OpenTUI stream CLI. The CLI script is the OpenTUI Adapter; it should call these Modules instead of owning command discovery, navigation, path semantics, and test harness details directly.

## Language

**Stream TUI**:
The terminal UI for looking at one event stream, appending input, and navigating local stream tools.

**OpenTUI Adapter**:
The renderable/input Implementation that translates Module outputs into `@opentui/core` renderables.

**Slash Discovery Module**:
The pure Module that turns command records plus the current composer text into slash suggestions.

**Command Router Module**:
The Module that owns the local oRPC-style command hierarchy, command handlers, input schemas, and TUI metadata.

**Command Invocation Module**:
The pure Module that parses a submitted slash command into command input.

**Stream Context Module**:
The pure Module that resolves current-stream-relative paths and formats paths back for command input.

**Navigation Module**:
The pure Module that owns view and focus state transitions. Panel state should
only return here once the Adapter renders a real panel.

**Feed Formatting Module**:
The pure Module that prepares reduced feed items for terminal display without creating OpenTUI renderables.

**Pilotty Command Module**:
The pure Module that builds repeatable `pilotty` command invocations for agent/manual terminal automation.

**Terminal Automation Run**:
A manual or agent-driven run that drives the **Stream TUI** through a managed PTY session and records visible behavior.
_Avoid_: checked-in spec, unit test

**Terminal Behavior Spec**:
A checked-in black-box test that launches the **Stream TUI** and asserts user-visible workflow behavior.
_Avoid_: Browser spec, unit test, renderer invariant

**Terminal Rendering Spec**:
A checked-in test that asserts terminal screen invariants such as sticky scroll, wrapping, cursor state, colour, or scrollback.
_Avoid_: command parser test, reducer test

**Pilotty Session**:
A named managed PTY session used by a **Terminal Automation Run** to isolate one running terminal app.
_Avoid_: tmux pane, shell session

## Relationships

- A **Terminal Automation Run** owns exactly one **Pilotty Session** per scenario.
- A **Pilotty Session** is created before user-visible assertions and killed during cleanup.
- A **Terminal Automation Run** should inspect visible text or screen snapshots, not internal reducer state.
- **Terminal Behavior Specs** use Microsoft TUI Test and launch the real `stream-tui` CLI command through a PTY.
- **Terminal Rendering Specs** are expected to use a screen-aware runner such as Termless if its spike succeeds.

## Rules

- Keep OpenTUI imports in the Adapter unless a Module is explicitly about rendering.
- Keep command discovery slash-first; terminal-wide shortcuts are optional polish.
- Let the local oRPC command router remain the source of truth for command hierarchy, handlers, input schemas, and TUI metadata.
- Prefer unit tests for Modules, **Terminal Behavior Specs** for workflows, and **Terminal Rendering Specs** for screen invariants.
- In `pilotty`, flags go before positionals: `pilotty spawn --name stream-tui pnpm --dir apps/agents ...`.
- Do not add a command result envelope. Commands call app context for UI effects and rely on oRPC/Zod errors for failures.
