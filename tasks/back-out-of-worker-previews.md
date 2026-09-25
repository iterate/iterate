---
status: ready
size: large
---

# Back out of Cloudflare Worker Previews

**Status:** planned (grilled 2026-09-25), nothing built yet. Branched after #3145 (D1 control plane) and #3069 (in-place readiness), which landed mid-grill. Next: `envs.ts`-derived per-commit env, then the deploy path, then cleanup and workflows.

## Why

Action item from the 2026-09-25 call with Jonas (Tuple call `57360661`). Worker Previews are new, and a lot of Cloudflare doesn't know about them:

- the dashboard's Durable Objects data view can't query a preview's DOs
- we pin a draft wrangler (`pkg.pr.new/wrangler@14416`) because released wrangler leaks a preview's KV/R2 on delete
- an existing preview can't gain a DO class (10061), so `preview.ts` deletes and recreates it
- Cloudflare's new config tooling doesn't support previews, which keeps our post-build `previewWranglerConfig` transform alive
- an in-place redeploy leaves old DOs answering with the old code for up to ~100 s, which the readiness gate has to wait out (#3069)

Jonas measured a brand-new plain worker at about 10 s slower to deploy than an in-place preview redeploy. Plain workers are "dirt simple, nuts and bolts", and "if we decide we were wrong … we can back out of the backing out".

Separate from `tasks/ci-change-detection.md` (what to deploy and test); this is only how a deployment is made.

## Decisions

1. **Plain Workers wherever a Worker Preview is used today.** Ordinary `wrangler deploy` on the dev/preview account with released wrangler; no `previews` config block, no `wrangler preview`, no pkg.pr.new pin.
2. **Path-based project routing stays** (workers.dev, `ingressRouting: paths`). Every project on a PR or CI deployment trusts the others.
3. **No change detection here.** Every run deploys the same set it does today (os + all 6 apps on PRs).
4. **Each set's os worker gets its own D1.** Settled as "don't wait for Jonas's D1 change"; it landed mid-grill (#3145). So `<name>-os-db` is created and migrated before the code uploads (`scripts/d1.ts`), as a preview's D1 is now.
5. **A fresh set of workers per tested commit**: `pr<n>-<sha7>-<app>` (`pr3144-a1b2c3d-os`, `pr3144-a1b2c3d-dash`, …), sha7 of the tested commit (the PR merged into main). Each os worker has its own KV ×2, R2 and Artifacts namespace. `reset` goes away. The PR body's Sign in link re-seeds the test person and project each deploy, so data not surviving a push costs nothing.
6. **The parents stay as plain "main on dev" workers.** `os`, `dash`, … at `*.iterate-dev-preview.workers.dev`, deployed in place from main by `preview-parents.yml` and reset nightly, as today. Only comments and docs stop calling them parents; no PR depends on them.
7. **Every workflow moves.** `preview-os.yml`, `main-os-e2e.yml`, `os-latency.yml`, `os-real-model.yml`, `os-e2e-soak.yml` all deploy `<prefix>-<sha7>-<app>`; `--name` is the prefix. (`--settle` already went in #3069.) The in-place version wait #3069 added is only needed where a worker is still redeployed in place: main on dev.
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

- [ ] `envs.ts`: derive a per-commit env set from a name; the name rule (`<prefix>-<sha7>`, 63-char DNS-label guard, the account-resource and former-parent clashes `resolvePreviewName` refuses today)
- [ ] `generate-wrangler-config.ts` / `start-app.ts`: build for a derived env; resources binding-only; the test-link and preview-admin vars `previewWranglerConfig` sets today
- [ ] `preview.ts deploy`: build and `deployApp` os and each app with released wrangler; secrets per worker; readiness gate kept for a brand-new worker's first seconds; the in-place version wait only for main on dev
- [ ] Delete `preparePreviewWrangler`, `uploadPreviewSecrets`, the 10061 recreate path, `reset`, `previewWranglerConfig`, `writeStartAppPreviewConfig`
- [ ] Delete a set: `wrangler delete` each worker, then KV, R2 (emptied first), Artifacts namespace and D1 by name
- [ ] `cleanup-superseded` command and its job in every workflow of decision 7
- [ ] `preview-delete.yml`: every `pr<n>-*` set
- [ ] `preview-sweep.ts`: rules over worker names; table tests
- [ ] `preview-os.yml`: the deploy job outputs the set's name for the suites; a test-only dispatch resolves the PR's newest set; `reset` action gone
- [ ] `main-os-e2e.yml`, `os-latency.yml`, `os-real-model.yml`, `os-e2e-soak.yml`: prefix names
- [ ] Callers that assume Worker Previews: `e2e/support/deployed-target.ts`, `specs/setup.ts`, `packages/ui` environment favicon, `scripts/lib/do-reset.ts`, `scripts/ci/do-duration-probe.ts`
- [ ] PR body section: per-commit URL, the worker's dashboard link, no "every push redeploys it in place"
- [ ] `docs/dev-environments.md`: the four second-push scenarios (decision 12)
- [ ] Docs: `docs/dev-environments.md`, `docs/pull-requests.md` (Previews), `apps/os/README.md`, `docs/depot-ci.md`, the workflow headers, `envs.ts` comments (parents → main on dev)
- [ ] Tests: `preview.test.ts`, `preview-sweep.test.ts`, `scripts/ci/depot-workflows.test.ts`, `scripts/ci/preview-os-workflow.test.ts`
- [ ] Post-merge, once: delete every Worker Preview still on `os` and the app parents, with their KV/R2/Artifacts (the new sweep lists workers, not previews)

## Evidence (decision 11)

- [ ] A PR run green on `pr<n>-<sha7>-*`, with Deploy preview time and time to green next to recent main-based PRs (CI trace)
- [ ] A second push whose `Clean up superseded` job deleted the first set: workers, KV, R2, Artifacts gone; `pnpm preview sweep --dry-run` finds nothing stale
- [ ] The same second push when the previous commit (a) was cancelled halfway through deploying, (b) failed to deploy, (c) deployed but failed its tests: a sanity check with throwaway commits once the happy path works, not a rigorous test; say what each left behind and what cleaned it up
- [ ] `preview-delete.yml` dispatched for the PR, leaving no `pr<n>-*` anything
- [ ] `main-os-e2e.yml` dispatched from a scratch branch, green with no settle
- [ ] `os-latency.yml` dispatched once (real-model and soak share its `--name` path; covered by tests)
- [ ] The dashboard's Durable Objects data view working on a per-commit worker (screenshot)
- [ ] Workers on the account, counted before and after

## Context

- Released wrangler (4.45+) auto-provisions binding-only KV, R2 and D1 on `wrangler deploy`, named with the worker as prefix.
- 500 Workers per paid account; 1,000 KV namespaces. 7 open PRs on 2026-09-25, 200+ merged the week before.
- Today's code: `apps/os/scripts/preview.ts` (1,424 lines), `preview-config.ts` (653), `preview-sweep.ts` (182), `preview-artifacts.ts` (247), `d1.ts` (110).
- Grilled in Plannotator (8 revisions). Every recommendation was taken; the sad-path evidence and decision 12 came from your note on rev 7.

## Implementation log
