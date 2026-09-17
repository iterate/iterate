---
status: in-progress
size: medium
---

# Find the shortest defensible preview rollout delay

Status: experiment specified; implementation and fresh-deployment trials remain.
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
- [ ] Record a fresh 90-second control through the canonical Depot workflow.
- [x] Make the rollout wait visible as its own smoke phase. *`agent-smoke.ts` records the deployment wait separately from connection and project creation.*
- [ ] Run shorter-delay experiments; retain a per-run evidence ledger.
- [ ] Inspect deployment/version-reset telemetry and explain observed failures.
- [ ] Repeat the best candidate against fresh deployments and all suites.
- [ ] Record a recommendation, tradeoffs, sample limitations and reproduction steps.
- [ ] Run appropriate tests/checks, commit and push the final result.
- [ ] Confirm experiment cleanup, move this task to complete and return a compare link.

## Implementation log

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
