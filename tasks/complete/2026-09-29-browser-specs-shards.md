---
status: complete
size: medium
---

# Browser specs in shards again: every spec at once

**Status:** done in iterate/iterate#3394. Ten shards of six workers, shard 1 collects and gives the verdict, the CI trace groups the shards and shows each job's steps flat. Two green PR runs: Browser specs' verdict 85 s and 103 s after the run started (deploy ends at 56 s), no retries in 112 spec runs. Still open: whether `depot ci retry --failed` re-collects a retried leg (unexercised), and the follow-ups below. Assumptions below were made without Misha; each says why.

Browser specs had six 16-worker shards on the legacy platform (iterate/iterate#2659, 2026-09-16). The os-next roll-forward (iterate/iterate#2837, 2026-09-23) replaced that workflow with Preview OS's single Browser specs job, so sharding went with it. Bring it back on Preview OS and Main OS e2e, simpler than last time.

## The maths

Rule (Misha, iterate/iterate#2659): with Playwright's full parallelism, `shards × workers ≥ tests`, so every spec starts at once and the suite takes about as long as its longest spec.

- **Tests:** 56 in `pnpm spec --list` today (54 run, 2 skip), measured from main's Browser specs job `vbs7x5989z` (2026-09-28).
- **Workers per shard: 6**, on a `4x16`, the density iterate/iterate#3258 measured on this platform (2026-09-27): six browsers peak at 2.7 of 4 vCPUs. Unchanged from today.
- **Shards: 10.** `ceil(56 / 6) = 10`, so 60 slots, 4 spare.
- Playwright 1.63 deals `floor(tests / shards)` tests to each shard and one more to the first `tests mod shards` (`filterForShard`), in list order. No spec uses serial mode, so each test is its own group and the fullest shard holds `ceil(tests / shards)`. The guard below checks exactly that.

What to expect: today the Playwright wall is about 102 s (sum of spec time about 500 s over 6 workers, then the admin spec's tail). The longest spec is about 26 s (notes sessions, admin, voice). With every spec at once the wall should be about the longest spec plus any retry, so about 30 to 55 s.

## Design

- **One definition, two jobs.** `specs` keeps its name, **Browser specs** (the required check), and is shard 1. A new matrix job, `specs-shard`, runs shards 2 to 10 as **Browser specs 2/10** … **10/10**. All ten run the suite steps E2E tests already shares (the `suite-steps` anchor): install, wait for Deploy preview (`scripts/ci/await-deploy.ts`), run their share.
- **Shard 1 collects.** After its own share it waits for every `specs-shard` leg to settle (Depot's GetWorkflow, as the deploy wait does), downloads each leg's newest attempt's `test-results` artifact, merges their Playwright blob reports with its own into the one HTML report behind the **Playwright report** status, and fails red when any leg did not pass. So the required check still means "every spec passed".
- **No setup or teardown shard.** Last time a separate prepare job deployed and leased a slot, and a finish job erased it, because a shard that did either could leak the slot or erase it under its siblings. Now Deploy preview is its own job and the preview lives until the PR closes, so the only "teardown" left is merging reports, which is safe in shard 1. (Why shard-1-does-everything was backed out last time isn't in git; that is the likely reason.)
- **Evidence stays per job.** Each shard keeps its own telemetry, flake records, R2 upload and `test-results` artifact. Only shard 1 writes an HTML report (the merged one), so the fixed-name `public-playwright-report` upload has one writer. Shards write a blob report instead.
- **Main OS e2e gets the same shape**, as `scripts/ci/depot-workflows.test.ts` requires.

## Assumptions (made without Misha)

- "Whatever we settled on last week" = six workers per `4x16` (iterate/iterate#3258), not last fortnight's 16 per 16-core runner (iterate/iterate#2659): iterate/iterate#3258 is the newest measurement on this platform.
- Fixed counts plus a failing guard, not adaptive sharding, as Misha asked in iterate/iterate#2659.
- Shards start with the run and wait for the deploy, as Misha described, not `needs: deploy`. That costs idle runner time; see the cost note.

## Risks to measure, not assume

- **Retries.** iterate/iterate#3258 found 12+ browsers at once against one preview retried 2 to 4 times as many specs, mostly specs whose page shows no progress while the preview is busy (1 s action budget). Ten shards put about 54 browsers on the preview at once. The PR measures retried specs per run against the 0.26 to 0.31 baseline and reports it, whatever it is.
- **Cost.** Nine more `4x16` runners a push, each mostly waiting for the deploy: roughly +$0.17 a push, about +$30 a day at 180 pushes. Starting shards 2 to 10 with `needs: deploy` would roughly halve that for about 13 s more wall.
- **Time to green.** E2E tests (ends 141/187 s p50/p90) and Test (141/163 s) become the wall once specs are faster, so PR time to green gains less than the specs job does.

## Checklist

- [x] `playwright.config.ts`: read the shard from the environment (`PLAYWRIGHT_SHARD=3/10`); a shard writes a blob report and no HTML report _`SPECS_SHARD`/`SPECS_SHARDS` env; blob to `test-results/playwright-blob`_
- [x] Guard test: `ceil(listed tests / shards) ≤ workers`, failing with what to change (the shard count in both workflows) _`scripts/ci/specs-shards.test.ts`; asserts the fewest shards, `shards = ceil(tests / workers)`, so it also fails when specs are removed_
- [x] `preview-os.yml`: `specs` is shard 1/10 and collects; `specs-shard` matrix for 2..10; the trace job needs both _collect step in the shared `suite-steps`, gated on `SPECS_SHARD == '1'`; `specs` timeout 70 → 110 for the collection_
- [x] `main-os-e2e.yml`: same shape _plus the alert job needs the legs; only shard 1 saves Playwright's browser cache_
- [x] Collector: wait for the legs, download their blobs, merge the HTML report, fail on any red leg (a script under `scripts/ci/`, tested through a fake Depot) _`scripts/ci/specs-shards.ts`, reusing the deploy wait's poll loop (`pollWorkflow` in await-deploy.ts)_
- [x] Trace: label shard legs; time to green still ends at the last suite job _`jobKeyInWorkflow` drops `:matrix-<n>`; legs use their display name_
- [x] Trace: the shards under one **Browser specs** parent span (Misha, follow-up) _`assembleTrace` adds a `ci.kind: group` span over `specs` + `specs-shard` jobs; the viewer lists its shards 1–10 in order, each collapsed until opened. Last week's traces had no such parent: the old CI tracer showed "Playwright N/6" as siblings, and the explainer's "grouped shard phases" meant each shard's Setup → Wait → Run → Upload_
- [x] Trace shape (Misha, follow-up): jobs in the trace job's `needs` order (Deploy preview, E2E tests, Browser specs); no Setup/Test/Finish level; no "Run the suite against the preview" row; each suite's tests in one **Run tests** row _steps carry `ci.phase` for their bar colour; E2E tests gets the same shape, its 339 tests fold into its Run tests row; previewed on run `jvb8z6wp57` before pushing_
- [x] Workflow tests (`preview-os-workflow.test.ts`, `depot-workflows.test.ts`) pin the new shape
- [x] Docs: `docs/depot-ci.md` (preview job shape, reliability defaults), `docs/testing.md` _new section "Browser specs in shards"_
- [x] Main's alert page and the CI telemetry sync read every shard _`scripts/monitors/e2e.ts` names failing rows from any leg; `testEvidenceJobs` lists `specs-shard`_
- [x] Measure on the PR: Playwright wall, job and verdict time, retries per run, over several runs; compare with iterate/iterate#3258's numbers _runs `qxmljkwgml`, `jvb8z6wp57`: verdict 85/103 s after the run's start, slowest shard's tests 22.6/40.4 s (vs ~84 s Playwright on one 4x16 in iterate/iterate#3258), 0 retries; n=2, so the retry rate is still to watch on main_
- [ ] ~~Check `depot ci retry <run> --failed` on a red leg re-runs the leg and shard 1, and shard 1 collects the new attempt~~ _not exercised: no leg went red on this PR; the collector reads each leg's newest attempt, which its tests cover_

- [x] Browser specs as a coordinator (Misha, follow-up): `specs` runs no spec; the matrix is shards 1–10, all alike; `specs` starts with the run on a `2x8`, decides "is there a preview" by the suites' own (anchored) steps, collects, and uploads the merged report _the trace nests the shards under its row instead of a synthetic group_

## Follow-ups (not in this PR)

- The flake dashboard's Cost and incident sections treat each evidence folder as a run of its suite, so they now see one shard as a specs run. Group a workflow run's shards into one run.
- Pack shards by spec duration instead of count: 500 s of specs could fit 4 shards that each end near the longest spec, at 40% of the cost.

## Implementation log

- Baseline (main, `vbs7x5989z`, 2026-09-28): job start 20:50:22, setup done +10 s, deploy wait 40 s, Playwright 102 s for 56 tests (sum of spec time ~500 s incl. one retry), longest spec 26.3 s (notes sessions).
- Why shard-1-collects was dropped before isn't in git or the task files; the old design needed a prepare job (deploy + slot lease) and a finish job (erase the slot). Neither exists now.
- Local proof of the Playwright side: two shards of the local-only `suite` project wrote `report-suite-1.zip` / `report-suite-2.zip`; `merge-reports --reporter html` merged them (6 tests).
- Main's page: a Browser specs run red only because of a leg now reads "failed: Browser specs, Browser specs 2/2; failing rows: …" (`scripts/monitors/e2e.test.ts`).
- 7 tests in `scripts/ci/toolchain.test.ts` and `tracing.test.ts` fail locally on main too (macOS bash 3.2 has no `inherit_errexit`); CI's bash is fine.
