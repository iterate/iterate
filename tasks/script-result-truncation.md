---
status: in-progress
size: medium
---

# Smarter truncation for oversized script results

**Status summary:** implemented; unit tests green (typecheck/lint/knip/format clean). Remaining: CI + review. Followup task filed for typed `Results<...>` handles.

When an agent script returns a big result, `renderScriptSettlement` slices the pretty-printed JSON at `scriptResultHistoryLimit` (30k chars) — bisecting JSON mid-key and showing only the start of the payload (often one giant array's first entries). The model learns nothing about overall shape; in [this chat](https://os.iterate.com/projects/misha/agents/streams/agents/mobile/2026-08-03t16-27-32-701z) the agent had to guess a prior result's structure and got it wrong.

Fix: on overflow, render (1) an inferred TypeScript type of the whole value, (2) a small inspect-style preview (a few items per array, capped strings/depth, valid JSON with truncation markers), (3) the existing spill notice. The full result already spills to `script-results/<id>.json`; the type tells the agent how to write the follow-up `readFile` script.

Decisions (grilled with Misha 2026-08-04):

- Drill-in stays the spill-file + `itx.workspace.readFile` recipe. Typed `Results<"agent-output-400">` cast is a followup (see `tasks/typed-script-result-handles.md`).
- Type inference is hand-rolled (sync, zero deps, Workers-safe) — not quicktype (Workers compat scar tissue: the `quicktype-core>readable-stream` pnpm override).
- Preview builds on the existing `truncateJsonToBytes` (was PostHog-only) with an aggressive arrays/strings/depth policy pre-pass.
- Budget shrinks on overflow: type ~3k chars + preview ~10k bytes + notice. 30k stays the passthrough threshold, per-agent patchable as before.

## Checklist

- [x] `apps/os/src/lib/infer-json-type.ts` — `inferJsonType(value, {maxChars})` → TS type text: structural merge of array elements (union cap ~3), cardinality comments (`// 1234 items`, `// ~45k chars`), small literal unions for repeated short strings, budget enforced by collapsing deepest subtrees to `unknown` _shape lattice + merge + depth-shrinking renderer; also renders wide keyed maps as `Record<string, T>` and drops undefined-valued keys to match the spilled JSON_
- [x] unit tests `apps/os/src/lib/infer-json-type.test.ts` _11 tests incl. optionality-from-undefined and budget enforcement_
- [x] move `apps/os/src/domains/integrations/truncate-json.ts` (+ test) → `apps/os/src/lib/`, update posthog import; no behavior change _git mv; only importer was posthog.ts_
- [x] add `previewJson(value, {maxArrayItems, maxStringChars, maxDepth, maxBytes})` to truncate-json — policy pre-pass reusing existing marker idiom, then byte-budget guarantee _policy pass over the MeasuredJson tree (tiny ≤100-byte subtrees survive untouched), then truncateJsonToBytes for the ceiling_
- [x] rewire `renderScriptSettlement` JSON overflow branch: type block + preview block + spill notice (recipe now `const data: Result = JSON.parse(...)`); raw-text results keep slice path with ~10k preview; failure branch unchanged; `inferJsonType` failure degrades to no type block _`renderOversizedJsonResult` in agent-processor-implementation.ts; budgets 3k type / 8k preview / 10k raw-text, each clamped to historyLimit_
- [x] update system-prompt one-liner in `agent-defaults.ts` (~line 207)
- [x] update render expectations in `agent-processor.test.ts` (~1040–1140); e2e spill test should pass as-is _JSON spill test asserts type block + typed recipe; new test covers array-eliding preview with 400 rows_
- [x] file followup `tasks/typed-script-result-handles.md`

## Implementation log

- 2026-08-04: implemented as specced. Full os unit lane green (2545 passed). Demo render on a Slack-history-shaped 270KB payload: type block ~20 lines with `thread_ts?: string` optionality and literal unions, preview 3 messages + `[truncated 797 items; from 271814 JSON bytes]` marker — total rendered item ~2.5KB vs 30KB before.
