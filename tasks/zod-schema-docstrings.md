---
state: todo
priority: medium
size: medium
dependsOn: []
---

# Get real docstrings out of zod schema `.meta()` descriptions

The agent-next processor contract (and, as the style spreads, every processor
contract) documents every property with zod 4 `.meta({ description })`
instead of JSDoc comments. That is the right single source of truth — the
descriptions ride the schema into runtime introspection — but today nothing
turns them back into DEVELOPER-facing docstrings:

- `z.infer`/`z.output` types carry no JSDoc, so editor hover on
  `state.config.llmRequestDebounceMs` shows a bare `number` — the description
  is invisible exactly where an implementer reads it.
- The generated itx-api surface and the event docs site each have their own
  doc extraction; schema meta is not wired into either.

Look into:

1. A codegen step that emits `.d.ts` (or typed wrapper) declarations with the
   meta descriptions as JSDoc, so hover docs work — possibly as part of the
   existing itx-api generator.
2. Wiring meta descriptions into the events.iterate.com docs rendering for
   contract-owned events (payload property tables, not just the event-level
   description).
3. Whether TypeBox (or another schema library with first-class static-type
   docstrings) would serve better than zod for CONTRACT schemas specifically
   — weigh against how deep zod is in the platform (validation, defaults,
   prefault semantics, discriminated unions, the processor-contract
   machinery).

Origin: Jonas review of PR #2154 (2026-07-20) — "use zod4's zod.meta. also
add a task in tasks/ to note that we need to look into getting correct
docstrings out of these zod schemas in the future (or use typebox or sth)".
