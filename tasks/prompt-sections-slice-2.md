---
status: ready
size: large
---

# Prompt sections, slice 2: provenance + derived roles

Spec settled in a plannotator interview 2026-08-25 (16 revisions, 7 questions).
Slice 1 was PR #2512; the decision record is tasks/prompt-sections-tree.md
(Decision 8 revised by this interview — see the dated note there).

## Status

Implemented; local suites green (apps/os 3001 tests, packages/iterate 405,
mobile 149, shared 77; typecheck/lint/knip/format clean). Main pieces: the
v8 payload union + `deriveRole` in packages/shared, the producer sweep
(platform, routers, templates, starter apps), the append gate in
rpc-targets with per-caller-class specs, every `payload.role` reader
derived, the protocol-prompt rewrite + cache-key bump, and scenario
6-provenance. Remaining: preview e2e verification, and review of the
judgment calls marked **JC** in the plan below (especially worker-tier
channel-actor claims).

## The shape

The v8 context-added payload is a kind-discriminated union; `actor` is
required on every new append; role is derived at render:

```ts
// section (owners only — routers can't express this variant):
{ kind: "section", key: "gotchas", content, actor }
// message (everyone):
{ content, actor, refs?, files?, … }

function deriveRole(payload): Role {
  if (payload.key) return "system";          // sections are standing instructions
  if (payload.compaction) return "user";     // summaries are memory, not instructions
  if (!payload.actor) return payload.role || "user"; // pre-v8 history — or a bug: fails DOWN
  switch (payload.actor.type) {
    case "platform": case "agent": case "script": case "worker": return "developer";
    case "model": return "assistant";
    default: return "user";                  // web/mcp users, all channels, all future actors
  }
}
```

## Decisions (from the interview)

1. **Provenance-first.** Items carry who-supplied-this; trust is a fact about the author, not a claim in the payload.
2. **One pure derivation function at render.** No role logic anywhere else in the fold.
3. **No roleOverride.** Assistant records carry `{type: "model", llmRequestOffset?}`; the compaction summary derives user from its `compaction` field. One enforcement mechanism, zero escape-hatch fields.
4. **Append-time gate decides claimable provenance** — routers mint attested channel identity; a config worker cannot claim to be a human on any channel.
5. **Protocol prompt rewritten** to teach the trust tiers the derivation produces.
6. **`role` never appears on the v8 write surface; one small read fallback, NO TESTS for it** (per Misha). `actor` required on every new append (platform explicit `{type: "platform"}`). Reducer keeps one line: no actor → `payload.role || "user"` — fails down, never escalates. Rejected alternative (ignore stored role entirely): every existing stream's assistant records would re-render as user turns mid-conversation.
7. **The gate is one server-side validation/stamping point** in the OS worker's append handling for agent streams: caller-scoped schema, `actor` stamped from the authenticated caller, claims ignored. `model`/`platform` inexpressible externally.
8. **"Verified" = channel attestation, not OS-principal resolution.** The router attests the channel-native identity it authenticated; identity linking to OS principals is future work, out of this slice.
9. **`deriveRole(payload) → role`, no placement argument** — the ladder above. Developer precedence always requires an explicit gate-controlled claim; a dropped actor can only ever demote.
10. **Sections self-describe as `kind: "section"`** — payload-level discriminated union in the state collection's own vocabulary; `key` exists only inside the section variant (no hidden key⇒system rule, nothing to cross-validate); router schemas omit the variant entirely — keyed sections come from owners only, no new permission model.
11. **Config workers get `{type: "worker", name}`** — named by config slug; reusing `agent` would misattribute the project's own automation as another agent.
12. **`model` and `platform` render no `actor=` line** (default authorship, zero information); all other actors render as today, no per-line "verified" adornment — attestation is taught once, in the protocol prompt.

## Checklist

- [x] Contract v8.0.0: kind-discriminated context-added payload; `actor` required on new appends; `worker`/`platform`/`model` actor variants; `role` demoted to read-side fallback; regenerate itx-api — _agent-processor-contract.ts: three-shape z.union (section / message / read branch); role required on the read branch and absent elsewhere makes "role-free ⇒ actor required" a property of the union itself; `llmRequestOffset` moved onto the model actor; itx-api + examples regenerated_
- [x] Fold: `modelRoleForContextItem` → exported `deriveRole` (the ladder); demotion special-cases deleted — _the ladder lives in packages/shared/src/agent-events.ts (packages/ui and apps/mobile derive the same roles), re-exported from agent-prompt-fold.ts; union access helpers `contextItemKey`/`contextItemCompaction`/`modelOutputRequestOffset` beside it; trigger/waiting-clear/compaction logic reads the derived role_
- [x] Gate: caller-scoped append schemas; actor stamped from authenticated caller; section variant absent from router shapes; specs per caller class — _agent-context-gate.ts under StreamRpcTarget.append/appendIfStreamId + AgentRpcTarget.append; caller classes from ItxAuth plus a `contextGateScopePath` threaded only from the userspace itx mints (env.ITX, capability-host scripts, delivery expression roots); agent-context-gate.test.ts, one spec per class_
- [x] Producers: routers (slack/telegram/email/github) stop writing `role`; MCP session policy + birth defaults + both template workers author the section variant; three assistant-record sites gain `{type: "model"}`; corrective-feedback sites gain `{type: "platform"}` — _plus with-voice, voice-agent, the github-ai-linter starter app, slash-command generated code, rpc message/ask/addFiles, and the web routes; body-shape idempotency-key bumps everywhere a payload changed under a stable key_
- [x] UI readers of `payload.role` (pretty-state, feed, activity rounds, inspectors) switch to `deriveRole` — _agent-ui-reducer (with an interrupt-policy skip replacing the old developer-role feed hiding), mobile chat, pretty-state, llm-request-replay's output slice, agent-codemode/turn-loop/llm-request/presence, chat-reply-notify, explainer badge, voicelab chronology; activity-rounds already keyed on the script actor_
- [x] Protocol prompt: role paragraph rewritten to teach trust-by-provenance; AI Gateway response-cache key version bump — _AGENT_CONTEXT_PROTOCOL_PROMPT teaches stamped-actor provenance; cache key v4 → v5; the masker needed no new rules (worker names are stable config slugs, not per-run entropy)_
- [x] Specs: slice-1 byte-superset + first-appearance pass with only event-synthesis edits; build on the prompt-scenarios fixture suite — _byte-superset and first-appearance passed with ZERO changes; regenerating all seven scenarios moved only the protocol-prompt abridgement line; scenario 6-provenance added, rendering every tier in one request_
- [ ] Decision record: dated revision note on D8 (done in this branch's first commit); slice 2 checked off on merge

## Implementation log

### 2026-08-25: plan (committed before implementation)

Codebase survey done (producers, readers, auth tiers). The plan below is the
spec mapped onto the code as it stands; judgment calls are marked **JC** and
each is a candidate for review pushback.

**Contract v8** — `agentContextItemSchema()` becomes a `z.union` of three
strict variants (one shared actor union across all three):

1. `section`: `{ kind: "section", key, content, actor (required), llmRequestPolicy }`
2. `message`: `{ content, actor (required), files?, refs?, llmRequestPolicy, compaction? }`
   — no `kind` (matches the spec's shape exactly), no `key`, no `role`, no
   payload-level `llmRequestOffset` (it moves onto the model actor).
3. legacy: the v7 shape verbatim (`role` required, everything else as today)
   — **read tolerance for committed pre-v8 events**, which reduce through the
   same schema (`reduceAgentEvents` drops parse failures = conversation
   loss, so the legacy branch is not optional). Because `role` is required
   here and absent in 1–2, the union itself enforces "role never on the v8
   write surface ⇒ actor required": a role-free append without an actor
   fails `buildEvent`.

Actor union gains `worker {name}`, `platform {}`, `model {llmRequestOffset?}`.
**JC**: `llmRequestOffset` lives ON the model actor (per the spec's
`{type: "model", llmRequestOffset?}`); the payload-level field survives only
in the legacy variant, and the reduce guard reads both places.

**deriveRole** — the ladder verbatim, in
`packages/shared/src/agent-events.ts` (structurally typed param so the union
members and loose UI payloads both fit), re-exported from
agent-prompt-fold.ts. Reason for the shared home: packages/ui's feed reducer
and apps/mobile's chat reducer cannot import apps/os, and both need it.

**Fold** — `modelRoleForContextItem` deleted; render + reduce logic reads
`deriveRole`. `model`/`platform` actors render no `actor=` line;
`worker` renders `actor=worker:"<name>"`. Consequences accepted:

- Keyed items derive system, ALWAYS — so a keyed role-developer item no
  longer triggers a turn (v7 fired an agent-loop trigger for it). The one
  live producer that relied on that is the templates'
  `config/onboarding-start`; it becomes an unkeyed worker-actor message
  (derives developer, still triggers). **JC — revised after the first
  preview run**: the original "old templates only, accepted" framing was
  WRONG. Non-default templates (with-voice, codemode-tag, voice-agent) are
  pulled from a GitHub REF at project creation — on local dev and any
  unpinned/default-branch deployment that ref serves worker code predating
  v8, whose keyed-developer kickoff the gate was normalizing into a
  section, silently swallowing the onboarding agent's first turn
  (create-project.spec.ts caught it: the with-voice half never spoke). The
  gate now normalizes worker-tier keyed appends BY CLAIMED ROLE: system (or
  none) → section; developer/user/assistant → an unkeyed worker message
  keeping its policy/refs/files, so pre-v8 conversation starters still
  drive their turn (the worker actor derives developer — exactly the
  claimed role, no escalation; only the key's update identity is lost).
  Spec'd in agent-context-gate.test.ts; create-project.spec.ts passes
  locally against both template code generations.
- `contextTriggerSource`/`contextClearsWaitingFor` rewritten on the derived
  role: system/assistant → never; user → slash-check then external;
  developer → agent-loop. **JC**: `worker` classifies as developer ⇒
  agent-loop trigger (project automation is loop work, like scripts), but
  DOES clear a waiting-for summary (a named outside author, like `agent`).
- `applyContextRewritten` synthesizes v8 section payloads (actor platform —
  the fold wrote it); its role-inheritance line dies with stored roles.

**Gate** — new `agent-context-gate.ts`, applied in `StreamRpcTarget.append`
(the funnel every itx append door drains into: `AgentRpcTarget.append`,
`.message/.ask/.addFiles`, `itx.streams.get(...).append`, web-UI raw
appends). Only `agents/context-added` events are touched. Caller classing
from what the rpc layer already knows (`ItxAuth` + an optional
`callerScopePath` threaded from the itx-vended doors — agent `.stream`,
streams collection `.get`, `.at`):

- external admin / internal-without-scope (platform code) → trusted, no gate.
- external user session → message shape only; `actor` STAMPED
  `{type:"user", origin, userId: principal}` (an `origin: "mcp"` claim is
  kept — same actor type, no escalation); `role` claims tolerated
  (deployed clients) but stripped; `key`/`compaction`/model-platform claims
  rejected.
- internal + `/agents/**` scope (agent scripts, sibling agents) → message
  shape; claimed `script`/`agent` actors kept (self-attribution inside the
  same trust tier — script executionIds are only knowable caller-side),
  anything else stamped `{type:"agent", path: scope}`.
- internal + other scope (config workers) and external `project-secret`
  (remote apps) → section + message shapes; claimed `worker` and CHANNEL
  actors (slack/telegram/email/github/integration) kept; `user`, `model`,
  `platform` claims rejected loudly; missing actor stamped
  `{type:"worker", name: "project-worker"}`.
  **JC — the big one**: the spec says "a config worker cannot claim to be a
  human on any channel", but the github "router" IS userland (the
  github-ai-linter starter app runs inside the config worker and mints
  `{type:"github", login}` from the platform-verified webhook envelope).
  Blocking channel claims for workers breaks that product. Resolution:
  "human" = the OS-authenticated `user` actor (the one carrying a
  principal/device identity); channel actors derive user role (the floor, no
  precedence gained) and remain claimable by workers — their attestation is
  worth exactly "the project's code said so", which the protocol prompt
  teaches. `user`/`model`/`platform` are the externally inexpressible ones.
- Keyed legacy worker payloads normalize to the section variant; stripped
  roles + stamped actors mean gated appends land as v8 shapes.

Routers (slack/telegram/email processor implementations) append inside the
processor runtime, never through these doors — they stay trusted and mint
attested channel actors; their payload shapes simply have no `key`.

**Producers sweep** (drop `role`, add actor):
platform sections + boot context → `{type:"platform"}`; assistant records
(agent-llm-request settle append, turn-loop web-message record, turn-loop
interrupted-partial) → `{type:"model", llmRequestOffset?}`; compaction
summary + corrective feedback + preamble transcription → `{type:"platform"}`;
script-result renders keep `{type:"script"}`; slash-command generated code
keeps script, drops role; rpc message/ask/addFiles drop role; web routes
drop role; slack/telegram/email transcriptions drop role; MCP session policy
rides the shared helper; configs/default + codemode-tag + with-voice +
voice-agent + github-ai-linter → `{type:"worker", name: <config slug>}` on
their own appends, sections as the section variant.

**Readers**: agent-ui-reducer (ui pkg), mobile chat, pretty-state,
llm-request-replay output slice, agent-codemode, agent-turn-loop,
agent-llm-request, agent-presence (`promptExists` = any section item),
chat-reply-notify (actor-based human check), explainer badge, voicelab
chronology — all via deriveRole / actor, per the reader sweep.

**Protocol prompt**: role paragraph rewritten to teach the tiers the ladder
produces + that `actor=` provenance is stamped at append time, not
self-claimed; gateway response-cache key bumped v4 → v5.

**Scenarios**: regenerate all with `-u`, review byte diffs (expect: protocol
prompt line only, plus any legacy-keyed role drift); add scenario
6-provenance showcasing worker/model/platform/channel actors end to end.

### Work log

- 2026-08-25: implemented in three commits (plan → contract/fold/producers/
  gate → readers/tests/scenarios/regen). Notes beyond the plan:
  - **Keyed items never trigger, confirmed live**: converting
    `config/onboarding-start` (and with-voice's twin) to an unkeyed
    worker-actor message preserved onboarding's first turn; the template
    tests pin the shape.
  - **Feed/mobile interrupt hiding moved to policy**: the web interrupt
    notice used role=developer to stay out of the chat; both readers now
    skip `llmRequestPolicy: interrupt-current-request` items instead —
    old interrupt events (role developer + user actor) stay hidden too.
  - **Birth batch appends with platform authority**: AgentRpcTarget.create
    appends the creation batch through a trusted-internal stream target —
    the gate rightly refuses platform actors from external sessions, and
    the batch is platform policy, not caller input. The MCP session policy
    already ran on a trusted-internal itx (no gate marker → trusted).
  - **github-ai-linter task item became a message**: it carries `refs`,
    which the section shape does not; worker actor keeps its developer
    render. Its keyed POLICY items became sections (now derive system
    where v7 rendered developer — single-purpose linter agents, accepted).
  - **project-app-session parses to a user tier** by principal prefix; an
    unknown external credential fails DOWN to user with no richer identity.
  - Docs: apps/os/docs/agents.md role paragraphs rewritten to the derived
    model; snippet fixes in domain-objects and debugging-streams docs.
  - Deferred deliberately: context-rewritten stays ungated (slice-3
    territory: "whoever may replace may compact"); no identity linking of
    channel actors to OS principals (D8: future work); preview e2e run.

- 2026-08-25 (third): merged-head preview fallout (after Misha merged
  main/#2516 into the branch and moved the checkout to the root worktree) —
  all in e2e fixtures and assertions:
  - itx-agents' synthetic-provider helper injected the pre-v8 assistant
    shape; it now records `{content, actor: {type: "model",
    llmRequestOffset}}` — the shape the platform's LLM component writes —
    and its trigger item dropped its stored role.
  - Birth-batch assertions in itx-agents/itx-egress asserted stored
    `role: "system"` on sections; they assert `kind: "section"` now.
  - examples-matrix runs each example across runtimes whose gate tiers
    differ (node/cli sessions send as user; REPL/project-worker send as the
    worker actor), so agent-send-message asserts the derived-sender SET,
    not one actor.

- 2026-08-25 (fifth): media failed BOTH attempts on the next run despite the
  Loading label — the label fix was insufficient, and the trace archaeology
  that followed nailed the full mechanism across all four failing attempts
  (runs 2 and 4, both attempts each): the row's signed-URL query takes
  ~15-20s on the affected runs, and its React commit lands 80-140ms AFTER
  the spec's tap every single time (both the spec's progress and the query
  ride the same slow session, so they converge on the same wall-clock
  moment — correlated, not coincidence). The tap hits the still-disabled
  pressable: silent no-op, viewer never opens, and the post-tap DOM is
  byte-frozen in the trace. The Loading label couldn't save it because
  middlewright extends deadlines only while a spinner is VISIBLE, and the
  placeholder vanished 80ms after the tap — before the next action's
  polls. (An earlier "label never rendered" reading was a grep artifact:
  raw-grepping JSON-escaped snapshot attributes.) Fix is structural now:
  the labeled "View full screen" pressable EXISTS only once imageUri does —
  a press target that cannot act is not rendered — so the spec's tap is an
  ordinary wait-for-element (extended by the visible Loading placeholder),
  and no latency can swallow a press. Verified green against both the local
  and the preview-9 backends.

- 2026-08-25 (fourth): round-three preview verdict, from the run's own
  evidence (not the lane summary): the playwright lane PASSED — media green
  (the race fix holds), create-project FLAKY-passed. Its first attempt lost
  to a platform recovery cycle, proven from the fixture project's stream on
  preview-9: user reply @16:17:01, request opened @16:17:02, then silence
  until stream/processor-revived @16:19:07 — the incarnation died
  mid-attempt (streamed chunks occupy the offset gap), the keepalive
  revival adopted the open request, and the reply landed 16:19:17 — ~16s
  past the spec's 120s manual budget. The retry's sibling project answered
  in 17s end to end. Not a slice-2 code path (nothing here touches
  eviction, keepalive, or transport lifetimes) and not papered over: the
  spec's budget is deliberately shorter than a worst-case revival cycle,
  and lengthening it would hide a real platform-latency event behind green.
  The vitest lane's one red, userspace-facet-source-version, is the known
  pre-existing expected-fail false alarm (distinct bootIds on recycle) —
  not chased, per coordination. Preview retried as-is (Depot job
  wz1s7587kt).

- 2026-08-25 (second): first preview run came back with three spec
  failures; all three root-caused, two were real regressions:
  - **create-project.spec** — two causes stacked: the spec polled the
    `iterate/config/onboarding-instructions:v1` idempotency key I had
    bumped to v2 (spec now finds the event by payload key, which survives
    both shapes AND both template code generations), and the with-voice
    half exposed the gate swallowing pre-v8 keyed-developer kickoffs (the
    JC rewrite above; gate fixed). Passes locally end to end.
  - **repl-examples "agent-send-message"** — the gate correctly refused
    `message()`'s user-actor claim from the REPL's execution scope (project
    code at a non-agent path = worker tier). Fix: `#contextActor()` in
    rpc-targets now classifies through the same gate ladder — worker-tier
    callers' message/ask/addFiles stamp `{type:"worker",
    name:"project-worker"}` instead of claiming a user. Ripples: the REPL
    example and the pipelining e2e assert the worker actor now; a
    worker-tier `message()` is an agent-loop trigger (does not refill the
    autonomous budget) and renders with an actor=worker line — honest:
    these senders are project automation, not attested humans. The MCP
    handler and admin tooling are trusted-tier and keep stamping user
    actors; the voice-agent talk client's ask() moves to the worker actor
    (its notes are relayed transcriptions, not attested user identity).
  - **mobile media.spec** — first ruled preview flake (passes locally, no
    mechanism in this diff), then OVERRULED by comparison evidence (#2516's
    preview passed first try; slice-2 previews failed 4/4). The run
    artifacts (trace + failure screenshot, Depot run znd31nkr6b) gave the
    real mechanism: a RACE in the media row, not a slice-2 code path. "View
    full screen" is a silently-DISABLED press until the signed-URL query
    resolves; the spec clicks ~0.4s after the row's text renders, and on
    the slice-2 previews the URL resolved ~100ms after the click (the trace
    shows the image GET starting right after the failed press). A lost race
    is terminal — nothing re-clicks. Whether slice-2 shifts that latency or
    the previews just landed on the losing side is not provable from two
    runs; the CLASS is closed product-side: the placeholder thumb now
    declares accessibilityLabel="Loading", so middlewright's spinner-waiter
    holds the click until the URL resolves (and humans see an honest
    loading state — the same convention the screen's list loader already
    uses).
