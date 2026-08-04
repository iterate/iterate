---
status: in-progress
size: small
---

# Stop agents outsourcing their own job to ai.run; teach the HTML→Markdown path

## Status summary

Spec fleshed out; implementation not started.

## Motivation

A prod chat (`agents/mobile/2026-08-03t16-27-32-701z` in the misha project) took 8 rounds
to summarise five FirstFT emails. The transcript shows both failure modes were taught by
our own docs:

- The agent piped email content through `itx.ai.run("@cf/meta/llama-3.2-3b-instruct")`
  and relayed the 3B model's output verbatim to the user, because the `ai-generate-text`
  example and `AiRpcTarget.__describe()` both advertise "summarize, draft, classify,
  answer" as *the* use case for `ai.run`. Nothing anywhere says "you are already the LLM —
  return the data and write it yourself". It also burned ~4 rounds guessing `ai.run`'s
  call shape (`run({messages})` instead of `run(model, body)`) and re-reading docs.
- The agent hand-rolled a regex HTML-stripper for the Gmail message bodies.
  `itx.ai.toMarkdown` already converts HTML (with `conversionOptions.html` knobs), but
  the gmail example stops at `format: "metadata"` subjects, never mentions that bodies
  are base64url MIME parts, and the toMarkdown docs frame it as a converter for stored
  documents, not for an in-hand HTML string.

## Checklist

- [ ] Invert the `ai.run` framing in the three source-of-truth descriptions: the
      `AiRpcTarget.__describe()` instructions, the `run` JSDoc (flows into
      `itx-api.generated.ts`), and the `ai-generate-text` example description.
      New framing: `ai.run` is for what the agent *cannot* do (image/audio/video
      generation, transcription, bulk classification at volume) — never for text the
      agent is about to read or relay.
- [ ] Reshape the `ai-generate-text` example body to demo the legitimate use (bulk
      classification via `Promise.all`) instead of demoing summarisation.
- [ ] Add a "you are the LLM" bullet to THE SHAPE OF WORK in
      `agent-defaults.ts` (and bump `DEFAULT_AGENT_SYSTEM_PROMPT_REVISION`).
- [ ] Extend the `gmail-search-inbox` example with the real body path: fetch one
      message `format: "full"`, walk MIME parts for `text/html`, base64url-decode,
      convert with `itx.ai.toMarkdown` — with description keywords (body, content,
      read, html) so word-overlap docs search routes email-content tasks there.
- [ ] Say "in-hand HTML string → `new Blob([html], { type: "text/html" })` →
      `toMarkdown`" in the toMarkdown descriptions (`__describe` child, JSDoc
      overload, `cf-ai-to-markdown` example description).
- [ ] Regenerate `itx-api.generated.ts` / `examples.generated.ts` and run checks.

## Explicitly out of scope (for now, per Misha)

- Renaming/retitling the `ai-generate-text` example for search ranking.
- Promoting the "choosing a door" (egress.fetch vs browser markdown vs toMarkdown)
  guidance into the system prompt.
- A `getMessageText(id)`-style helper on the gmail integration — not ready for
  helper functions yet.
- Truncation/spill-file ergonomics (separate problem, observed in the same chat).
- The stale `apps/os/src/README.md` pointer to deleted `types.ts`.

## Implementation notes

(log kept while implementing)
