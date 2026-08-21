---
status: done
size: large
supersedes: agent-birth-userland-refactor (PR #2507, closed)
pr: https://github.com/iterate/iterate/pull/2508
---

# Agent birth: all-in on debounce

## Status summary

Spec settled via plannotator (2 rounds, approved 2026-08-19). Implementation
complete: platform, all three templates, tests, codegen. Full suite verified
locally. Branch lives on the root worktree per request; commits pushed, no PR
yet — proposed PR body at the bottom. #2507 closed as superseded. Main open
question for discussion: the existing-projects migration consequence below.

## The decided model

Replaces both the #2497 stored-wishes mechanism (merged, to be deleted here)
and the #2507 readiness-machinery approach (open draft, to be closed).

- **Platform defaults ride the create batch, inline.** `create()` keeps
  appending the full default batch exactly as `agentCreationForPath` does
  today — plus an explicit `agent/configured` with
  `{interpretResponses: true, llmRequestDebounceMs: 60_000}`.
  The 60s is an explicit event, NOT a schema default: changing the schema
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
  `interpretResponses` (schema default `true`). Flag-off
  semantics = exactly today's agent-headless: turn loop + LLM request run,
  nothing platform-side parses assistant output. `HeadlessAgentProcessor`
  and its contract are deleted, and (review decision, superseding the
  original shim plan) `config.driver` is deleted OUTRIGHT: old
  driver-bearing `agent/configured` events fail the strict payload schema
  and skip; old seeded worker code appending driver flips fails loudly.
  Existing converted agents fall back to platform parsing until
  codemode-tag's deploy-time sweep appends the explicit flag. The
  `"agent-headless"` slug is NOT re-registered either: leftover
  subscriptions under that name fail loudly, which is fine — those agents
  work through the "agent" subscription every stream carries from birth.
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

- Dead worker + chatty user: every message re-anchors a fresh 60s window
  (true debounce), so the first reply can be pushed out indefinitely.
  Organic failure; observability is a someday-problem.
- **Existing projects** (seeded before this change): their worker.ts never
  lowers the debounce, so agents they create AFTER this deploys debounce at
  60s per message until the project's config repo is updated. Existing
  agents are untouched (no new birth event lands on them). FLAGGED for
  discussion before merge — the fix per project is a one-commit worker.ts
  update.

## Checklist

- [x] Task file spec commit (this file) _committed first as `ecc65fb1a`_
- [x] Delete #2497 stored wishes _`agent-defaults.ts` (schema, validator,
      allowlist, folding), `readAgentBirthDefaults` in rpc-targets.ts,
      `AgentBirthDefaultsValue` in sdk.ts, and the project processor's
      generic defaults store (`project/defaults-configured` + state.defaults
      — agents was its only consumer)_
- [x] Contract: `interpretResponses`, driver deleted _v6.0.0; the driver→flag
      fold shim was built, then deleted in review — old driver events now
      fail strict schema and skip; stale "measured from FIRST trigger"
      debounce description fixed in passing (the fold anchors to the NEWEST
      trigger)_
- [x] Merge headless into `AgentProcessor` _flag gate lives at the
      composition point in AgentProcessor.processEvent (review round:
      originally inside AgentCodemode); agent-headless-processor.ts deleted
      outright (review decision: no stub — old streams' "agent-headless"
      subscription deliveries fail loudly, accepted; their agents still work
      through the "agent" subscription every stream carries from birth);
      liveState reads one fold_
- [x] create(): explicit birth config event _`agent/birth-config:v1` —
      parsing on, debounce 60s. NEWBORN-GATED: create() is get-or-create and
      revision-bumped batch events deliberately land on existing agents as
      upgrades, so a `getEvents({limit: 1})` probe skips the event for
      pre-existing streams (a late 60s event would overwrite the worker's
      lowered value). Integration routers pass highInitialDebounce: false —
      their agents carry explicit prompts at birth and keep 250ms_
- [x] configs/default _#configureNewbornAgent on agent/created: forked-prompt
      supersession (read-compare vs the platform slot), lowercase
      house-style context, debounce 250 last; worker-updated publish deleted_
- [x] configs/codemode-tag _birth reaction (parsing off + XML prompt +
      debounce 250, one atomic batch), deploy-time #convertAgents sweep for
      pre-existing agents, driver-handover + idle-wait machinery deleted;
      interpreter now gates on a per-turn snapshot of the parsing flag
      (platform stamp alone no longer distinguishes who owns the turn)_
- [x] configs/with-voice _minimal reaction: lower the debounce, nothing else_
- [x] Tests _agent-response-parsing.test.ts (renamed from headless test):
      the flag-off userland loop (the driver-shim and stub-inertness specs
      were deleted with their subjects); agent-processor.test.ts:
      the birth-hold/organic-early-release spec + dead-worker degrade spec;
      agent-defaults.test.ts: birth-config in/out; template test: birth
      reaction incl. copied-event guard; defaults-store tests removed_
- [x] format → lint:fix → knip → codegen → full suite _lint:fix regenerates
      the template codegen; itx-api regenerated post-format_
- [x] Push; close #2507 with a link here _closed as superseded_

## Proposed PR body

> ## Agent birth: all-in on debounce
>
> New agents are born with platform defaults inline (as today) plus one new
> explicit config event: response parsing ON, debounce **60s**. The
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
>       payload: { config: { interpretResponses: false, llmRequestDebounceMs: 250 } } },
>     { type: ".../agents/context-added",
>       payload: { role: "system", key: "agent/system-prompt", content: "...<codemode> blocks..." } },
>   );
> ```
>
> - `interpretResponses` replaces `config.driver`; the headless processor,
>   its slug, and the driver knob are deleted outright (flag-off = old
>   headless semantics). Old driver events fail strict schema and skip;
>   leftover "agent-headless" subscriptions fail loudly — accepted, those
>   agents work through their "agent" subscription.
> - The 60s birth event is gated to brand-new streams by an existence
>   probe: create() is get-or-create, and a late 60s event would overwrite
>   the worker's lowered debounce on existing agents.
> - The #2497 project birth-defaults store (`agents/birth-defaults` wishes)
>   is deleted — the reactive path replaces it.
> - codemode-tag's LLM dialect switches from ```ts fences to XML
>   `<codemode>` blocks, demonstrating full userland control of parsing.
>
> Known consequence: projects seeded before this change don't lower the
> debounce; their newly-created agents wait 60s per message until the
> project commits an updated worker.ts.

## Implementation log

- 2026-08-19: branch created on root worktree; spec committed before
  implementation. Plannotator rounds recorded in
  `explainers.ignoreme/agent-birth-all-in-debounce-plan.html` (gitignored).
- 2026-08-19: implementation in one pass. Judgment calls beyond the spec:
  - **Newborn probe in create()** (the one piece of the spec that grew):
    the plan said "explicit 10s event in the birth batch", but create() is
    get-or-create — agents call `child.create()` routinely, and the batch's
    revision-bumped events deliberately land on existing agents as
    upgrades. An unconditional new event would therefore hit EXISTING
    agents on their next re-create and overwrite the worker's lowered
    debounce with 10s, permanently. A `getEvents({limit: 1})` existence
    probe gates the event to brand-new streams; race-safe because
    concurrent creates that both see an empty stream append identical
    batches that dedupe on keys.
  - **Driver shim instead of hard delete**: old `agent/configured` events
    (and old seeded worker code still deployed in project repos) carry
    `config.driver`. Rather than letting them fail strict schema and skip,
    the configured payload tolerates the field and the fold maps
    `agent-headless` → parsing off — existing converted agents keep exact
    semantics with ~6 lines, marked for deletion later.
  - **codemode-tag interpreter gate**: previously "stamped by the headless
    slug" implied "converted stream". With one processor the stamp no
    longer distinguishes, so the interpreter snapshots the agent's parsing
    flag once per assistant turn — parsing on → the platform owns the
    turn, skip (prevents double chat messages in the degraded-start
    window).
  - Deleted the project processor's generic defaults store entirely
    (event + state.defaults): the agents key was its only consumer.
  - Deleted two stray `*.ignoreme.ts` scratch files in apps/os that broke
    typecheck (left over from an earlier debugging session).
- 2026-08-19 (review round): renamed the flag
  `enableDefaultLlmResponseParsing` → `interpretResponses` (the original
  was a placeholder), and stripped the two-processor plumbing the flag had
  made vestigial: the `AgentComponent` interface and generic components
  list are gone (AgentProcessor now holds three named parts and calls them
  explicitly, with the interpretResponses gate visible in processEvent);
  the module-level `agentComponentHost` adapter and its protected-member
  cast became a private `#makeHost()` method; the injected
  `AgentResponseFormat` (only ever fencedTs) is now a direct import in
  agent-codemode.ts — agent-response-format.ts stays as the dialect module.
- 2026-08-19 (review round): the driver shim reversed — `config.driver` is
  deleted outright (payload field, fold mapping, shim test). Old driver
  events fail strict schema and skip; existing converted agents fall back
  to platform parsing until codemode-tag's deploy-time sweep appends the
  explicit flag. Same loud-failure stance as the stub deletion.
- 2026-08-19 (preview review): `AGENT_INITIAL_DEBOUNCE_MS` bumped 10s → 60s
  after a live preview birth hit the timeout on a first-ever worker build
  (thread p1711/agents/web/2026-08-19t16-12-19-764z). Ridiculously generous
  on purpose — a wrong-dialect first turn costs more than a slow one;
  tighten once cold-build latency is optimised.
- 2026-08-19 (preview review): newborn-probe bug found live (preview p1743:
  wrong-format reply at ~2s). The probe counted ANY event, but probing an
  unborn path materializes the stream DO, whose bookkeeping events
  (stream/created, platform subscriptions) can commit before the read
  returns — the probe raced its own side effect, concluded "preexisting",
  and skipped the birth config entirely (debounce 250, parsing on → the
  worker lost by 165ms). Fixed: the probe filters to agent/created, the one
  event that means "agent exists".
- 2026-08-19 (preview review): codemode-tag birth-reaction ordering fix —
  the AGENTS.md sync ran AFTER the conversion batch whose last event lowers
  the debounce (the release), so first turns raced AGENTS.md and its
  application looked inconsistent across agents (preview p1759). Sync now
  runs first, release stays last — matching the default template's order.
- 2026-08-20 (preview review): configs/** added to the preview workflow
  trigger paths and the OS app's affected-paths. Template seeding pins
  github references to the DEPLOYED revision's SHA, so a template-only
  change (like the AGENTS.md ordering fix) was unreachable on preview: the
  deploy said "nothing to deploy" and new projects kept seeding the old
  pinned template (observed on p0936). The one red check on the previous
  head was an unrelated slack-agent e2e flake (model reply omitted the
  slack call; same code passed the suite on the prior run).
- 2026-08-20 (pre-merge prd migration): the debounce-lowering `agent/created`
  reaction was committed to 9 of the 10 prd project config repos ahead of
  deploy (harmless today: 250 is already the default; `interpretResponses`
  deliberately NOT included — prd's strict configured-payload schema would
  reject it until this deploys). Via `itx.repo.edit` exact-once matching;
  every worker rebuilt (`worker-updated`) within seconds. Placed AFTER the
  existing AGENTS.md sync where one existed (release last). Commits:
  voice-test 75104c9, voice-fresh f952ecb, eval-…403947 16ada83,
  eval-…249689 1aa12a9, jeeves 7f4b7c1, garple be512df, lispwoso 4a176f7,
  misha ed2856c, iterate 3f04ffe.
  **restaurant NOT migrated**: it is built on the deleted mechanisms
  (publishes `agents/birth-defaults` with `driver: "agent-headless"` + a
  waiter debounce, gates its prompt sync on `config.driver`). After deploy
  its defaults publish is inert, driver appends are rejected, and the gate
  never matches — its waiter flow breaks until migrated to
  `interpretResponses` + a reactive birth, which can only land post-deploy.
