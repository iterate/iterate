---
status: ready
size: large
---

# Prompt sections, slice 2: provenance + derived roles

Spec settled in a plannotator interview 2026-08-25 (16 revisions, 7 questions).
Slice 1 was PR #2512; the decision record is tasks/prompt-sections-tree.md
(Decision 8 revised by this interview — see the dated note there).

## Status

Not started. Spec below is final.

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

(empty)
