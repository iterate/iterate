---
status: in-progress
size: medium
---

# Codemode script reuse: `itx.previousScriptAsHelperFunction`

## Status summary

POC in progress. Design fleshed out below; implementation not started yet.
Main pieces: re-parameterization function, script lookup RPC, harness-level
callable, prompt docs, an eval proving the agent reaches for it.

## Problem

Agents re-derive the same codemode script every time a request repeats with
different inputs:

- user: "prime factorize 23409823948238439732889"
- agent: *writes long complicated codemode prime factorization algorithm*
- user: "prime factorize 5489334582393292300937"
- agent: *writes the same long algorithm again, spending the same tokens*

The script text of every past run is already durably journaled
(`events.iterate.com/capability-host/script-run-requested` on the scope
stream). The agent should be able to point at a past script, name which
literals were "the inputs", and call it again with new inputs:

```ts
async itx => {
  const primeFactorize = await itx.previousScriptAsHelperFunction({
    eventOffset: 1234,
    parameters: [{ name: "number", content: "23409823948238439732889n" }],
  })
  return await primeFactorize(itx, { number: 5489334582393292300937n })
}
```

Told about this, the agent's second response shrinks from a full algorithm to
a few lines — a large token saving on repeat-shaped work.

## Design

### Semantics

`itx.previousScriptAsHelperFunction({ eventOffset, parameters })`:

1. Reads the event at `eventOffset` on the current scope stream. Accepts any
   of the three offsets the agent might plausibly know:
   - a `script-run-requested` event (code is right there)
   - a `script-run-settled` event (what `results[N].offset` exposes) — resolve
     `executionId` → request event via its idempotency key
   - the assistant-output event that produced the script (`executionId` is
     `agent-output:<offset>`) — same idempotency-key resolution
   Throws with a clear message for any other event type or a missing offset.
2. For each `parameters` entry: `name` must be a valid JS identifier, and
   `content` must occur **exactly once** in the script text (0 or 2+ is an
   error, with a count in the message). Replace the occurrence with `name`.
3. Returns an async function `(itx, vars) => result` that executes the
   re-parameterized script with `vars` in scope.

### Execution shape (deviation from the original sketch, and why)

The sketch suggested inserting `, { number }: { number: typeof ... }` into the
original parameter list and `eval`-ing. Two constraints push a different shape:

- Dynamic-worker isolates have no `eval`/`new Function`; new code only runs by
  loading a fresh dynamic worker (that is the whole codemode design).
- RPC can't return a plain function, so the callable must be manufactured in
  the harness (`script-execution-entrypoint.ts`), the JS that already wraps
  `itx` inside the script's isolate.

So instead of parameter-list surgery, the platform wraps lexically:

```js
async (itx, vars) => {
  const { number } = vars
  const helper = <original script text, with the literal replaced by `number`>
  return await helper(itx)
}
```

Free `number` references inside the transformed script close over the
destructured const. No fragile insertion into `async itx =>` vs
`async (itx) =>` forms.

The callable returned to the agent's script is a harness-local closure that
submits this envelope as a **child script run** (vars serialized as JS
literals — bigint included — so the journaled child script is a
self-contained, auditable record) and returns its result.

### Pieces

- `reparameterizeScript({ code, parameters })` — pure function, unit-tested:
  identifier validation, exactly-once occurrence check, replacement, envelope
  rendering. Lives in the capability-host domain.
- Offset→script lookup RPC on the capability host (sibling of
  `getScriptResult`), so lookup + transform happen server-side with good
  errors.
- Harness wiring in `script-execution-entrypoint.ts`: `itx.previousScriptAsHelperFunction`
  intercepted locally; returns the closure described above. Vars→literal
  serialization embedded in the harness source.
- Child-run execution: preferred door is the existing journaled script-run
  flow so the reuse run gets normal observability (`results` array, settle
  events, evals can audit it). **Risk to resolve:** whether the capability-host
  processor picks up a child `script-run-requested` while the parent run is
  still executing, or blocks (→ deadlock until expiry). If it blocks, fall
  back to a direct `scriptExecutionEntrypoint.run` door with its own journal
  breadcrumb.
- Typing: the typecheck prelude (`virtual-project.ts`) gains the member on
  `Itx`. POC types vars as `Record<string, any>`; the `typeof`-placeholder
  trick for precise per-parameter types is future work.
- Prompt: one-liner in `configs/default/prompts/agent-system-prompt.md`
  (output-formatting section, next to the `results[0].data` guidance) so the
  agent knows the helper exists. Possibly also the post-settlement recipe text
  in `agent-codemode.ts`.
- Regenerate `pnpm generate:itx-api` if any real RPC member is added.

## Eval

`evals/script-reuse/eval.md`: fresh project, ask for a prime factorization of
one big number, then a second one. Success criteria: the second response's
script uses `previousScriptAsHelperFunction` pointed at the first run (no
re-derived algorithm), both answers are correct, and the second response's
generated-script token count is a small fraction of the first. Must run
against an environment with this branch deployed (local dev), not prod.

Also a structural e2e test in `apps/os/e2e/vitest/` (synthetic provider
output, no model spend) exercising the helper end-to-end: seed a first script
run, then a second synthetic script that reuses it, assert the settlement.

## Checklist

- [ ] `reparameterizeScript` pure function + unit tests
- [ ] offset→script lookup + transform RPC on the capability host
- [ ] harness closure: `itx.previousScriptAsHelperFunction`
- [ ] child-run execution path (resolve the concurrent-run/deadlock question)
- [ ] prelude typing on `Itx`
- [ ] regenerate itx api if needed
- [ ] prompt documentation (agent-system-prompt.md)
- [ ] structural e2e test with synthetic provider output
- [ ] `evals/script-reuse/eval.md` written
- [ ] eval run against a dev environment, agent observed using the helper

## Assumptions made (user was AFK)

- Exactly-once occurrence is enforced per parameter, as specified; error
  messages report the actual count so the agent can self-correct.
- The three accepted offset kinds (requested / settled / agent-output) are a
  superset of the sketch's "the codemode script at that offset" — the settle
  offset is what the agent actually sees in `results`, so accepting only the
  request offset would make the feature nearly undiscoverable.
- Precise `typeof`-based vars typing deferred; `Record<string, any>` for POC.
- The reuse run is journaled as a normal child script run rather than being
  invisible — observability seemed more valuable than journal thrift.

## Implementation log

(nothing yet)
