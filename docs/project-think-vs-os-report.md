# Project Think vs apps/os: Deep Review and Harvest

Date: 2026-07-08

This report compares Iterate OS, especially `apps/os` and its `itx` surface, against the latest local checkout of Cloudflare's Project Think work in `cloudflare/agents`.

## Source Snapshot

Iterate OS:

- Repository: `/Users/jonastemplestein/.superset/worktrees/iterate/melodic-possum`
- Commit reviewed: `1c87225503ec`
- Main areas reviewed: `apps/os`, `apps/os/src`, `apps/os/src/domains`, `docs/domain-objects-and-stream-processors.md`, `apps/os/docs`

Cloudflare Agents / Project Think:

- Repository: `/Users/jonastemplestein/src/github.com/cloudflare/agents`
- Source: `https://github.com/cloudflare/agents`
- Branch reviewed: `main`
- Commit reviewed: `d1cc31751687`
- Think package version: `@cloudflare/think@0.12.1`
- Important areas reviewed: `packages/think`, `docs/think`, `packages/agents/src/chat`, `packages/agents/src/index.ts`, `packages/agents/src/experimental/memory/session`, `packages/shell`, `packages/codemode`, `agent-think`

Research method:

- Pulled Cloudflare's repository in `~/src` to the latest `main`.
- Reviewed current code and docs.
- Mined git history for the Think, Agents, recovery, sub-agent, workspace, codemode, and agent-think arcs.
- Mined GitHub issues and PRs for roadmap, production pain, regressions, and unresolved design debates.
- Used four sub-agents for parallel review: OS architecture, Think architecture, Think history, and Think issue/PR mining.

## Executive Summary

The strongest conclusion is that Project Think and apps/os are not competing implementations of the same idea. They are adjacent layers with different centers of gravity.

Iterate OS is a durable project operating system. Its core abstraction is a project-scoped, self-describing capability space backed by append-only streams and domain processors. The important nouns are `Session`, `Project`, `Itx`, `CapabilityHost`, streams, dynamic workers, repos, workspaces, sandboxes, and processors. OS treats events as the authority, folds state from journals, and lets agents act through a scoped `itx` capability tree.

Project Think is a durable chat-turn harness. Its core abstraction is one Durable Object owning chat sessions, turn execution, resumption, tool calls, client tools, actions, submissions, channels, messengers, workspace tools, and sub-agent facets. Think treats the agent loop itself as the product surface and invests heavily in recovery from deploy churn, hibernation, lost streams, tool result races, and Durable Object memory failure.

The recommendation is not to replace OS's model with Think. OS's evented capability-space architecture is deeper and better suited to projects as durable environments. But we should aggressively import Think's lessons around turn ledgers, recovery, session projections, human-in-the-loop actions, bounded output ingestion, sub-agent run progress, messenger delivery, and observability.

The highest-value path is:

1. Keep OS streams as durable truth.
2. Add a Think-like durable turn/submission/action layer for OS agents.
3. Add a derived Think-like session/message projection for search, branching, compaction, and UI hydration.
4. Add recovery chaos tests around duplicate assistant messages, interrupted tools, deploy churn, OOMs, and reconnects.
5. Avoid direct dependence on unstable Think transcript shapes until its sessions, channels, metadata, and event model settle.

## Core Conceptual Difference

### OS: Durable Capability Spaces

OS models a project as a durable capability space. A user session authenticates into projects. A project exposes an `itx` surface. The `itx` surface exposes built-in and dynamically mounted capabilities. Agents, project workers, MCP clients, and scripts all operate by discovering and invoking capabilities.

The important OS implementation ideas are:

- `Session -> Project -> Itx -> CapabilityHost` as the authority chain.
- `__describe()` as the self-description protocol for agents and tools.
- Append-only streams as the public coordination primitive.
- Domain processors that fold streams into state and perform side effects after commit.
- Capability hosts that support dynamic mounts, parent fallback, and scoped script execution.
- Dynamic workers, workspaces, repos, and sandboxes as separate runtime/storage concepts.
- The agent loop as an event processor that produces executable `itx` scripts.

Relevant source points:

- `apps/os/src/README.md`
- `apps/os/src/rpc-targets.ts`
- `apps/os/src/domains/streams/stream-durable-object.ts`
- `apps/os/src/domains/streams/stream-storage.ts`
- `apps/os/src/domains/agents/agent-durable-object.ts`
- `apps/os/src/domains/agents/agent-processor-contract.ts`
- `apps/os/src/domains/agents/agent-processor-implementation.ts`
- `apps/os/src/domains/capability-host/capability-host-durable-object.ts`
- `apps/os/src/domains/capability-host/capability-host-processor-implementation.ts`
- `docs/domain-objects-and-stream-processors.md`

### Think: Durable Chat Turns

Think models an agent as a Durable Object that owns chat lifecycle. It gives application authors a base class that already handles sessions, messages, streaming, tools, client tools, recovery, workspace files, actions, submissions, channels, messengers, extensions, and sub-agents.

The important Think implementation ideas are:

- `Think extends Agent` as the application base class.
- `Session` as a message tree with compaction, context blocks, FTS, and branch history.
- `runFiber` as the durable execution substrate.
- `chatRecovery = true` as a default for chat turns.
- Resumable stream buffers for token replay across reconnect/restart.
- `submitMessages()` and `runTurn()` as durable acceptance boundaries.
- Actions and approval ledgers for human-in-the-loop turns.
- Sub-agent facets and retained agent tools for child work.
- Messengers and channels for Slack/Telegram/Chat SDK style ingress.
- Workspace tools backed by DO SQLite or R2, plus shell/codemode execution.

Relevant source points:

- `docs/think/index.md`
- `docs/think/lifecycle-hooks.md`
- `docs/think/tools.md`
- `docs/think/client-tools.md`
- `docs/think/sub-agents.md`
- `docs/think/programmatic-submissions.md`
- `packages/think/src/think.ts`
- `packages/agents/src/index.ts`
- `packages/agents/src/chat/resumable-stream.ts`
- `packages/agents/src/chat/resume-handshake.ts`
- `packages/agents/src/experimental/memory/session/session.ts`
- `packages/agents/src/experimental/memory/session/providers/agent.ts`
- `packages/shell/src/filesystem.ts`

## Noun Mapping

| OS concept                    | Closest Think concept                                      |                          Match quality | Notes                                                                                                                                             |
| ----------------------------- | ---------------------------------------------------------- | -------------------------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project                       | Top-level agent instance, app, workspace, or artifact root |                                Partial | OS project is a tenant/runtime/capability boundary. Think agent is a chat actor. Think does not have OS's full project operating-system boundary. |
| `itx`                         | Tool set, action/channel surface, extension host bindings  |                                Partial | `itx` is a general capability tree. Think tools are model-facing AI SDK tools plus lifecycle APIs.                                                |
| Capability host               | Extension manager, tool registry, sub-agent facet          |                                Partial | OS supports dynamic capability mounts with parent fallback. Think merges tools/extensions/session tools but not as a general introspectable tree. |
| `__describe()`                | Tool schemas, agent manifests, framework discovery         |                        Weak to partial | OS self-description is a core protocol. Think has scattered schemas/manifests but no equivalent universal capability description.                 |
| Stream                        | Resumable stream, session messages, run/action ledgers     |                                Partial | OS streams are append-only domain logs. Think streams include token buffers; its ledgers are SQL tables.                                          |
| Domain processor              | Think turn loop, recovery engine, scheduled task handler   |                                Partial | OS processors fold event streams. Think handlers orchestrate durable chat lifecycle and SQL ledgers.                                              |
| Agent stream `/agents/<name>` | Think `Session` plus turn ledger                           | Strong for chat UI, weak for authority | Think has much richer chat/session lifecycle. OS has better event authority and project integration.                                              |
| Dynamic worker                | Think extension worker, codemode Worker Loader execution   |                                Partial | Both use Workers as dynamic code surfaces. OS dynamic workers are first-class project runtime artifacts.                                          |
| Workspace                     | Think Workspace / Shell filesystem                         |                                 Strong | Think's Workspace is more mature as a chat-agent local VFS. OS workspaces are project/repo oriented and separate from chat memory.                |
| Sandbox container             | Cloudflare Sandbox / `agent-think` container worker        |                   Strong directionally | Think's stable exported sandbox tools are not ready, but `agent-think` shows the real path.                                                       |
| MCP inbound bridge            | Think MCP tools / Agents MCP transport                     |                   Strong directionally | Both use MCP as a tool/client bridge. Think has invested in resumable MCP transport.                                                              |
| Project worker event delivery | Messenger/channel/schedule ingress                         |                                Partial | OS routes domain events into project workers. Think routes external messages into agent turns.                                                    |

## Architecture Comparison

### Persistence

OS's persistence philosophy is event-source first. A stream append is the commit point: validate, assign an offset, reduce core state, persist, then fan out. Processor state and checkpoints can be rebuilt or repaired from the journal. The docs repeatedly emphasize that names are derived, reducers are pure, side effects happen in processors, and streams remain the authority.

Think's persistence philosophy is ledger first. It uses DO SQLite for several durable ledgers: session messages, compactions, FTS, config, stream chunks, workspace files, fibers, submissions, actions, and schedules. The agent loop is durable because each subsystem has a table, not because there is one universal event stream.

What OS should take:

- Use Think-like derived SQL tables for chat/session UX, but keep stream events as authority.
- Add explicit ledgers for turn status, action status, tool result settlement, and recovery incidents.
- Keep large objects out of streams. OS already does this for worker artifacts; apply the same discipline to agent tool outputs and sandbox logs.

What OS should not take:

- Do not make chat transcript tables the canonical project history.
- Do not let Think's `UIMessage` or current session schema leak across OS boundaries.
- Do not replace `__describe()` with AI SDK tool schemas; they solve different problems.

### Turn Execution and Recovery

Think's history shows that recovery is the hardest part of durable agents. Recent work repeatedly fixed deploy churn, orphaned turns, memory-limit loops, duplicate messages, parallel client-tool races, context overflow, stream replay, and durable tool-result settlement.

Important Think primitives:

- `runFiber` registers durable work before execution and recovers via alarm/retry logic.
- `chatRecovery` wraps chat turns by default.
- `ResumableStream` persists token chunks and terminal states.
- `ResumeHandshake` handles reconnect handshakes and pre-stream waiting.
- Durable settled tool results prevent completed tools from re-running after recovery.
- Recovery incidents are recorded for observability.
- Programmatic submissions create an idempotent acceptance boundary.

OS currently has a strong domain event model but less evidence of a mature chat-turn recovery engine. The OS agent processor can schedule model requests and run returned scripts, but the Think lessons show that correctness requires more than append-and-retry.

OS should add a first-class agent turn ledger with:

- `turn_requested`
- `turn_started`
- `model_stream_started`
- `assistant_message_started`
- `tool_call_requested`
- `tool_call_settled`
- `assistant_message_completed`
- `turn_completed`
- `turn_failed_terminal`
- `turn_recovery_attempted`
- `turn_recovery_terminalized`

Each event should have stable IDs:

- `turnId`
- `submissionId` or `idempotencyKey`
- `assistantMessageId`
- `toolCallId`
- `toolResultId`
- `streamId`
- `recoveryAttempt`

This would let OS replay or resume without duplicating assistant messages or re-running settled tools.

### Sessions and Message History

Think's `Session` is one of the most directly useful pieces for OS. It is not just an array of chat messages. It provides:

- Tree-structured messages via `parent_id`.
- Multiple sessions per agent.
- Branching and latest-leaf resolution.
- Context blocks.
- Compaction overlays.
- FTS5 search.
- Byte-budgeted recent history hydration.
- Chunked reads to avoid SQLite memory pressure.
- Media eviction/hydration budgets.

OS's agent stream is more authoritative, but Think's session shape is better for UI, search, branch/fork, and context-window management. OS should build a derived session projection over agent streams rather than replacing streams.

Suggested OS projection:

- Stream remains authority.
- Derived tables store `messages`, `message_parts`, `branches`, `compactions`, `message_fts`, and `turn_index`.
- Projection is rebuildable from stream events.
- UI reads from projection for fast hydration/search.
- Agents read from projection for context assembly.
- Recovery logic writes canonical events, then projection catches up.

This preserves OS's event discipline while gaining Think's chat ergonomics.

### Tools, Capabilities, and Self-Description

Think's tool system is effective for chat agents: workspace tools, custom tools, extension tools, session tools, skills, MCP tools, client tools, and actions can all be merged into the model's tool surface.

OS's capability system is more general. `__describe()` exposes instructions, types, children, parent links, and dynamic capabilities. Reads can chain upward to parent scopes while writes remain local. Unknown dotted paths can fall back to durable capability hosts. Dynamic workers and scripts receive a scoped `itx`.

The useful import is not Think's tool registry itself. The useful import is Think's operational maturity around tool lifecycle:

- `beforeToolCall` and `afterToolCall` hooks.
- Durable settled tool results.
- Action/approval ledgers.
- Client-tool pause/resume semantics.
- Tool-result recovery after disconnect.
- Tool-call observability spans.
- Explicitly bounded tool output.

OS should preserve `itx` as the primary abstraction, but add lifecycle and durable-result semantics around capability invocation when the caller is an agent turn.

### Sub-Agents and Facets

Think's sub-agent story has matured quickly:

- Sub-agent routing/facets.
- Retained streaming agent tools.
- Detached background child runs.
- Durable progress and milestones.
- Parent/child recovery integration.
- Child tools owned by the child, not the parent.

This maps well to OS agents, project workers, and stateful workers, but OS should avoid copying Think's exact facet model. Think facets live within one Agent/root machine model. OS's project boundary, capability hosts, dynamic workers, and streams are richer and should remain explicit.

OS should import the retained child-run UX:

- Parent starts child run and gets a retained handle.
- Child streams progress events.
- Parent can detach and later reattach.
- Completion, failure, and cancellation are durable.
- Milestones are first-class UI events.
- Child work is inspectable independently.

This fits OS streams naturally. A child agent run can be a stream or substream with stable parent linkage.

### Messengers and Channels

Think's messenger/channel work is directly relevant to OS integrations. It centralizes ingress/delivery concerns for Chat SDK and Telegram, with direction toward Discord and multi-surface messengers.

OS currently has separate integration processors for things like Slack, email, PRs, and other domain-specific flows. That is powerful, but it risks provider-specific behavior being scattered across processors.

The valuable Think concept is a delivery policy boundary:

- Incoming message is accepted durably.
- Thread/channel/messenger context is immutable for the turn.
- Delivery side effects are idempotent and checkpointed.
- Recovered turns do not re-post uncheckpointed interruption text.
- Attachments preserve replayable fetch metadata.

Open Think issues prove these details matter. OS should make messenger context part of the turn/event payload, not ambient mutable state.

### Workspaces, Sandboxes, Artifacts, and Coding Agents

Think's built-in Workspace is mature as a chat-agent virtual filesystem. It supports read/write/edit/list/find/grep/delete/bash, bounded snapshots, optional R2, and a shell abstraction. This is useful for small-to-medium per-agent workspace state.

The real coding-agent direction, however, is not the current `createSandboxTools` export. GitHub issues and PRs show that `createSandboxTools` is effectively not ready, while `agent-think`, Cloudflare Sandbox containers, `@cloudflare/workspace`, and `@cloudflare/coding-agent` are the serious path.

OS already has clearer separation:

- Repos are project data and GitHub-syncable.
- Workspaces are branch-oriented clones.
- Sandboxes are explicit pet containers.
- Dynamic workers are build/load/runtime artifacts.
- Worker artifacts are content-addressed and kept out of streams.

OS should keep that separation. The Think lesson is to improve lifecycle and safety:

- Bounded output ingestion for all shell/sandbox/codemode logs.
- Store full logs in workspace/container storage, not Durable Object event rows.
- Store first N bytes, last N bytes, byte counts, and a pointer in stream events.
- Make workspace lifecycle simple enough to recover.
- Make observers non-blocking.
- Use idempotency keys that include external source IDs, for example comment IDs on GitHub callbacks.

### Observability

Think's recent work points toward first-party tracing for agent turns, model calls, tool calls, and sub-agent spans. The open PR for Cloudflare-native AI tracing is especially relevant because OS is already a Cloudflare-native product and should not have to invent a separate observability stack for these paths.

OS should add agent-span events and/or trace spans at these boundaries:

- Message accepted.
- Turn admitted.
- Model request started/finished.
- Tool/capability invocation started/finished.
- Dynamic worker script started/finished.
- Sandbox command started/finished.
- Child run started/progress/completed.
- Recovery attempt started/finished.
- Terminal recovery failure.

These should link to stream offsets, turn IDs, request IDs, and user/project IDs.

## Think History: Important Arcs

The git history shows a clear maturation path.

### Initial All-in Package

Think began as an opinionated package with sessions, workspace, extensions, execution, and a full assistant example. It was valuable, but too much behavior lived directly in `@cloudflare/think`.

Important commits:

- `a1eab1d3` - `feat: @cloudflare/think ... (#1089)`
- `b5238de6` - persistent Workspace class
- `fd1f4352` - `@cloudflare/shell`

Lesson for OS:

- Avoid a large magical base class as the durable architecture boundary.
- Extract primitives that can be tested and reused across agent, project worker, MCP, and dashboard paths.

### Extraction Into Shared Primitives

Think got healthier as shared behavior moved down into:

- `agents/chat`
- base `Agent` fibers
- shared recovery engine
- React chat transport
- retained agent tools
- codemode connectors
- MCP transport

Important commits:

- `f3d55579` - extract shared chat layer
- `dfab937c` - unified durable fiber architecture
- `3b2af544` - shared host-agnostic chat recovery engine
- `c58b4015` - hoist React chat hook into shared Agents

Lesson for OS:

- Put recovery, turn ledgers, tool settlement, session projections, and child-run progress into domain primitives, not one UI route or one agent processor.

### Recovery Became the Main Product

Many Think changes were recovery hardening, not feature work:

- Durable chat RPC recovery.
- Stream resumption.
- Bounded incidents.
- Transcript repair.
- Deploy-churn survival.
- Context-window overflow recovery.
- Memory-limit circuit breakers.
- Durable settled tool results.
- Event-driven auto-continuation barriers.

Important commits:

- `61309f71` - enable chat recovery by default
- `449b4216` - durable recovery for Think chat RPC
- `02f93809` - harden recovery foundations
- `fac44632` - persist settled tool results
- `4c8b3712` - harden recovery, transcript integrity, compaction under deploy churn
- `919bfaa3` - event-driven auto-continuation barrier
- `1bbd9bca` - bound DO memory-limit crash loops

Lesson for OS:

- Durable agents are mostly failure-state design.
- "Append and retry" is insufficient without stable identities for turns, assistant messages, tool calls, and tool results.

### API Moved Upward

Think moved from raw chat mechanics toward product APIs:

- `submitMessages()`
- `runTurn()`
- actions and approvals
- channels
- notices
- scheduled tasks
- messengers
- starter apps and framework generation

Important commits and PRs:

- `bf3860c2` / PR #1511 - durable submissions API
- `32ea71ef` / PR #1587 - first-class messengers
- `8ad724b1` / PR #1585 - declarative scheduled tasks
- `190ea814` / PR #1790 - turns, actions, channels
- PR #1896 - graduate sessions to canonical `agents/sessions`

Lesson for OS:

- Users and integrations need an accepted/submitted/delivered status model, not just a chat stream.
- OS's `itx` API should expose high-level turn/run status in addition to raw stream events.

## GitHub Issue and PR Mining

This section captures high-signal public Cloudflare discussions.

### Roadmap and Direction

- [Issue #1439](https://github.com/cloudflare/agents/issues/1439), Project Think roadmap: Think aims to become the default durable serverless agent path for agents that think, act, persist, fork, and hand off work.
- [Issue #1440](https://github.com/cloudflare/agents/issues/1440), Think + Artifacts: artifacts are framed as versioned handoff, likely repo/session/task oriented, with forks and Git-compatible tooling.
- [Issue #1402](https://github.com/cloudflare/agents/issues/1402), `think:apps`: Cloudflare is still exploring whether apps are patterns, sub-agents/facets, manifests, installable bundles, or MCP/extension bundles.
- [PR #1896](https://github.com/cloudflare/agents/pull/1896), graduate sessions: sessions are moving from experimental imports toward a stable primitive.
- [PR #1860](https://github.com/cloudflare/agents/pull/1860), Cloudflare-native AI tracing: indicates tracing of agent/model/tool calls is becoming first-party.

OS take:

- Treat Think as strategically important but still moving.
- Follow sessions, tracing, artifacts, and apps closely.
- Avoid building on unstable package internals without an adapter.

### Recovery and Streaming Regressions

- [Issue #1876](https://github.com/cloudflare/agents/issues/1876), duplicate assistant message on continuation recovery: recovery may append a second assistant message instead of continuing the interrupted one.
- [Issue #1837](https://github.com/cloudflare/agents/issues/1837), reconnect resume race: overlapping resume calls could hit active-response races.
- [Issue #1681](https://github.com/cloudflare/agents/issues/1681), disable stream persistence: users worry about SQLite write cost, but disabling persistence conflicts with recovery.
- [Issue #1706](https://github.com/cloudflare/agents/issues/1706), stream buffer lifecycle: cleanup had to become explicit.
- [Issue #1728](https://github.com/cloudflare/agents/issues/1728), recovery attempt bounds: wall-clock bounds are not enough for all retry loops.
- [Issue #1649](https://github.com/cloudflare/agents/issues/1649), parallel client tools race: auto-continuation before all client tool results arrived produced missing tool-result errors.

OS take:

- Add duplicate-assistant-message tests.
- Add parallel client/tool result barrier tests.
- Add reconnect/resume chaos tests.
- Make stream buffer cleanup explicit.
- Bound recovery by attempts and wall time.

### Metadata, Events, and Transcript Semantics

- [Issue #1676](https://github.com/cloudflare/agents/issues/1676), events/render-only messages/typed metadata: Think lacks a clean distinction between model-visible messages, UI-visible events, and typed metadata.
- [Issue #1873](https://github.com/cloudflare/agents/issues/1873), assistant metadata write path: assistant message metadata can be dropped through the stream conversion path.
- [Issue #1833](https://github.com/cloudflare/agents/issues/1833), attachment metadata stripped: messenger serialization lost replayable attachment fetch metadata.

OS take:

- OS is already stronger here because it has typed events and domain streams.
- Do not collapse event semantics into chat-message semantics.
- Preserve typed metadata and attachment replay metadata as first-class event data.

### Sub-Agents, Facets, and Schedules

- [Issue #1752](https://github.com/cloudflare/agents/issues/1752), detached sub-agent runs: long-running child work needed to stop blocking parents.
- [PR #1758](https://github.com/cloudflare/agents/pull/1758), detached background agent-tool runs: merged durable completion, progress, and milestones.
- [Issue #1856](https://github.com/cloudflare/agents/issues/1856), external HTTP to sub-agent: routing callbacks to facets is not clean yet.
- [Issue #1877](https://github.com/cloudflare/agents/issues/1877), scheduled tasks duplicate on facets: schedule ownership across root/facet boundaries is sharp.
- [Issue #1894](https://github.com/cloudflare/agents/issues/1894), messenger context race: per-turn context needs to be immutable and not stored in ambient mutable fields.

OS take:

- Define root vs child ownership explicitly.
- Put schedule ownership in durable config, not class inheritance side effects.
- Make per-turn external context immutable and persisted.
- Model detached child work as durable child runs with retained progress events.

### Sandboxes and Coding Agents

- [Issue #1319](https://github.com/cloudflare/agents/issues/1319), `createSandboxTools` no-op: the exported sandbox tool path is not the real production path yet.
- [Issue #1870](https://github.com/cloudflare/agents/issues/1870), unbounded exec output OOM: container exec output can OOM the Agent DO and brick replay.
- [Issue #1883](https://github.com/cloudflare/agents/issues/1883), agent-think validation: container-local workspace with large dependency trees works when lifecycle is hardened.
- [PR #1830](https://github.com/cloudflare/agents/pull/1830), sandbox coding agent example: Think orchestrates Claude Code in Cloudflare Sandbox containers via sub-agents.
- [PR #1831](https://github.com/cloudflare/agents/pull/1831), CodingAgent RFC: coding agent is proposed as a distinct package, not just a Think subclass.
- [PR #1889](https://github.com/cloudflare/agents/pull/1889), agent-think hardening: simplified workspace lifecycle, non-blocking reporting, and better terminal failure surfacing.

OS take:

- Do not depend on `createSandboxTools`.
- Treat containers as a control-plane plus external compute reconciliation problem.
- Put all unbounded stdout/stderr/log streams behind caps and external storage pointers.
- Keep workspace lifecycle simple and inspectable.

## What OS Should Steal

### 1. Durable Turn Ledger

Build a turn ledger for OS agents.

Why:

- Think's history shows this is the backbone for recovery, idempotency, UI status, and external integrations.
- OS currently has event streams but should make agent turns first-class within those streams.

Shape:

- A submitted user/system/external message creates a durable `submissionId`.
- Admission creates a `turnId`.
- Model output is tied to an `assistantMessageId` before streaming begins.
- Tool calls and results have stable IDs.
- Recovery reuses the same IDs.
- Terminal failures are explicit events, not inferred from absence.

Candidate files:

- `apps/os/src/domains/agents/agent-processor-contract.ts`
- `apps/os/src/domains/agents/agent-processor-implementation.ts`
- `apps/os/src/domains/agents/agent-durable-object.ts`
- `apps/os/src/rpc-targets.ts`

### 2. Durable Tool Result Settlement

Record tool/capability results durably before they can be fed back into a recovered turn.

Why:

- Think had to persist settled tool results to avoid re-running completed tools after recovery.
- OS agents execute scripts and capability calls; duplicated side effects would be expensive and confusing.

Shape:

- Each agent-initiated capability invocation gets `toolCallId`.
- Result is persisted as `tool_call_settled`.
- Recovered turns read settled results instead of invoking again.
- Idempotency keys include target capability, args hash, project ID, and turn ID.

### 3. Session Projection Over Agent Streams

Create a derived session/message index for OS agent streams.

Why:

- Think sessions solve real UX and model-context problems: search, compaction, branching, recent history, and bootability.
- OS streams are authoritative but not the best direct UI/query shape.

Shape:

- Derived SQLite projection per agent or stream.
- Tables for messages, parts, branches, compactions, FTS, and turn linkage.
- Rebuildable from stream events.
- Byte-budgeted hydration.
- Media/log eviction policies.

### 4. Recovery Chaos Harness

Add tests that intentionally interrupt agent turns.

Scenarios:

- Disconnect during model streaming.
- Deploy/restart during tool execution.
- Duplicate reconnect/resume attempts.
- Parallel client/tool results arriving out of order.
- Context-window overflow mid-turn.
- DO memory-limit crash loop.
- Script output exceeding size caps.
- Child agent completes while parent is asleep.

Assertions:

- No duplicate assistant messages.
- Settled tools are not re-run.
- User-visible side effects are idempotent.
- Terminal recovery emits a visible, queryable status.
- Stream/projection state can be rebuilt.

### 5. Immutable Per-Turn Context

Persist external ingress context with the turn.

Why:

- Think's messenger context race shows ambient mutable fields are unsafe under concurrent turns.
- OS has Slack/email/PR/web/MCP ingress paths that need exact context preservation.

Shape:

- `turnContext` includes messenger/provider, external thread ID, author, auth claims, attachment metadata, delivery policy, and idempotency key.
- It is immutable once accepted.
- Hooks and processors receive it as an argument, not from mutable object state.

### 6. Retained Child Runs

Add retained child-run handles for agents, project workers, and sandboxes.

Why:

- Think's detached sub-agent runs solve a real UX problem: long-running child work should not block parent turns.
- OS streams are a natural fit for retained progress and milestone events.

Shape:

- Parent emits `child_run_requested`.
- Child stream emits progress, milestone, output, completed, failed, canceled.
- Parent can detach, reattach, summarize, or cancel.
- Dashboard can inspect child runs independently.

### 7. Output Caps and Log Pointers

Bound every stdout/stderr/tool-output path before it reaches DO memory or stream events.

Why:

- Think issue #1870 is exactly the failure mode coding-agent systems hit: unbounded exec output bricks the durable agent on replay.
- OS streams already avoid storing worker artifacts directly; apply the same rule to logs.

Shape:

- Store first bytes, last bytes, total bytes, line count, truncation flag, content hash, and pointer.
- Full logs live in workspace/container storage, R2, repo artifact store, or another external blob layer.
- Processors never hydrate full logs unless explicitly asked.

### 8. Messenger Delivery Policy

Unify integration delivery semantics.

Why:

- Think messengers make acceptance, streaming, delivery, edit/post policy, and recovery visible as one system.
- OS integrations should not each rediscover idempotent delivery.

Shape:

- Provider adapters accept external messages into OS streams.
- Delivery policy is explicit: post, edit, thread reply, silent, digest, or status-only.
- Provider message IDs are stored on delivery events.
- Recovery reuses delivery IDs instead of posting duplicates.

### 9. First-Party Agent Observability

Add trace/span/event instrumentation around agent work.

Why:

- Think is moving toward Cloudflare-native AI tracing.
- OS needs to explain agent behavior across streams, workers, sandboxes, model calls, and integrations.

Shape:

- Trace IDs linked to project ID, stream path, turn ID, request ID, and deployment.
- Spans for model calls, tool invocations, dynamic worker calls, sandbox commands, child runs, and recovery attempts.
- Dashboard surfaces failure clusters and slow spans.

### 10. Skills as Project Capability Resources

Think's Agent Skills integration is a useful way to package instructions and tool-use knowledge.

OS should not copy the exact Think skill API immediately, but should support a project capability/resource pattern for:

- Agent instructions.
- Domain-specific tool docs.
- Repo-local workflows.
- External integration playbooks.
- Reusable prompt/context packs.

These can be exposed through `__describe()` and mounted in project capability space.

## What OS Should Not Copy Blindly

### Do Not Make Think the OS Core

Think is still experimental and moving fast. Public issues show active instability around:

- Duplicate assistant messages on recovery.
- Session import paths.
- Messenger context races.
- Assistant metadata persistence.
- Facet schedule duplication.
- Sandbox tool readiness.
- Event/message semantics.

OS should keep Think behind an adapter if it experiments with it.

### Do Not Replace Events With Chat Messages

OS's typed stream events are more general than Think's transcript. Think itself has open issues asking for typed events, render-only messages, and model-visible vs UI-visible distinction. OS already has the better primitive here.

### Do Not Hide Authority in a Base Class

Think's base class is convenient for app authors. OS needs explicit authority boundaries: project IDs, scoped `itx`, capability hosts, streams, workers, secrets, and repos. A magical base class would make OS harder to reason about.

### Do Not Treat Sub-Agent Facets as Free

Think's schedule duplication and external callback routing issues show that root/facet ownership is hard. OS should make ownership explicit in stream and capability names rather than deriving it implicitly from class paths.

### Do Not Store Large Operational Output in Durable Object Rows

Think's unbounded exec-output issue is a direct warning. Large logs and artifacts need blob/file storage plus pointers. Stream events and turn ledgers should stay small.

## Recommended OS Backlog

### P0: Agent Turn Authority and Recovery

1. Add stable agent turn IDs and assistant message IDs.
2. Add durable tool-call/result settlement.
3. Add terminal recovery events.
4. Add duplicate-message and duplicate-tool-call regression tests.
5. Add output caps for script execution and sandbox command output.

Expected impact:

- Prevents the most damaging durable-agent correctness bugs.
- Gives the dashboard and integrations a reliable status model.
- Makes recovery testable.

### P0: Output and Artifact Safety

1. Audit every path where command/model/tool output enters DO memory or stream events.
2. Add max persisted bytes and truncation metadata.
3. Store full logs outside event rows.
4. Add tests for huge stdout/stderr and huge tool payloads.

Expected impact:

- Prevents OOM replay loops and bricked sessions.
- Aligns logs with OS's existing artifact-store discipline.

### P1: Session Projection

1. Build derived message/session tables for agent streams.
2. Add FTS and compacted context projections.
3. Add branch/fork support using parent message IDs.
4. Move dashboard chat hydration to the projection.
5. Keep stream events as source of truth.

Expected impact:

- Faster UI.
- Better long-running agent context.
- Better search/debugging.
- Cleaner future support for forks and artifacts.

### P1: Child Run Model

1. Define child run events.
2. Add retained run handles.
3. Add progress/milestone UI.
4. Add detach/reattach/cancel APIs.
5. Use this for sub-agents, sandboxes, long scripts, and project worker tasks.

Expected impact:

- Long-running work becomes inspectable and recoverable.
- Parent agents stop blocking on child work.

### P1: Integration Delivery Semantics

1. Define immutable `turnContext`.
2. Normalize external ingress into accepted submissions.
3. Store provider message IDs on delivery events.
4. Add idempotent delivery policies for Slack/email/GitHub/MCP.
5. Add recovery tests for interrupted delivery.

Expected impact:

- Fewer duplicate replies and lost context bugs.
- Cleaner integration processors.

### P1: Observability

1. Add turn/model/tool/worker/sandbox/recovery spans.
2. Link spans to stream offsets.
3. Surface recovery incidents in dashboard debug views.
4. Track retry counts, terminalization, and duplicate-prevention decisions.

Expected impact:

- Makes agent failures diagnosable.
- Aligns OS with Cloudflare's emerging AI tracing direction.

### P2: Skills, Artifacts, and App Bundles

1. Expose skill-like resources through `__describe()`.
2. Explore versioned task artifacts as repo/workspace branches.
3. Watch Think's artifacts/apps work before committing to a framework.
4. Consider a small adapter that can run a Think agent as an OS capability for experiments.

Expected impact:

- Lets OS benefit from Cloudflare's ecosystem without binding core architecture to unstable APIs.

## Concrete Design Sketch: OS Agent Turn Ledger

The turn ledger should be a stream-level contract, not just an internal table.

Example event families:

- `agent-message-submitted`
- `agent-turn-admitted`
- `agent-turn-started`
- `agent-assistant-message-started`
- `agent-model-output-delta`
- `agent-tool-call-requested`
- `agent-tool-call-settled`
- `agent-assistant-message-completed`
- `agent-turn-completed`
- `agent-turn-failed`
- `agent-turn-recovery-attempted`
- `agent-turn-terminalized`

Rules:

- Every submitted message has an idempotency key.
- Every turn has exactly one active assistant message ID unless explicitly branched.
- Tool calls are never executed twice after a settled result exists.
- Recovery attempts must reuse existing IDs.
- User-visible delivery side effects must be tied to delivery events.
- The session projection derives UI messages from these events.

Why this fits OS:

- It follows the existing event/processor design.
- It can be folded by `AgentProcessor`.
- It can be projected into Think-like session tables.
- It can be exposed through `itx.agents`.
- It can be inspected by the dashboard and MCP bridge.

## Concrete Design Sketch: Session Projection

Source of truth:

- Agent stream events.

Derived tables:

- `agent_messages`
- `agent_message_parts`
- `agent_turns`
- `agent_tool_calls`
- `agent_branches`
- `agent_compactions`
- `agent_message_fts`

Projection policy:

- Rebuild from stream offsets.
- Store last applied stream offset.
- Apply compaction as overlay, not destructive mutation.
- Keep model-visible and UI-visible parts separate.
- Keep typed event metadata separate from message text.
- Hydrate with byte budgets.
- Store large attachment/log references as pointers.

This gives OS most of Think Session's benefits without surrendering event authority.

## Concrete Design Sketch: Child Runs

Event shape:

- `child-run-requested`
- `child-run-accepted`
- `child-run-progressed`
- `child-run-milestone-reached`
- `child-run-output-appended`
- `child-run-completed`
- `child-run-failed`
- `child-run-canceled`

Applies to:

- Sub-agent tasks.
- Sandbox commands.
- Dynamic worker jobs.
- Repo/workspace operations.
- GitHub issue/PR automation.
- Long MCP tool invocations.

Rules:

- Parent and child stream paths are explicit.
- The child owns its tools and side effects.
- The parent owns request, cancellation, and summary policy.
- Progress events are compact and safe to replay.
- Full outputs use pointers.

## Concrete Design Sketch: Output Caps

For any command/tool output, persist:

- `stdoutPreviewStart`
- `stdoutPreviewEnd`
- `stderrPreviewStart`
- `stderrPreviewEnd`
- `stdoutBytes`
- `stderrBytes`
- `lineCount`
- `truncated`
- `contentHash`
- `fullOutputRef`

Policy:

- Default preview budget should be small enough for DO safety.
- Full output should live in workspace/container/blob storage.
- Agent context should receive summaries/previews by default.
- Users can explicitly open full logs from dashboard/debug tools.

## Direct Ideas Worth Mining Later

These are useful but less urgent than recovery and turn authority.

- Think framework generation could inspire OS project-agent scaffolding, but OS already has stronger project templates and dynamic workers.
- Think's `create-think` split between new project scaffolding and augmenting existing projects is a good pattern for OS CLI commands.
- Think's `getModel()` model-string ergonomics are worth copying for OS agent configuration.
- Think's lifecycle hooks are useful as conceptual checkpoints even if OS implements them as processor events.
- Think's action ledger can map to OS approvals, human-in-the-loop pauses, and dangerous capability calls.
- Think's channel/notices API could map to OS dashboard notifications and integration status updates.
- Think Studio is worth watching as a model for OS agent-debug panels.
- MCP resumability work is worth comparing to OS inbound MCP behavior.
- Codemode connectors may become a better substrate for browser/shell/approval tools than custom one-off OS implementations.

## Risk Register

| Risk                                           | Evidence                               | OS response                                                       |
| ---------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------- |
| Duplicate assistant messages after recovery    | Think issue #1876                      | Stable assistant message IDs and recovery tests.                  |
| Re-running side-effecting tools                | Think settled-tool-result fixes        | Durable tool result settlement before continuation.               |
| Unbounded command output bricks DO             | Think issue #1870                      | Output caps and external log pointers.                            |
| Ambient context races                          | Think issue #1894                      | Immutable per-turn context.                                       |
| Facet/root schedule duplication                | Think issue #1877                      | Explicit owner path and schedule ownership.                       |
| Metadata dropped through transcript conversion | Think issue #1873                      | Keep typed events separate from chat messages.                    |
| Attachment replay broken by serialization      | Think issue #1833                      | Preserve fetch/replay metadata in event payloads.                 |
| Recovery cost from persisted stream chunks     | Think issue #1681                      | Make OS token/log replay policy explicit and bounded.             |
| Sandbox API churn                              | Think issue #1319 and coding-agent RFC | Use adapter boundary and keep OS sandbox abstraction independent. |
| Think API churn                                | Roadmap and sessions PR #1896          | Do not leak Think internals into OS contracts.                    |

## Bottom Line

OS has the stronger architecture for a durable project operating system: event streams, capability hosts, `itx`, dynamic workers, project workers, repos, workspaces, sandboxes, and self-description are the right primitives.

Think has the stronger architecture for durable chat turns: session projections, stream resumption, recovery, durable submissions, actions, retained sub-agent tools, messenger delivery, and agent-workspace ergonomics.

The best design is a hybrid where OS remains the authority plane and imports Think-like lifecycle machinery as internal projections and ledgers:

- OS streams stay canonical.
- Think-like turn/session/action tables are rebuildable projections or scoped ledgers.
- `itx` stays the primary capability API.
- Agents get durable turn IDs, tool settlement, child-run handles, and recovery incidents.
- UI gets fast session projections, FTS, compaction, and branch/fork semantics.
- Integrations get immutable per-turn context and idempotent delivery events.

That path gives us Think's operational lessons without giving up OS's deeper project model.

## Source Links

Cloudflare repository and public discussions:

- `https://github.com/cloudflare/agents`
- `https://github.com/cloudflare/agents/issues/1439`
- `https://github.com/cloudflare/agents/issues/1440`
- `https://github.com/cloudflare/agents/issues/1402`
- `https://github.com/cloudflare/agents/issues/1876`
- `https://github.com/cloudflare/agents/issues/1877`
- `https://github.com/cloudflare/agents/issues/1870`
- `https://github.com/cloudflare/agents/issues/1894`
- `https://github.com/cloudflare/agents/issues/1873`
- `https://github.com/cloudflare/agents/issues/1676`
- `https://github.com/cloudflare/agents/issues/1681`
- `https://github.com/cloudflare/agents/issues/1728`
- `https://github.com/cloudflare/agents/pull/1089`
- `https://github.com/cloudflare/agents/pull/1511`
- `https://github.com/cloudflare/agents/pull/1587`
- `https://github.com/cloudflare/agents/pull/1758`
- `https://github.com/cloudflare/agents/pull/1788`
- `https://github.com/cloudflare/agents/pull/1790`
- `https://github.com/cloudflare/agents/pull/1794`
- `https://github.com/cloudflare/agents/pull/1830`
- `https://github.com/cloudflare/agents/pull/1831`
- `https://github.com/cloudflare/agents/pull/1860`
- `https://github.com/cloudflare/agents/pull/1889`
- `https://github.com/cloudflare/agents/pull/1896`

Local source files reviewed:

- `apps/os/src/README.md`
- `apps/os/src/rpc-targets.ts`
- `apps/os/src/domains/itx/describe.ts`
- `apps/os/src/domains/streams/stream-durable-object.ts`
- `apps/os/src/domains/streams/stream-storage.ts`
- `apps/os/src/domains/agents/agent-durable-object.ts`
- `apps/os/src/domains/agents/agent-processor-contract.ts`
- `apps/os/src/domains/agents/agent-processor-implementation.ts`
- `apps/os/src/domains/capability-host/capability-host-durable-object.ts`
- `apps/os/src/domains/capability-host/capability-host-processor-implementation.ts`
- `apps/os/src/domains/workers/artifact-store.ts`
- `apps/os/src/domains/workers/worker-loader.ts`
- `docs/domain-objects-and-stream-processors.md`
- `/Users/jonastemplestein/src/github.com/cloudflare/agents/docs/think/index.md`
- `/Users/jonastemplestein/src/github.com/cloudflare/agents/docs/think/lifecycle-hooks.md`
- `/Users/jonastemplestein/src/github.com/cloudflare/agents/docs/think/tools.md`
- `/Users/jonastemplestein/src/github.com/cloudflare/agents/docs/think/client-tools.md`
- `/Users/jonastemplestein/src/github.com/cloudflare/agents/docs/think/sub-agents.md`
- `/Users/jonastemplestein/src/github.com/cloudflare/agents/docs/think/programmatic-submissions.md`
- `/Users/jonastemplestein/src/github.com/cloudflare/agents/packages/think/src/think.ts`
- `/Users/jonastemplestein/src/github.com/cloudflare/agents/packages/agents/src/index.ts`
- `/Users/jonastemplestein/src/github.com/cloudflare/agents/packages/agents/src/chat/resumable-stream.ts`
- `/Users/jonastemplestein/src/github.com/cloudflare/agents/packages/agents/src/chat/resume-handshake.ts`
- `/Users/jonastemplestein/src/github.com/cloudflare/agents/packages/agents/src/experimental/memory/session/session.ts`
- `/Users/jonastemplestein/src/github.com/cloudflare/agents/packages/agents/src/experimental/memory/session/providers/agent.ts`
- `/Users/jonastemplestein/src/github.com/cloudflare/agents/packages/shell/src/filesystem.ts`
- `/Users/jonastemplestein/src/github.com/cloudflare/agents/agent-think`
