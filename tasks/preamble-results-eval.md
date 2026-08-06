---
status: in-progress
size: medium
branch: preamble-results-eval
---

# Eval: the next script uses `results[...]` instead of re-fetching

## Status summary

Spec committed first (this commit). Implementation next: one opt-in
real-LLM e2e file with two cases (inline `results[N].data`, large
`await results[N].load(itx)`).

## Why

PR #2431 gave codemode scripts a preamble: a `results` array of prior
script outcomes (`results[0].data` inline for small results,
`await results[0].load(itx)` for large ones). The system prompt and the
script-settlement renders teach it. Nothing proves the teaching works: a
live field test caught the model copying a fenced
`JSON.parse(await itx.workspace.readFile(...))` recipe instead of using the
loader — a prompt regression an eval would have caught.

This task adds that eval: after a script returns data, the model's NEXT
script must reference `results[...]` — not re-fetch, not re-paste JSON, not
read the workspace spill file.

## Shape (decisions, made solo — flagged as assumptions)

- **File**: `apps/os/e2e/vitest/agent-preamble-results.llm.e2e.test.ts`.
  _Assumption_: adopt the draft cost-dimension filename marker from
  docs/testing.md (`*.llm.e2e.test.ts` for tests that pay for model turns) —
  this is its first instance.
- **Opt-in, not default CI**: model-choice assertions are single-sample and
  probabilistic; they must not flake unrelated PRs. Gate:
  `test.skipIf(process.env.LLM_EVALS !== "1")` — `skipIf` is the structural
  form the dated-skips lint guard permits, and the skip is visible in every
  run's output rather than hidden by a title filter. _Assumption_: env-gate
  (the doppler-native control docs/testing.md sanctions) over a separate
  vitest project, because bare `pnpm e2e` runs all projects and would
  silently start paying.
- **Invocation** (documented in the test header too), from `apps/os`:

  ```bash
  # local dev (pnpm dev running or auto-started) or shared dev
  doppler run --config dev -- env LLM_EVALS=1 pnpm e2e agent-preamble-results

  # a preview slot
  doppler run --config preview_3 -- env LLM_EVALS=1 pnpm e2e agent-preamble-results
  ```

- **Round 1 is synthetic, round 2 is real.** Round 1 (the script that
  produces data) is journaled with the established
  `appendSyntheticProviderOutput` fixture — the same trust-boundary-honest
  helper the codemode fence/pipelining e2es use — and the script executes for
  real in a dynamic worker, settles, and gets the real settlement render.
  _Assumption_: this beats a fully-real round 1 because the eval's subject is
  round 2 only; synthetic round 1 is deterministic and saves a paid turn.
  Round 2 goes through the real product surface: `agent.ask(...)` (a user
  web-chat message) and a real LLM turn using the environment's configured
  transport.
- **Data must be non-reproducible**: round-1 scripts generate values at
  runtime (`Math.random`/`crypto.randomUUID`), so the values exist only in
  the settlement — the model cannot re-derive them from its own script text,
  and re-generating gives wrong answers the correctness assertion catches.
- **Quiescence between rounds**: a result-bearing settlement triggers an
  autonomous feedback turn (the codemode loop). The test waits until every
  llm-request and script-run has settled and the stream head is stable
  before recording the round-2 cursor, so the assertion window contains only
  round-2 scripts.

## Cases

- [ ] **Inline case**: round-1 script returns ~24 orders with random
      `amountCents` (compact JSON well under the 16,000-char inline gate, so
      its `results` row has `.data`). User asks for the exact sum. Assert:
      the first round-2 script matches `/results\[\d+\]\.data/`; no round-2
      script matches `workspace.readFile` or `Math.random` (re-generation =
      re-fetch); the visible reply contains the true total (computed by the
      test from the journaled settlement).
- [ ] **Large case**: round-1 script returns ~2,500 rows with a
      `crypto.randomUUID()` secret buried mid-array (compact JSON over the
      16,000-char gate → `.load` row; pretty-printed over the ~30k render
      limit → also spills to a workspace file, so the readFile temptation
      from the field test is present). User asks for the secret. Assert: the
      first round-2 script matches `/await results\[\d+\]\.load\(itx\)/`; no
      round-2 script touches `workspace.readFile`; the reply contains the
      actual secret.
- [ ] Header comment documents the exact run command; task file + PR body
      show it too.
- [ ] `pnpm typecheck && pnpm lint && pnpm knip && pnpm format && pnpm test`
      green; eval run against a live environment at least once with results
      recorded here.

## Non-goals

- No multi-sample scoring/statistics harness — one good scenario per case,
  run on demand. If we later want pass@k, this file is the seed.
- No CI wiring — explicitly a manual lane (docs/testing.md's "wired or
  documented as manual" rule; the file header is the documentation).
- Not editing `tasks/codemode-script-preamble-followups.md` (three sibling
  branches share it).

## Implementation log

- Worktree `preamble-results-eval` off origin/main (34c7de98a, the preamble
  PR itself).
