---
status: ready
size: large
---

# Prompt sections, slice 2: provenance + derived roles

Spec settled in a plannotator interview 2026-08-25 (16 revisions, 7 questions).
Slice 1 was PR #2512; the decision record is tasks/prompt-sections-tree.md
(Decision 8 revised by this interview — see the dated note there).

## Status

In progress. Spec below is final; the implementation plan (with the judgment
calls it forced) is at the bottom, in the log.

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

- [ ] Contract v8.0.0: kind-discriminated context-added payload; `actor` required on new appends; `worker`/`platform`/`model` actor variants; `role` demoted to read-side fallback; regenerate itx-api
- [ ] Fold: `modelRoleForContextItem` → exported `deriveRole` (the ladder); demotion special-cases deleted
- [ ] Gate: caller-scoped append schemas; actor stamped from authenticated caller; section variant absent from router shapes; specs per caller class
- [ ] Producers: routers (slack/telegram/email/github) stop writing `role`; MCP session policy + birth defaults + both template workers author the section variant; three assistant-record sites gain `{type: "model"}`; corrective-feedback sites gain `{type: "platform"}`
- [ ] UI readers of `payload.role` (pretty-state, feed, activity rounds, inspectors) switch to `deriveRole`
- [ ] Protocol prompt: role paragraph rewritten to teach trust-by-provenance; AI Gateway response-cache key version bump
- [ ] Specs: slice-1 byte-superset + first-appearance pass with only event-synthesis edits; build on the prompt-scenarios fixture suite (apps/os/src/domains/agents/prompt-scenarios/) — extend/add scenarios rather than hand-writing request outputs
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
  live producer that relied on that is the default template's
  `config/onboarding-start`; it becomes an unkeyed worker-actor message
  (derives developer, still triggers). **JC**: projects whose config repo
  still runs the old template create their onboarding agent with a keyed
  developer item that no longer speaks first; new projects seed the new
  template, existing projects already onboarded — accepted, not mitigated.
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

- (running notes appended below as implementation proceeds)
