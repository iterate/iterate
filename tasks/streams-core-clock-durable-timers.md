---
state: backlog
priority: medium
size: medium
dependsOn: [streams-core-processor-host-homogenization]
---

# Streams: core-owned clock / durable timers as stream facts

Background: `tasks/agents-system-audit-and-reconciler-design.md` §6 and §2.2.

## Problem

Nothing in the system can wake a dead host when no events arrive. No DO alarms
are used anywhere. Even after connect-triggered reconciliation (the
homogenization task), there is a residual hole: if a host crashes and _nothing_
ever pokes the stream or the host again, in-flight work stays dangling and
scheduled work never fires. Time-based behavior today is warm-instance
`setTimeout` only (the agent debounce timer,
`apps/os/src/domains/agents/stream-processors/agent/implementation.ts:343-358`).

## Idea

The Stream DO is the one durable, always-addressable participant — the natural
owner of the clock:

- A processor appends a fact like "wake me at T" (a configuration-ish event).
- The core processor reduces these into desired wakeups and sets a DO alarm
  for the earliest one (its runtime state = the pending alarm; reconciling it
  is the same processEvent-as-reconciler pattern).
- The alarm fires → core appends a tick/presence fact → normal delivery →
  every subscriber's reconciliation runs.

Durable timers as stream facts: observable in the log, replayable, testable.

## Payoffs

- Closes the last recovery hole: a tick guarantees somebody is awake to notice
  dangling work even with zero external traffic.
- The agent debounce stops depending on warm `setTimeout` at all:
  `llm-request-scheduled` implies a due time; the scheduler's reconciliation
  ("past due and still scheduled → request now") plus a core-owned alarm makes
  the debounce fully durable.
- Generalizes to anything needing time: retry backoff, idle timeouts, MCP/WS
  keepalive checks.

## Cares / open questions

- Don't tick forever on idle streams: only arm an alarm while there are
  outstanding requested wakeups; cancel/re-arm as they're consumed.
- Tick events add log noise; consider only appending when a wakeup is actually
  due, never on a free-running interval.
- Who clears a requested wakeup — the requester (append "wakeup-consumed") or
  the core (one-shot semantics)? Lean one-shot.
