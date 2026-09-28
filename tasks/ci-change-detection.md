---
status: experiment
size: large
---

# CI change detection: inherit results and reuse deployments

**Status:** an experiment, not a commitment: built to see what inherit and reuse cost in code and save in CI before deciding whether to keep them. Decided 2026-09-28: inherit and reuse, as #2712 had them; no suite selection for now. It replaces the 2026-09-25 draft (never committed; `stash@{0}`), which predates #3165.

- **Built:** units (`scripts/ci/preview-units.ts`), inherit (`scripts/ci/preview-inherit.ts`, the `changes` step), reuse (`apps/os/scripts/preview-reuse.ts`, partial deployments, the plan artifact, cleanup and sweep rules), docs. Since decision 7, a PR run tests its head, and both walk its history.
- **Proven live** (under decision 3's first form, testing the merge with main): a docs-only push inherited both suites in 8 s with no deploy; a specs-only push inherited E2E tests; a notes-only push deployed one worker and the specs passed against it; reverting both deployed nothing.
- **Left:** the same live checks under decision 7.

## Why now

On the 2026-09-25 Tuple call (`57360661`), Misha asked for this: if a PR changes only an app, reuse an earlier platform deployment and deploy only that app. It's the history walk from before (#2712), which was never brought back after #2837 deleted it.

#3165 (merged 2026-09-27) made it easier. Every tested commit now gets immutable plain Workers, `pr<n>-<sha7>-<app>` and `main-<sha7>-<app>`. So there are per-commit deployments to reuse again, and main's newest `main-<sha7>` is a deployment a PR can safely test against.

## What the numbers say

- A PR run: Deploy preview ~55 s; E2E tests ~105 s and Browser specs ~130 s, both counting their wait for the deploy. Time to green is ~2¼ min (last 10 merged PRs).
- 200 PRs merged 24–28 Sep: 181 needed a preview. About 10 change only an app (dash, notes, voice, agents, kit) and about 10 change only e2e tests or specs. Everything else changes os or code os shares (`packages/iterate` alone: 59).
- 145 follow-up commits in the last 60 PRs: 121 change product code, 16 only tests, 8 only docs. Today every one of them redeploys and retests everything, because the rule reads the whole PR's diff.
- Required checks aren't strict (`strict_required_status_checks_policy: false`): a PR can merge on a green run against an older main.

## Decisions

1. **Inherit and reuse only.** Suite selection (running only the changed units' suites) is out for now: every run that tests still runs E2E and all Browser specs.
2. **Inherit keys on the PR head.** A suite whose inputs haven't changed since an earlier green head passes without running: a docs-only push is the same as not pushing. It never carries a red.
3. ~~**Reuse keys on the tested tree.**~~ _Replaced by decision 7: keyed on the tested merge with main, reuse missed whenever main changed apps/os between pushes, about every half hour (live check C)._
4. **Reuse takes the nearest ancestor with a full deployment,** the PR's own or main's `main-<sha7>`. An app-only PR deploys only its app, linked to that deployment's os and other apps. If apps/os changed since, it deploys its own, as today.
5. **An os change still runs every spec** (it always does, with no selection). Revisit with the R2 parquet evidence: how often did an app spec catch an os regression?
6. **Main OS e2e is unchanged:** everything on every push. It's the canary, and it's where reused main deployments come from.
7. **A PR run tests its head, not the head merged into main** (2026-09-28, after live check C). Deployments are per commit, so inherit and reuse both walk the head's history parent by parent, into main's past where the PR branched. A commit that merges main in is a commit like any other, usually one with many changes. The PR-wide "does this PR touch a preview path" gate goes: a PR that changes nothing a suite depends on inherits main's green. The cost: Depot still reads the workflow file from the merge commit, so a head that predates a workflow change needing code landing with it fails Preview OS until it merges main in (#2999's failure mode), and Preview OS no longer catches a semantic conflict with newer main before the merge.

## Design

### Units

`scripts/ci/preview-units.ts` names the seven units a deployment has (os and the six apps) and each one's product paths: exactly its `deploy-<unit>.yml` push `paths:`, which a test keeps equal. The preview machinery (preview-os.yml, `.depot/actions`, `apps/os/scripts/preview*.ts`, the toolchain) counts as every unit's product. Each suite names the units it tests and its own test paths:

```ts
export const previewSuites = {
  e2e: {
    units: ["os"],
    tests: [
      "apps/os/e2e/**",
      "apps/agents/**",
      "packages/agents/**",
      "packages/voice/**",
      "packages/cli/**",
    ],
  },
  specs: { units: PREVIEW_UNITS, tests: ["specs/**", "playwright.config.ts"] },
};
```

A test walks `git ls-files`: every file `previewPaths` matches is some unit's or suite's input, or on a short list of files no suite depends on (docs, unit tests, benches).

**No fingerprints.** A deployment's name already names its commit (`pr3200-a1b2c3d`), so "unit unchanged" is GitHub's comparison of that commit with the head touching none of its paths. Nothing is recorded on the workers.

### Inherit

`scripts/ci/preview-inherit.ts`, in each suite job (and in Deploy preview, for both) before setup, on pushes only:

1. Walk the head's history back (`GET /commits?sha=<head>`: the PR's commits, then main's) to the nearest commit with a completed check of this suite, a PR run's or Main OS e2e's. Green (run or inherited) is the candidate; cancelled or skipped means keep walking; anything else means run. None within 20 commits means run.
2. If `compare/<candidate>...<head>` touches none of the suite's inputs, pass: the summary links the run inherited from. The log names the files that made it run.
3. E2E never inherits while the PR has the `slow-e2e` label.

Deploy preview inherits when both suites do: no deploy, no trace. The PR body keeps pointing at the last deployment. This replaces the PR-wide `preview-paths.ts changes` gate: a PR that changes nothing a suite depends on inherits main's green where it branched.

### Reuse

On a PR's pushes only (never main, latency, real-model or a soak), Deploy preview plans before it builds:

1. Candidates: every live **full** deployment (all seven workers) of the PR's and of main's, never this run's own name.
2. GitHub's comparison of each one's commit (the sha7 in its name) with the head: an ancestor's distance and the units changed since. The nearest ancestor is the one a walk back would reach first.
3. If its apps/os is unchanged, the run deploys the changed apps under its own name, each linked to that deployment's os and other apps (`PREVIEW_REUSE`, read by start-app.ts `linkedEnvironment`), and reuses the rest. A tests-only push deploys nothing. Otherwise, or with no ancestor deployed: a full deployment, as today.

So a deployment is either **full** (its own os and every app) or **partial** (some apps, no os and no os resources). Only full ones are ever reused, so reuse never chains.

What else changes:

- **The plan reaches the suites** as Deploy preview's `preview-plan` artifact (the `output/preview.json` it already writes, plus `reuses` and `deploys`). A PR run's suites read it from their own workflow run after the wait (scripts/ci/depot.ts, as the trace job reads artifacts), and test the plan's os and apps.
- **The readiness gate, the sign-in seed and the PR body** use the plan's os. The PR body section marks reused rows with the deployment they come from.
- **Cleanup keeps what a plan reuses.** `cleanup-superseded` never deletes the plan's `reuses`. A `main-…` deployment stays until 45 minutes after its successor was created, so a PR testing against it keeps it (the suite bound is 30). The sweep keeps each prefix's newest partial deployment beside its newest full one.
- **A test-only dispatch** still tests the prefix's newest full deployment: it can't see a partial one's plan.
- **Main's deployments are short-lived** (the cleanup keeps one 45 minutes past its successor), so a PR branched from an older main deploys in full on its first push, and reuses its own deployment after.

## Phases

### 1. Units (no behavior change)

- [x] `scripts/ci/preview-units.ts`: units (= `deploy-<unit>.yml` paths), machinery, suites; `changedUnits(files)`, `suiteInputsChanged(suite, files)` _`touchesSuite`; the paths matcher moved here from preview-paths.ts_
- [x] Tests: units equal the deploy workflows' paths; every `previewPaths` file is some unit's or suite's input or a known no-suite file; `changedUnits` table (docs, unit test, lockfile → every unit, machinery → every unit, rename out of `apps/os`) _preview-units.test.ts; renames are the callers' `--no-renames`_

### 2. Inherit

- [x] `planInherit` as a pure function over (PR commits with their check results, labels, changed files) → `inherit <sha> | run`, table-tested: docs push, unit-test push, specs-only push (E2E inherits, specs run), red candidate, cancelled then green, force-push, `slow-e2e` label _preview-inherit.test.ts, 16 rows, GitHub injected as functions_
- [x] E2E tests / Browser specs / Deploy preview: the inherit step, its summary line, and the steps after it skipped _no new step: `preview-paths.ts changes` asks it (PREVIEW_SUITES) and writes `preview=false`, which every later step and the trace already skip on; `checks: read` added_
- [x] ~~Workflow tests: the truth table gains inheriting runs~~ _inheriting is `preview=false`, which the table already covers; the tests check each job's step names its suites_
- [ ] Live check on this PR: a docs-only push, a specs-only push

### 3. Reuse

- [x] `planReuse` as a pure function over (candidates with their touched units, requested apps) → `{ reuses, deploys }`, table-tested _preview-reuse.test.ts_
- [x] `PREVIEW_REUSE` in start-app.ts `linkedEnvironment`: an app of a partial deployment links to the reused os and apps _envs.ts `PreviewPlan`/`previewPlanMembers`; viteBuild takes the build's env_
- [x] preview.ts `deploy`: candidates, the plan, deploy only `deploys`, the gate/seed/section on the plan's os, `preview.json` + `preview-plan` artifact _`planDeployment`, `filesChangedSince` (GitHub resolves the sha7, git fetches it at depth 1)_
- [x] Suites: read the plan after the wait, test its urls _`planOfThisRun` via await-deploy.ts `artifactOfThisRun`; PR runs only_
- [x] `planSupersededCleanup`: never the plan's `reuses`; 45 min grace for `main`; sweep keeps a prefix's newest partial deployment _and the sweep counts main's idle hour from its successor's creation_
- [x] PR body section: reused rows name their deployment
- [x] Docs: `docs/dev-environments.md` (second pushes, partial deployments), the preview-os.yml header _a row in Second pushes, and an "Inherited verdicts and reused deployments" section_
- [ ] Live check: a notes-only push on this PR (deploys one worker), a tests-only push (deploys none)

## Later, not now

- **Select:** run only the changed units' suites. With reuse alone, an app-only PR still runs E2E against main's os, which proves nothing new; this is where select would save next. Jonas's view (os changes run E2E, not the app specs) is its policy question.
- **`packages/iterate` forces every unit** (59 of 200 PRs). If that keeps defeating reuse, compare a unit's built bundle instead of its input paths. That's exact, but it needs a build before the plan.
- A result store keyed by the tested tree's contents, so an identical tree inherits across PRs (and main after a squash merge with no main movement).
- Reusing a partial deployment's own apps (a second push to a notes-only PR redeploys notes even when notes didn't change).
- One manifest for the path lists copied into `previewPaths` and the workflows' `paths:`.

## References

- Old draft: `git show 'stash@{0}^2:tasks/ci-change-detection.md'` (the stash's index commit, `de2457c92`)
- Old planner: `git show 97ffd6fd65:scripts/preview/change-plan.ts` (#2712); history via the API: `origin/codex/lazy-preview-history` (#2744); both deleted by #2837
- Per-commit deployments: #3165, `envs.ts` `previewDeployment`, `apps/os/scripts/preview.ts`, `preview-sweep.ts` `planSupersededCleanup`
- Today's PR-wide skip: `scripts/ci/preview-paths.ts`; tested commit: `scripts/ci/preview-tested-commit.ts`; the suites' wait: `scripts/ci/await-deploy.ts`
- App linking: `scripts/lib/start-app.ts` `linkedEnvironment`; CIMD client id: `packages/iterate/src/app-server.ts`

## Implementation log

- 2026-09-28: live checks under the first form of decision 3 (reuse keyed on the tested merge with main): `e7fbf83` (docs) inherited both suites in 8 s; `60772a1` (a spec comment) inherited E2E tests but deployed in full, because main had landed an apps/os change (#3346) since the PR's last deployment; `8f0e8dc` (notes) reused `pr3340-c08836c` and deployed one worker, specs green against it; `5c96717` (reverts) reused it and deployed nothing, Deploy preview 28 s.
- Misha on `60772a1`: it should have needed no deployment; deployments are per commit, so walk parents like #2712 did. Decision 7: a PR run tests its head. `preview-tested-commit.ts` and the `preview-paths.ts changes` gate are deleted; inherit and reuse both place ancestors through GitHub's compare API.
