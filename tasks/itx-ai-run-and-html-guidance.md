---
status: in-review
size: small
pr: https://github.com/iterate/iterate/pull/2399
---

# Stop agents outsourcing their own job to ai.run; teach the HTML→Markdown path

## Status summary

Implemented, all checks green, PR open as draft. All checklist items done; one
judgement call flagged below (example title changed alongside its description).

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

- [x] Invert the `ai.run` framing in the three source-of-truth descriptions
      _(rpc-targets.ts: `AiRpcTarget.__describe()` instructions + `run` child blip +
      `run` JSDoc, which flows into `itx-api.generated.ts`; and the `ai-generate-text`
      example description in examples-source.ts)_
- [x] Reshape the `ai-generate-text` example body to demo bulk classification
      _(Promise.all over reviews → one-word sentiment each; also retitled "Run a hosted
      text model for bulk, mechanical work" — the old title "Generate or summarize text
      with a hosted LLM" contradicted the new description. Retitle-for-search-ranking
      was scoped out, but leaving an opposite-message title made no sense; the id
      `ai-generate-text` is unchanged. The body now compiles clean against the surface,
      so its SURFACE_GAPS excuse in examples-typecheck.test.ts was deleted per that
      test's own contract.)_
- [x] Add a "you are the LLM" bullet to THE SHAPE OF WORK
      _(agent-defaults.ts; revision 6 → 7. The bullet overflowed the prompt budget by
      ~47 tokens, so DEFAULT_PROMPT_TOKEN_CEILING went 4150 → 4200 with a dated
      rationale comment, following that file's established raise protocol.)_
- [x] Extend `gmail-search-inbox` with the real body path
      _(search → metadata subjects as before, then: fetch first hit `format: "full"`,
      flatten the MIME tree with a stack walk (generated bodies must be plain JS — no
      TS annotations, so no typed recursive helper), prefer text/html, base64url-decode,
      `itx.ai.toMarkdown`. Description now carries the magnet words: content, body,
      html, base64url, MIME, "never regex-strip HTML by hand".)_
- [x] Teach "in-hand HTML string → Blob → toMarkdown" in the toMarkdown descriptions
      _(`__describe` child blip + JSDoc overload in rpc-targets.ts, plus the
      `cf-ai-to-markdown` example description and body, which now converts an HTML
      string alongside the CSV.)_
- [x] Regenerate and run checks
      _(examples.generated.ts, itx-api.generated.ts ×2, itx-api-graph.generated.ts;
      typecheck, lint, knip, format, full apps/os unit suite all green.)_

## Explicitly out of scope (for now, per Misha)

- Renaming the `ai-generate-text` example *id* for search ranking.
- Promoting the "choosing a door" (egress.fetch vs browser markdown vs toMarkdown)
  guidance into the system prompt.
- A `getMessageText(id)`-style helper on the gmail integration — not ready for
  helper functions yet.
- Truncation/spill-file ergonomics (separate problem, observed in the same chat).
- The stale `apps/os/src/README.md` pointer to deleted `types.ts`.

## Implementation notes

- The examples generator extracts fn bodies as **plain JS** (they must parse under
  `AsyncFunction`), which is why the gmail MIME walk is a while-stack instead of a
  typed recursive function — a recursive arrow can't infer its own type without an
  annotation, and annotations fail generation.
- After the `ai-generate-text` body rewrite, tier-1 typecheck of the generated body
  came back clean, and examples-typecheck.test.ts treats a clean excused entry as an
  error ("the excuse should be deleted") — so the excuse was deleted; sibling excuse
  entries now cross-reference `ai-generate-image` instead.
