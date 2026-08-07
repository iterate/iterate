---
status: in-progress
size: small
---

# getScriptResult slice — server-side paging of stored script results

> **Status**: done, pending review — slice option live end to end (processor →
> DO → rpc-target → generated itx API), raw-text spill notice teaches the new
> recipe, all gates green (typecheck/lint/knip/format/test). Deliberately left
> out: spill retirement (parent follow-ups task) and a slice recipe in the
> oversized-JSON render.

Follow-up to #2431, scoped-down take on the fourth item of
`tasks/codemode-script-preamble-followups.md` ("do we still need spill?").
Per Misha: do NOT retire the workspace spill mechanism yet — just close its
one remaining advantage over `getScriptResult`: paging a slice of a huge
result without loading the whole thing into the script.

## Shape

```ts
itx.capabilityHost.getScriptResult(executionId, options?: { slice?: [start: number, end?: number] })
```

- Unsliced: unchanged — `{ executionId, data }` with the full JSON value.
- Sliced: `{ executionId, data: string, slicedFrom: { totalChars, start, end } }`
  — `data` is always a string page; `slicedFrom` reports the resolved
  (clamped) offsets plus the canonical text's total length so the caller can
  keep paging.
- Slicing operates on the result's **canonical text**: string results as
  themselves; JSON results pretty-printed (`JSON.stringify(data, null, 2)`) —
  the same bytes the workspace spill file holds
  (`stringifyScriptResult` in agent-processor-implementation.ts), so char
  counts quoted in chat history line up with slice offsets.
- `String.prototype.slice` semantics: negative indices count from the end,
  out-of-range clamps, `end` defaults to the end of the text.
- Unknown executions and failed scripts throw exactly as before, sliced or
  not.

## Checklist

- [x] `GetScriptResultOptions` type in capability-host `types.ts` _plus `ScriptResultSlicedFrom`; lives beside SetPreambleInput, picked up by the itx generator_
- [x] Processor verb accepts `options` and slices canonical text (`capability-host-processor-implementation.ts`) _slice resolution inline in `getScriptResult`; `validatedSlice` helper rejects malformed tuples_
- [x] DO + rpc-target pass-throughs (`capability-host-durable-object.ts`, `rpc-targets.ts`), docstrings + `__describe` children note updated _the rpc-target docstring is what the generated API publishes_
- [x] Regenerate `itx-api.generated.ts` / `itx-api-graph.generated.ts` (+ packages/iterate copy) via `pnpm generate:itx-api` _generator run; no hand edits; union signature + both new type aliases came through_
- [x] rawTextSpillNotice loader-branch recipe demonstrates server-side slicing via `getScriptResult(..., { slice })`; workspace pointer line stays _agent-processor-implementation.ts; `load(itx)` kept as the whole-string escape hatch; small-result (`data`) branch unchanged_
- [x] Tests: slice of a string result, slice of a JSON result (pretty-printed equivalence), clamping/negative offsets, unsliced unchanged, failed-script throw _three new specs in capability-host-preamble.test.ts beside the existing getScriptResult one_
- [x] Update agent test asserting the old load-then-slice recipe _agent-processor.test.ts "oversized result's render points at the preamble's typed loader" now expects the slice recipe_
- [x] `pnpm typecheck && pnpm lint && pnpm knip && pnpm format && pnpm test` _all green in the worktree (2710 tests, 262 files)_

## Assumptions (mine, delineated)

- **Union return type, not overloads**: the generated itx surface publishes a
  single signature whose return is a two-branch union. `.data` collapses to
  `unknown` on the union, so the preamble loader's `as ResultN` cast is
  unaffected. Overload projection through the generator felt riskier for no
  reader benefit.
- **Pretty JSON, not compact, as canonical text**: the spill file and every
  "your script returned N chars" message use `JSON.stringify(x, null, 2)`;
  matching that keeps offsets meaningful to the agent. (The preamble's
  16 KB inline threshold uses compact JSON — that's a retention decision,
  not a paging surface, so no conflict.)
- **Only the raw-text spill notice gains a slice recipe**: the oversized-JSON
  render keeps its loader-first "filter/pick with TypeScript" recipe —
  structured filtering beats text paging for JSON; text paging is the raw-text
  story.
- **Spill stays**: the workspace pointer lines remain; retiring spill is a
  future decision (see the parent follow-ups task).

## Implementation log

- `slicedFrom.start/end` report the *resolved* offsets (after negative
  resolution and clamping), not the caller's raw inputs — that's what a
  paging loop needs; an inverted range serves the empty page at the resolved
  start.
- Slice validation rejects non-integer offsets loudly (repo style: validate
  assumptions rather than coerce).
- `results[N].load(itx)` preamble loaders keep calling `getScriptResult`
  optionless; `.data` on the union return collapses to `unknown`, so the
  loader's `as ResultN` cast needed no change. No stream/state/event changes
  anywhere — read-verb extension only.

