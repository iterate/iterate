---
status: in-progress
size: large
branch: codemode-script-preamble
---

# Codemode script preamble ("prior results" for agent scripts)

## Status summary

Spec settled via a plannotator grill session (4 rounds; decisions below). Implementation not started yet — this commit is the spec.

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

1. **Capability host owns preamble state.** New events `capability-host/preamble-set {key, code}` (keyed upsert) / `capability-host/preamble-removed {key}` on the capability-host contract (version bump), reduced into host state; entries ordered by first-set offset. Every script door in the scope — agent output, slash commands, scheduler, public `runScript` — gets the preamble at typecheck + execution. Agent scripts run on the agent's own stream, so this is per-agent for agents. *(user-approved)*

2. **Prior results are auto-provided by the platform**, reusing the existing small-vs-spilled split — no new truncation algorithm. Small results embed as JSON literals (their literal type comes for free); large ones contribute their already-inferred type (reuse `inferJsonType` from the agent render path) plus an **async** loader. *(user-approved)*

3. **One `results` array, DERIVED — never stored as preamble code.** The host already reduces `script-run-settled`; it retains the last ~20 settlements (metadata + small payloads) in state, and the preamble *assembler* stitches the array fresh for each script run. No per-result events, no O(n²) array rewrites — the settlement event is the only durable storage. Shape *(user-specified)*:

   ```ts
   const results = [
     // newest first: results[0] = the script you just ran
     { executionId: "agent-output:57", data: { users: ["..."] } },      // small: inline literal
     { executionId: "agent-output:42",                                  // large: typed loader
       get data(): never { throw new Error("Large result: use `await results[1].load(itx)`") },
       load: async (itx: Itx): Promise<Result42> => /* reads the settled result back */ },
     { executionId: "agent-output:33", error: "TypeError: ..." },       // failed script
   ] as const;
   ```

   `as const` so `results[0].data` has its literal type. `.data` / `.error` (never `.result`, which reads awkwardly as `results[0].result`). Large entries: `.data` typed `never` with a throwing getter pointing at `.load`. Inline-vs-loader gate: one host-side size constant (~16KB serialized), mirroring the render-side spill threshold. The loader reads the settlement back from the scope stream (works for every script door; no workspace coupling).

4. **Writer surface: methods on the capability host** — `await itx.capabilityHost.setPreamble({ key, code })` / `removePreamble({ key })`, and via `capabilityHosts.get(path)` for other scopes. Mirrors `provideCapability`/`revokeCapability`; no new top-level itx name. `setPreamble` compiles the assembled preamble at set time (same pattern as the capability `types` compile gate) and rejects entries that would break later scripts.

5. **Execution mechanics.** Typecheck module (`virtual-project.ts`) injects preamble statements between the itx-type prelude and `const script = (` — module scope, so the emitted-JS path carries the preamble for free (`Itx` type is in scope for loaders). Raw-embed fallback (no emitted JS): wrap as `const fn = await (async () => { <preamble>; return (<code>); })()` so preamble names cannot collide with harness symbols in `main.js`.

6. **Typecheck attribution.** Compiler errors on preamble lines never block a script (it didn't write them): they downgrade the gate verdict to `unchecked` (run anyway) with a log. Script-line errors keep blocking as today; line numbers mapped past prelude + preamble so blame stays accurate.

7. **Model visibility.** Agent processor transcribes `preamble-set`/`preamble-removed` into developer context items showing the code. The `results` array needs no transcription — the settlement render already shows the data; it now also names the binding (e.g. "this result is available to your next script as `results[0].data`" / "`await results[0].load(itx)`"). The codemode system prompt (`agent-defaults.ts`) gains a short paragraph documenting the preamble and `results`.

8. **`itx.docs.typecheck` parity** — the advisory checker includes the scope's preamble exactly like the real gate.

## Checklist

- [ ] Contract: `preamble-set` / `preamble-removed` events + preamble entries + retained-settlements state on `CapabilityHostProcessorContract` (version bump), consumes/emits updated
- [ ] Assembly: a helper that renders host state → preamble text (`results` array + user entries, stable order), shared by gate, execution, and docs.typecheck
- [ ] Typecheck: `virtual-project.ts` accepts preamble input, injects at module scope, maps line numbers, downgrades preamble-line errors to `unchecked`
- [ ] Execution: `script-execution-entrypoint.ts` `scriptWorkerRef` takes preamble; emitted-JS path + raw-fallback async-IIFE wrap
- [ ] Host implementation: preamble reduce; retained settlements (cap ~20, size-capped inline payloads); wire assembled preamble into `#typecheckScriptForRun` and execution; result loader read-back path
- [ ] RPC surface: `setPreamble` (set-time compile gate) / `removePreamble` on `CapabilityHostRpcTarget`; `__describe` mentions them; regen generated API files
- [ ] Agent processor: settlement render names the `results[N]` binding; transcribe preamble-set/removed as developer context
- [ ] Prompt docs: `agent-defaults.ts` paragraph on preamble + `results`
- [ ] Tests: host reduce/set-gate/run-with-preamble; virtual-project preamble typecheck (attribution + line mapping); entrypoint fallback wrap; agent processor render/transcription; an end-to-end "script 1 returns data, script 2 uses `results[0].data`" spec
- [ ] `pnpm typecheck && pnpm lint && pnpm knip && pnpm format && pnpm test`

## Implementation notes

*(log added during implementation)*
