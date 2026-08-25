---
status: done
size: small
---

# Context metadata lines only on synthesized messages

**Status summary**: implemented — fold render gated on stored role (refs
exception via keep-the-line), protocol prompt updated, cache key bumped to v5,
all unit suites, regenerated fixtures, and both e2e sanity specs green
locally. Nothing outstanding beyond CI/review.

Today every timeline item renders with a leading protocol-metadata line
(`@<offset> [key=…] [actor=…] [refs=[…]]`). Design review of the merged
prompt fold (#2512, discussed while reviewing #2515) concluded the line
earns its keep on messages the platform synthesizes and costs the most on
the model's own turns: nothing mechanical reads offsets back out of
prompts, and every assistant turn visibly starting `@N` is few-shot
pressure for the model to start writing `@`-lines itself (and to notice
its own output was edited). Misha's call: **metadata lines go on
system/developer messages only — user and assistant turns render bare.**
The send stamp ("Requested at:") is already a synthesized developer
message, so the model's clock keeps its place in the timeline.

## Decisions (best-guess where not specified — marked ⚠️)

1. **The rule keys on the STORED payload role, not the rendered role.**
   `modelRoleForContextItem` demotes some developer payloads to render as
   user (webhook-derived actors, compaction summaries) precisely because
   their CONTENT is untrusted — but those are exactly the items where the
   provenance metadata (`actor=webhook:…`, refs) matters most to the trust
   story the protocol prompt tells. ⚠️ So: payload.role system/developer →
   metadata line; payload.role user/assistant → bare. A compaction summary
   (developer payload rendered as user) keeps its line; a human's chat
   message loses it.
2. **Assistant items render exactly what the assistant produced.** No
   `@offset` line — replaying its own turns verbatim removes both the
   mimicry pressure and the edited-my-output dissonance.
3. **User items render bare content.** ⚠️ Their `actor=user:web`
   provenance drops from the prompt; the protocol prompt's role-semantics
   paragraph already tells the model how to treat user-role items, and the
   event retains full provenance for every non-prompt consumer (UI,
   audits). If a specific integration needs per-message user provenance in
   the prompt, it can say so in content — not blocked by the kernel.
4. **The `refs=[…]` affordance moves with the line.** ⚠️ An item whose
   payload carries refs but whose role renders bare (e.g. a user message
   with attachments) still needs the model to see the ref coordinates —
   render refs for such items as a trailing bracket line only when refs
   exist, or fold refs into the metadata-line rule's exception: any item
   WITH refs keeps the metadata line regardless of role. Pick whichever
   reads cleaner in the fixtures; record the choice in the log.
5. **Protocol prompt updated in the same change**: the "Timeline items
   start with @<offset>" sentence becomes conditional ("System- and
   developer-role timeline items start with…"), and the supersedes/section
   sentences stay as they are. The agent-to-agent reply instruction
   (actor=agent items are developer-role) is unaffected.
6. **Cache-key version bump**: rendered bytes change for every existing
   stream, so bump CLOUDFLARE_AI_GATEWAY_RESPONSE_CACHE_KEY_VERSION (v4 →
   v5) and confirm `maskCloudflareAiGatewayResponseCacheEntropy` needs no
   change (the mask targets "Requested at:", which is untouched).
7. **Byte-superset invariant is preserved by construction** — the change
   is per-item rendering, not placement; the specs proving it should pass
   with only expected-output updates.
8. **Fixtures regenerate**: `pnpm --dir apps/os vitest run prompt-scenarios -u`
   refreshes the scenario fixtures and the generated explainer page — the
   diff of those regenerated fixtures IS the review artifact showing the
   before/after prompts. Annotations referencing metadata lines on
   user/assistant items must be re-anchored (stale `find`s fail the test,
   so they can't slip through silently). The prod explainer sync happens
   after merge, not in this PR.

## Checklist

- [x] fold render: metadata line gated on stored role (decision 1–4),
      protocol prompt wording updated (decision 5) — _`renderProjectedContextItem`
      in agent-prompt-fold.ts: `hasMetadataLine = role system/developer || refs
      present`; decision-4 choice: any item WITH refs keeps the full metadata
      line (one render shape, one protocol sentence). Protocol prompt sentence 3
      now conditions on role, sentence 5 reworded to "Protocol metadata never
      extends past an item's first line"_
- [x] cache key version bump + mask sanity check (decision 6) —
      _workers-ai-transport.ts v4 → v5; the `"content":"@\d+` offset mask still
      matches exactly the items that keep the line, "Requested at:" mask
      untouched — no mask change needed_
- [x] fold/processor specs updated; byte-superset + first-appearance specs
      still pass — _agent-prompt-fold.test.ts (3 user-item first-lines now bare
      content), agent-processor.test.ts (files test asserts bare content),
      llm-request-replay.test.ts (same); byte-superset and first-appearance
      specs pass unchanged. Full apps/os unit suite green_
- [x] scenario fixtures + explainer regenerated via -u; annotations
      re-anchored where they referenced dropped lines — _`vitest run
      prompt-scenarios -u` then a plain run (idempotent); every annotation
      `find` anchored to content or section tags, none referenced dropped
      lines, so no manual re-anchoring was needed_
- [x] e2e/eval sanity: agent-response-cache e2e and one codemode round-trip
      spec green — _both run locally against a fresh dev server under
      `doppler run --config dev`: agent-response-cache.e2e.test.ts (cache HIT
      after the v5 key's warm-up MISS) and agent-codemode-fence.itx.e2e.test.ts
      each 1/1 green_

## Implementation log

- Decision 4 resolved as "any item carrying refs keeps the metadata line
  regardless of role": one render shape, one protocol-prompt sentence, and
  the ref coordinates stay on the same line as `actor=` provenance. The
  trailing-bracket-line alternative would have introduced a second metadata
  format needing its own protocol explanation.
- Decision 1 confirmed in code: the gate reads `payload.role` (stored), so a
  demoted developer item (slack/telegram/email/github actor, compaction
  summary) renders as user WITH its provenance line — the existing
  demotion-taxonomy specs in agent-processor.test.ts pass unchanged.
- A user item with file attachments but no refs renders bare: files ride the
  message object and `prepareAgentLlmMessages` flattens the attachment hint
  at send time, so nothing is lost from the prompt.
- stream-processor-pretty-state.tsx's `renderProjectedContextItem` was
  inspected and left alone: it is a state-inspector view of the standing
  document that prints `role=` and `updates=` fields the prompt never
  renders — a debug affordance, not a prompt mirror. codemode-tag's worker
  has no vendored renderer; its `@${event.offset}` hits are idempotency keys.
- Fixture regeneration: all annotation `find` anchors already pointed at
  content strings or `<section>` tags, so the -u cycle re-anchored the
  rendered comments automatically; a plain run confirms idempotency.
- e2e sanity ran locally: started a detached dev server and ran
  agent-response-cache.e2e.test.ts plus agent-codemode-fence.itx.e2e.test.ts
  under `doppler run --config dev` — both green. The v5 cache-key bump makes
  the first run a MISS then HIT, which the test models as expected warm-up.
