---
status: done
size: large
---

# Back out of Cloudflare Worker Previews

**Status:** done, merged 2026-09-27. Built: per-commit deployments derived from their name (`envs.ts` `previewDeployment`), prd's deploy path for them, set-based cleanup/delete/sweep, all workflows moved, docs. Proven on this PR's own runs: green deploys, the second-push cleanup, a cancelled half-set cleaned up, sign-in, no leaked Durable Object namespaces. Left to the first runs after merge: Main OS e2e, the latency guard, the PR-close delete and the nightly sweep (which also takes the legacy Worker Previews, once idle a day).

## Why

Action item from the 2026-09-25 call with Jonas (Tuple call `57360661`). Worker Previews are new, and a lot of Cloudflare doesn't know about them:

- the dashboard's Durable Objects data view can't query a preview's DOs
- we pin a draft wrangler (`pkg.pr.new/wrangler@14416`) because released wrangler leaks a preview's KV/R2 on delete
- an existing preview can't gain a DO class (10061), so `preview.ts` deletes and recreates it
- Cloudflare's new config tooling doesn't support previews, which keeps our post-build `previewWranglerConfig` transform alive
- an in-place redeploy leaves old DOs answering with the old code for up to ~100 s, which the readiness gate has to wait out (iterate/iterate#3069)

Jonas measured a brand-new plain worker at about 10 s slower to deploy than an in-place preview redeploy. Plain workers are "dirt simple, nuts and bolts", and "if we decide we were wrong … we can back out of the backing out".

Separate from `tasks/ci-change-detection.md` (what to deploy and test); this is only how a deployment is made.

## Decisions

1. **Plain Workers wherever a Worker Preview is used today.** Ordinary `wrangler deploy` on the dev/preview account with released wrangler; no `previews` config block, no `wrangler preview`, no pkg.pr.new pin.
2. **Path-based project routing stays** (workers.dev, `ingressRouting: paths`). Every project on a PR or CI deployment trusts the others.
3. **No change detection here.** Every run deploys the same set it does today (os + all 6 apps on PRs).
4. **Each set's os worker gets its own D1.** Settled as "don't wait for Jonas's D1 change"; it landed mid-grill (iterate/iterate#3145). So `<name>-os-db` is created and migrated before the code uploads (`scripts/d1.ts`), as a preview's D1 is now.
5. **A fresh set of workers per tested commit**: `pr<n>-<sha7>-<app>` (`pr3144-a1b2c3d-os`, `pr3144-a1b2c3d-dash`, …), sha7 of the tested commit (the PR merged into main). Each os worker has its own KV ×2, R2 and Artifacts namespace. `reset` goes away. The PR body's Sign in link re-seeds the test person and project each deploy, so data not surviving a push costs nothing.
6. **The parents stay as plain "main on dev" workers.** `os`, `dash`, … at `*.iterate-dev-preview.workers.dev`, deployed in place from main by `preview-parents.yml` and reset nightly, as today. Only comments and docs stop calling them parents; no PR depends on them.
7. **Every workflow moves.** `preview-os.yml`, `main-os-e2e.yml`, `os-latency.yml`, `os-real-model.yml`, `os-e2e-soak.yml` all deploy `<prefix>-<sha7>-<app>`; `--name` is the prefix. (`--settle` already went in iterate/iterate#3069.) The in-place version wait iterate/iterate#3069 added is only needed where a worker is still redeployed in place: main on dev.
8. **Cleanup in three layers.**
   - A `Clean up superseded` job, started once the new set passes readiness and run beside the suites, deletes every older set with the same prefix. It never gates checks; a cancelled one is covered by the next run's.
   - PR close (`preview-delete.yml`) deletes every `pr<n>-*` set.
   - The nightly sweep, rewritten for worker names: a set whose PR is closed, a set that isn't its prefix's newest and is over an hour old, and any per-set resource whose worker is gone.
   - A set's KV/R2/Artifacts (and D1) are deleted by name with its workers (`wrangler delete` doesn't). The newest set of each prefix is always kept.
9. **A per-commit deployment is an `envs.ts` environment.** A function in `envs.ts` derives it from a name: an `OsEnv` for `<name>-os` plus one env per app, resources binding-only. Built and deployed through the same `viteWranglerConfig` / `startAppWorkerConfig` → `deployApp` path as prd. `previewWranglerConfig` and `writeStartAppPreviewConfig` are deleted.
10. **Out of scope:** Cloudflare's TS config file, deploying only changed apps, a shared Artifacts namespace, renames ("preview", `pnpm preview`, `preview-os.yml`, the required `E2E tests` / `Browser specs` checks, `osEnvs.preview` keep their names), deleting main on dev, the D1 control plane.
11. **Evidence in the PR body before it leaves draft** (below).
12. **The second-push scenarios are documented** in `docs/dev-environments.md`'s preview section: for each of happy, cancelled mid-deploy, failed deploy and failed tests, what the previous set looks like and which cleanup layer deletes it, so whoever next changes this setup can check the cases still hold.

## Checklist

- [x] `envs.ts`: derive a per-commit env set from a name; the name rule (`<prefix>-<sha7>`, 63-char DNS-label guard, the account-resource and former-parent clashes `resolvePreviewName` refuses today) _`previewDeployment(name)`, `osEnv(name)` and an optional `OsEnv.resources`; the clash checks went: every name ends `-<sha7>-<member>`, which no account resource has_
- [x] `generate-wrangler-config.ts` / `start-app.ts`: build for a derived env; resources binding-only; the test-link and preview-admin vars `previewWranglerConfig` sets today _`deploymentWranglerConfig` / `linkedEnvironment`; KV binding-only, D1 by name, R2/Artifacts named after the worker; since iterate/iterate#3250, `adminIssuer`, `testEmailDomain` and `admins` on `OsEnv`_
- [x] `preview.ts deploy`: build and `deployApp` os and each app with released wrangler; secrets per worker; readiness gate kept for a brand-new worker's first seconds; the in-place version wait only for main on dev _`deployOs({ env: name })` (deploy.ts creates D1/R2/Artifacts, then migrates) + `deployStartApp`; gate fed the version `/version` names_
- [x] Delete `preparePreviewWrangler`, `uploadPreviewSecrets`, the 10061 recreate path, `reset`, `previewWranglerConfig`, `writeStartAppPreviewConfig` _gone, with `--apps auto` (a fresh name never has the untouched apps)_
- [x] Delete a set: `wrangler delete` each worker, then KV, R2 (emptied first), Artifacts namespace and D1 by name _`deletePreviewDeployment`: workers via `DELETE /workers/scripts/:name?force=true`, then KV/R2/D1/Artifacts, all settled_
- [x] `cleanup-superseded` command and its job in every workflow of decision 7 _jobs in preview-os and main-os-e2e; a `continue-on-error` step in latency and real-model; the soak relies on the sweep_
- [x] `preview-delete.yml`: every `pr<n>-*` set _`pnpm preview delete` now deletes every deployment of the prefix_
- [x] `preview-sweep.ts`: rules over worker names; table tests _`groupPreviewDeployments` + rules 1–4 + `planSupersededCleanup`; `newestPreviewDeployment` needs the os worker, so a failed push never gets the last good one swept_
- [x] `preview-os.yml`: the deploy job outputs the set's name for the suites; a test-only dispatch resolves the PR's newest set; `reset` action gone _`outputs.deployment` via `$GITHUB_OUTPUT`; suites get `PREVIEW_DEPLOYMENT`_
- [x] `main-os-e2e.yml`, `os-latency.yml`, `os-real-model.yml`, `os-e2e-soak.yml`: prefix names _prefixes `main`, `latency`, `real-model`; soak `<name>-<sha7>`_
- [x] Callers that assume Worker Previews: `e2e/support/deployed-target.ts`, `specs/setup.ts`, `packages/ui` environment favicon, `scripts/lib/do-reset.ts`, `scripts/ci/do-duration-probe.ts` _deployed-target resolves the name; favicon regex already matched; do-duration-probe comment; do-reset untouched (still right for main on dev)_
- [x] PR body section: per-commit URL, the worker's dashboard link, no "every push redeploys it in place" _`deployment` + `versionId`; dashboard link to `<name>-os`_
- [x] `docs/dev-environments.md`: the four second-push scenarios (decision 12) _"Second pushes" table (five rows: the cleanup-cancelled case too)_
- [x] Docs: `docs/dev-environments.md`, `docs/pull-requests.md` (Previews), `apps/os/README.md`, `docs/depot-ci.md`, the workflow headers, `envs.ts` comments (parents → main on dev) _plus testing.md, the creating-an-app skill, debug-os-worker skill_
- [x] Tests: `preview.test.ts`, `preview-sweep.test.ts`, `scripts/ci/depot-workflows.test.ts`, `scripts/ci/preview-os-workflow.test.ts` _plus start-app.test.ts and the favicon test_
- [x] ~~Post-merge, once: delete every Worker Preview still on `os` and the app parents~~ _not a one-off: the nightly sweep's legacy step (`deleteLegacyWorkerPreviews`, `planLegacyWorkerPreviewSweep`) takes each once idle a day, on `os`, `<app>` and iterate/iterate#3260's former parents, with os's previews' KV/R2/D1/Artifacts_

## Evidence (decision 11)

- [x] A PR run green on `pr<n>-<sha7>-*`, with Deploy preview time and time to green next to recent main-based PRs (CI trace) _Deploy preview 68 s (51–122 s on recent PRs), time to green 3m22s_
- [x] A second push whose `Clean up superseded` job deleted the first set: workers, KV, R2, Artifacts gone _`pr3165-5454df5` deleted by the next run's cleanup_; ~~`pnpm preview sweep --dry-run` finds nothing stale~~ _can't run locally on Node 26: importing npm undici 8 leaves global `fetch` responses with no headers, so a gzip JSON body parses as nothing; CI's Node 24 lists fine (the cleanup jobs use the same listing). The first nightly run is the check_
- [x] The same second push when the previous commit (a) was cancelled halfway through deploying, (b) failed to deploy, (c) deployed but failed its tests _(a) `pr3165-7e56da6`, a D1 and no workers, deleted by the next cleanup; (c) `pr3165-c11441e`, deployed with its E2E red (Depot run `7tjkf1kdh6`), deleted by the next deployment's cleanup; (b) covered by the `planSupersededCleanup` table only_
- [ ] `preview-delete.yml` for the PR, leaving no `pr<n>-*` anything _runs on merge_
- [ ] Main OS e2e green on `main-<sha7>` _runs on merge_
- [ ] `os-latency.yml` once _its next 3-hourly run after merge_
- [x] ~~The dashboard's Durable Objects data view working on a per-commit worker (screenshot)~~ _not taken; per-commit workers are plain workers, which the data view supports_
- [x] Workers on the account, counted before and after _34 before, 35–36 during (one PR deployment = 7); 196 Durable Object namespaces, none left by a deleted worker: deleting a worker takes its namespaces, so iterate/iterate#3260's 500-namespace squeeze does not recur. `os` alone still holds 88 for its legacy Worker Previews, which the sweep takes_

## Context

- Released wrangler (4.45+) auto-provisions binding-only KV, R2 and D1 on `wrangler deploy`, named with the worker as prefix.
- 500 Workers per paid account; 1,000 KV namespaces. 7 open PRs on 2026-09-25, 200+ merged the week before.
- Today's code: `apps/os/scripts/preview.ts` (1,424 lines), `preview-config.ts` (653), `preview-sweep.ts` (182), `preview-artifacts.ts` (247), `d1.ts` (110).
- Grilled in Plannotator (8 revisions). Every recommendation was taken; the sad-path evidence and decision 12 came from your note on rev 7.

## Implementation log

- 2026-09-25: main moved twice mid-grill: iterate/iterate#3145 (the control plane is D1) and iterate/iterate#3069 (in-place readiness, `--settle` gone). Decision 4 became "each set's os worker gets its own D1".
- Resources: the repo's wrangler (4.140) auto-provisions binding-only KV as `<worker>-<binding>` and finds a D1 by `database_name`, but an R2 `bucket_name` is "fully specified" (never provisioned), and a D1 has to be migrated before the code uploads. So deploy.ts creates D1, R2 and Artifacts by name and wrangler creates the KV. Checked in `wrangler-dist/cli.js` (`provisionBindings`, `autoProvisionedResourceName`, `D1Handler.isConnectedToExistingResource`).
- Legacy Worker Previews: the Cloudflare API deletes them directly (`DELETE /workers/workers/{worker}/previews/{name}?force=true`), so the transitional sweep step needs no draft wrangler.
- Merged main after iterate/iterate#3166 (the apps read `APP_CONFIG`): `startAppWorkerConfig` builds that blob from `linkedEnvironment`, and the preview swap it added (`startAppPreviewConfig`) is gone with the rest.
- Latency guard: it measured an in-place-redeployed preview on purpose ("what production is"). It now measures a fresh deployment whenever main moved between runs, so its baseline may shift once.
- 2026-09-27: merged main again, 65 commits. iterate/iterate#3250 replaced test links with prd admins signing in through prd and `login_hint` impersonation: `OsEnv.testLinks` became `adminIssuer` + `testEmailDomain`, and `previewDeployment` lists its `admins` itself (prd's plus `admin@preview.iterate.test`), so the generator no longer merges admins. iterate/iterate#3238 had moved the suite lines into the CI trace job; with the status and suite lines already gone from the section here, the hand-over and `pnpm preview suite-lines` went too, keeping its injected, tested `writePullRequestBody`. iterate/iterate#3260's former-parent rule 0 folded into the legacy step (24 h idle for every legacy Worker Preview, not just the former parents'). iterate/iterate#3268 moved the integration reference; the `--deployment` note moved with it.
