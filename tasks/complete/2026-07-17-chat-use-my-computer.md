status: complete
size: medium

# Enable use-my-computer from iterate chat

Status: complete. `/use-my-computer` now launches the existing provider from chat, derives its name from the OS username, shows provider state and activity, and stops sharing with the chat process. Unit, full-repo, build, lint, typecheck, knip, and black-box TUI checks pass.

## Goal

Let a person explicitly lend their computer to the current project without leaving an `iterate chat` session. Typing `/use-my-computer` in the chat composer starts the existing `iterate use-my-computer --json` provider alongside the TUI and keeps it alive until chat exits.

For a local username such as `joebloggs`, the project-wide capability is mounted as `itx.joebloggsComputer`, so an agent can call `itx.joebloggsComputer.runSwift(...)`.

## Acceptance criteria

- [x] `/use-my-computer` is handled locally and is never sent as an agent chat message. _The composer intercepts it through `chat-slash-command.ts`; the PTY spec verifies it never appears as a `you ›` turn._
- [x] The capability name is derived deterministically from the operating-system username and is a valid camelCase itx path, e.g. `joebloggsComputer`. _`computerCapabilityName` normalizes `userInfo().username`, including punctuation and numeric prefixes._
- [x] The chat UI visibly reports starting, live, reconnecting, conflict, invocation, and failure states emitted by the existing machine provider. _`chat-computer-sharing.ts` folds the provider's NDJSON into the existing header notice._
- [x] Repeating `/use-my-computer` while the provider is already starting or live is idempotent and does not launch a competing provider. _The controller keeps one generation-guarded child process and tests duplicate starts._
- [x] Exiting chat closes the provider's stdin so the existing fail-closed `--json` lifecycle stops sharing. _The controller is disposed on process exit; the child already treats stdin EOF as its shutdown signal._
- [x] Tests cover slash-command recognition, username naming, and the user-visible TUI workflow. _Focused Vitest specs cover the controller/parser; Microsoft TUI Test proves the real provider mounts through chat._
- [x] Relevant package tests, typecheck, lint, and formatting pass. _Verified with root test/typecheck/lint/format/knip, the iterate build, and the Doppler-backed local TUI run._

## Security boundary

This adds no new callable machine primitive: the mounted capability remains the existing project-wide `ask`, `notify`, and unrestricted `runSwift` surface. It does make that high-privilege surface easier to activate, so activation stays an explicit slash command, the mounted name and state stay visible, duplicate activation is blocked, and sharing is tied to the chat process lifetime.

## Implementation log

- 2026-07-17: Replaced the superseded chat-specific machine implementation in PR #1709 with this narrower design, which launches and observes the maintained `use-my-computer --json` provider.
- 2026-07-17: The live PTY proof created a disposable project, submitted `/use-my-computer`, waited for the existing provider's end-to-end mount ping, and confirmed the slash command was not journaled as a user message.
