---
status: in-progress
size: medium
---

# Find the shortest defensible preview rollout delay

Status: zero delay rejected: the second trial recorded a code-update reset
8.4 seconds after deploy during smoke project creation, despite passing all
tests without retries. Testing 30 seconds next; repeated evidence remains.
Five recent main smoke runs averaged 114.7 seconds, including 85.6 seconds
waiting for the fixed 90-second deployment-age boundary.

## Request and assumptions

Find the sweet spot below 90 seconds using real evidence. Work in an isolated
worktree, commit and push the work, and **do not open a PR**. The user is AFK
and authorized sustained deployment experiments. This is an experiment, not
permission to claim reliability from a few green smoke tests.

- Branch: `codex/rollout-delay-experiment`, based on main `3f0c2021a7`.
- Use the existing serialized Depot `preview-main.yml` workflow dispatched
  on this feature branch. It already supports branch validation without
  replacing the main dashboard baseline. Respect its lease and lifecycle lock.
- Each trial must deploy fresh Worker versions and execute the canonical
  preview suites. Warm-slot reruns without deployment are not evidence about
  rollout propagation. No production deployments or changes to secrets.
- Keep existing timeouts, retry policy, suite selection and worker counts.
  Record first-attempt failures and recoveries, including on otherwise-green runs.
- Begin with a 90-second control and a zero-delay probe. If zero exposes
  rollout failures, compare 30 and 60 seconds, then refine the boundary.
  Interleave controls if unrelated failures or platform drift obscure the result.
- Aim for at least ten fresh-deployment trials at the best candidate, with
  broader repeated proof if results warrant it. Report sample size and
  limitations; zero observed failures does not prove zero risk.
- A confirmed rollout reset rejects that candidate. Classify other failures
  against their artifacts and telemetry before treating them as delay evidence.
- Include smoke and whole-workflow timing, actual age at first project
  creation, slot/version identity, test failures/retries and cleanup outcome.
- Instrument missing timing where needed; add behavior tests before changing
  any nontrivial configuration or evidence-processing logic.
- Recommend a lower default only if evidence supports it. Otherwise preserve
  the default and deliver the experiment and findings with explicit uncertainty.

## Work

- [x] Commit this specification before implementation and push the branch. *Commit `fc4599939`.*
- [x] Record a fresh 90-second control through the canonical Depot workflow. *`4s9c5w1gmf` finished; smoke 115.43s, wait 87.05s, first project age 91.20s. One workspace test retried, so this is not a retry-free control.*
- [x] Make the rollout wait visible as its own smoke phase. *`agent-smoke.ts` records the deployment wait separately from connection and project creation.*
- [ ] Run shorter-delay experiments; retain a per-run evidence ledger.
- [ ] Inspect deployment/version-reset telemetry and explain observed failures.
- [ ] Repeat the best candidate against fresh deployments and all suites.
- [ ] Record a recommendation, tradeoffs, sample limitations and reproduction steps.
- [ ] Run appropriate tests/checks, commit and push the final result.
- [ ] Confirm experiment cleanup, move this task to complete and return a compare link.

## Implementation log

- Control revision `758ccc78a`, package build [35264059614](https://github.com/iterate/iterate/actions/runs/35264059614)
  succeeded; fresh control dispatch `4s9c5w1gmf` uses the unchanged 90-second gate.
- Zero-delay spec failed as expected (`expected 90 to be 0`) before the constant
  changed. This candidate removes only the artificial deployment-age delay;
  exact-version health checks and the agent smoke prerequisite stay enabled.
- The initial setup dispatch `zl16nw5xv4` used the specification-only commit.
  Feature branches without PRs do not publish their SDK packages automatically,
  so this cannot serve as the control. Added an experiment-only push trigger to
  the existing package publisher; remove it before final delivery. Later trials
  will wait for the exact-head package publication before dispatch.
- 2026-09-17: initial baseline from five main runs: 105.4–121.2 seconds total,
  78.6–87.6 seconds of rollout wait, 26.8–34.5 seconds of actual smoke work;
  all smoke attempts passed without retries. This is historical context,
  not the fresh experimental control.

Codex task: `01a0b054-bdd8-7d52-9c01-30d9b92576c8`.

- 2026-09-17 19:33 UTC: control `4s9c5w1gmf` completed all suites and cleanup.
  The workspace namespace test retried after `An internal error occurred.`
  Cloudflare recorded two storage-reset references, including OS trace
  `1116b76e067186c40f29059b4e7d17f9` at 19:29:14 UTC (over three minutes after
  OS deployment) and Streams trace `d6e9892ef1298b2e3b8f8a09b7e96be4`.
  These are storage-error resets, not the code-update-reset signature (zero
  matches across all six deployed services). Exact correlation between the
  workspace retry and a storage-reset trace remains unproven. Retain this
  control as a latency sample and baseline failure evidence, not a clean streak.
  Known failing specs and `SAME-BOOT STALENESS` were also retained separately.
  The zero-delay batch is alive on the immutable candidate, first run `tvvdlqht59`.

- 2026-09-17 19:45 UTC: zero-delay run `tvvdlqht59` finished all suites and
  cleanup. Smoke passed first attempt in 28.70s, creating its project at
  deployment age 2.79s. No code-update resets or initial-connection recoveries.
  The Streams first-paint test retried: first navigation took 12.93s, row
  appeared 2.82s later, exceeding the 10s threshold; retry passed in 2.68s.
  Its first attempt began 117.32s after Streams deployed, beyond the old
  90s boundary. This does not establish a rollout failure, but the trial is
  not retry-free. Continue zero-delay fresh deployments while retaining it.

- 2026-09-17 19:54 UTC: second zero-delay run `10dgtcf6tc` passed all suites
  with zero test retries and a 21.96s smoke, but CF recorded five code-update
  reset records across two traces. Scheduler reset at deployment age 8.399s
  belongs to smoke project `prj_1a781a304ced4f24b9ad8a1aa5a185ce`; the same
  trace contains its creation timing and the explicit platform exception.
  A later repo callback reset at age 124.504s remains unclassified. Cleanup
  succeeded. Zero is rejected; stop its batch and test 30 seconds.
  `docs/ci-rollout-delay-experiment.md` retains the evidence and reproduction
  steps. Broader lifecycle queries now capture absorbed product recoveries
  as well as explicit code-update errors.

- 30-second candidate validation: changed the existing deployment-age spec
  first (red: expected 30, received 0), then the constant. All 216 preview
  tests, scripts typecheck and changed-file lint passed. No retries,
  watchdogs, worker counts or suite selection changed.
