---
status: in-progress
size: small
---

# getScriptResult slice — server-side paging of stored script results

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

- [ ] `GetScriptResultOptions` type in capability-host `types.ts`
- [ ] Processor verb accepts `options` and slices canonical text (`capability-host-processor-implementation.ts`)
- [ ] DO + rpc-target pass-throughs (`capability-host-durable-object.ts`, `rpc-targets.ts`), docstrings + `__describe` children note updated
- [ ] Regenerate `itx-api.generated.ts` / `itx-api-graph.generated.ts` (+ packages/iterate copy) via `pnpm generate:itx-api`
- [ ] rawTextSpillNotice loader-branch recipe demonstrates server-side slicing via `getScriptResult(..., { slice })`; workspace pointer line stays
- [ ] Tests: slice of a string result, slice of a JSON result (pretty-printed equivalence), clamping/negative offsets, unsliced unchanged, failed-script throw
- [ ] Update agent test asserting the old load-then-slice recipe
- [ ] `pnpm typecheck && pnpm lint && pnpm knip && pnpm format && pnpm test`

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

