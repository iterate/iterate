status: in-progress
size: medium

# Enable use-my-computer from iterate chat

Status: specification complete; implementation and verification remain. The intended change reuses the existing `use-my-computer` subprocess and capability rather than adding another machine-access implementation.

## Goal

Let a person explicitly lend their computer to the current project without leaving an `iterate chat` session. Typing `/use-my-computer` in the chat composer starts the existing `iterate use-my-computer --json` provider alongside the TUI and keeps it alive until chat exits.

For a local username such as `joebloggs`, the project-wide capability is mounted as `itx.joebloggsComputer`, so an agent can call `itx.joebloggsComputer.runSwift(...)`.

## Acceptance criteria

- [ ] `/use-my-computer` is handled locally and is never sent as an agent chat message.
- [ ] The capability name is derived deterministically from the operating-system username and is a valid camelCase itx path, e.g. `joebloggsComputer`.
- [ ] The chat UI visibly reports starting, live, reconnecting, conflict, invocation, and failure states emitted by the existing machine provider.
- [ ] Repeating `/use-my-computer` while the provider is already starting or live is idempotent and does not launch a competing provider.
- [ ] Exiting chat closes the provider's stdin so the existing fail-closed `--json` lifecycle stops sharing.
- [ ] Tests cover slash-command recognition, username naming, and the user-visible TUI workflow.
- [ ] Relevant package tests, typecheck, lint, and formatting pass.

## Security boundary

This adds no new callable machine primitive: the mounted capability remains the existing project-wide `ask`, `notify`, and unrestricted `runSwift` surface. It does make that high-privilege surface easier to activate, so activation stays an explicit slash command, the mounted name and state stay visible, duplicate activation is blocked, and sharing is tied to the chat process lifetime.

## Implementation log

- 2026-07-17: Replaced the superseded chat-specific machine implementation in PR #1709 with this narrower design, which launches and observes the maintained `use-my-computer --json` provider.
