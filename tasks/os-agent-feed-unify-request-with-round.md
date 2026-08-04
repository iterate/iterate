---
status: ready
size: medium
---

# apps/os: show the LLM request with its round, like mobile's Meta tab

Follow-up from #2398 (do after it merges).

In apps/os, an agent turn's pieces are split across surfaces: the feed shows
the script/result rows, while the request that produced them lives in a
separate LLM trace sheet (`?llmRequest=<offset>`,
`llm-request-inspector-panel.tsx`). Mobile's activity card now keeps them
together — each round is `Script | Approvals | Result | Meta`, where Meta is
one YAML doc (model, duration, tokens, outcome, plus the full replayed
prompt under `prompt:`) rendered in the shared code block.

Misha: "it actually bugs me that apps/os separates out the request from the
script/result."

- [ ] Fold the per-request meta + replayed prompt into the feed's round
      rendering in apps/os (tab, expandable section, whatever fits the web
      feed) instead of only the separate trace sheet
- [ ] Reuse the same `replayLlmRequest` fold (`apps/os/src/lib/llm-request-replay.ts`)
      — mobile's Meta tab shows it can drive an inline view directly
- [ ] Decide what happens to the standalone `?llmRequest` sheet (keep as
      deep-link, or retire once the inline view covers it)
