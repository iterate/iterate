---
status: experiment
size: large
---

# CI change detection: inherit results and reuse deployments

**Status:** an experiment, not a commitment: built to see what inherit and reuse cost in code and save in CI before deciding whether to keep them. Decided 2026-09-28: inherit, run only the tests a push changed, and reuse whole deployments, walking the head's history as #2712 did. It replaces the 2026-09-25 draft (never committed; `stash@{0}`), which predates #3165.

- **Built:** units (`scripts/ci/preview-units.ts`), inherit (`scripts/ci/preview-inherit.ts`, the `changes` step), selection (a suite that runs after a green runs only the changed rows or the changed apps' specs), reuse (`apps/os/scripts/preview-reuse.ts`: whole or not at all), the plan artifact, cleanup and sweep rules, docs, an explainer. A PR run tests its head, and inherit and reuse walk its history.
- **Proven live** (after decisions 8 and 9): an e2e-row-only push ran one test file on a reused deployment and was green in 64 s (was about 2:15); a Notes-only push ran one spec (26 s) with E2E tests inherited in 6 s, but deployed all seven Workers, and a brand-new deployment's readiness gate took 16–96 s today, so it was green in 2:39; docs-only pushes inherit both suites in about 8 s.
- **Left:** a decision on whether to keep it. Partial deploys (an app-only push reusing a warm apps/os) are deferred: see Later.

## Why now

On the 2026-09-25 Tuple call (`57360661`), Misha asked for this: if a PR changes only an app, reuse an earlier platform deployment and deploy only that app. It's the history walk from before (#2712), which was never brought back after #2837 deleted it.

#3165 (merged 2026-09-27) made it easier. Every tested commit now gets immutable plain Workers, `pr<n>-<sha7>-<app>` and `main-<sha7>-<app>`. So there are per-commit deployments to reuse again, and main's newest `main-<sha7>` is a deployment a PR can safely test against.

## What the numbers say

- A PR run: Deploy preview ~55 s; E2E tests ~105 s and Browser specs ~130 s, both counting their wait for the deploy. Time to green is ~2¼ min (last 10 merged PRs).
- 200 PRs merged 24–28 Sep: 181 needed a preview. About 10 change only an app (dash, notes, voice, agents, kit) and about 10 change only e2e tests or specs. Everything else changes os or code os shares (`packages/iterate` alone: 59).
- 145 follow-up commits in the last 60 PRs: 121 change product code, 16 only tests, 8 only docs. Today every one of them redeploys and retests everything, because the rule reads the whole PR's diff.
- Required checks aren't strict (`strict_required_status_checks_policy: false`): a PR can merge on a green run against an older main.

## Decisions

1. **Inherit and reuse first.** Suite selection was out at first; decision 8 brings a narrow form of it back.
2. **Inherit keys on the PR head.** A suite whose inputs haven't changed since an earlier green head passes without running: a docs-only push is the same as not pushing. It never carries a red.
3. ~~**Reuse keys on the tested tree.**~~ _Replaced by decision 7: keyed on the tested merge with main, reuse missed whenever main changed apps/os between pushes, about every half hour (live check C)._
4. **Reuse takes the nearest ancestor with a full deployment,** the PR's own or main's `main-<sha7>`. ~~An app-only PR deploys only its app, linked to that deployment's os and other apps.~~ _Replaced by decision 9._
5. **An os change still runs every spec** (decision 8 selects only for app, spec and e2e-row changes). Revisit with the R2 parquet evidence: how often did an app spec catch an os regression?
6. **Main OS e2e is unchanged:** everything on every push. It's the canary, and it's where reused main deployments come from.
7. **A PR run tests its head, not the head merged into main** (2026-09-28, after live check C). Deployments are per commit, so inherit and reuse both walk the head's history parent by parent, into main's past where the PR branched. A commit that merges main in is a commit like any other, usually one with many changes. The PR-wide "does this PR touch a preview path" gate goes: a PR that changes nothing a suite depends on inherits main's green. The cost: Depot still reads the workflow file from the merge commit, so a head that predates a workflow change needing code landing with it fails Preview OS until it merges main in (#2999's failure mode), and Preview OS no longer catches a semantic conflict with newer main before the merge.
8. **A suite that runs after a green runs only what the changed files select** (2026-09-28). A push that changes only e2e row files runs those files; one that changes only spec files and single apps runs those specs and those apps' Playwright projects (the Dash reruns every app's projects, since each signs in through it). A change to apps/os, agents, kit, shared test code or the config runs the whole suite. Sound because the rest passed at the green and depends on nothing that changed since.
9. **Reuse is whole or not at all** (2026-09-28). With decision 8, an app-only push's time goes on its specs, so deploying one Worker instead of seven saved about 10 s for the most complexity in the change (apps linked to another deployment's os, partial cleanup and sweep rules). Now: if the head changed nothing that deploys since the nearest ancestor with a deployment, the run deploys nothing and tests that one; otherwise it deploys all seven.

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

### Selection

`preview-units.ts` `suiteSelection(suite, inputs)`, where `inputs` are the files the suite depends on that changed since its nearest green, returns the runner's arguments or nothing (the whole suite):

- E2E tests: when every input is an e2e row's file (`apps/os/e2e/**/*.e2e.test.ts`, `apps/agents/e2e/**/*.e2e.test.ts`), those files.
- Browser specs: a changed spec file adds itself and its projects (`specs/os/` runs in `os` and `os-phone`, and each app's phone project beside it); a changed app adds its projects' directories (`notes` → `specs/notes/`; `dash` → dash, notes, agents, voice and admin). A test lists Playwright's projects per spec file, so a new project fails it until the map names it. Anything else, os, agents, kit, `specs/setup.ts`, the shared helpers, `playwright.config.ts`, means everything.

The suite job's `changes` step writes it as `selection` (JSON); `runSuite` appends it to `pnpm e2e:run` or `pnpm spec`. A test file the push deleted or renamed away is no input at all (`preview-inherit.ts` `comparedFiles`), so a push that only deletes a spec inherits, and every Browser specs shard gets the same decision.

### Reuse

On a PR's pushes only (never main, latency, real-model or a soak), Deploy preview plans before it builds:

1. Candidates: every live **full** deployment (all seven workers) of the PR's and of main's, never this run's own name.
2. GitHub's comparison of each one's commit (the sha7 in its name) with the head: an ancestor's distance and the units changed since. The nearest ancestor is the one a walk back would reach first.
3. If the head changed no unit since, the run deploys nothing and the suites test that deployment. Otherwise, or with no ancestor deployed, it deploys all seven, as before.

What else changes:

- **The plan reaches the suites** as Deploy preview's `preview-plan` artifact (the `output/preview.json` it already writes, plus `reuses`). A PR run's suites read it from their own workflow run after the wait (scripts/ci/depot.ts, as the trace job reads artifacts).
- **The readiness gate, the sign-in seed and the PR body** use the tested deployment's os. The PR body marks reused rows with the deployment they come from.
- **Main's deployments stay 45 minutes** past their successor's creation, so a PR run testing one keeps it. A PR branched from an older main deploys in full on its first push, and reuses its own deployment after.

## Phases

### 1. Units (no behavior change)

- [x] `scripts/ci/preview-units.ts`: units (= `deploy-<unit>.yml` paths), machinery, suites; `changedUnits(files)`, `suiteInputsChanged(suite, files)` _`touchesSuite`; the paths matcher moved here from preview-paths.ts_
- [x] Tests: units equal the deploy workflows' paths; every `previewPaths` file is some unit's or suite's input or a known no-suite file; `changedUnits` table (docs, unit test, lockfile → every unit, machinery → every unit, rename out of `apps/os`) _preview-units.test.ts; renames are the callers' `--no-renames`_

### 2. Inherit

- [x] `planInherit` as a pure function over (PR commits with their check results, labels, changed files) → `inherit <sha> | run`, table-tested: docs push, unit-test push, specs-only push (E2E inherits, specs run), red candidate, cancelled then green, force-push, `slow-e2e` label _preview-inherit.test.ts, 16 rows, GitHub injected as functions_
- [x] E2E tests / Browser specs / Deploy preview: the inherit step, its summary line, and the steps after it skipped _no new step: `preview-paths.ts changes` asks it (PREVIEW_SUITES) and writes `preview=false`, which every later step and the trace already skip on; `checks: read` added_
- [x] ~~Workflow tests: the truth table gains inheriting runs~~ _inheriting is `preview=false`, which the table already covers; the tests check each job's step names its suites_
- [x] Live check on this PR: a docs-only push, a specs-only push _`e7fbf83` (docs: both inherited, 8 s, nothing deployed), `60772a1` (spec: E2E inherited); again after decision 7_

### 3. Reuse

- [x] `planReuse` as a pure function over (candidates with their touched units, requested apps) → `{ reuses, deploys }`, table-tested _preview-reuse.test.ts_
- [x] ~~`PREVIEW_REUSE` in start-app.ts `linkedEnvironment`: an app of a partial deployment links to the reused os and apps~~ _built, then removed by decision 9_
- [x] preview.ts `deploy`: candidates, the plan, the gate/seed/section on the tested os, `preview.json` + `preview-plan` artifact _`planDeployment`, `placeInHistory` (GitHub's compare API)_
- [x] Suites: read the plan after the wait, test its urls _`planOfThisRun` via await-deploy.ts `artifactOfThisRun`; PR runs only_
- [x] `planSupersededCleanup`: 45 min grace for `main` _and the sweep counts main's idle hour from its successor's creation; the partial-deployment rules went with decision 9_
- [x] PR body section: reused rows name their deployment
- [x] Docs: `docs/dev-environments.md` (second pushes, partial deployments), the preview-os.yml header _a row in Second pushes, and an "Inherited verdicts and reused deployments" section_
- [x] Live check: a notes-only push on this PR (deploys one worker), a tests-only push (deploys none) _`068e2e5` (notes: one worker on `pr3340-91866ad`, before decision 9), `665c364` (revert: nothing deployed), `eb6db04` (docs after red: nothing deployed, both suites rerun)_

### 4. Selection and whole reuse (decisions 8 and 9)

- [x] `suiteSelection` in preview-units.ts, table-tested _16 rows: e2e files, spec files, app projects, the Dash's fan-out, everything for os/kit/shared code_
- [x] planInherit carries the selection; the step writes `selection`; runSuite passes it on _deleted test files dropped in `comparedFiles` since the merge of #3394 (shards): a shard with nothing to run would leave no blob report_
- [x] Reuse whole or not at all: partial deployments, `PREVIEW_REUSE` app linking and the partial cleanup/sweep rules removed
- [x] Live check: an e2e-row push runs one file on a reused deployment; a Notes push deploys all seven and runs the Notes project _`00bfa5e`: 1 file, nothing deployed, green in 64 s; `00e96d5` and `6a7af4e`: the notes project alone (1 spec, 26 s), E2E tests inherited in 6 s, Deploy preview 127–182 s_

## Later, not now

- **Partial deploys again** (deferred 2026-09-28): an app-only push deploying only its app against a reused, warm apps/os would skip the os deploy and a brand-new deployment's readiness gate (16–96 s on 2026-09-28). The first version of this PR had it; decision 9 removed it for its complexity.

- **Select for os changes:** Jonas's view (an os change runs E2E, not the app specs) is the remaining policy question; os changes run everything today.
- **`packages/iterate` forces every unit** (59 of 200 PRs). If that keeps defeating reuse, compare a unit's built bundle instead of its input paths. That's exact, but it needs a build before the plan.
- A result store keyed by the tested tree's contents, so an identical tree inherits across PRs (and main after a squash merge with no main movement).
- One manifest for the path lists copied into `previewPaths` and the workflows' `paths:`.

## References

- Explainer for newcomers: `explainers/ci-inherit-and-reuse.html`, at https://ci-reports.iterate-dev-preview.workers.dev/explainers/ci-change-detection/ci-inherit-and-reuse once ci-reports serves explainers (#3395)

- Old draft: `git show 'stash@{0}^2:tasks/ci-change-detection.md'` (the stash's index commit, `de2457c92`)
- Old planner: `git show 97ffd6fd65:scripts/preview/change-plan.ts` (#2712); history via the API: `origin/codex/lazy-preview-history` (#2744); both deleted by #2837
- Per-commit deployments: #3165, `envs.ts` `previewDeployment`, `apps/os/scripts/preview.ts`, `preview-sweep.ts` `planSupersededCleanup`
- Main's PR-wide skip: `scripts/ci/preview-paths.ts` `changes`; tested commit: `scripts/ci/preview-tested-commit.ts` (both deleted here); the suites' wait: `scripts/ci/await-deploy.ts`; the specs shards: `scripts/ci/specs-shards.ts` (#3394)
- App linking: `scripts/lib/start-app.ts` `linkedEnvironment`; CIMD client id: `packages/iterate/src/app-server.ts`

## Implementation log

- 2026-09-28: live checks under the first form of decision 3 (reuse keyed on the tested merge with main): `e7fbf83` (docs) inherited both suites in 8 s; `60772a1` (a spec comment) inherited E2E tests but deployed in full, because main had landed an apps/os change (#3346) since the PR's last deployment; `8f0e8dc` (notes) reused `pr3340-c08836c` and deployed one worker, specs green against it; `5c96717` (reverts) reused it and deployed nothing, Deploy preview 28 s.
- Misha on `60772a1`: it should have needed no deployment; deployments are per commit, so walk parents like #2712 did. Decision 7: a PR run tests its head. `preview-tested-commit.ts` and the `preview-paths.ts changes` gate are deleted; inherit and reuse both place ancestors through GitHub's compare API.
- After decision 7: `91866ad` (merge of main) walked into main's history and ran both suites (the PR changes machinery); its E2E tests and one spec went red on Cloudflare Artifacts errors. `eb6db04` (docs) inherited nothing from that red, reused `pr3340-91866ad` and passed. `068e2e5` (notes) and `665c364` (its revert) behaved as the plan says. Old merge-commit deployments (`pr3340-c08836c`) were correctly passed over as "not an ancestor".
- Decisions 8 and 9 (Misha, after asking whether it was worth it): as built it saved about 9% of Preview OS machine time and time only on docs pushes, with partial deployments the costliest part. Selecting the changed rows and app projects puts the time savings on test-only and app-only pushes, and makes partial deployments not worth their complexity.
- Live checks after decisions 8 and 9: the first e2e-row push (`4773a5e`) failed with "No test files found": vitest matches a filter against the path from its root, apps/os, so selected rows now go as absolute paths (`4bee6ae`). Then `00bfa5e` ran one file on a reused deployment, green in 64 s; `00e96d5` and `6a7af4e` ran only the notes project. Their full deploys took 127–182 s, most of it the readiness gate on a brand-new apps/os (16, 31, 62 and 96 s across today's full deploys; 1–2 s on a reused, warm one). That is decision 9's trade-off: a partial deployment reusing a warm apps/os would have skipped both the os deploy and that wait.
- 2026-09-29: merged main with #3394 (Browser specs in 10 shards plus a merging Browser specs job). Every shard and the merger run the inherit step for `specs`, so all eleven decide alike; each shard gets the selection and runs its share of it (Playwright skips its "No tests found" error when sharded, and writes a blob report either way). A push that only deleted a spec used to reach `runSuite` and return early, which with shards would leave no blob report and turn the merger red, so deleted test files are now dropped before the decision (`comparedFiles`).
- 2026-09-29, second merge of main (39 commits): #3410 lets Main OS e2e runs overlap and keeps a deployment a running Main OS e2e run tests (`deploymentsUnderTest`); that asks Depot about Main OS e2e alone, so the 45-minute grace for a PR testing a reused `main-…` stays, and `planSupersededCleanup` takes both. #3411 added the Agents specs and phone projects (`agents-phone`, `voice-phone`, `dash-phone`) that the selection map did not name, so a changed voice upgrade spec would have skipped `voice-phone`: the map names them now, and `preview-units.test.ts` checks it against `playwright test --list`. Agents app changes still run every spec (decision 8), though it now has a project of its own.
