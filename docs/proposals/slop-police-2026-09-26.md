# Slop police: the menu, 2026-09-26

The 2026-09-23..25 merge wave landed 333 PRs (#2841 to #3197). Eight read-only audits then looked at `origin/main` at `18adc4f21`: size against value, backwards compatibility, cross-purpose fixes and retries, repo structure, tests, duplication and dead code, CI, and docs and instructions. A second pass tried to refute every "safe and obviously right" finding against main and every open PR's diff.

What survived that pass merged overnight as ten PRs ([Already landed](#already-landed)). This file is the rest, ranked by value against cost. Nothing on it merges without you. Where two audits found the same thing, it appears once.

**How to answer.** Reply with item numbers and a verdict ("1: yes to CI-M1(b) and the gate cut; 6: I read the fault alarm and the DO cost alarm, nothing else"). Items marked "a nod" need only a yes.

**Columns**

- **Size** is lines removed (net), plus CI seconds where speed is the point.
- **Needs your decision** says what only you can settle: product, API, paging, deployment config, or something outside the repo.
- **Blocked by** names an open PR that rewrites the same files.

## Decided (2026-09-26)

- **In progress, no decision needed:** 7, 9, 11, 13, 19, 22 (the facet-file fold, one copy of each fixture, one vitest config if clean), 39, 40 (a nod given), 42 and 44. Each is its own PR, merged after review.
- **1, yes.** Browser specs get capacity: bigger Depot runners and/or Playwright sharding, as the old stack did (#2659). The readiness gate goes from 5 rounds to 3, os-phone runs on Main OS e2e only, and the TTG guard pages again on a 20 s regression. Also in flight: the trace job writes the suite lines once, and a bigger deploy runner if measured faster.
- **2, yes.** "The shape of a test" goes into `docs/vitest-patterns.md`. Rule 6 keeps production timings, per 3.
- **3, no.** Tests keep production timings: "I want it to be like in production."
- **4, yes.** The DO cost alarm is set from a measured baseline, and prd is checked for runaway Durable Objects first.
- **5, yes.** A lockfile guard that holds at merge time.
- **6, simplify, with limits.** Keep the traces viewer and the flake machinery for now. One scheduled health job, the Slack posts summarised, and no shadcn news post.
- **8 and 23, yes.** Both retry rules, one failure module, and the `UNAVAILABLE` code.
- **10, yes.** D1 is the only source of truth for orgs and projects.
- **14, no.** The admin app stays separate.
- **15, yes.** Use whatever PostHog recommends, and delete the custom masking.
- **20, keep and simplify.** One re-dial and one close-code policy; Vite HMR behind tunnels must keep working.
- **21, on hold** until it's clear how Misha's handwritten docs are treated.
- **28, not now.** The oversized files stay unsplit.
- **30, yes.** Impersonation only, provided PR bodies can deep-link to it.
- **32, yes.** The Kit firmware leftovers go.
- **34, no.**
- **35, yes.** `WORKER_BASE_URL` is the one name.
- **36, no.** Parallel work would race on strict `APP_CONFIG` keys.
- **37, yes.** Every spec passes under path-based project URLs.

## Already landed

| Batch                 | PR    | Merge       | Lines (lockfile aside)                  | What changed                                                                                                                                       |
| --------------------- | ----- | ----------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| tests-lint-tables     | #3206 | `21e9714cd` | −1,175 / +823                           | Lint-rule tests are valid/invalid tables of template-literal sources; a duplicate test goes                                                        |
| docs                  | #3207 | `db51e36d3` | −375 / +97                              | Docs say `pnpm os e2e` and list the admin app; the legacy flake hunt, a generic Vitest tutorial and repeated sections go                           |
| repo-hygiene          | #3205 | `fbc4f1969` | −58 / +42, 4 screenshots, lockfile −890 | PR screenshots, a dead lint plugin and stale config go; app scripts start through `isMainModule`; `iterate/with-itx` ships its types               |
| tests-idioms          | #3208 | `6c35dfa53` | −138 / +138                             | 109 `test.each` become `test.for`, every test name unchanged                                                                                       |
| retry-safe            | #3209 | `1ce08bfc3` | −396 / +362                             | Scripts share one HTTP failure classifier; the Worker Loader workaround gets its pin; dead retry classifications and a latent close-reason leak go |
| retired-do-erase      | #3204 | `91408cbec` | −944 / +174                             | The Durable Object reset parks only the Worker's own classes; wrangler stops listing three retired classes                                         |
| tests-unit-builders   | #3211 | `067463a41` | −1,254 / +916                           | Unit tests build their fakes once and name every case: 96 casts and 7 hidden tables go; firmware host tests use `assert.h`                         |
| tests-harness         | #3212 | `103594746` | −818 / +575                             | Every vitest config restores mocks, globals and env; the Workers suite reads logs through typed helpers; test fixtures live in one place           |
| client-fixture-dedupe | #3210 | `d6d9ffdcc` | −1,143 / +553, lockfile −65             | Agents and the UI kit share one read-only code block; dummy-petshop builds its Worker config, encoders and test helpers once                       |
| ci-speed              | #3203 | `6c83c5efd` | −66 / +117                              | Every CI job but Test takes its dependencies from the baked image                                                                                  |

**Total: −6,367 / +3,797 (net −2,570), and the lockfile −955 / +12.** #3213 (`9cb83f949`) also merged: it fixed a Node heartbeat row that went red on main after #3210.

## Top 15

| #   | Item                                                                                                                        | Size                                        | Risk    | Needs your decision         |
| --- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------- | --------------------------- |
| 1   | [CI back under 3 minutes](#1-ci-back-under-3-minutes)                                                                       | TTG 218 → ~180 s p50                        | low     | yes: runner, gate, os-phone |
| 2   | [One style guide for the shape of a test](#2-one-style-guide-for-the-shape-of-a-test)                                       | +30 doc lines                               | none    | yes: approve the text       |
| 3   | [Tests stop waiting out production timeouts](#3-tests-stop-waiting-out-production-timeouts)                                 | `pnpm test` −25 s, Test −10–20 s, e2e −20 s | low-med | yes: deployment config      |
| 4   | [prd's Durable Object cost alarm pages again](#4-prds-durable-object-cost-alarm-pages-again)                                | ~4 lines                                    | low     | yes: threshold              |
| 5   | [A stale merge can't break main](#5-a-stale-merge-cant-break-main)                                                          | +30                                         | low     | yes: pick the mechanism     |
| 6   | [CI tooling diet](#6-ci-tooling-diet-one-telemetry-record-one-health-job-no-flake-pipeline)                                 | −4k to −6k                                  | medium  | yes: which pages you read   |
| 7   | [Stop committing the browser extension's capnweb copy](#7-stop-committing-the-browser-extensions-capnweb-copy)              | −3,739                                      | low     | a nod                       |
| 8   | [Retries: settle two rules, then one failure module](#8-retries-settle-two-rules-then-one-failure-module)                   | −450 to −800                                | medium  | yes: two rules              |
| 9   | [Pin Cloudflare's coming platform DO retries](#9-pin-cloudflares-coming-platform-do-retries-then-delete-ours)               | +30 now, −80 later                          | low     | no                          |
| 10  | [D1 is the only source of truth for orgs and projects](#10-d1-is-the-only-source-of-truth-for-orgs-and-projects)            | −500 to −800                                | medium  | yes: DB/API shape           |
| 11  | [Delete tests no CI runs, and tests that pin implementation](#11-delete-tests-no-ci-runs-and-tests-that-pin-implementation) | −650                                        | low     | a nod                       |
| 12  | [Your 30-minute cleanup outside the repo](#12-your-30-minute-cleanup-outside-the-repo)                                      | unblocks ~−100                              | low     | yes: only you               |
| 13  | [Platform facts are silently dropped on every deploy](#13-platform-facts-are-silently-dropped-on-every-deploy)              | ~0                                          | low-med | no                          |
| 14  | [Fold the admin app into dash](#14-fold-the-admin-app-into-dash)                                                            | −700 and a Worker                           | medium  | yes: product                |
| 15  | [Session replay masks every input](#15-session-replay-masks-every-input)                                                    | −800                                        | low     | yes: product                |

---

## 1. CI back under 3 minutes

**Problem.** PR time to green (TTG) for pushes that skip the slow e2e rows went from 164/205 s (p50/p90, 2026-09-24) to **218/260 s** since #3069. Only 6 of 51 pushes met your 3-minute rule, against 23 of 38 before. Browser specs is now the slowest job on 45 of 49 green pushes. It doubled to 120 s p50 because the suite grew from 26 to 40 specs (#3063, #3144, #3185), and at p90 (152 s) it breaks "e2e ≤ 2 min once the preview is live". Deploy preview is +20 s: #3069's version gate adds 13 s, and admin is a 7th client build. The TTG guard has said "over" since 09-24 without paging again, so nobody heard. The numbers are in [Appendix D](#appendix-d-ci-findings).

**Proposal.** #3203 left out CI-N1 (start the longest flows first) because it failed its gate. Five specs dispatches in each order, alternating: clean runs took 74–79 s in main's order and 70–81 s in the new one, and the Dash specs' retries rose from 4 to 8. Started together, the heavy flows slow each other down (admin 28–34 s at t=0, against 19–24 s when it runs last). So the −15 s the replay predicted, which held each test's duration fixed, does not happen. In order:

- **CI-N1.** Start only the admin spec first (it ends the suite in every clean main-order run). Gate: at least 5 dispatches each way, and no rise in retries. Do it after CI-M6.
- **CI-M1.** Give specs capacity: Playwright workers 6 → 10 on 2x8, or specs on its own 4x16 with 12 workers (about +$0.01 a run; this reverses #3125 for specs only). −20–35 s. Replayed over the last 51 pushes: 192/232.
- **CI-M2.** Tune #3069's gate: drop the 5.6 s `/version` smoke, require 3 consecutive rounds instead of 5, and use 2 contexts per probe (−6–13 s; soak ≥ 20 runs). After #3165 removes Worker Previews, re-run the fresh-preview repro. If the fault is gone, delete `preview-readiness.ts` (−335 lines and seconds on every deploy); if not, pin it with `createFailing`.
- **CI-M11.** `os-phone` re-runs 8 issuer specs on every PR (about −8 s). Run it on Main OS e2e only, or keep only the 2 specs whose layout differs.
- **CI-M12.** The TTG guard pages again when p50 worsens by more than 20 s since its last page, and names the slow job. Confirm its lines (165/200).
- **CI-M8.** The CI trace job writes both suite lines into the PR body once; the suites stop doing a read, PATCH, sleep, read (−30 lines, −3–6 s).
- **CI-M3** (after #3165). The suite runner stops importing all 1,425 lines of `preview.ts` (−5–10 s on each suite when the image is cold).
- **CI-M7.** Re-measure oxlint's `--threads 1`; the grandfather rule that justified it is gone. Lint −10–20 s, not on the TTG path.
- **CI-M10.** Deploy preview on 8x32, or build only the changed clients (−3–8 s).

**Size:** replayed TTG about 180/219 with CI-M1 and the gate cut. Below 170 s the Test job is the wall (item 3). **Risk:** low. More concurrent browsers could raise the 1 s action-timeout flakes; a separate runner avoids that. **Needs your decision:** the runner (your D7 decision), the gate (D1) and os-phone coverage.

**Also open: CI-M6.** The new Dash specs flake on the 1 s action budget ("an admin opens any project's contexts" retried 12 times and failed 17). They wait on server outcomes the page shows no progress for. The fix is progress UI in the product, or an eventual-state assert under the 15 s expect budget. It belongs to those specs' owners, and CI-N1 waits on it.

## 2. One style guide for the shape of a test

**Problem.** At the audit, test code was 86k lines (44% of all TypeScript) in 13 archetypes, each with its own fixture habits. There were 834 casts in tests and 238 `any` annotations (155 of them in OS e2e), no tables at all in OS e2e, and 77 hidden tables (one test body with four or more `expect(f(…))` on the same `f`). `docs/vitest-patterns.md` prescribes `test.for` with object rows, but nothing enforced it, so 134 tables used `test.each`.

**Proposal.** Add one section, "The shape of a test", to `docs/vitest-patterns.md` (about 30 lines; `docs/testing.md` is left alone because #3165 edits it):

1. **Many inputs, one behaviour: a table.** `test.for` with object rows keyed `name`, titled `"$name"`. No `test.each`, tuple rows or printf titles. A body with four or more `expect(f(…))` on one `f` is a table.
2. **One fixture home per suite.** Unit files use their domain harness (`iterate/stream/test-support`), Workers files `__workers-tests__/support.ts`, e2e files `e2e/support/`, specs `specs/test-support/`. A helper two suites need moves down a layer, never into a copy.
3. **No casts in test bodies.** One typed builder at the bottom of the file, with defaults, casting at most once, with a comment. When production takes more than it uses, narrow its parameter (`Pick<>`) instead of casting at every call. Read the platform through typed readers (`readLog`, `snapshot`), not `invoke(…) as {…}`.
4. **Assert the object.** `toMatchObject` on the whole value; `toEqual` only where exactness is the point, and say so. No `toBe(true)` on a derived boolean: assert the collection.
5. **Titles say the behaviour in one line of about 100 characters.** The why goes in a comment. A file header names the subject and what is out of scope; it never re-lists the tests.
6. **Time.** Unit tests use fake timers. A Workers or e2e row never waits out a production constant; the deadline is injected (item 3). A fixed sleep is a named negative wait with a comment, or it becomes `until`.
7. **Restore by config.** `restoreMocks`, `unstubGlobals` and `unstubEnvs` in every vitest config. (#3212 did this.)
8. **Tests don't read source text.** Import boundaries belong in lint. When two files must agree, make one the source.
9. **A row no CI runs is not a test.** Opt-in probes live in `scripts/` or go (item 11).

The 13 archetypes and the ideal shape of each are in [Appendix B](#appendix-b-the-13-test-archetypes). Tonight's batches already apply rules 1, 3, 4 and 7 (#3206, #3208, #3211, #3212). The lint rule for rule 1 waits for the open PRs ([Queued](#queued-no-brainers-blocked-on-open-prs)).

**Size:** +30 doc lines. **Risk:** none. **Needs your decision:** approve the text.

## 3. Tests stop waiting out production timeouts

**Problem.** `pnpm test` has a floor of about 67 s. Two Workers rows wait out the real 60 s facet watchdog, five wait 30 s grant re-checks, and four `oauth-recheck-*` files exist only so those waits run in parallel. On preview, about 20 residency e2e rows wait a real 37–44 s quiet window, which sets e2e's 49–55 s wall. A test that copies a production constant pins the constant, not the behaviour.

**Proposal.** Make the watchdog, the re-check interval and the residency quiet window deployment configuration. The test worker (`wrangler.test.jsonc`) and the preview use 1–5 s. Keep one real-interval row among the opt-in slow rows or in Main OS e2e. Fold the four oauth-recheck files back into one table.

**Size:** about −40 lines and 4 files; `pnpm test` −25 s; Test job −10–20 s (needed for TTG < 170 s); e2e −20 s. **Risk:** preview timing differs from prd, which is why the real-interval row stays. **Needs your decision:** yes; it is deployment config.

## 4. prd's Durable Object cost alarm pages again

**Problem.** `scripts/ci/do-duration-alert.ts:54-62` sets prd's ceiling to 600 DO-hours an hour: about 100 of baseline plus about 540 for `os-next`, which no longer exists on the prd account. A sixfold regression today pages nobody, which the observability invariant forbids.

**Proposal.** Re-measure a few days of prd DO-hours (`do-duration-probe.ts --json`, or the alarm's thread), set the ceiling to about 2× the baseline, and drop the os-next sentence.

**Size:** ~4 lines. **Risk:** low; it may page once if the estimate is off. **Needs your decision:** the threshold.

## 5. A stale merge can't break main

**Problem.** #3188 was green against an older main. Its squash produced a lockfile pnpm rejects: 14 main workflows failed, and Deploy OS did not deploy, until #3195 eight minutes later. With many agents merging in parallel this will recur, and the lockfile is the likeliest file.

**Proposal.** Cheapest: `merges-with-main.ts` fails a PR whose `pnpm-lock.yaml` changed when main's lockfile has moved since its merge base (+30). The alternatives are the merge queue from #2955 or "require branches to be up to date"; both add rebase churn with parallel agents.

**Size:** +30. **Risk:** low. **Needs your decision:** pick one.

## 6. CI tooling diet: one telemetry record, one health job, no flake pipeline

**Problem.** CI and ops tooling is about 12k lines, plus about as much in tests: `scripts/ci`'s tests (12.3k) outweigh the scripts (11.8k). Three pipelines record overlapping per-test telemetry (CI traces, R2 Parquet evidence, PostHog), plus flake records and three flake sentinels. About ten scheduled workflows post to Slack. The flake dashboard was rewritten twice in 72 h (#2894 was 96% gone within 2 days). The flake pipeline is about 2,900 lines for **one** real `createFlake` test (`scheduled-appends-dormant.e2e.test.ts:27`), and `createFailing` already goes red when a pinned defect starts passing. Test telemetry has two homes: the Vitest reporter in shared and the Playwright reporter in `scripts/ci`.

**Proposal.**

- Keep one per-test record, the evidence Parquet (the dashboard already reads it). Derive or drop the traces viewer and the PostHog CI events.
- Delete `createFlake`, the sentinels, the dashboard and the flake-record plumbing. Fix the one flake or pin it with `createFailing`. `failing-test.ts` keeps only its own registration.
- Fold the guards that page on a change of state (pr-ttg, os-latency, main-e2e-alert, do-duration) into one scheduled health job with one state artifact. Keep the prd fault alarm and the DO cost alarm separate.
- Drop the daily shadcn-upstream "news" post; keep `check` on PRs that touch vendored files.
- Delete tests that pin a doc table to code (`test-results-parquet.test.ts:190`), env knobs nothing sets (`TEST_TELEMETRY_APP`), and incident-dated rows in the CI-script tests once their class is fixed at the root.
- Move scheduled monitors to `scripts/monitors/`.
- If the Playwright telemetry reporter survives, give its test one fake-run builder; otherwise skip that.

**Size:** −4k to −6k (the flake pipeline alone about −2.5k). **Risk:** medium; you lose a page or dashboard you actually read. **Needs your decision:** say which pages and dashboards you use.

## 7. Stop committing the browser extension's capnweb copy

**Problem.** `apps/browser-extension/capnweb.js` is a 3,739-line verbatim copy, refreshed by hand (#3141), and a Python script zips it from the spa build. The spa and the extension also hand-roll the same OAuth PKCE code.

**Proposal.** Give the extension a `package.json` whose build copies capnweb from `node_modules` into `dist/` and zips it with Node; gitignore the copy. Optionally share one `oauth.js`.

**Size:** −3,739 committed lines, plus about −60. **Risk:** low; "load unpacked" points at `dist/`. **Needs your decision:** a nod.

## 8. Retries: settle two rules, then one failure module

**Problem.** There are 15 hand-written retry or re-dial loops on 13 delay schedules, and 8 predicates for "is this the platform's failure". workerd marks errors `retryable` (DISCONNECTED), `overloaded` (don't retry now) or `remote` (the far side's own code threw). We read only `retryable`, and only one loop has jitter. Two rules contradict each other:

- **Deploy resets.** The edge deliberately does _not_ repeat a read a deploy cut (`iterate-context.ts:236-257`, pinned by `iterate-context.test.ts:122`). The same `itx.facets.get(x).snapshot()` _is_ repeated from oauth, a `cd` fetch, the worker loader and the lease. The only stated reason is log naming.
- **Storage-timeout resets.** workerd throws these as OVERLOADED, and Cloudflare and capnp both say never to retry those at once. The edge does; `d1Fault` says never.

**Proposal.** The full model is [Appendix A](#appendix-a-one-failure-model).

1. **Decide:** (a) repeat a deploy reset once for idempotent calls everywhere, logged `<area>.deploy-reset-retry` at info; (b) an overloaded failure is never repeated at once: answer 503 with `Retry-After` and let a durable ladder retry.
2. **Then** one module (`packages/shared/src/platform-retry.ts`) with `failureKind()` (refused, deploy-reset, disconnected, overloaded, failed), `httpFailureKind()`, named jittered schedules and one logged give-up. It absorbs `retryable-error.ts`, `d1Fault`'s table, the facet, artifacts, browser and git-wire predicates, `cloudflare-429-retry.ts` and the six script HTTP loops.
3. One `contextStub()` wrapper applies the policy at the stub layer, so a call gets one policy whichever hop makes it.
4. One written policy under "Failures and retries" in `docs/engineering-invariants.md`, and one event naming rule, `<module>.<outcome>`.

#3209 landed the safe first step: one HTTP classifier for the CI scripts (a 429 now repeats in Depot and fault-alarm reads too), and the artifacts and browser loops go through `retryPlatformFailures`. The fresh-stub helper waits for rule (a). The two close-code policies (`sendableCloseCode` → 1000, the lease's `relayCloseCode` → 1011) still need one decision (item 20).

**Size:** −300 to −400 for the module, −150 to −200 for the scripts' HTTP loops, −40 for the stub layer. **Risk:** medium; retry behaviour changes in about 10 places, each with a test to update. #3165 touches `erase-data.ts` and `deploy.ts`. **Needs your decision:** the two rules.

## 9. Pin Cloudflare's coming platform DO retries, then delete ours

**Problem.** workerd merged platform-level Durable Object retries on 2026-09-17..25, behind autogates: 5 attempts, a 10 s cap and full-jitter 0.5–2 s backoff, only for calls never delivered to the object. When they turn on they stack on our own repeats (up to 10 attempts). They also make the `READ_CALLS` allow-list and the relend retry unnecessary.

**Proposal.** Add a slow `createFailing` test that an undelivered DO call is retried by the runtime. It goes red when the gate ships; then delete `READ_CALLS`, `isIdempotentItxCall` and the relend retry, and set `retryPolicy` if wrangler exposes it.

**Size:** +30 now, −80 later. **Risk:** low. **Needs your decision:** no.

## 10. D1 is the only source of truth for orgs and projects

**Problem.** Every org and project verb writes the D1 row, then appends facts to the org's and each member's account stream, then waits for the fold, because the dash renders the fold. `session.ts:220` admits "the fold can settle opposite to the database's own order". At least five PRs in 72 h fixed this dual write (#2988, #3045, #2872, #3113, #2993).

**Proposal.** The dash reads orgs, members, invitations and projects from `/api` (D1 already has the queries). The streams stay as activity logs; a fact there only invalidates the dash query. Delete the duplicated fold state, the fold wait on every org verb, `landProjectOnOrganization` and most fact builders, including the single-use ones.

**Size:** −500 to −800, a bug class, and a wait on every verb. **Risk:** medium; it changes what the dash reads. **Needs your decision:** yes. **Blocked by:** #3190 (`session.ts`).

## 11. Delete tests no CI runs, and tests that pin implementation

**Problem.**

- About 420 lines of e2e probes are gated on env vars nothing sets: `RUN_FACET_ABORT_REPRO` (a whole 275-line file), `RUN_WAKE_LOOP_PROBE` and `RUN_SELF_LOOP_PROBE`. That breaks testing.md's "no variable without a real setter". (`RUN_RESIDENCY_TIMING` does have a setter, `os-e2e-soak.yml`'s `residency-timing` input, and #3165 keeps it; its rows are a soak tool, not dead.)
- Several tests assert implementation: two files agreeing on a compat date (`wrangler-config.test.ts`); a regex import-graph check over source (`library.test.ts:1127`), which belongs in an oxlint zone; a copied `EVENT_CHUNK_SIZE`; console wording in `d1.test.ts`.
- `secrets.e2e.test.ts:444` re-runs over the wire 10 HMAC cases the unit kernel already covers.

**Proposal.** Move the probes to `apps/os/scripts/probes/` or delete them. Make one of each agreeing pair the source; move the boundary check to lint. Keep one pass, one fail and the edge cases in the e2e.

**Size:** about −650. **Risk:** low; the probes are investigation tools someone may want. **Needs your decision:** a nod.

## 12. Your 30-minute cleanup outside the repo

Agents never delete Workers, so these wait on you. Each one unblocks a compat deletion.

- **Cloudflare, dev account:**
  - the `os-preview` Worker, 30 `os-preview-*` KV namespaces and 15 R2 buckets;
  - the old `agents-preview`, `dash-preview`, `kit-preview`, `notes-preview` and `voice-preview` parents;
  - repro Workers `alarm-loader-facet-repro`, `alarm-move-earlier-repro`, `do-alarm-held-repro` and `fresh-preview-repro` (check first that no pin still needs them);
  - `iterate`, `captun`, `captun-public`, `super-ninja` and `pr3165-fc659e6-*`, which the repo doesn't name.

  That unblocks deleting `FORMER_PARENT` and preview-sweep rule 7 (−45).

- **Cloudflare, prd account:**
  - `cf-artifact-viewer-prd` (still binds `os-prd-repos`);
  - `alarm-loader-facet-repro`, `captun-public`, `revhub` and `tunnels-prd`, which the repo doesn't name;
  - an orphaned DO namespace owned by `iterate-service-workflow-agents`.

  That unblocks dropping the `artifactsNamespace` special case at the next prd recreate.

- **Doppler:**
  - copy Exa and Parallel into `os`;
  - put the GitHub App id and key where the flake-dashboard job can read them (they are byte-identical to `os/prd`'s);
  - then retire `os-legacy-2026-04` and `os-legacy-backup`;
  - delete the leftover `dev_jonas`, `dev_misha`, `dev_rahul`, `dev_personal` and `stg` configs, which the docs say don't exist.
- **PostHog:** delete or rebuild dashboards 839069 and 839068, which are built on pre-#2494 events.
- **Old checkouts:** check the MacBook's `~/src/github.com/iterate/iterate` (and ask teammates) for an `.alchemy/` folder. Once none holds one, drop `.alchemy/` from `.gitignore` (−3). Review of #3205 took this out of the batch: the folder held local dev secrets, the repo is public, and the audit checked only the Beelink's checkouts, so removing the line first would let `git add -A` commit someone's secrets.
- **Provider consoles (optional):** re-register the Slack, Google and GitHub callbacks and webhooks on one reserved prefix such as `/.integrations/<provider>/…`. That ends "legacy URL" routing under `/api`. Medium risk: it must ship together with the deploy.

**Size:** unblocks about −100. **Risk:** low. **Needs your decision:** only you can do it.

## 13. Platform facts are silently dropped on every deploy

**Problem.** `session.ts:437-470` warns and drops a platform fact whose append a deploy or transport cut interrupted (`session.platform-fact-cut`). The facts are unkeyed, so a repeat could duplicate them. The event name is neither `platform-failure-*` nor `deploy-reset-*`, so the fault alarm never counts it. The invariant says no silent data loss.

**Proposal.** Key the facts by the ids that already exist (sign-in, mint, consent), then route them through the one repeat. If item 10 lands, these become activity-log entries and matter less.

**Size:** ~0. **Risk:** low-medium. **Needs your decision:** no.

## 14. Fold the admin app into dash

**Problem.** Admin is a whole deployable (Worker, workflow, `envs.ts` block, Doppler project, OAuth client, preview and spec) for three pages. Since #3163 an admin can act as anyone in dash from the consent page, and admin's project explorer route duplicates dash's `contexts.$` route.

**Proposal.** Three `admin`-scope routes in dash (global contexts, all users, all projects); retire the admin app. The minimum alternative is one shared `ProjectContextExplorer` (−120).

**Size:** −500 to −700 lines, one Worker, one Doppler project and one OAuth client. **Risk:** medium; `admin.iterate.com` was a deliberate choice. **Needs your decision:** yes, product.

## 15. Session replay masks every input

**Problem.** Replays record typed text on purpose, and then about 1k lines try to catch every secret: a word-list heuristic, key-prefix regexes, a custom `maskInputFn` and a 304-line lint rule (#3067).

**Proposal.** PostHog's default `maskAllInputs: true` with no `maskInputFn`. Keep the `ph-no-capture` blocks for secrets rendered on screen, and the invite-link redaction.

**Size:** −800. **Risk:** low technically; replays stop showing typed non-secret text. **Needs your decision:** yes, product.

---

## The rest, ranked

### 16. A client-app kit and one app registry

- **Problem:** six apps copy the same shell (router, server entry, root, auth, index and projects routes, vite config, `app.ts`), about 1,700 lines. `router.tsx` is byte-identical in three apps. Adding an app edits 13+ files. The six `deploy-<app>.yml` files are identical apart from the name, and the five client blocks in `envs.ts` differ only in name and URL.
- **Proposal:**
  - `@iterate-com/ui/apps` gets `startAppServerEntry`, `createAppRouter`, `appRootRoute` and `authRoute`; each route file becomes 3 lines.
  - One map in `envs.ts` drives `FIRST_PARTY_APPS`, the preview `APPS`, the `urls` keys, knip and preview paths, plus a `startAppEnvs(name, { prdBaseUrl })` helper.
  - One reusable deploy workflow (first prove Depot runs local reusable workflows).
- **Size:** about −800 to −1,100; a new app goes from 13+ edits to about 4.
- **Risk:** medium; SSR and hydration for every client.
- **Needs your decision:** yes, for `envs.ts`.
- **Blocked by:** #3165.

### 17. Type the e2e and Workers harness, and the operator scripts, with `iterate/api`

- **Problem:** `openItx(): any`, `openSession(): Promise<any>` and `readAll(): any[]` mean the tests that exist to prove the published API don't compile against it.
- **Proposal:**
  - Type the harness with `newWebSocketRpcSession<IterateApi>`.
  - Make `iterate/api`'s types load without workers-types, so the seven operator scripts, `getin` and the voice tools can use `connectIterate` instead of hand-built capnweb sessions with casts. Then move the voice tools to `apps/voice/scripts`.
- **Size:** hundreds of `any` gone; about −120 lines in scripts.
- **Risk:** medium; it may surface real contract gaps.
- **Needs your decision:** no.
- **Blocked by:** #3190, #3186.

### 18. `depot-workflows.test.ts` keeps only invariants

- **Problem:** 1,215 lines and 64 tests, many restating the YAML: step names, a regex on a config's indentation, "names its checks as Preview OS does".
- **Proposal:** keep the cost and security invariants as for-every-workflow rules (only `DOPPLER_TOKEN` is stored, a job-scoped GitHub token, firmware publishing runs no repo code); delete the pins.
- **Size:** −600 to −800.
- **Risk:** some pins caught real regressions.
- **Needs your decision:** yes.
- **Blocked by:** #3165.

### 19. dummy-petshop: trim it, and give each preview its own

- **Problem:** a 6.3k-line fake with 2.5k lines of tests of itself. It re-implements a fake OAuth server five times. One shared Durable Object failed about 25 e2e rows in every run for two hours on 09-25.
- **Proposal:** after #3190 removes lends, delete the fakes and test-control routes no e2e row calls, and reduce the self-tests to sealing and state units. Add one `fakeAuthorizationServer()`. Give each preview its own petshop, or a DO per run id. Also re-audit the integrations code for lend-only paths, and split the 996-line dash integrations route.
- **Size:** about −1,650, and +40 for per-preview.
- **Risk:** low-medium.
- **Needs your decision:** no.
- **Blocked by:** #3190.

### 20. Tunnel sockets surviving a deploy

- **Problem:** #3093 built a custom seq/ack/resume wire (about 1.3k lines with tests) so dev-tunnel HMR sockets survive `os-prd` deploys (52 deploys in one day). Two server-side re-dial loops have different schedules and deploy logic. Close codes follow two opposite policies (1006 → 1011 in the lease, → 1000 in three other paths).
- **Proposal:** deploy prd less often and delete the splice, accepting a reconnect on deploy; or keep it and record the decision. Either way, one `redial()` and one close-code policy (1011 for an abnormal drop).
- **Size:** −1.3k if deleted; −70 otherwise.
- **Risk:** medium; HMR state is lost on deploy.
- **Needs your decision:** yes.

### 21. Docs diet

- **Problem:** CI and test docs are 3,127 of 9,553 markdown lines (33%), mostly incident stories with Depot run ids. Previews are described in five docs. The slow-row rule is written five times, and the flake docs live in four places. There are four style docs. `specs/AGENTS.md` is 1,054 words. `apps/os/README.md` carries 186 lines of integration API reference. `testing.md` holds a "DRAFT, under discussion" section.
- **Proposal:**
  - Keep rules, commands and what-to-do-when, with one line of evidence per PR number.
  - One preview doc after #3165, and one style doc.
  - Move the README's integration reference to `apps/os/docs/integrations.md` after #3190.
  - Move the DRAFT section's open questions here.
  - Trim the recreate-production skill against `project-seeds.md`, keeping every "never" line.
  - Keep test-evidence.md's "Setup" (the only runbook for the R2 bucket's hand-applied lifecycle rules) and its cost basis until item 6 is decided.
- **Size:** about −2,700 doc lines.
- **Risk:** low.
- **Needs your decision:** yes, for how much rationale docs keep.

### 22. Test structure

- **Proposal:**
  - Fold the 17 incident-named facet Workers files into `facets.test.ts` rows with one `sources.ts` (−400).
  - Unify the fixtures: StreamEvent builders ×8, fake `itx.ai` ×10, `publishConfigWorker` ×2, 29 hand-rolled `mkdtempSync` (−250 to −300).
  - One root vitest config with `projects` instead of 13 (−100); it also ends the relative imports of shared's reporters.
  - Rewrite `agent-ui-reducer.test.ts`, 1,666 lines with no tables (about −660; after the authority work).
  - Question memory-budget's control rows (−300 lines and −10 s).
  - A policy for fixed sleeps and `toBe(true)`; spell test support one way (it is spelled seven ways today); settle the unit/e2e fixture layering.
- **Size:** about −1,700.
- **Risk:** low-medium.
- **Needs your decision:** no, beyond item 2.

### 23. An `UNAVAILABLE` error code, and one meaning for `retryable`

- **Problem:** `ControlPlaneUnavailableError` crosses `/api` with no code, against lib.ts's own rule. Two 503 answers disagree (Retry-After 60 vs 1). `retryable` means three things: workerd's DISCONNECTED, the control plane's "send again", and our own "halt now".
- **Proposal:**
  - Add `codedError("UNAVAILABLE", …, { kind, retryAfterMs })` and one edge mapping to 503 or 502.
  - "Halt now" becomes a documented code.
  - The control plane's deadline uses `withTimeout`.
  - The processor's checkpoint latch keys on its own code.
- **Size:** about −40.
- **Risk:** medium; `ErrorCode` is published SDK API.
- **Needs your decision:** yes.

### 24. The prd fault alarm classifies less, the platform classifies more

- **Problem:** `prd-fault-alarm.ts` (980 lines plus a 1,402-line test, 21 commits in a week) un-counts expected 502/503s by message and ray id across four hops. It also splits queries past a 16-node filter limit.
- **Proposal:** internal hops return expected outcomes as coded values, and only the edge maps them to HTTP; a DO logs its own `deploy-reset` line.
- **Size:** −250 to −400.
- **Risk:** medium-high (paging coverage).
- **Needs your decision:** no, after item 8.

### 25. rpc-stubs' six recovery layers

- **Problem:** `rpc-stubs.ts` grew +1,631/−198 lines in 5 days. It now stacks the relend retry, the pager keepalive and re-dial, the liveness probe, the census un-set, lend-again, and splice resume.
- **Proposal:** draw the lend's state machine in the header, then delete the layers the others cover, proven with the existing Workers tests. Split the file's four sections.
- **Size:** −100 to −300.
- **Risk:** high.
- **Needs your decision:** no.

### 26. The Worker Loader clone-version defect in one place

- **Problem:** three recoveries with different bounds: facet-host `#recover`, the workers.get replay and the loader-id retire.
- **Proposal:** one "retire and replay once" in `worker-loader.ts`. Since #3209 the fault alarm posts once either heal has gone 28 days unused, so the workaround says when it can go.
- **Size:** −40.
- **Risk:** low.
- **Needs your decision:** no.
- **Blocked by:** #3190, #3200.

### 27. The control-plane edge memos

- **Problem:** five per-isolate memos and a 3 s deadline were built for the retired DO singleton. They carry caveats ("a memoized row stays until the isolate goes"), and three of them never sweep.
- **Proposal:** measure uncached D1 reads, then drop the memos, or use D1 read replication with `withSession`.
- **Size:** −100 to −150.
- **Risk:** medium (latency).
- **Needs your decision:** no.
- **Blocked by:** #3190.

### 28. Split the oversized files; give `apps/os/src` folders

- **Problem:** `built-ins.ts` is one 1,200-line function; `session.ts` holds seven RPC classes; `iterate-context-durable-object.ts` is 1,548 lines; `preview.ts` is 1,425. `apps/os/src` has 67 flat files, about 20 of them sign-in files with no folder.
- **Proposal:** split them, and add `issuer/`, `secret/`, `library/` and `context/` folders.
- **Size:** 0 lines.
- **Risk:** conflicts with nearly every apps/os PR; do it when the queue is empty.
- **Needs your decision:** when.

### 29. Integrations: one provider list and one provider table

- **Problem:** the provider list is spelled about 12 times, and the disconnect tail is repeated in five providers.
- **Proposal:** publish the provider types once from `iterate/api`; add one `{ connect, finish?, revoke? }` table.
- **Size:** −70.
- **Risk:** low.
- **Needs your decision:** yes; a shared tail builds the event type from a parameter (`${provider}/connected`), which is the generic-mechanism exception to spelling event types inline.
- **Blocked by:** #3190.

### 30. Two ways to sign someone in with one click

- **Problem:** HMAC test links in public PR bodies with a prd-admin round trip (#2966, #3158) sit beside #3163's audited impersonation. That is about 750 lines together. One `act_as` assertion in `admin-and-impersonation.test.ts:213-218` stays until this is decided: it pins that an `act_as` on the public authorization URL makes nobody act as someone else.
- **Proposal:** trust a prd admin sign-in plus impersonation on previews, or post the link somewhere private.
- **Size:** −300 to −600.
- **Risk:** medium, security-sensitive.
- **Needs your decision:** yes.

### 31. Userspace, after the authority redesign

- **Problem:**
  - The entity lifecycle exists twice, and the copies diverged: agents never got the sliced terminal wait that fixed 3 of 8 failed creations (−200, published SDK surface).
  - The agents UI parses events by hand instead of with `AgentContract` (−150; it also covers the agents `isRecord` and `formatClockTime` copies).
  - The installers duplicate the cache key and the folder commit.
  - `install-packages.ts` is a one-shot migration that breaks the trpc-cli rule (−103; the authority design also names it).
  - The agents LLM retry pauses only after `maxAttempts`, even on a 401.
  - The ai-transport workaround has no `createFailing` pin.
  - The agents e2e tests live in the web app.
  - Two dated `test.skip`s in `control-plane-contexts.test.ts` (revisit by 2026-11-15) record open authority gaps: a client calling the account facet's `processEventBatch`, and a user subscribing to another user's log through the pager.
- **Proposal:** each fix above, the partner-stream fakes as rows, and one agents e2e support file. The redesign decides whether the two gaps are fixed or the skips renewed.
- **Size:** about −600.
- **Risk:** medium.
- **Needs your decision:** the agents package owner's.
- **Blocked by:** #3186 and the authority redesign.

### 32. Kit firmware and voice legacy

- **Proposal:**
  - Reinstall voice on templestein and iterate, then drop `screen.status()` in the next firmware release.
  - Drop or rename the misleading `spkDrops` counter.
  - Rename `voice-agent/spk-frame` and `conversation-ended` in firmware and platform together.
  - Then decide whether `screen-context-repro.json` can lose its two ~10 KB guides; today `agent.test.ts` keeps the context verbatim because the September 21 bug dropped the supplied Markdown.
- **Size:** about −30.
- **Risk:** low; it needs a firmware release.
- **Needs your decision:** yes.

### 33. Menu bar dead approval code

- **Problem:** about 420 lines of Swift, the signing path, entitlements and a README paragraph are dead.
- **Proposal:** delete them.
- **Size:** about −450.
- **Risk:** it only compiles on a Mac, and nothing here can run `swiftc`; it needs one `./build-menubar-app.sh`.
- **Needs your decision:** no; needs a Mac.

### 34. Process

- **Proposal:**
  - A one-page decision note before a storage, routing or CI-gate redesign, plus one "current design" line per concept in `apps/os/AGENTS.md`. The control plane went through five storage designs in 72 h, project routing took five PRs, and about 41k lines were written and deleted inside the period.
  - Cap PR bodies at a summary, a risk map and a lines table. They average 14 KB, and #3063's is 53 KB.
  - Attach images with `gh --attach` instead of committing `docs/pr-assets` (#3205 deleted the last four).
  - Decide the `tasks/` convention: #3165 and #3168 both add plan files, and `tasks/complete/` holds one. Then keep or delete them together.
  - Write down "pre-commit hooks stay format-only".
  - Commit the `pr-wait` script agents keep in a scratchpad.
- **Size:** docs only.
- **Risk:** none.
- **Needs your decision:** yes. `docs/pull-requests.md` is hash-gated, so batch its edits.

### 35. Smaller structure

- **Proposal:**
  - Vendored shadcn moves to `components/shadcn/`, so one glob replaces a list copied into 10+ places and its sync test.
  - The OS Worker config becomes one TypeScript object like every other Worker's (after #3165).
  - Preview tooling moves to `scripts/preview/` (after #3165).
  - Userspace examples get one home.
  - One lint rule per file.
  - One name for the OS base URL (`DEMO_BASE_URL` vs `WORKER_BASE_URL`).
  - `os` becomes `@iterate-com/os`.
  - `pnpm-workspace.yaml` lists 19 workspaces one by one; globs need glob expansion in `unitTestWorkspaces` and `depot-workflows.test.ts:83` first.
  - `scripts/ci/context-sweep.ts` becomes a trpc-cli program that throws instead of setting `process.exitCode`, so the scheduled prd sweep still goes red.
- **Size:** about −180.
- **Risk:** low each; many touch files open PRs edit.
- **Needs your decision:** yes, for the env var rename.

### 36. Refuse unknown `APP_CONFIG` keys

- **Problem:** stale Doppler keys are warned about and dropped, so drift persists in every deployment's config.
- **Proposal:** list today's warnings, clean Doppler, then make an unknown key a parse error.
- **Size:** about 0; it is a policy change.
- **Risk:** a stale key fails a deploy loudly.
- **Needs your decision:** yes (Doppler).

### 37. Notes proxy spec

- **Problem:** Notes is not base-path aware under a proxied project path (issue #2908).
- **Proposal:** make Notes base-path aware, or run the spec only where `subdomains` holds.
- **Size:** small.
- **Risk:** low.
- **Needs your decision:** yes, product.

### 38. Deploy shape

- **Problem:** "WebSocket connection failed." and "code was updated" still fail an e2e row on the first attempt in 4% of runs after #3069.
- **Proposal:** this is already parked with you (A in-place redeploy plus hold, B a fresh preview per push, C the version gate). #3165 moves toward B. The report should show the per-shape flake rate beside TTG.
- **Needs your decision:** yes, already parked.

### 39. Optional: `assert` in the remaining firmware tests

- **Proposal:** replace `CHECK(`/`check(` with `assert(` in 8 firmware tests (about 360 call sites, −70 lines of macros). The macros already abort exactly like `assert`.
- **Size:** −70.
- **Risk:** none.
- **Needs your decision:** no.

### 40. Whole `$name` titles in every table

- **Problem:** Vitest prints a `$field` title through loupe with `chaiConfig.truncateThreshold` (default 40), so a longer row name is quoted and cut with `…` (`@vitest/runner` 4.1.11, `formatTitle`). #3211 kept its new row names under 40 and runs `memory-budget.test.ts`'s rows through a `for … test(row.name)` loop only to keep its long titles whole. Tables already on main print cut titles.
- **Proposal:** one line per vitest config, `chaiConfig: { truncateThreshold: 0 }`. Then `memory-budget`'s loop can become `test.for`.
- **Size:** about +13.
- **Risk:** it renames every cut title, so test telemetry's per-test history breaks once for those rows, and it widens assertion-diff output.
- **Needs your decision:** a nod (telemetry history).

### 41. One `commit()` for the stream test fake

- **Problem:** `memoryStream().stream.append` is typed as `ProcessorStream`'s `Promise | StreamEvent[]`, so `processor.test.ts` and `processor-rules.test.ts` each keep a 3-line `commit(mem, …events)` that casts to `StreamEvent[]`.
- **Proposal:** narrow `memoryStream`'s own `append` to the synchronous array, deleting both helpers and their casts.
- **Size:** −10.
- **Risk:** it changes the declared type of the published `iterate/stream/test-support` entry.
- **Needs your decision:** yes (published type).

### 42. A preview's Artifacts namespace can fail to create

- **Problem:** on #3204's first Deploy preview, `POST /artifacts/namespaces` answered 409 with code 10306, "Namespace activation is already in progress", after about 20 s. `ensureArtifactsNamespace` (`apps/os/scripts/preview-artifacts.ts:55`) models only the 404 on its read, so the deploy failed; re-dispatching Preview OS passed. The invariant counts this as an open error.
- **Proposal:** model 10306 as "the create is still settling" and read the namespace again for a bounded time, with a unit row for it.
- **Size:** about +10.
- **Risk:** low.
- **Needs your decision:** no.

### 43. `subscribeToNothing` stays two one-liners

- **Problem:** exporting the palette's `() => () => {}` so `app-shell.tsx` could import it adds an export to `@iterate-com/ui/components/app-shell-palette` (every `components/*` file is a package entry) and ties the shell to the palette, for a net of 0 lines. It was reverted when #3210 landed.
- **Proposal:** leave it. If a shared copy is wanted, it belongs in a `lib/` module both files import.
- **Size:** 0.
- **Needs your decision:** no.

### 44. The manual restores the config left behind

- **Problem:** #3212 makes every vitest config restore spies, stubbed globals and env before each test. About 35 manual restores remain: trailing `spy.mockRestore()` / `vi.unstubAllGlobals()` lines and `try { … } finally { spy.mockRestore() }` wrappers (`session.test.ts`, `subscription-delivery.test.ts`, `fetch-upgrade-splice.test.ts`, `worker.test.ts`, `erase-data`, `preview-artifacts`, `preview-readiness`, `lib.test.ts`, `record-pipelined-steps.test.ts`, `failing-test.test.ts`, `device-auth.test.ts`, `socket.test.ts`). The four vitest flags are also spelled in 13 configs (about 60 lines).
- **Proposal:** read each restore and delete it unless a later step of the same test needs the original back (the mid-test restores in `oauth.test.ts` and the `oauth-recheck-*` pair do). Optionally, one exported `unitTestOptions` beside `vitestReporters` holds the four flags once, at the cost of one more indirection per config.
- **Size:** about −80.
- **Risk:** low.
- **Needs your decision:** no.

---

## Queued no-brainers blocked on open PRs

These are safe and mechanical but edit hunks an open PR rewrites. Land them as follow-up batches once that PR merges.

**After #3165** (plain-Worker previews):

- Delete `apps/os/scripts/control-plane-load.ts`, its package script, knip entry and perf comment (−177). Consider deleting `apps/os/bench` too, which runs in no CI (−350).
- One `preview-integrations.ts` instead of four one-constant files (−35); #3190 also touches the e2e that imports them.
- Move `slugify` into `specs/test-support/screenshot.ts` and drop the shared export (`preview.test.ts:609` names the file).
- Collapse the six `scripts/app.ts` and six client `vite.config.ts` into `start-app.ts` (−160).
- `apps/os/scripts/{deploy,ensure-resources,erase-data,preview}.ts` follow the script entry-point convention.
- Delete `allowDopplerConfigFallback`; the 7 deploy workflows pass `--env prd` (−23).
- Doc fixes in `testing.md` (lines 114 and 126 and the preview sections) and `depot-ci.md:865-873`; test tidies in `d1.test.ts` and `preview.test.ts:150`; the optional rename of the `AgentDurableObject` tombstone in `preview.test.ts`'s fixture (left out of #3204).

**After #3190 and #3200** (connect picker, `forCaller`):

- Move the fixture-slug helper out of shared; move `connect-button` to dash, or drop it.
- The fresh-stub repeat at the built-ins `cd` site and the smaller `facet-host.ts` and `built-ins.ts` tidies.
- `sha256Hex` once; one webhook verifier; the single-use fact builders (unless item 10 lands); `iterate-context-durable-object.ts`'s `rpc-stub-${kind}` (also check whether `itx/rpc-stub-attached` has any producer).
- The README's "seven mechanisms" line; rename `record-pipelined-steps.ts` to `with-itx.ts`.
- Two test tidies in the Workers files #3190 edits.

**After #3168** (kit): tidy `configuration_test.c` and `config-image.test.ts`.

**After #3186** (agents authority): the partner-stream fakes as rows, one agents e2e support file, the voice-tools README line, and `packages/agents` importing shared base64 (which also gives the published package its first source dependency on `@iterate-com/shared`, and the copy is chunked on purpose to avoid a call-stack overflow; decide with the redesign).

**After #3201** (`deployApp` takes the env it deploys; draft, stacked on #3165): one deploy CLI helper for `apps/dummy-petshop/scripts/deploy.ts` and `apps/ci-reports/scripts/deploy.ts`, which #3201 rewrites.

**After #3202** (a repo pulls and pushes its main to a remote):

- git-wire throws `HttpAnswerError` and also repeats an upload-pack read whose fetch rejected. #3202 rewrites `createGitWireTransport`'s `post` loop (it now sends through an injected `fetch`, the context's egress for a user's own remote), so re-derive it on #3202's code, and decide whether a network failure through egress to someone else's git host is ours to repeat.
- `FakeArtifacts` out of `e2e/support/fake-artifacts.ts`, which #3202 edits. Settle item 22's "spell test support one way" first.

**After #3165, #3168, #3186, #3190, #3200 and #3202 all merge** (lint rules; the repo keeps no grandfather lists, so each lands with its codemod):

- `iterate/prefer-test-for`. #3208's codemod skipped 26 `test.each` in files those PRs touch, so the rule would turn main's lint red today. Land it with a second codemod pass over those files. The same pass rewrites the 23 tuple tables #3208 left as tuples (11 with `as const`, 4 with a tuple type argument, kept only so `test.for` would not widen their columns) as object rows with `$field` titles that print the same names.
- `iterate/prefer-object-property-match` also covers `expect(a?.b)` and `expect(a["b"])`, with about 140 fixes. Read each site: a `toEqual` rewritten to `toMatchObject` stays green while it loosens (extra keys pass), so keep `-- exact:` disables where exactness is the point, and leave numeric indexes (`arr[0]`) out of the rule.

## Decided, no action

- **Preview D1 cleanup:** keep. It is live since #3145, not compat.
- **Kit `/.auth/login` and `/.auth/connect`:** keep the code; #3205 reworded the comment.
- **`FORMER_PARENT` and preview-sweep rule 7:** keep until item 12's cleanup.
- **`.alchemy/` in `.gitignore`:** waits on item 12's checkout check.
- **The `namespace:` log field:** keep. Its value varies (`iterate-context`, `rpc-stubs`, `subscription-delivery`) and tells a reader of Workers Logs which Durable Object a context name belongs to.
- **`deploy-helpers.ts:194-196` and the `SLACK_PR_DASHBOARD_STATE` notes in `depot-ci.md`:** keep; they record what did not work and why.
- **`silent: "passed-only"` in apps/os's e2e and perf projects:** not set; passing perf rows print the `[latency]` lines people read.
- **PostHog CI delivery through the shared classifier:** not done. Today's loop repeats a timeout too, and PostHog dedups a repeated batch; item 6 may drop these events anyway.
- **Kept on purpose:**
  - contract `version` bumps;
  - `previousKey` secret rotation;
  - the 10061 preview recreate;
  - previews' `migrations` entry (the pinned wrangler predates `exports`);
  - petshop's legacy-login models;
  - dash `.default()` readers (deploy skew);
  - D1 migrations 0000–0001;
  - entrypoint re-exports.
- **Informational:**
  - knip is clean on main;
  - the 29 exports only tests import are legitimate;
  - exact copy-paste is 0.76% of lines.

---

## Appendix A: one failure model

This is the proposal behind items 8, 9, 23 and 24, from the audit of `18adc4f21`. #3209 has since landed the first step for the scripts.

**What exists.** 15 hand-written retry or re-dial loops on at least 13 delay schedules. 8 predicates decide what a "platform failure" is, and 3 more decide what a "deploy reset" is. Only the subscription-delivery ladder uses jitter. Nothing in apps/os reads workerd's `overloaded` or `remote`. No client reads `retryable` or `waitedMs`, though both cross `/api`.

**What the primary sources say.**

- **Cloudflare's Durable Objects error-handling guide:** `.retryable` errors may be retried "if requests to the Durable Object are idempotent"; `.overloaded` "should not be retried … retrying will worsen the overload"; `.remote` means the exception came from the object's own code. Use exponential backoff with jitter, capped, and a new stub after an exception.
- **capnp's `Exception.Type`:** FAILED would fail again unchanged. OVERLOADED, including a timeout, "should NOT retry again immediately". DISCONNECTED: rebuild the capability and retry, and treat a second DISCONNECTED while doing so as OVERLOADED. That is exactly "one immediate repeat on a fresh stub, then back off".
- **workerd:** a DO storage-timeout reset is thrown as OVERLOADED (`io/worker.c++:3736`), so JS sees `overloaded: true`, not `retryable`. workerd never sets `retryable: false`.
- **workerd's platform retries** (`api/actor-call-retry.{h,c++}`, autogates `DURABLE_OBJECT_RETRIES_*`, 2026-09-17..25): DISCONNECTED only, only when the request never reached the actor; 5 attempts, 10 s, full jitter 500 ms to 2 s.

**The model.** Every failure is one of five kinds. The hop that first sees it decides the kind, and the kind rides as own properties, which both Workers RPC and capnweb preserve.

| Kind           | Recognized by                                                                                                        | Retry at this hop                                                                             | Answered as                              | Logged                                                                |
| -------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------- |
| `refused`      | a `code` from `ErrorCode` (an expected outcome)                                                                      | never                                                                                         | 4xx or a typed answer                    | never as an error                                                     |
| `deploy-reset` | workerd's flag plus the "code was updated" message                                                                   | once, at once, on a fresh stub, only if idempotent                                            | 503 + `Retry-After: 1` if it still fails | `<area>.deploy-reset-<action>` at info                                |
| `disconnected` | workerd `retryable: true` without `remote: true`; an HTTP network error or 5xx; Artifacts 10400; Browser 6002        | once at once on a fresh stub (RPC), or the CI schedule with jitter (HTTP), only if idempotent | 503                                      | `<area>.platform-failure-<action>` warn, which the fault alarm counts |
| `overloaded`   | workerd `overloaded: true` (including the storage-timeout reset); D1 "overloaded"; HTTP 429 or 408; our own deadline | **never at once**: only a durable ladder, or the caller after `Retry-After`                   | 503 + `Retry-After`                      | `<area>.platform-failure-<action>` warn                               |
| `failed`       | everything else, including "internal error; reference"                                                               | never, except a named workaround with a `createFailing` pin                                   | 500                                      | `reportIssue`                                                         |

**Rules.**

- **R1. Retry at the hop nearest the failure.** A `retryable` error that also carries `remote: true` already had its repeat one hop down, so it is not repeated again. The edge is the exception. This stops retries multiplying across hops.
- **R2. Idempotency decides whether a repeat is allowed; the kind decides when.** Idempotent means a read, a keyed durable append, a GET or HEAD with no body, an HTTP `PUT`, `PATCH` or `DELETE`, or an explicitly listed route.
- **R3. Schedules come from a short named list, not from each call site.** `ONCE_ON_FRESH_STUB = [0]`, `UPSTREAM_ONCE = [1000]`, `CI_HTTP = [2000, 5000, 10000]`, `RECONNECT` (exponential from 250 ms, capped at 8 s, with a deadline) and `DURABLE_LADDER` (1 s·2ⁿ, capped at 30 min). Every schedule but the one-shot is jittered, and every schedule ends in a bound and a logged give-up.
- **R4. Delete the in-call retries once workerd's ship.** Pin it with a `createFailing` check that the platform retries an undelivered call (item 9).
- **R5. Never invent a flag value workerd does not use.** "Never retry this" is a `code`, not `retryable: false`. "Unavailable" is `code: "UNAVAILABLE"` with `data: { kind, retryAfterMs }` (item 23).

**The module.** `packages/shared/src/platform-retry.ts`, already imported by apps/os and the scripts, grows `failureKind(error)`, `httpFailureKind(responseOrError)` (reading `Retry-After`), a `retryPlatformFailures(attempt, { area, action, schedule, idempotent })` that never repeats an overloaded failure at once, and a `fetchRetryingPlatformFailures` for scripts with a per-attempt timeout. It deletes `apps/os/src/retryable-error.ts`, `scripts/lib/cloudflare-429-retry.ts` and its tests, the test-evidence and PostHog loops, five hand-rolled one-repeat blocks and the ad hoc error classes #3209 did not already remove.

**The written policy.** About 25 lines under "Failures and retries" in `docs/engineering-invariants.md`: the table, R1–R5 and the four source links, linked from lib.ts's error-channel comment and from `platform-retry.ts`.

## Appendix B: the 13 test archetypes

The ideal shape of each, which the style guide in item 2 generalizes. Counts are from the audit of `62fc2273b`, before tonight's batches.

| #   | Archetype                                         | Lives in                                                                                                       | Ideal shape                                                                                                                                                                                            |
| --- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A1  | Unit kernel, pure function (114 files, 33k lines) | `src/**/x.test.ts` beside the source                                                                           | One `test.for` of object rows `{ name, …inputs, …expected }`, titled `"$name"`, one assertion body, the expected value a literal in the row. Inputs of a wide type come from one typed builder.        |
| A2  | Processor or reducer                              | `processor.test.ts`, `agent-ui-reducer.test.ts`, `core-processor.test.ts`                                      | Rows of `{ name, events, expected }`. Events come from short builders at the bottom (`userSays("…")`), never 12-line literals. Engine rules get the re-reduce row.                                     |
| A3  | Harnessed engine, stateful unit                   | `rpc-stubs.test.ts`, `library.test.ts`, `worker-loader.test.ts`                                                | One typed builder per collaborator, with defaults, casting at most once inside the builder. Tests pass only what differs.                                                                              |
| A4  | Workers (72 files, 17k lines)                     | `apps/os/__workers-tests__/<topic>.test.ts`                                                                    | Only cases that need `cloudflare:test` controls. Typed readers (`readLog`, `snapshot`) instead of `invoke([...]) as {...}`. Deadlines injected, not waited out. Files named by topic, not by incident. |
| A5  | OS e2e (67 files, 17k lines, 0 tables, 155 `any`) | `apps/os/e2e/<topic>.e2e.test.ts`                                                                              | One story per test, because setup is expensive. A test owns its project. Assert whole responses with `toMatchObject`. Gates come only from `support/project-host.ts`. Typed against `iterate/api`.     |
| A6  | Agents e2e                                        | `apps/agents/e2e/*.e2e.test.ts`                                                                                | A5, plus one scriptable fake `itx.ai` (frames, delays, failures) instead of a class per scenario; scenarios differing only in the fake are rows.                                                       |
| A7  | Browser specs                                     | `specs/<app>/*.spec.ts`                                                                                        | Already the best-shaped archetype. Playwright has no `test.for`, so a `for (const row of rows) test(…)` loop is the table form.                                                                        |
| A8  | Perf and bench                                    | `apps/os/perf/*.perf.test.ts`                                                                                  | Rows of `{ metric, load }`. Budgets live in `latency.ts`. Opt-in gates come from `project-host.ts`.                                                                                                    |
| A9  | CI script (50 files, 15k lines)                   | `scripts/**/*.test.ts`, `apps/*/scripts/*.test.ts`                                                             | Test the pure decision function with a table; fake IO through injected dependencies. No tests of argument parsing, log wording or another file's text.                                                 |
| A10 | Config conformance                                | `depot-workflows.test.ts`, `preview-os-workflow.test.ts`, `lint/oxlintrc-*.test.ts`, `wrangler-config.test.ts` | Only invariants that guard cost or security, each a for-every-workflow rule. No pins of step names, formatting or two files agreeing.                                                                  |
| A11 | Lint rule                                         | `lint/oxlint-plugin-*.test.ts`                                                                                 | `{ valid, invalid }` rows of template-literal sources (#3206 did this).                                                                                                                                |
| A12 | Test-infra self-tests                             | `packages/shared/src/test-support/*.test.ts`                                                                   | One typed fake-run builder per reporter.                                                                                                                                                               |
| A13 | Firmware host (CTest)                             | `apps/kit/firmware/tests/*_test.c`                                                                             | `<assert.h>` (CMake sets `-UNDEBUG`), shared capture fixtures in a header, no per-file assertion macros (#3211 did most of this; item 39 is the rest).                                                 |

**Fixture systems doing the same job**, which item 22 unifies: log readers (44 inline casts in Workers tests, fixed by #3212), three `cloudflare:workers` shims (#3212), about 8 StreamEvent builders, 10 fake `itx.ai` providers, 5 inline fake MCP servers in `library.test.ts` (#3211), 29 hand-rolled `mkdtempSync`, two `publishConfigWorker`, three `fetchReachesThisWorker`, five Counter/Tally facet sources, and 13 near-identical vitest configs.

## Appendix C: the shape of the repo

The shape the last weeks' PRs have been converging on (#3018 drew the SDK/platform line, #3146 cleaned up the monorepo, #3150 moved single-app code into its app, #3191 made agents and voice packages). Every "move" below is a place the tree does not match it yet.

| Kind                   | What it is                                                                                                                                                                                                                                                                                                                                                                                                          | Members                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| The platform           | `apps/os`: one Worker (TanStack Start and Vite) holding the issuer, `/api`, `/mcp`, ingress and every Durable Object. `src/` has one folder per durable entity (`<entity>/{contract,durable-object,processor}.ts`) plus `stream/`, `context/`, `control-plane/`, `integrations/` and `library/`. Its suites are `e2e/`, `__workers-tests__/` and `perf/`; its programs are in `scripts/`; its long docs in `docs/`. | `apps/os`                                                                                                                                          |
| A client app           | `apps/<name>`: a TanStack Start app on its own Worker and an ordinary OAuth client of the platform, with no secrets and no data. It declares only its name; `scripts/lib/start-app.ts` and `envs.ts` supply the rest.                                                                                                                                                                                               | admin, agents, dash, kit, notes, voice                                                                                                             |
| A plain Worker         | `apps/<name>` with `src/worker.ts`, an inline Cloudflare config in `vite.config.ts` from `envs.ts`, and `scripts/deploy.ts`. Test fixtures and CI tools.                                                                                                                                                                                                                                                            | dummy-petshop, ci-reports                                                                                                                          |
| A static app           | `apps/<name>/public`, no build.                                                                                                                                                                                                                                                                                                                                                                                     | spa, browser-extension                                                                                                                             |
| A published package    | `packages/<name>`, built by tsdown, `publishConfig.exports` pointing at `dist/`, published by pkg.pr.new on every main commit.                                                                                                                                                                                                                                                                                      | `iterate` (the SDK), `@iterate-com/cli`, the userspace apps `@iterate-com/agents` and `@iterate-com/voice`, the fixture `@iterate-com/petshop-sdk` |
| A private package      | Exports point at source. Only code two or more workspaces use.                                                                                                                                                                                                                                                                                                                                                      | `@iterate-com/ui`, `@iterate-com/shared`                                                                                                           |
| A userspace template   | `configs/<template>/`: `worker.ts`, `AGENTS.md`, `package.json`, `tsconfig.json`, copied into a new project.                                                                                                                                                                                                                                                                                                        | default, with-agents                                                                                                                               |
| A script               | A trpc-cli program with an `isMainModule` gate. One app's programs live in `apps/<app>/scripts/`; repo-wide ones in `scripts/` (`ci/` for workflows, `lib/` for deploy libraries, `depot-ci/` for image bakes, `hooks/`).                                                                                                                                                                                           |                                                                                                                                                    |
| A test                 | Unit `*.test.ts` beside its source; a deployable's contract in `<app>/e2e/*.e2e.test.ts`; workerd controls in `__workers-tests__/`; browser product specs in root `specs/<app>/`.                                                                                                                                                                                                                                   |                                                                                                                                                    |
| Instructions and rules | `AGENTS.md` for instructions, `docs/` and `<app>/docs/` for guides, `rules/` for review rules, `lint/` for enforced rules, `.agents/skills` for skills.                                                                                                                                                                                                                                                             |                                                                                                                                                    |

**Layering.** Lint enforces the SDK/platform line: `packages/**` and `apps/!(os)/**` may not import `apps/os` except through its two test harnesses.

**The moves, by item.**

- Client apps share a kit and one registry, so adding an app is about 4 edits, not 13+ (item 16; the `scripts/app.ts` collapse is queued after #3165).
- Admin folds into dash (item 14).
- `apps/os/src`'s 67 flat files get domain folders; oversized files split (item 28).
- The browser extension gets a `package.json` and stops committing capnweb (item 7).
- Operator scripts and the voice tools connect through `iterate/api`; the voice tools move to `apps/voice/scripts` (item 17).
- Preview tooling moves to `scripts/preview/`; scheduled monitors to `scripts/monitors/`; vendored shadcn to `components/shadcn/`; `os` becomes `@iterate-com/os`; the OS Worker config becomes a TypeScript object (items 6 and 35).
- Test support is spelled one way, and 13 vitest configs become one with `projects` (item 22).
- The `tasks/` convention is decided (item 34).

Already done tonight: `iterate/with-itx`'s published types, the dead codegen lint plugin, stale config, `isMainModule` entry points, `getin` into apps/os and petshop-sdk's build recipe (#3205); one `plainWorkerConfig` for the two plain Workers (#3210); and the unused `workflow_call` in `release.yml` (#3203).

## Appendix D: CI findings

Measured from Depot run records and R2 flake records, 2026-09-22 to 2026-09-25 ~21:00 UTC, before #3203.

**Verdict: PR CI slid back.** TTG for pushes that skip the slow e2e rows and go green on the first try went from 164/205 s (p50/p90) to 218/260 s since #3069 (n=51): +54 s at p50, and +78 s against the best window (#3125, 140/147 s). The 3-minute target is met by 6 of 51 pushes, against 23 of 38 before.

| Window (starts at a merge)      | TTG, slow rows skipped (n) | Red first verdict | TTG, every row (n) |
| ------------------------------- | -------------------------- | ----------------- | ------------------ |
| 09-24 17:14, split jobs (#3054) | 167/206 (39)               | 4%                | 290/331 (64)       |
| #3125, 2x8 runners              | 140/147 (7)                | 0%                | 267/285 (6)        |
| #3128, slow rows opt-in         | 163/210 (33)               | 21%               | 296/314 (7)        |
| #3146, catalog and toolchain    | 215/247 (12)               | 36%               | 334/357 (6)        |
| #3145, control-plane D1         | 195/215 (13)               | 48%               | 374/375 (3)        |
| #3069, version gate             | 219/266 (20)               | 13%               | –                  |
| #3170, D1 near CI               | 218/251 (25)               | 19%               | 313/337 (5)        |
| #3188, TypeScript 7             | 221/232 (6)                | 0%                | –                  |

**Per job, green pushes, p50/p90 (s):**

| Job                | Baseline | #3125   | #3146   | #3069   | #3188   |
| ------------------ | -------- | ------- | ------- | ------- | ------- |
| Lint and Typecheck | 27/56    | 26/47   | 68/76   | 47/59   | 56/58   |
| Test               | 124/150  | 108/112 | 153/164 | 143/147 | 154/159 |
| Deploy preview     | 58/85    | 52/67   | 83/95   | 91/118  | 79/87   |
| E2E tests          | 86/109   | 67/89   | 111/126 | 86/110  | 100/126 |
| **Browser specs**  | 78/102   | 66/84   | 119/139 | 117/140 | 124/139 |

**What regressed, and which PR caused it.**

| Regression                             | Cause                                                                                                                                                           | Cost                           |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Browser specs became the critical path | #3144 (admin spec, 3 contexts specs), #3063 (8 integration and sign-in specs, 10–16 s each), #3185 (project delete). Playwright went 26 → 40 tests on 6 workers | TTG +35–50 s                   |
| Deploy preview +20 s                   | #3069's gate (12 → 25 s p50), #3144's 7th client build, #3146's Vite and wrangler bump                                                                          | +20 s                          |
| Lint +20 s (not critical)              | #3146: oxlint 24 → 41 s, typecheck 24 → 37 s; TypeScript 7 (#3188) took typecheck back to 29 s                                                                  | +20 s                          |
| Test +10–20 s (next critical)          | #3146, and #3179's second 60 s watchdog row                                                                                                                     | +10–20 s                       |
| Main client deploys +25 s              | #3146's `pnpm install` in `deploy-<app>.yml`                                                                                                                    | fixed by #3203                 |
| Red main, 14 workflows                 | #3188's stale merge left a lockfile pnpm rejects                                                                                                                | 8 min, fixed by #3195 (item 5) |

**What-if**, replaying the 51 green pushes since #3069:

| Cut                              | TTG p50/p90 (s) |
| -------------------------------- | --------------- |
| specs −20 s                      | 204/245         |
| specs −35 s                      | 192/232         |
| + gate −13 s                     | 180/219         |
| + specs −45, deploy −20, e2e −15 | 168/206         |

Below about 170 s the Test job (ending at 156/189 s) is the wall (item 3).

**Flakiness is incident-driven.** The red-first-verdict rate went from 4% to 25% after #3128, driven by three incidents, all fixed: the control-plane D1 placed far from CI (#3145, fixed by #3170), the dummy petshop's Durable Object stalling under #3063's new rows (fixed by #3192), and #3188's lockfile (fixed by #3195). The residue is about 6% of specs runs and 18% of e2e runs needing an in-job retry. The open clusters are the new Dash specs on the 1 s action budget (CI-M6, item 1), one 30 s timeout on a nested-context WebSocket row, and the D1 3 s bound (8 runs in two days). Unit tests are deterministic: 0 retries in 558 runs. #3069's gate halved the platform-signature e2e retries (8% → 4%). Main is still fast: deploys take about a minute.
