# Agent-loop research index

Research fan-out from the compaction/agent-processor design discussion
(2026-07-09). Two rounds of parallel research agents; each doc covers the same topic
checklist — tool calls, truncation, steering, subagents, compaction,
interruptions, timeouts, background processes, streaming — with code
references into local checkouts and links to design discussions, and ends
with an "Implications for iterate" section cross-referencing
`apps/os/src/domains/agents/design-improvements.md` item numbers.

## Docs

| Doc | System | Code checkout |
| --- | ------ | ------------- |
| [pi-coding-agent.md](pi-coding-agent.md) | pi (badlogic/pi-mono → renamed earendil-works/pi) — upstream of our PR #1639 port | `~/src/github.com/badlogic/pi-mono` |
| [opencode.md](opencode.md) | OpenCode + the core-v2 Effect-ts rewrite | `~/src/github.com/sst/opencode` (dev) · `opencode-v2` (v2 branch) · `opencode-2.0` (abandoned April spike) |
| [claude-code.md](claude-code.md) | Claude Code (closed; docs/teardowns/Agent SDK) | — |
| [codex.md](codex.md) | OpenAI Codex CLI (Rust, open) + cloud Codex | `~/src/github.com/openai/codex` |
| [cloudflare-agents-sdk.md](cloudflare-agents-sdk.md) | Cloudflare Agents SDK + **Project Think** (`@cloudflare/think`) | `~/src/github.com/cloudflare/agents` |
| [vercel-eve.md](vercel-eve.md) | Vercel eve (filesystem-first durable agents on Workflow SDK) | `~/src/github.com/vercel/eve` |
| [agent-design-survey.md](agent-design-survey.md) | Cross-cutting design-space survey + other agents worth studying (Amp, Aider, Cline, Goose, Crush, Gemini CLI, SWE-agent, smolagents, Letta, Droid…) | (web-sourced) |
| [factory-droid.md](factory-droid.md) | Factory Droid + Missions orchestrator/worker/validator architecture | `~/src/github.com/Factory-AI/droid-sdk-typescript` |
| [gemini-cli.md](gemini-cli.md) | Gemini CLI — steering, compression, subagents, checkpointing | `~/src/github.com/google-gemini/gemini-cli` |
| [letta-memgpt.md](letta-memgpt.md) | Letta (MemGPT) — memory hierarchy, summarizer, sleep-time agents | `~/src/github.com/letta-ai/letta` |

## Convergent findings across systems

Mapped to design-improvements.md items:

- **Item 1 (normalized deltas):** OpenCode v2's durable/ephemeral event split
  is the strongest precedent — delta events are declared ephemeral in a
  manifest, streamed live but never persisted; the completion event carries
  the full text durably. eve's 26-type session event stream and Codex's
  ~60-variant EventMsg protocol are both normalized, provider-agnostic event
  schemas worth comparing when we design `agent/output-delta`.
- **Items 2+3 (usage/window):** eve triggers compaction on
  `lastKnownInputTokens + chars/4 estimate` vs 90% of window; Claude Code
  uses last API `input_tokens` + char/4 hybrid, threshold ≈ window − 13k.
  Everyone folds last-known usage; nobody re-counts. The model→window
  registries in the wild: Letta bakes `context_window` as a required
  `LLMConfig` field with hardcoded per-model defaults; Gemini CLI's
  `tokenLimits.ts` is a plain switch with a fail-open 1M fallback for unknown
  models. Both confirm: provider owns the table, agent folds the number.
- **Item 4 (compaction):** all systems compact **blocking**; none run a
  parallel compaction lane (our non-blocking ambition is genuinely novel).
  pi guards staleness (skip if aborted / pre-boundary / already recovered
  once) and threads `previousSummary` to avoid summary-of-summary pile-up.
  OpenCode's `Compaction.Ended` row is literally our proposed
  `history-compacted { floorOffset }` — history loads read events only after
  the latest compaction row. Cloudflare Think stores compaction as a
  **non-destructive overlay** (model sees overlay + tail; full history stays
  readable) — closest philosophically to our append-only stream.
- **Item 5 (single request slot):** Codex also enforces one active turn per
  session (`Mutex<Option<ActiveTurn>>`). Nobody does parallel conversation +
  compaction requests today — even Letta's "sleep-time agents", marketed as
  background memory reorganization, are strictly sequential (fired after the
  foreground turn completes, every N turns, last-write-wins on shared blocks).
- **Item 4 (compaction) — floor-offset safety (Gemini):** Gemini CLI's
  `findCompressSplitPoint()` only ever splits at user turns that are NOT
  function responses. Our `history-compacted { floorOffset }` needs the same
  constraint: walk back from the proposed floor to the nearest safe boundary
  (never mid tool-call/result pair). Letta's summary lands at position 1
  (after system prompt) with a sentinel string for re-detection, produced by
  a dedicated cheap summarizer model — and notably Letta's *proactive* 90%
  trigger is commented out in the current agent path; only reactive
  (ContextWindowExceededError) compaction runs. Items 2+3 first, for real.
- **Item 6 (previous_response_id vs compaction):** Codex answers it exactly —
  compaction is a separate unary HTTP call (`/responses/compact`), never on
  the WebSocket session, and the continuation chain is always broken after.
  Validates the "compaction lane over plain HTTPS" direction.
- **Item 8 (orphan sweep):** OpenCode's `failInterruptedTools()` drain-start
  sweep is the same pattern as our openai-ws orphan recovery — and confirms
  cloudflare-ai needs it too.
- **Item 9 (cancel doesn't abort):** near-universally botched — Codex's
  interrupt sets an abort token but drains the socket anyway (issue #29439);
  same gap in Aider, Goose, Claude Code background bash. AbortController into
  the transport is the known fix; nobody's proud here.
- **Item 10 (chunk amplification):** OpenCode's ephemeral-delta manifest is
  the fix; Cloudflare Think instead makes buffered chunks *useful*
  (ResumableStream: SQLite-buffered chunks + client ack replay).
- **Item 11 (O(history) re-fold):** eve avoids it by embedding the session
  snapshot in the workflow step result (O(1) read, but loses auditability);
  OpenCode bounds it with the compaction-row floor; Codex has the same
  unbounded problem as us (3 GB rollout JSONL crash, issue #25215).
- **Steering (new item candidate):** the richest vein. pi has two queues
  (steer = inject before next LLM call mid-turn; follow-up = new turn after
  loop exit); OpenCode v2 has `delivery: "steer" | "queue"` with a durable
  Admitted → Promoted lifecycle; Claude Code queues by default with
  esc-to-interrupt synthesizing tool_results for orphaned tool_use ids;
  Gemini CLI has a `hintBuffer`. Our `llmRequestPolicy` enum
  (dont-trigger / interrupt / after-current) has no "steer into the running
  turn" arm.
- **Fresh-validator principle (new item candidate, Factory):** the
  context-contamination argument formalizes why validators must be fresh
  agents, not re-queried workers. Maps to our stream-per-agent model: mission
  = parent stream, features = child streams, validators = sibling child streams
  that never inherit worker history. See [factory-droid.md §6.1](factory-droid.md).
- **Item 4 (compaction) — Factory addition:** structured summary sections
  (intent, file mods, decisions, next steps, artifact breadcrumbs) outperform
  prose; artifact trail is the weakest dimension across all systems (Factory's
  best: 2.45/5). Never regenerate the full summary — only summarize the
  newly-dropped span and merge. Thread `previousSummary` to avoid
  summary-of-summary drift.
- **Deferred Context Engine (Factory → our `__describe()`):** 50.8% input
  token reduction at 100+ deferred schemas. Main gap vs our system: no warm
  cache across sessions for frequently promoted `__describe()` results.

## Suggested next deep-dives (from the survey)

1. ~~**Letta/MemGPT** — memory hierarchy + self-compaction.~~ DONE — see [letta-memgpt.md](letta-memgpt.md).
2. ~~**Factory Droid "Missions" architecture write-up**~~ — done, see [factory-droid.md](factory-droid.md).
3. ~~**Gemini CLI** — steering hintBuffer adoptable without event-schema changes.~~ DONE — see [gemini-cli.md](gemini-cli.md).

All three second-round dives complete (2026-07-09; all verified in active
development first — Letta v0.16.8 pushed 07-03, Gemini CLI v0.50.0 pushed
07-08, Factory pushed 07-09).
