---
status: in-progress
size: large
supersedes: agent-birth-userland-refactor (PR #2507, to be closed)
---

# Agent birth: all-in on debounce

## Status summary

Spec settled via plannotator (2 rounds, approved 2026-08-19). Implementation
starting. Branch lives on the root worktree per request; commits pushed, no PR
yet — proposed PR body at the bottom.

## The decided model

Replaces both the #2497 stored-wishes mechanism (merged, to be deleted here)
and the #2507 readiness-machinery approach (open draft, to be closed).

- **Platform defaults ride the create batch, inline.** `create()` keeps
  appending the full default batch exactly as `agentCreationForPath` does
  today — plus an explicit `agent/configured` with
  `{enableDefaultLlmResponseParsing: true, llmRequestDebounceMs: 10_000}`.
  The 10s is an explicit event, NOT a schema default: changing the schema
  default would retroactively slow every existing agent.
- **All-in on debounce; no readiness machinery.** No birth-finalized, no
  deadline sleeper, no sentinels, no degraded-start offer. The project's
  config worker reacts to `agent/created` and appends its overrides; its
  `llmRequestDebounceMs: 250` append doubles as the organic early release
  (a delivery at head reschedules the pending sleep-then-append; the request
  intent dedupes on `request/${trigger.offset}`, so the short window wins).
  Worker slow past the window → the agent answers with platform defaults;
  keyed supersession heals later turns.
- **One agent processor, flag-configurable parsing.** New config field
  `enableDefaultLlmResponseParsing` (schema default `true`). Flag-off
  semantics = exactly today's agent-headless: turn loop + LLM request run,
  nothing platform-side parses assistant output. `HeadlessAgentProcessor`
  and its contract are deleted; `config.driver` is deprecated — the payload
  still tolerates it and the fold maps `driver: "agent-headless"` to
  `enableDefaultLlmResponseParsing: false`, so existing headless agents and
  old seeded worker code keep exact semantics (shim, delete later). The
  `"agent-headless"` subscription name stays registered as an alias so
  existing streams keep waking.
- **Userland customizes reactively** in `worker.ts processEvent` on
  `agent/created` — no new subscription machinery; the parser rides the same
  worker feed that delivers `agent/created`. Templates:
  - `configs/default`: debounce→250 + illustrative all-lowercase context.
  - `configs/codemode-tag`: parsing off, debounce→250, XML `<codemode>`
    block prompt superseding the platform slot, vendored parser switched to
    the XML dialect. Driver-handover and birth-defaults-publishing machinery
    deleted.
  - `configs/with-voice`: same shape as codemode-tag with its own prompt (if
    it uses the defaults mechanism today; otherwise just debounce→250).

## Known consequences (accepted in review)

- Dead worker + chatty user: every message re-anchors a fresh 10s window
  (true debounce), so the first reply can be pushed out indefinitely.
  Organic failure; observability is a someday-problem.
- **Existing projects** (seeded before this change): their worker.ts never
  lowers the debounce, so agents they create AFTER this deploys debounce at
  10s per message until the project's config repo is updated. Existing
  agents are untouched (no new birth event lands on them). FLAGGED for
  discussion before merge — the fix per project is a one-commit worker.ts
  update.

## Checklist

- [ ] Task file spec commit (this file)
- [ ] Delete #2497 stored wishes: `AgentBirthDefaults`,
      `validateAgentBirthEvents`, `AGENT_BIRTH_DEFAULTS_KEY`, subscription
      allowlist, `defaults` folding in `agentCreationForPath`,
      `readAgentBirthDefaults` + create-site reads in rpc-targets.ts,
      `AgentBirthDefaultsValue` in packages/iterate/src/sdk.ts, and the
      project processor's generic defaults store if agents was its only
      consumer
- [ ] Contract: add `enableDefaultLlmResponseParsing` (default true);
      deprecate `driver` (tolerated in configured payload; fold maps
      agent-headless → parsing off); version bump
- [ ] Merge headless into `AgentProcessor` (flag-gate the interpretation
      component); delete agent-headless-processor.ts; alias-register
      `"agent-headless"` in processor-facet-durable-object.ts
- [ ] create(): explicit birth config event (parsing on, debounce 10s)
- [ ] configs/default: birth reaction (debounce 250 + lowercase context);
      delete birth-defaults publishing
- [ ] configs/codemode-tag: birth reaction (parsing off, debounce 250, XML
      codemode prompt); parser → XML dialect; delete defaults publishing +
      driver handover
- [ ] configs/with-voice: migrate same shape
- [ ] Tests: birth-config assertions; flag-off behavior (repurpose headless
      tests); organic-early-release spec (config append mid-window fires the
      request early); remove defaults-store tests
- [ ] format → lint:fix → knip → regenerate template codegen + itx-api →
      full test suite
- [ ] Push; close #2507 with a link here

## Proposed PR body

> ## Agent birth: all-in on debounce
>
> New agents are born with platform defaults inline (as today) plus one new
> explicit config event: response parsing ON, debounce **10s**. The
> project's config worker reacts to `agent/created` and appends overrides —
> prompt supersessions, parsing off, its own dialect — and lowers the
> debounce to 250ms as its "done configuring" signal, which releases any
> held first turn immediately. No readiness events, no deadlines: if the
> worker is slow, the first turn goes out with coherent platform defaults.
>
> ```ts
> // configs/codemode-tag/worker.ts
> case "events.iterate.com/agent/created":
>   await itx.streams.get(event.path).append(
>     { type: ".../agent/configured",
>       payload: { config: { enableDefaultLlmResponseParsing: false, llmRequestDebounceMs: 250 } } },
>     { type: ".../agents/context-added",
>       payload: { role: "system", key: "agent/system-prompt", content: "...<codemode> blocks..." } },
>   );
> ```
>
> - `enableDefaultLlmResponseParsing` replaces `config.driver`; the
>   headless processor and contract are deleted (flag-off = old headless
>   semantics; `driver: "agent-headless"` still parses and maps to the flag
>   for existing streams).
> - The #2497 project birth-defaults store (`agents/birth-defaults` wishes)
>   is deleted — the reactive path replaces it.
> - codemode-tag's LLM dialect switches from ```ts fences to XML
>   `<codemode>` blocks, demonstrating full userland control of parsing.
>
> Known consequence: projects seeded before this change don't lower the
> debounce; their newly-created agents wait 10s per message until the
> project commits an updated worker.ts.

## Implementation log

- 2026-08-19: branch created on root worktree; spec committed before
  implementation. Plannotator rounds recorded in
  `explainers.ignoreme/agent-birth-all-in-debounce-plan.html` (gitignored).
