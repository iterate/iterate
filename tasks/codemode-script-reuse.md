---
status: in-review
size: medium
---

# Codemode script reuse: `itx.previousScriptAsHelperFunction`

## Status summary

POC implemented and proven live: a real agent on local dev reused a 2.4k-char
Pollard's-rho script through a 273-char reuse script on the follow-up request.
Unit tests, an e2e, and the eval file are in. Remaining: the Codex-run eval
result (running), reviewer judgement on the prompt-ceiling raise and the
`done`-row contract bump.

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

## Design (as built)

`itx.previousScriptAsHelperFunction({ eventOffset, parameters })`:

1. `eventOffset` accepts any of the three offsets the agent might know: the
   `script-run-requested` event, the `script-run-settled` event (what
   `results[N].offset` exposes), or the assistant-output event that produced
   the script. Resolution: point-read by public-door idempotency key, then a
   bounded forward scan for agent-lane requests (their idempotency keys carry
   the agent processor's prefix).
2. Each parameter's `name` must be a valid identifier not already appearing
   in the script; its `content` must occur **exactly once** (count reported
   in the error). The occurrence is replaced with `name`.
3. Returns `(itx, vars) => result`. Calling it renders an envelope — the new
   values as consts (serialized as JS literals, bigint included) that the
   swapped identifiers close over — and submits it as a **journaled child
   script run** via `capabilityHost.runScript`, so the reuse is a
   self-contained auditable record. The callable itself is manufactured in
   the dynamic-worker harness (`script-execution-entrypoint.ts`): RPC cannot
   return a plain function and script isolates have no `eval`.

Supporting changes:

- **`done` results rows** (contract 0.6.0 → 0.7.0): a void-returning success
  previously left no `results` row, making the common send-message-and-finish
  script unaddressable. Every settled script now keeps an offset handle;
  void successes render as `{ offset, executionId, done: true }`.
- **Typecheck prelude** types the member on `Itx` (harness-only surface, so
  it is not on the generated Project type). Kept on the same prelude line as
  the alias — the prelude's line accounting must not shift.
- **Prompt teach**: one bullet in the output-formatting section; prompt
  ceiling raised 4250 → 4350 with the raise argued in the constant's comment
  log (the sanctioned mechanism per that file).
- `prepareScriptReuse` RPC on the capability host is the server half;
  regenerated itx api.

## Checklist

- [x] `reparameterizeScript` pure function + unit tests _in
  `script-reuse.ts`; validation errors name counts so the agent can
  self-correct (observed live: it renamed `n` → `targetNumber` after the
  collision error)_
- [x] offset→script lookup + transform RPC _`prepareScriptReuse` on
  `CapabilityHostRpcTarget`, next to `getScriptResult`_
- [x] harness closure `itx.previousScriptAsHelperFunction` _in
  `scriptWorkerRef`'s synthesized source; envelope renderer embedded via
  Function#toString like `sandboxExecTimeout`_
- [x] child-run execution path _journaled via existing `runScript`; no
  deadlock — the processor starts executions with `runInBackground`, verified
  live (child at offset 1156 ran while the parent awaited it)_
- [x] prelude typing on `Itx` _virtual-project.ts, same-line intersection_
- [x] regenerate itx api _`pnpm generate:itx-api`_
- [x] prompt documentation _agent-system-prompt.md + ceiling raise_
- [x] `done` rows for void results _contract 0.7.0; new preamble tests_
- [x] structural e2e test _`script-reuse.itx.e2e.test.ts`, passing against
  local dev — no model turns_
- [x] `evals/script-reuse/eval.md` written _10-digit-prime semiprimes force a
  real algorithm; criteria demand the reuse mechanism, not just answers_
- [ ] eval run via `pnpm eval script-reuse` _(Codex run in progress; direct
  live probes of the same flow already passed — see log)_

## Assumptions made (user was AFK)

- Exactly-once occurrence enforced per parameter, as specified; a literal
  hardcoded twice (e.g. in a sendMessage template) stays un-swapped — the
  live agent noticed via its delivery receipt and sent a correction message.
- The callable executes as a journaled child run rather than in-isolate
  (`eval` is unavailable in workers; observability seemed more valuable than
  journal thrift anyway).
- Void-result `done` rows change the preamble surface for everyone — judged
  worth it because reuse is otherwise undiscoverable for the most common
  script shape.
- Precise `typeof`-based vars typing deferred; `Record<string, unknown>` for
  the POC.
- The prompt ceiling raise (4250 → 4350) is flagged for explicit review.

## Implementation log

- Explored codemode internals + evals harness (two subagent reports).
- Built transform + envelope as pure functions; unit tests first failed on a
  bad substring assumption, fixed.
- e2e passed on the first live run (settle-offset door, child run, bigint
  round trip).
- Live probe 1 (easy numbers, small script): agent ignored the helper and
  rewrote — exposed (a) void scripts leave no `results` row, (b) rewriting a
  short script is rational. Led to `done` rows + harder eval numbers.
- Live probe 2 (2^31/2^32-adjacent primes): agent tried
  `eventOffset: <assistant offset>`; resolution failed (agent-lane
  idempotency prefix) — fixed with the bounded forward scan. Model also
  passed a bigint as a string (teach now says `123n` not `"123n"`), and then
  factored the too-recognizable number in its own head (!) — eval numbers
  changed to arbitrary 10-digit primes.
- Live probe 3: full success — reuse via `results[N].offset` including
  self-correction of a rejected parameter name and of the reused script's
  hardcoded message prose.
- Prompt ceiling: bullet compacted twice; final overage was exactly 1 char
  (17401/17400) before the last trim landed it at the raised ceiling.
