---
status: in-review
size: medium
---

# Codemode script reuse: `itx.capabilityHost.previousScriptHelper`

## Status summary

Done, pending review. The Codex-run eval **passed on round 3**: a real agent
on local dev reused a 2,408-char Pollard's-rho script through a 265-char
reuse script on the follow-up request, with no re-derived algorithm. Rounds 1
and 2 each exposed a real gap (documented below) and drove product guards
that made round 3 converge. Reviewer judgement wanted on: the prompt-ceiling
raise (4250 → 4350) and the `done`-row contract bump (0.6.0 → 0.7.0).

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

## Design (as built — redesigned after Misha's review)

The original build manufactured a plain-function callable inside the
dynamic-worker harness ("RPC can't return a function"). Misha flagged that as
a red flag and relaxed the API to a handle with a method — which is the itx
surface's native shape, so the whole harness workaround was deleted:

```ts
const h = await itx.capabilityHost.previousScriptHelper({
  eventOffset: results[0].offset,
  parameters: [{ name: "n", content: "1234567890n" }],
})
return await h.run({ n: 987n })
```

It lives on the capability host (next to runScript/getScriptResult/
setPreamble — where the script journal lives), works in every runtime (CLI,
REPL, workers, codemode), and is typed via the generated api.

`previousScriptHelper({ eventOffset, parameters })`:

1. `eventOffset` accepts any of the three offsets the agent might know: the
   `script-run-requested` event, the `script-run-settled` event (what
   `results[N].offset` exposes), or the assistant-output event that produced
   the script. Resolution: point-read by public-door idempotency key, then a
   bounded forward scan for agent-lane requests (their idempotency keys carry
   the agent processor's prefix).
2. Each parameter's `content` must occur **exactly once** (count reported in
   the error) and be a value expression (statement-shaped and
   template-interior content rejected with teaching errors). The occurrence
   is swapped for a **generated alias** (`__reuse_<name>`, deterministically
   suffixed until free — Misha's suggestion), so the caller's `name` never
   collides with the script's own identifiers.
3. Returns a `ReusableScript` handle; `run(vars)` renders an envelope — the
   new values as consts (serialized as JS literals, bigint included) bound
   to the aliases — and submits it as a **journaled child script run** via
   `runScript`, so the reuse is a self-contained auditable record.

Supporting changes:

- **`done` results rows** (contract 0.6.0 → 0.7.0): a void-returning success
  previously left no `results` row, making the common send-message-and-finish
  script unaddressable. Every settled script now keeps an offset handle;
  void successes render as `{ offset, executionId, done: true }`.
- **Prompt teach**: one bullet in the output-formatting section; prompt
  ceiling raised 4250 → 4350 with the raise argued in the constant's comment
  log (the sanctioned mechanism per that file).
- Regenerated itx api (`ReusableScript` interface + the host method).

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
- [x] eval run via `pnpm eval script-reuse` _passed on round 3
  (`evals/runs.ignoreme/script-reuse/1787769275338/`): reuse mechanism
  confirmed, 265 vs 2,408 chars, answers verified independently. Rounds 1–2
  failed and each produced a product guard (failed-source rejection;
  statement/template content rejection)_

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
- Codex eval round 1: FAILED — the model's first attempt hit the `n` name
  collision, `results[0]` shifted to that failed attempt's error row, and the
  model pointed the next attempts at its own failed reuse script, nesting
  reuse-of-reuse until it rewrote the algorithm. Guard added: a failed run is
  rejected as a reuse source with the fix in the message.
- Codex eval round 2: FAILED — splice-thinking: content was a whole
  `const n = 123n;` line (child died with `n is not defined`) and a
  template-string interior. Guards added: statement-shaped and
  template-interior content rejected with the value-substitution recipe.
- Codex eval round 3: SUCCESS — two failed attempts (caught by the new
  teaching errors), one small results inspection, then a 265-char reuse
  script; old-number prose corrected in a follow-up message per criteria.

## Follow-up ideas (deliberately out of scope)

- Precise per-parameter vars typing via the `typeof`-placeholder trick from
  the original sketch.
- A `contains`/search addressing mode so the agent can name a past script by
  content rather than offset.

## Redesign log (post-review)

Misha's feedback replaced the harness-manufactured callable with a plain RPC
handle (`ReusableScript.run(vars)`) on the capability host, and replaced
name-collision *errors* with generated aliases (no collision class at all —
it had been the first-attempt failure in every eval round). The harness and
typecheck-prelude special cases were reverted wholesale; the collision
follow-up idea above became moot.

Eval round 4 (new API): **SUCCESS on the first attempt** — zero failed reuse
attempts (round 3 needed two corrective rounds before the aliasing change).
Turn 2: one 239-char reuse script via `results[0].offset`, the journaled
child run, and the allowed prose-correction message. 562 chars of turn-2
agent-authored script vs 2,359 for turn 1
(`evals/runs.ignoreme/script-reuse/1787770331931/`).
