---
status: implemented
size: large
branch: codemode-script-preamble
pr: https://github.com/iterate/iterate/pull/2431
---

# Codemode script preamble ("prior results" for agent scripts)

## Status summary

Implemented and green locally (typecheck, lint, knip, format, full test suite). Main pieces all landed: contract events + retained-results state, the two-variant assembler, typecheck/execution injection with attribution rules, host verbs (`setPreamble`/`removePreamble`/`getPreamble`/`getScriptResult`), agent rendering + prompt teach, ~30 new tests. Remaining: CI + review; possible follow-up to teach the Slack/Telegram prompts about `results` (left out to respect their budgets).

## Motivation

Codemode scripts are exactly one `async (itx) => {...}` expression. When a script returns data, the model can only reuse it by copy-pasting JSON into its next script (token waste, transcription errors) or re-fetching it. Oversized results are worse: they spill to `script-results/` workspace files and the next script must `JSON.parse(await itx.workspace.readFile(...))` by hand.

Fix: a **preamble** — TypeScript injected above the script at both typecheck and execution. Two sources:

1. **Platform-derived `results` array** — prior script results, addressable and typed.
2. **User/agent-defined entries** via events — constants, helpers, anything:

```ts
const TECH_CHANNEL_ID = "c1234";
function myHelper(input: string) { /* ... */ }
```

## Decisions (grill session, 2026-08-06)

1. **Capability host owns preamble state.** New events `capability-host/preamble-set {key, code}` (keyed upsert) / `capability-host/preamble-removed {key}` on the capability-host contract (v0.5.0), reduced into host state; entries ordered by first-set offset. Every script door in the scope — agent output, slash commands, scheduler, public `runScript` — gets the preamble at typecheck + execution. *(user-approved)*

2. **Prior results are auto-provided by the platform**, reusing the existing small-vs-spilled split — no new truncation algorithm. Small results embed as JSON literals (their literal type comes for free); large ones contribute their already-inferred type (`inferJsonType`) plus an **async** loader. *(user-approved)*

3. **One `results` array, DERIVED — never stored as preamble code.** The host reduces `script-run-settled` into a retained tail (last 20) and the assembler stitches the array fresh per run. No per-result events, no O(n²) array rewrites — the settlement event is the only durable storage. `results[0]` is newest; `.data` (never `.result`), `.error` for failures, `as const` for literal types, and large rows get `get data(): never { throw }` steering to a typed `load(itx)`. *(user-specified shape)*

4. **Writer surface: methods on the capability host** — `await itx.capabilityHost.setPreamble({ key, code })` / `removePreamble({ key })` / `getPreamble()`. `setPreamble` compiles the assembled preamble at set time and rejects only problems the candidate *introduces* (a stale entry never vetoes an unrelated set).

5. **Execution mechanics.** Typecheck module injects the preamble between the `Itx` alias and the script const — the emitted-JS path carries it for free. No-emit fallback wraps `const fn = await (async () => { <preambleJs>; return (<code>); })()` so preamble names cannot collide with harness symbols.

6. **Typecheck attribution.** Any error on preamble lines downgrades the run gate to `unchecked` (a preamble syntax error cascades misparses, so even script-line diagnostics are untrustworthy then). The advisory door labels preamble errors `preamble:N`.

7. **Model visibility.** Settlement render names the binding (`results[0].data` or `await results[0].load(itx)`); `preamble-set`/`removed` transcribe as non-triggering developer context; the system prompt's fresh-scripts bullet teaches `results` + `setPreamble` (prompt ceiling 4200 → 4250, documented in agent-prompt-budgets.test.ts).

8. **`itx.docs.typecheck` parity** — the advisory checker includes the scope's preamble via `getPreamble()`.

## Checklist

- [x] Contract: `preamble-set` / `preamble-removed` events + preamble entries + retained-settlements state (v0.5.0) — _capability-host-processor-contract.ts, rows pinned to `capability-host-preamble.ts` types_
- [x] Assembly: state → preamble text, shared by gate/execution/docs — _`assemblePreamble` renders ts + js variants; `retainedScriptResult` classifies settlements (16KB inline cap, 3KB inferred-type budget, 2KB error cap); `__proto__` JSON falls back to JSON.parse_
- [x] Typecheck: preamble input, module-scope injection, line mapping, downgrade-to-unchecked — _virtual-project.ts `assembleScriptProject`/`checkItxScriptForExecution`/`checkItxScript` + new `checkPreamble`; `formatProblems` labels `preamble:N`_
- [x] Execution: `scriptWorkerRef` takes `preambleJs`; async-IIFE wrap on the no-emit fallback — _script-execution-entrypoint.ts_
- [x] Host: reduce (upsert/remove/retained tail), verbs with set-time gate diffing with/without candidate, `getScriptResult` point read by settle idempotency key, preamble threaded from head state — _capability-host-processor-implementation.ts, durable object, deps_
- [x] RPC surface + regenerated `itx-api.generated.ts` — _CapabilityHostRpcTarget setPreamble/removePreamble/getPreamble/getScriptResult; docs.typecheck parity_
- [x] Agent processor: render names the binding (small vs large); preamble transcription (non-triggering); prompt teach — _agent-processor-implementation.ts, agent-defaults.ts_
- [x] Tests — _capability-host-preamble.test.ts (assembler + verbs, 11), virtual-project.test.ts (+6 real-compiler: end-to-end results typing incl. the `never` trap, unchecked downgrade, preamble:N attribution, checkPreamble), capability-host-processor.test.ts (+3: derive+inject, gate threading, retention cap), agent-processor.test.ts (+2 & extended render assertions), script-execution-entrypoint.test.ts (+2 fallback wrap)_
- [x] `pnpm typecheck && pnpm lint && pnpm knip && pnpm format && pnpm test` — _all green locally_

## Implementation notes

- The `results` array is assembled at the **at-head pass** from the same head state as capabilities, so a result settled in the same delivery as the next request is visible to it.
- Slack/Telegram system prompts were deliberately NOT updated (their own budgets); their scripts still GET the preamble — the scope is the stream — they just aren't taught it. Possible follow-up.
- `getScriptResult` reads the settlement event back by `capability-host/script-run-settled@<executionId>`, so loaders work for any execution that ever settled in the scope, retained or not, and for every script door (no workspace coupling).
- Set-time gate compares problems with vs without the candidate (string-set diff) — a scope already broken (stale entry, rotted inferred type) doesn't block new sets, mirroring the run gate's never-block-on-scope-code stance.
