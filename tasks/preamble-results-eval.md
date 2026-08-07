---
status: in-progress
size: small
branch: preamble-results-eval
---

# Eval: follow-up scripts use `results[...]` instead of re-fetching

## Status summary

Redone per Misha's review on PR #2442: the deliverable is
`evals/preamble-results/eval.md` — a short natural-language eval in the
`evals/summarise-emails` style, run by the `evals/run.ts` harness. The
earlier vitest e2e approach (two structural-assertion tests) is removed;
its live-run lessons are kept in the log below and as prose hints in the
eval.md.

## Why

PR #2431 gave codemode scripts a preamble: a `results` array of prior
script outcomes (`results[0].data` inline for small results,
`await results[0].load(itx)` for large ones). The system prompt and the
script-settlement renders teach it. Field testing on preview 5 caught the
model copying a fenced `JSON.parse(await itx.workspace.readFile(...))`
recipe instead of using the loader, defensively writing API responses to
workspace files, and returning full raw payloads — the regressions an eval
should catch.

## Shape

- One file: `evals/preamble-results/eval.md`. Terse prose in the
  `evals/summarise-emails/eval.md` mold: a concrete starter prompt (TVMaze
  Sopranos episodes fetch, then the real field-test follow-up — "Which
  episodes was Carmela happy in?", semantic judgment over the summaries),
  the previously observed problems in prose, and success criteria
  describing HOW we expect it to happen. (An earlier revision linked the
  preview-5 field-test streams; those get erased with the preview slot, so
  the eval stands alone now.)
- Run with the `evals/run.ts` harness: `run(slug)` spawns a coding agent
  headlessly against a real environment (fresh project, default template,
  brokered stand-ins for unavailable integrations), judges against the
  eval's success criteria, and writes
  `evals/runs.ignoreme/<slug>/<ts>/result.md`.
- `evals/run.ts` and the rest of the evals folder are not yet in git — this
  branch adds ONLY `evals/preamble-results/eval.md`. Harness output
  (`runs.ignoreme/`) is already covered by the root .gitignore's
  `*ignoreme*` rule; no gitignore change needed.

## Checklist

- [x] ~~Vitest e2e with structural assertions
      (`apps/os/e2e/vitest/agent-preamble-results.llm.e2e.test.ts`:
      `LLM_EVALS=1` gate, regexes over the scripts between the settlement
      render and the reply, correctness checks against the journaled
      settlement)~~ _built, passed 2/2 live, then replaced per review —
      "should be like the summarise emails one in the evals/ folder";
      removed on this branch in the same commit that adds the eval.md_
- [x] `evals/preamble-results/eval.md` in the summarise-emails style.
      _Committed on this branch; short enough that PR #2442's body shows it
      inline._
- [x] Rewritten per review to drop the deleted preview-5 stream links:
      now a concrete starter prompt (TVMaze Sopranos episodes fetch) plus
      success criteria describing HOW we expect it to happen.
      _Review thread on eval.md, 2026-08-07._
- [x] Follow-up corrected to the real field-test exchange: "Which episodes
      was Carmela happy in?" — semantic judgment over the episode summaries,
      no arithmetic shortcut, exercising exactly the retained-results flow.
      _Misha's correction, 2026-08-07; I'd invented a runtime question._
- [x] Lessons from the vitest live runs preserved. _Implementation log
      below + the success-criteria caveats in the eval.md (inline renders
      can be mentally computed; agents legitimately dig into results on
      their own follow-up turn)._
- [x] Checks green. _typecheck/lint/knip/format/test — the eval.md is data
      for the harness, nothing executes in CI._

## Non-goals

- No harness changes — `evals/run.ts` is Misha's and not yet tracked; this
  branch only adds an eval definition it can run.
- Not editing `tasks/codemode-script-preamble-followups.md` (three sibling
  branches share it).

## Implementation log

- Worktree `preamble-results-eval` off origin/main (34c7de98a, the preamble
  PR itself).
- v1 (vitest, commits 9affd06e0/b7597d83b, later removed): two opt-in e2e
  cases driving a real agent — synthetic round-1 script producing
  runtime-generated data, real `agent.ask` follow-up, regex assertions on
  the scripts between the settlement render and the reply. Live run 1
  failed both cases and taught two lessons now baked into the eval.md
  prose:
  - the model legitimately digs into a fresh result during its own
    follow-up turn, before the user asks — for the large case it ran
    `await results[0].load(itx)` there and simply recalled the answer
    later, so any judgement window must start at the settlement render,
    not at the user's question;
  - small inline results render fully in history, so a model can retype or
    mentally compute from the render (it correctly summed 24 rendered
    amounts without touching `results`); datasets must be big enough that
    this is hopeless (300 rows was enough).
  Live run 2 passed 2/2 (24.9s / 16.8s) after those fixes.
- v2 (this shape): vitest file removed; `evals/preamble-results/eval.md`
  added, referencing the two preview-5 field-test streams
  (`…/nustom/agents/streams/agents/onboarding` — pre-fix readFile paging of
  a spilled result; `…/agents/web/2026-08-06t16-13-19-265z` — better, but a
  defensive `writeFile` copy and a full-payload return).
