---
status: experiment
size: large
---

# CI change detection: inherit results and reuse deployments

**Status:** an experiment, not a commitment: built to see what inherit and reuse cost in code and save in CI before deciding whether to keep them. Nothing built yet. Decided 2026-09-28: inherit and reuse, as #2712 had them; no suite selection for now. It replaces the 2026-09-25 draft (never committed; `stash@{0}`), which predates #3165. The main open implementation question is how Deploy preview hands its reuse plan to the suites.

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
3. **Reuse keys on the tested tree.** A unit's deployment is reused only when its fingerprint in the tested merge commit matches, because main's new tests arrive with the merge and must run against main's new product.
4. **Reuse looks at the PR's newest deployment, then main's newest `main-<sha7>`.** An app-only PR deploys only its app, linked to main's os and main's other apps. If nothing matches, it deploys its own, as today.
5. **An os change still runs every spec** (it always does, with no selection). Revisit with the R2 parquet evidence: how often did an app spec catch an os regression?
6. **Main OS e2e is unchanged:** everything on every push. It's the canary, and it's where reused main deployments come from.

## Design

### Units and fingerprints

One manifest, `scripts/ci/units.ts`, replaces the path lists copied into 5+ places: `previewPaths`, the `paths:` of main-os-e2e.yml, preview-parents.yml and preview-delete.yml, and each `deploy-<app>.yml`.

```ts
export const units = {
  os: {
    product: [
      "apps/os/**",
      "configs/**",
      "packages/iterate/**",
      "packages/shared/**",
      "envs.ts",
      "pnpm-lock.yaml" /* … */,
      "!apps/os/e2e/**",
      "!**/*.test.ts",
      "!apps/os/docs/**" /* … as deploy-os.yml */,
    ],
  },
  notes: { product: ["apps/notes/**", "packages/ui/**" /* … */] },
  // dash, agents, admin, voice, kit
};
// Deploy machinery (.depot/actions, preview-os.yml, apps/os/scripts/{deploy,preview*,d1,…}.ts) counts as every unit's product.
export const suites = {
  e2e: { units: ["os"], tests: ["apps/os/e2e/**", "apps/agents/e2e/**", "packages/cli/**"] },
  specs: {
    units: ["os", "dash", "notes", "admin", "voice"],
    tests: ["specs/**", "playwright.config.ts"],
  },
};
```

`depot-workflows.test.ts` checks that each workflow's `paths:` matches the manifest.

A unit's **fingerprint** is sha256 of the sorted `path + blob sha` list of its product files in a tree (`git ls-tree -r`, ~30 ms). Every deploy records it on the worker. Recommended: `wrangler deploy --tag <unit>:<fp12>`, read back through the deployments API that #3314 already uses.

### Inherit

Each suite job, before it sets up:

1. Walk the PR's commits back from the head to the nearest one with a completed check of this suite. A green check (run or inherited) is the candidate; a red one means run; no candidate at all (a force-push, the first push) means run.
2. If the PR head changes none of the suite's inputs since the candidate (its units' product plus its `tests`), pass: the summary links the run inherited from. Otherwise run.
3. The `slow-e2e` label or `slow-rows` input differing from the candidate's run means run.

Deploy preview inherits when both suites would: no deploy, and the PR body section keeps pointing at the last deployment, which is still the PR's newest. A dispatch never inherits.

The history walk from #2712 survives only here, and only over the PR's own commits.

### Reuse

Deploy preview, per unit:

1. Fingerprint the unit in the tested merge commit.
2. Candidates, in order: the PR's newest deployment, then main's newest `main-<sha7>`. Take the first whose recorded fingerprint for that unit matches and whose worker is live. The first is usually a miss when main has moved the unit since the last push.
3. Deploy the misses under `pr<n>-<sha7>`; reuse the hits.

A tests-only PR usually deploys nothing. A notes-only PR deploys `pr<n>-<sha7>-notes`. Everything else deploys everything, as today.

What reuse needs:

- **Apps linked to another deployment's os.** #3165 made the name decide everything (`previewDeployment(name)` links apps to `<name>-os`). Reuse needs something like `previewDeployment(name, { base: "main-c3d4e5f", own: ["notes"] })`: os and the unchanged apps come from `base`, the deployed ones from `name`. Apps are CIMD OAuth clients (`<origin>/.auth/client.json`), so any app origin can sign in against any os without os-side registration.
- **The plan has to reach the suites.** Today each suite works out its deployment from the commit by the deploy's own rules. A reused set depends on a Cloudflare listing that can change between jobs (main's next deployment could land in between). So Deploy preview publishes its plan (unit → deployment name), and the suites read it once their wait ends. Open: a commit status, an R2 object, or a Depot job output (if `await-deploy.ts` can read one).
- **Main's cleanup can't delete a reused os out from under a running PR.** `planSupersededCleanup` keeps a superseded `main-…` deployment for the suite bound (30 min). The next run's cleanup or the nightly sweep takes it after that.
- **A PR's cleanup never deletes what it reused.** `cleanup-superseded` deletes only `pr<n>-…` deployments, which a reused main deployment is not. But with partial sets, a PR's "newest deployment" must mean the newest plan's, not the newest worker's (a notes-only push leaves the older `pr<n>-<sha7>-os` in use).

## Phases

### 1. Manifest and fingerprints (no behavior change)

- [ ] `scripts/ci/units.ts`; `previewPaths` and the workflows' `paths:` built from or checked against it
- [ ] `fingerprint(unit, tree)`, table-tested: test-only change → same fp; lockfile → every unit; rename out of `apps/os` → os changes
- [ ] Record each unit's fp on every deploy (`--tag`), PR and main

### 2. Inherit

- [ ] `planInherit` as a pure function over (PR commits with their check results, changed files) → `inherit <sha> | run`, table-tested: docs push, unit-test push, specs-only push (E2E inherits, specs run), red candidate, force-push, `slow-e2e` label added
- [ ] E2E tests / Browser specs / Deploy preview: the inherit path, with a summary line linking the run inherited from
- [ ] Live check on a draft PR: docs-only push, specs-only push, push after a red run

### 3. Reuse

- [ ] `previewDeployment` with a base deployment; build and deploy only the missed units
- [ ] `planReuse` as a pure function over (tested-tree fingerprints, live candidates and their tags) → per-unit reuse or deploy, table-tested
- [ ] The plan published by Deploy preview and read by the suites (`runSuite`, `writeDeployedTarget`)
- [ ] `planSupersededCleanup`: 30 min grace for main's superseded deployments; a PR's newest is its newest plan's
- [ ] PR body section: reused rows link to main's workers, marked as reused
- [ ] `docs/dev-environments.md`: the second-push table, updated for partial sets
- [ ] Live check: notes-only PR (deploys one worker), tests-only PR (deploys none), os PR (deploys all), second push after main moved os (deploys all again)

## Later, not now

- **Select:** run only the changed units' suites. With reuse alone, an app-only PR still runs E2E against main's os, which proves nothing new; this is where select would save next. Jonas's view (os changes run E2E, not the app specs) is its policy question.
- **`packages/iterate` forces every unit** (59 of 200 PRs). If that keeps defeating reuse, fingerprint a unit by its built bundle instead of input globs. That's exact, but it needs a build before the plan.
- A result store keyed by the tested tree's fingerprints, so an identical tree inherits across PRs (and main after a squash merge with no main movement).

## References

- Old draft: `git show 'stash@{0}^2:tasks/ci-change-detection.md'` (the stash's index commit, `de2457c92`)
- Old planner: `git show 97ffd6fd65:scripts/preview/change-plan.ts` (#2712); history via the API: `origin/codex/lazy-preview-history` (#2744); both deleted by #2837
- Per-commit deployments: #3165, `envs.ts` `previewDeployment`, `apps/os/scripts/preview.ts`, `preview-sweep.ts` `planSupersededCleanup`
- Today's PR-wide skip: `scripts/ci/preview-paths.ts`; tested commit: `scripts/ci/preview-tested-commit.ts`; the suites' wait: `scripts/ci/await-deploy.ts`
- App linking: `scripts/lib/start-app.ts` `linkedEnvironment`; CIMD client id: `packages/iterate/src/app-server.ts`
