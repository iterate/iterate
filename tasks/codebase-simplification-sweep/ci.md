# Sweep candidates: ci

Verified candidates from the 2026-09-29 codebase simplification sweep for this area. Each passed an adversarial skeptic check; where the skeptic amended the proposal, the amendment wins. Line numbers are as of origin/main on 2026-09-29 (about cfd8a1d36) and have drifted since: #3442, #3455 and #3460 touched some of these files. The index and the owner calls are in ../codebase-simplification-sweep.md.

## Each test job's evidence upload loses three side mechanisms: a Doppler prefetch into an encrypted fallback file, a shell fallback reporter with marker files, and a pnpm-store reporter

- Sweep index: 45; risk: low; payoff: 4/10
- LOC: About −360 in total, measured:
- shell scripts: 30 + 34
- workflow steps and setup outputs: about −57
- test-evidence.ts: about −45
- env-context.ts: −12, and its test −15
- fake-doppler.ts: about −12
- depot-workflows.test.ts: about −125 (1448-1478, 1516-1578, 1580-1616)
- test-evidence.test.ts: about −25
- docs: about −20

The prefetch alone is about −105. (skeptic measured: A (proposed): about −111 across the files below.

- scripts/ci/test-evidence-unreported.sh: −30
- The three 'Report a test evidence step that could not' steps: −15
  - test.yml:140-144
  - preview-os.yml:379-383
  - main-os-e2e.yml:249-253
- test-evidence.ts: about −10 (marker writeFileSync and docstrings)
- depot-workflows.test.ts: about −43 (1580-1616, plus lines 1411, 1462-1463 and 1478)
- preview-os-workflow.test.ts:480-483: −4
- test-evidence.test.ts:581-582, 735 and 782: about −4 net, since 735 swaps to a summary assert
- docs/test-evidence.md: about −5

B (optional): about −120.

C (rejected): about −117. It would have removed:

- the 34-line script
- 11 step lines
- 6 action.yml output lines
- 64 test lines (1516-1578)
- about 2 lines of docs)
- Concepts: Before, 6 concepts:
- the prefetch step
- the encrypted fallback file and its fake
- the marker-file handshake
- the shell fallback reporter
- the TS/shell shared titles
- the pnpm-store reporter

After: 0 new concepts. The step outcome and the existing PostHog field carry it.

### Evidence

Merges three rows: the scripts-env heavy hunt and the ci parallel and heavy hunts.

The fallback reporter:

- scripts/ci/test-evidence-unreported.sh (30 lines).
- 'Report …' steps: test.yml:140-144, preview-os.yml:379-383, main-os-e2e.yml:249-253.
- Marker files: test-evidence.ts:494-524, `stepFailureTitles`, `reportStepFailure`.

The prefetch:

- 'Fetch the evidence upload's secrets' steps: test.yml:78-85, preview-os.yml:303-311, main-os-e2e.yml:174-181.
- test-evidence.ts:645-675: fetchUploadSecrets and uploadToken's RUNNER_TEMP file.
- dopplerSecret's one-user `fallback` option: scripts/lib/env-context.ts:165-167, 185-202.
- fake-doppler.ts:32-41 re-implements Doppler's fallback file for tests.

The pnpm-store reporter:

- scripts/ci/pnpm-store-report.sh (34 lines).
- Step: test.yml:145-155.
- .depot/actions/setup/action.yml:14-25: two outputs only it reads.

What already covers all this:

- The upload is continue-on-error and 'decides nothing' (test-evidence.ts:33-38).
- sync-ci-telemetry.ts:131-136 and :262-266 already record `test_evidence_uploaded: false` for every folder that never arrived.

What the prefetch saves: #3294 (d30bc55b5) measured 0.2–0.5 s.

### Current shape

A missing evidence folder is reported three times: by the script, by a bash step that checks marker files, and by the hourly PostHog field.

The upload's token is prefetched during the tests into Doppler's encrypted fallback file. A fake Doppler CLI emulates that file for tests.

The Test job also adds a bash-rendered line about pnpm's cache.

### Proposed shape

```yaml
- name: Upload the test evidence to R2
  if: ${{ always() && steps.evidence-write.outputs.manifest == 'written' }}
  continue-on-error: true
  timeout-minutes: 3
  env: { DOPPLER_TOKEN: ${{ secrets.DOPPLER_TOKEN }} }
  run: node scripts/ci/test-evidence.ts upload
```

```ts
const apiToken = dopplerSecret(
  ciBucketEnvs.ci.dopplerProject,
  ciBucketEnvs.ci.dopplerConfig,
  "CLOUDFLARE_API_TOKEN",
);
```

Delete:

- both .sh files
- the prefetch and report steps
- fetchUploadSecrets, stepFailureTitles and the markers
- dopplerSecret's `fallback` and fake-doppler's emulation of it
- the two setup outputs

### What changes

Token read:

- The upload makes one Doppler read after the tests. It overlaps the parallel Depot upload. #3294 measured the cost at 0.2–0.5 s.
- If Doppler fails at that moment, the (continue-on-error) upload fails and the sync counts it.

A step that dies before reporting itself (a Node crash, a timeout) still shows as failed, and `test_evidence_uploaded` is still false. It loses only the second warning and the summary line.

The Test summary loses its pnpm line. actions/cache still logs keys, and a failed restore or save still shows red.

Test verdicts are unchanged.

### Pinned by

- scripts/ci/depot-workflows.test.ts:1389-1492, 1516-1578, 1580-1616, 1629-1645
- scripts/ci/test-evidence.test.ts:559-583, plus the marker asserts at 735 and 782
- scripts/lib/env-context.test.ts:79-93

### Skeptic's amended proposal

Split the candidate: do A, offer B only if a soak run shows its cost, and drop C.

**A. Delete the fallback reporter.**

Delete:

- scripts/ci/test-evidence-unreported.sh
- the three 'Report a test evidence step that could not' steps
- the RUNNER_TEMP marker write in reportStepFailure, which becomes just the warning plus the summary line
- the `export` on stepFailureTitles; the map stays private for failStep's `keyof`
- the fallback test at depot-workflows.test.ts:1580-1616
- the report lines in the test.each: 1411, 1462-1463 and the ordering assert at 1478
- preview-os-workflow.test.ts:480-483
- the marker asserts in test-evidence.test.ts at 581-582 and 782

At test-evidence.test.ts:735, replace the marker assert with an assert on the summary line, `**No test evidence manifest**`, so the write failure's report stays pinned.

In the docs, replace the step-3 bullet and the 'plain-shell fallback step' clause with one sentence: 'An upload that dies before it can report itself shows as a failed step, and `test_evidence_uploaded: false` in PostHog counts it.'

```ts
export function reportStepFailure(input: {
  command: keyof typeof stepFailureTitles;
  error: unknown;
  environment: NodeJS.ProcessEnv;
}) {
  const title = stepFailureTitles[input.command];
  const message = describeError(input.error);
  console.log(`::warning title=${title}::${escapeWorkflowData(message)}`);
  stepSummary(input.environment, `**${title}**: ${message}. The tests' result is unaffected.`);
}
```

What changes:

- An upload process that dies outside its own catch (Node fails to start, is killed, or a hung `doppler` spawnSync runs into the 3-minute step timeout) gets no warning annotation and no summary line. It still shows as a failed continue-on-error step, and the hourly sync counts it.
- A write step that dies before its manifest loses only a second warning, because the job is already red: the step has no continue-on-error.
- Concepts go from 3 (in-process report, marker handshake, shell fallback with shared titles) to 1 (the in-process report), plus the existing PostHog field.

**B. Optional: delete the Doppler prefetch.** Do this only after a Depot soak shows the tail is unchanged, or Jonas accepts the cost. #3294 bought this deliberately.

Delete:

- the three 'Fetch the evidence upload's secrets' steps
- fetchUploadSecrets and uploadToken
- dopplerSecret's `fallback` option and statSync
- fake-doppler's emulation of `--fallback` and `--fallback-only`
- env-context.test.ts:79-93
- depot-workflows.test.ts:1446-1461 and the Kit parallel-block entry

upload() then reads the token directly:

```ts
const apiToken = dopplerSecret(bucket.dopplerProject, bucket.dopplerConfig, "CLOUDFLARE_API_TOKEN");
```

What changes: about 0.3 s of Doppler download moves into the R2 upload after the tests. It is hidden only if `actions/upload-artifact` in the same parallel block takes longer. That is about −120 LOC and one fewer concept.

**C. Drop the pnpm-store reporter from this candidate.** It is unrelated to the evidence, and it is the only place the store's hit, fallback or miss, or a failed save on main, shows up outside actions/cache's own log.

### Skeptic's verdict

I checked this against origin/main at b3daf4846. PR #3446 is already merged and touches none of these steps. The candidate bundles three separate mechanisms, and only one of them is clearly junk.

**A. The fallback reporter: holds.** A TS-to-shell handshake through marker files, a 30-line bash script that repeats the TS reporter's titles and text, and one step in each of three workflows all exist to warn about the rare failure that happens outside `upload()`'s own try. That failure is on a step that decides nothing.

- `uploadToken()` runs inside the try, so a Doppler refusal is already reported by `reportStepFailure`.
- The upload has its own 90 s deadline (`UPLOAD_DEADLINE_MS`), against a 3-minute step timeout.
- So the shell script only fires when Node fails to start, the process is killed, or a hung `doppler` spawnSync (it has no timeout) runs into the step timeout.
- A write step that dies before its manifest already fails the job, because that step is not continue-on-error. The shell warning adds nothing there.
- The sync already records `test_evidence_uploaded: false` for every attempt with no evidence (sync-ci-telemetry.ts:131-136, 262-266).

This is two mechanisms doing one job, plus a protocol that is hard to explain. No guarantee is lost: test verdicts, the upload itself and the PostHog count are all unchanged.

**B. The Doppler prefetch: a real trade, not junk.** It is identical in behaviour but slower. Jonas added it yesterday in #3294, a PR whose whole point was the job tail after the tests (Test 2.64 s, E2E 2.65 / 2.80 s against a ≤ 3 s target).

- The 0.24–0.53 s the candidate quotes is the cost of the prefetch step itself, not the tail it saves. No one has measured the tail with and without it on the same image.
- The R2 upload runs in parallel with `actions/upload-artifact`, so the extra ~0.3 s Doppler read may or may not lengthen the tail.
- It is about 120 lines and one concept (Doppler's encrypted fallback file, one user of `dopplerSecret`'s `fallback` option, and a fake CLI that imitates it). That is worth offering, but only with a soak run that shows what it costs. It should not be sold as junk.

**C. The pnpm-store reporter: drop.** It has nothing to do with the evidence. Nothing else shows which store a run restored (exact key, fallback key, or none), and nothing else turns a failed save on main into a warning. docs/depot-ci.md:457-459 says actions/cache reports this only in its own log. The claim that a failed restore or save "still shows red" is unverified for a continue-on-error step inside a composite action on Depot. Deleting it removes a small but unique signal and replaces it with nothing, so it is a lateral move.

**Re-measured LOC (sed/wc on main):**

- A: about −111.
  - the .sh: 30
  - three steps: 5+5+5
  - test-evidence.ts: about 10 (marker write 4, docstrings about 6)
  - depot-workflows.test.ts: about 43 (fallback test 1580-1616 plus 4 lines in test.each)
  - preview-os-workflow.test.ts:480-483: 4
  - test-evidence.test.ts: 4
  - docs: about 5
- B: about −120.
  - three steps: 8+9+8, plus 3 upload comments
  - test-evidence.ts fetchUploadSecrets and uploadToken: about 30
  - env-context.ts: about 12
  - env-context.test.ts:79-93: 16
  - fake-doppler.ts: about 11
  - depot-workflows.test.ts:1446-1461 and the Kit test's entry: about 18
  - docs: about 5
- C: about −117, not proposed.

The candidate's −360 total is about right, but only A is proposed as a clear win.

## Keep the DO cost check's pages in the health job's state, which already holds every other signal's pages, instead of in Slack history

- Sweep index: 46; risk: medium; payoff: 5/10
- LOC: About −230 to −300 net, measured.
- do-cost.ts: 557 → about 430–470. The spans are: upkeepPage 53, decidePage 43 → about 20–32, headline and reply 74 → about 12, dry-run 14 → 5.
- do-cost.test.ts: 711 → about 560. Rows 450-624 exist only to exercise Slack-history lookup; the incident replay is rewritten against state.
- health.ts: about +6 to +10. (skeptic measured: - do-cost.ts: 557 → 393, measured. I built a draft (scratchpad/docost-draft/do-cost.fmt.ts) from the original's unchanged spans (33-36, 42-82, 185-314, 360-369, 454-482) plus the new code, and formatted it with oxfmt. The draft is not typechecked or run.
- do-cost.test.ts: 711 → about 560, estimated. Rows 450-575 and 598-624 (about 155 lines) exist only for Slack-history lookup and go. The incident replay needs about +15 for memory and `sendUpdates`, and the `openPage` helper goes (−7).
- health.ts: about +8. health.test.ts: about +3. docs/depot-ci.md: about −2.
- Net: about −300. scripts/ci/slack.ts is unchanged, because notify.ts, prd-fault-alarm.ts and `keepPage` still use its page helpers.)
- Concepts: One job has 2 page stores today: health's state, and Slack history with a marker, a 48 h window, a 30-day expiry, peak-in-text, headline-by-text, reply-by-prefix and its own PageAction/upkeepPage. After the change it has 1.

### Evidence

Merges the parallel and heavy hunts.

How every other health signal keeps its page:

- scripts/monitors/health.ts:76-83 `HealthState.pages`.
- :128-166 `sendUpdates` posts, edits, escalates and resolves for every other signal.
- scripts/monitors/page.ts:69-81 defines `PageUpdate`.

How DO cost does it instead:

- health.ts:199 calls `checkDoCost({ testRun, dryRun, runUrl })` with no memory, so DO cost posts on its own.
- do-cost.ts:37-41 sets OPEN_PAGE_HOURS 48 and EXPIRED_PAGE_HOURS 30 days.
- :316-358 has its own `PageAction` (the name clashes with page.ts's) and `decidePage`, which regex-parses the peak back out of the page text at :346.
- :400-452 `upkeepPage` runs findOpenPages over 48 h, then over 30 days to 'expire' pages.
- :484-557 finds the #ci headline and the details reply by text.
- :117-130 renders its own dry-run pages.
- do-cost.test.ts:516-518 says it keeps 'no state but #error-pulse'.

History:

- #3253 folded do-cost into health, which already had state.
- #3372 built the Slack-history page.
- #3374 gave every other signal a state page.

Together with the notify.ts→keepPage row, this cuts the repo's Slack page keepers from 5 to 3: keepPage, health state, and notify's deploy pages.

### Current shape

In the same job and process, the other signals return PageUpdates that health sends against the pages it keeps in state. DO cost instead searches Slack history for its pages and its daily #ci thread, stores its peak inside the page text, and re-pages and expires anything older than 48 hours.

### Proposed shape

```ts
export const DoCostMemory = z.object({
  thread: z.object({ date: z.string(), headlineTs: z.string(), detailsTs: z.string() }).optional(),
  peaks: z.record(z.string(), z.number()), // the DO-hours/h each open page shows, by account
});
// per account: no peak → tier>0 ? {signal:`DO cost ${label}`, kind:'post', page}; underCeilingSince → {kind:'resolve', why};
// crossed > max(1, tier(peak)) → {kind:'escalate', page, news, broadcast:true} else {kind:'edit', page}
export async function checkDoCost({
  memory,
  testRun,
  runUrl,
}): Promise<{ updates: PageUpdate[]; memory: DoCostMemory }>;
```

- HealthState gains `doCost` and moves to schemaVersion 3.
- The #ci thread is updated by its ts from state.
- Delete upkeepPage, findOrCreateHeadline, the history scan in upsertDetailsReply, both windows, the peak regex, do-cost's own PageAction, and the dry-run rendering.

### What changes

- A page open at ship time goes unseen, so it is posted once more. The schema bump also restarts the other signals, which the existing policy accepts.
- An incident longer than 48 h keeps its one page instead of being re-paged and 'expired'.
- The peak comes from state instead of the page text.
- A run with no state posts a second #ci headline that day.
- The escalation reply comes after the edit, not before it.
- A page Slack can no longer edit follows sendUpdates' rule: a new page is posted and the frozen one gets no closing reply.
- Thresholds, tiers, texts and the #ci thread are unchanged.

### Pinned by

- scripts/monitors/do-cost.test.ts: all rows. 450-624 are history-only, including 'an old 🧪 page…', 'past 48 hours…' and 'hourly runs resolve a page Slack cannot edit once'.
- health.test.ts: sendUpdates and schemaVersion rows.
- depot-workflows.test.ts:656-693.

### Skeptic's amended proposal

Keep DO cost's pages and its #ci thread in the health job's state, and send its pages through `sendUpdates` like every other signal's.

```ts
export const DoCostMemory = z.object({
  thread: z.object({ date: z.string(), headlineTs: z.string(), detailsTs: z.string() }).optional(),
  peaks: z.record(z.string(), z.number()), // the peak each open page shows, by account; present = open
});
export async function checkDoCost(o: {
  memory: DoCostMemory;
  testRun: boolean;
  dryRun: boolean;
  runUrl?: string;
}): Promise<{ updates: PageUpdate[]; failures: string[]; memory: DoCostMemory }>;
```

**Pages**

A pure `pageUpdate(account, shown, runUrl)` replaces `decidePage` and returns `{ update, peak }`. The signal is `DO cost ${label}`.

- No page open and at the page tier: post.
- `underCeilingSince`: resolve, with today's why.
- A crossing past max(1, tier(shown)): escalate, with `news` = today's escalation words and broadcast true.
- Otherwise: edit.

`renderPage` returns a `PageContent`. An account whose probe failed keeps its peak.

**The #ci thread**

The #ci thread is kept from `memory.thread`. `keepThread` uses `updatePage` on the reply and the headline. When the date differs, or either message is gone, it posts a new headline and reply.

- A test run passes no thread in, returns the kept one unchanged, and never rewrites the real headline.
- A dry run prints the thread.
- A Slack error in the thread is caught into `failures`, so pages still go first. The probe-failure throw also becomes a `failures` entry.

**health.ts**

- `HealthState` gains `doCost: DoCostMemory` and goes to schemaVersion 3, with `readState`'s empty value set to `{ peaks: {} }`.
- `run` puts DO cost's updates first in `updates` and pushes its failures.

**Deletions**

- `postDailyThread`
- `upkeepPage`
- `decidePage`'s regex
- `OPEN_PAGE_HOURS` and `EXPIRED_PAGE_HOURS`
- do-cost's `PageAction`
- `findOrCreateHeadline` and `upsertDetailsReply`, including the history and reply scans
- the dry-run page rendering
- `DETAILS_TITLE`'s role in recognising the reply

**Tests**

- The incident replay is rewritten to carry memory and pages across runs through `sendUpdates`.
- The history-only rows at do-cost.test.ts 450-575 and 598-624 are deleted.

**Semantic changes to state in the PR**

- An open DO cost page at ship time is orphaned, and the other signals' open pages are too, because of the bump.
- An incident past 48 h keeps one page and gets no new top-level re-mention.
- A frozen page's resolution goes top-level.
- DO cost's Slack sends now follow the other checks, in one ordered pass.

### Skeptic's verdict

The claim holds. In the same process, the health job keeps two page stores. One is health's state plus `sendUpdates`, used by real-model, latency and TTG. The other is DO cost's Slack-history keeper: the marker, `findOpenPages` over a 48 h window and then again over 30 days to expire pages, the peak regex at do-cost.ts:346, its own `PageAction` (which clashes with page.ts), `upkeepPage` and the text-matched headline and reply.

This is an accident of timing, not a design choice. #3372 (DO cost pages) merged at 16:20 on 09-28 and #3374 (state pages) at 16:51 the same day. #3374's body says outright that "`do-cost.ts` is untouched" and that "findOpenPage and resolvePage stay DO cost's: the health jobs don't need them, because their state keeps each open page's ts". health.ts:12-13 even has to explain the exception ("in its own daily thread and pages"). #3446 (merged) touches none of this.

(a) Semantic deltas. The candidate's list is right but incomplete.

- A DO cost page open at ship time is orphaned, never resolved, and not only re-posted.
- The schema bump also orphans the open pages of real-model, latency and TTG. #3374 accepted that policy.
- A >48 h incident no longer re-mentions on-call through a new page. That re-page was a side effect of the lookback window, not a stated goal.
- Resolving a frozen page posts the reply top-level, not in its thread and broadcast.
- DO cost's pages now go out in the one ordered `sendUpdates` pass, after all checks have run, instead of first and on their own. A Slack error on any update stops the rest of that run's updates, and the next hour retries them. Depot reads carry an abort signal, so a hang is bounded.
- Page texts, escalation texts (`escalationText(news)` gives exactly today's string), tiers and the #ci thread wording are identical.

(b) The new shape really is simpler. do-cost becomes a check like the others: it returns updates, memory and failures. The following all go: the marker, both windows, the expiry, the peak regex, headline-by-text with paged history, reply-by-title, `upkeepPage`, do-cost's `PageAction` and the dry-run page rendering. The one new concept is `DoCostMemory` {thread, peaks}. The page keepers in `slack.ts` (`findOpenPages`, `resolveOlderPages`, `editPage`, `resolvePage`, `keepPage`) stay, because notify.ts, prd-fault-alarm.ts and the sweeps use them. So `slack.ts` does not shrink.

(c) No real guarantee is lost. The alarm can never go silent: state loss makes it re-post, it never swallows a page. "One repeat, never a lost page" holds through `postThenKeep` atomicity. An escalation whose post fails leaves the old peak in state, so the next run owes it again.

The proposal is mis-specified in several places. The amended proposal has the fixes.

- It drops `dryRun`, but the check still posts or prints the #ci thread.
- It would let a test run rewrite the real day's headline from state. `findOrCreateHeadline` guards against exactly that today.
- It would let a Slack error in the thread swallow the pages. do-cost.ts:158 says pages go first for this reason.
- It does not carry peaks forward for an account whose probe failed. That would re-post and orphan its page.

(d) LOC, re-measured. I built do-cost.ts from the original's unchanged spans plus the new code and formatted it with oxfmt: 557 → 393. It was not typechecked or run. do-cost.test.ts: the history-only rows 450-575 and 598-624 are about 155 lines to delete, and the replay gains about 15, so 711 → about 560. health.ts about +8, health.test.ts about +3, docs/depot-ci.md about −2. Net about −300.

Risk is medium-low. This is CI tooling, and the failure mode is a duplicate or orphaned page, never silence. Pinned by the do-cost.test.ts rows (the incident replay; the rows at 450-624 go) and the health.test.ts `sendUpdates` and `readState` schemaVersion rows. depot-workflows.test.ts:656-693 pins the health-state artifact, which exists already, so it pins nothing that changes.

A note on the check itself: while drafting I briefly copied a scratch file into the wt-main checkout, ran oxfmt from there, and deleted it at once. git status afterwards shows only the untracked packages/cli/proof/, which was already there.

## Main OS e2e becomes Preview OS's push trigger instead of a 414-line copy held in lockstep by a parity test

- Sweep index: 47; risk: high; payoff: 6/10
- LOC: About −420 net before docs:
- main-os-e2e.yml: −414.
- preview-os.yml: about +90 (paths 38, alert 43, expressions 10).
- depot-workflows.test.ts: −96 in parity tests, plus the main rows in the table tests.
- docs/depot-ci.md: 21 mentions to repoint. (skeptic measured: Measured by drafting the merged file at scratchpad/merge/preview-os.yml; it parses as YAML.
- preview-os.yml: 534 → 629 lines. That is 108 lines added and 13 lines rewritten in place.
- main-os-e2e.yml: −414.
- YAML net: −319.
- depot-workflows.test.ts: the two parity tests go. "names its checks as Preview OS does" (:1133-1154) is 22 lines and "suite jobs are one definition" (:1179-1250) is 72. About 12 more lines of main rows go from the test.each and test.for tables. The concurrency, push-paths and alert tests are pointed at preview-os and stay about the same size. The own-prefix test at :1064-1108 needs about +5 lines for a special case. Net about −100.
- preview-os-workflow.test.ts: push rows in the run table (:267-390) add about +20.
- testEvidenceJobs −2, TRACED_WORKFLOWS and the specs-shards test.for shrink by 1 each, and the monitors and fake-depot are renamed only (0).
- Docs: about 55 mentions of "Main OS e2e" / "main-os-e2e" outside tasks/ get repointed across about 12 doc and comment files. Net about −5: the docs/depot-ci.md:79 table row goes.
- Total: about −400 net. The candidate's −420 is close.)
- Concepts: 2 workflows plus a parity test become 1 workflow with 3 triggers.

### Evidence

- .depot/workflows/main-os-e2e.yml (414 lines) repeats preview-os.yml's deploy, e2e, specs-shard, specs, cleanup and trace jobs, including the whole `&suite-steps` anchor (main-os-e2e.yml:131-248 against preview-os.yml:231-383).
- scripts/ci/depot-workflows.test.ts:1136-1155 and :1180-1250 compare the two files step by step. Only 4 PR-only steps and 1 main-only step may differ.
- Preview OS's suite command already handles both cases (`${PR_NUMBER:+--pr …} ${DEPLOYMENT_PREFIX:+--name …}`, preview-os.yml:334-336), and so does its checkout ref.
- The push-path list is kept equal to preview-paths.ts by :1124-1131.

### Current shape

Every push to main runs a second workflow whose jobs, check names, runners, env and steps are Preview OS's, with the PR-only steps removed and an alert job added. A 90-line test fails whenever the two files drift, so the copy gives no independence.

### Proposed shape

Delete main-os-e2e.yml. In preview-os.yml:

```yaml
on:
  pull_request: …
  push: { branches: [main], paths: [<main-os-e2e.yml's list>] }
  workflow_dispatch: …
concurrency:
  group: preview-os-${{ github.event.pull_request.number || inputs.pull-request-number || github.sha }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
env:
  DEPLOYMENT_PREFIX: ${{ github.event_name == 'push' && 'main' || '' }}
jobs:
  alert: # moved as is; if: ${{ !cancelled() && github.event_name == 'push' }}
```

- The PR-only steps already skip on a push.
- The monitors read workflow 'Preview OS' with trigger 'push'.

### What changes

- Main's runs are named 'Preview OS' in Depot, in telemetry and in the monitors. The first run after the change restarts main-e2e's judgedAt/state and may page once.
- Push jobs get the union of permissions: pull-requests: write joins statuses: write.
- The main deploy runs on -8 instead of -4, unless runs-on becomes an expression.
- A dispatch without a PR number is grouped by sha instead of 'none'.
- The jobs, checks, suites, alert and trace are otherwise identical.
- The 'spell it twice' tension does not apply: the test already forbids the two copies from diverging.

### Pinned by

- scripts/ci/depot-workflows.test.ts: the 5 'Main OS e2e …' rows, plus the permissions and evidence test.each rows.
- preview-os-workflow.test.ts: needs push-case rows.
- scripts/monitors/e2e.test.ts, health.test.ts and fake-depot.ts use the workflow and artifact names.

### Skeptic's amended proposal

Delete .depot/workflows/main-os-e2e.yml. In preview-os.yml, as drafted and parsed at scratchpad/merge/preview-os.yml:

```yaml
on:
  pull_request: …                        # unchanged
  push: { branches: [main], paths: [<main-os-e2e.yml's list, less itself>] }
  workflow_dispatch: …                   # unchanged
concurrency:
  group: preview-os-${{ github.event.pull_request.number || inputs.pull-request-number || github.sha }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
env:
  PR_NUMBER: …                           # unchanged
  DEPLOYMENT_PREFIX: ${{ github.event_name == 'push' && 'main' || inputs.preview-name }}
jobs:
  deploy / e2e / specs-shard / specs:
    if: github.event_name != 'workflow_dispatch' || (inputs.<same as today>)
  deploy:
    checkout ref: …head.sha || (inputs.pull-request-number != '' && format(…)) || github.sha
    tested step: if: env.PR_NUMBER != ''
    run: pnpm preview deploy ${PR_NUMBER:+--pr "$PR_NUMBER"} ${DEPLOYMENT_PREFIX:+--name "$DEPLOYMENT_PREFIX"} --apps "$APPS"
  suite step env:
    drop the step-level DEPLOYMENT_PREFIX
    PREVIEW_AWAIT_DEPLOY_JOB: ${{ (github.event_name != 'workflow_dispatch' || inputs.action == 'deploy') && 'deploy' || '' }}
  &suite-steps:
    add "Save Playwright's browser" as is; its `if` already requires push to main and shard 1
  alert:
    move main's job as is (needs [deploy, e2e, specs, specs-shard]; if: !cancelled() && push)
```

Rename the rest:

- 'Main OS e2e' becomes 'Preview OS', and main-os-e2e.yml:* becomes preview-os.yml:*, in:
  - scripts/monitors/{e2e,health,fake-depot}.ts and their tests;
  - preview-sweep.ts CI_WORKFLOW_PREVIEWS;
  - tracing/cli.ts TRACED_WORKFLOWS;
  - test-evidence.ts testEvidenceJobs.
- mainE2eRecords.artifact becomes `preview-os-test-artifacts-attempt-<id>`.

Tests:

- Delete the two parity tests in depot-workflows.test.ts (:1133-1154, :1179-1250) and the main rows in its tables.
- Point the concurrency, push-paths and alert tests at preview-os.yml.
- Add push rows to preview-os-workflow.test.ts's run table (:267-390), asserting deploy, e2e, specs and alert run and that the suites await 'deploy'.

Accept these, and say them in the PR:

- one skipped "Page a change of state" check on every PR;
- one fresh main page state after the switch;
- the loss of main-os-e2e's fresh-deploy dispatch; `action=test preview-name=main` or `depot ci retry` stand in for it;
- -8 for main's deploy, as docs/depot-ci.md already prescribes.

### Skeptic's verdict

The candidate is right in substance but mis-specified. As written it would silently test the wrong commit.

(a) Every behaviour that changes:

1. Main's runs are named 'Preview OS'. The job keys go from main-os-e2e.yml:* to preview-os.yml:*, and the artifact prefix from main-os-test-artifacts- to preview-os-test-artifacts-. Code that has to follow:
   - scripts/monitors/e2e.ts `mainE2eRecords` and MAIN_JOBS, and the judgedAt z.enum;
   - health.ts, fake-depot.ts and their tests;
   - preview-sweep.ts CI_WORKFLOW_PREVIEWS becomes ["main", "Preview OS"]. deploymentsUnderTest will then also list in-progress PR runs, whose shas map to main-<sha7> names that don't exist, so this is harmless;
   - tracing/cli.ts TRACED_WORKFLOWS;
   - test-evidence.ts testEvidenceJobs.
     The monitors already filter trigger=="push" (e2e.ts checkMainE2e, health.ts:354), and ttg.ts only lists pull_request runs, so the judging logic itself doesn't change.
2. The first run after the change finds no main-e2e-state from 'Preview OS' and starts empty. A red main pages again, and any page still open is orphaned: its thread is never resolved.
3. Every PR run and every dispatch shows a skipped "Page a change of state" check. The repo already avoids this kind of clutter: depot-workflows.test.ts forbids schedule-only jobs in workflows with several triggers. The candidate missed this.
4. The bare workflow_dispatch of main-os-e2e is gone. It deployed main's head fresh and ran every suite with no page. The nearest replacement is `--input action=test --input preview-name=main`, which runs against the newest main deployment without redeploying, or `depot ci retry`. docs/depot-ci.md:868 needs rewording. The candidate missed this too.
5. Main's deploy moves from -4 to -8. That matches docs/depot-ci.md:390, which says Deploy preview runs on 8x32, so main's -4 is drift.
6. Main's push jobs gain pull-requests: write. Nothing uses it: PR_NUMBER is empty on a push, so no PR body is written.
7. A dispatch without a PR number is grouped by its sha instead of 'none'.
8. SLOW_ROWS: run can go. chooseSlowRows already returns "run" when there is no PR number (slow-rows.ts:26).
9. TEST_TELEMETRY_HEAD_SHA comes from the "Record the PR head" step (git rev-parse HEAD, which is github.sha) instead of the job env. The value is the same. The test row at depot-workflows.test.ts:454-470 goes.

(b) It is genuinely simpler. A 414-line mirror plus a 94-line test that forbids the mirror from diverging becomes one file with a third trigger. Push fits the concept Preview OS already has: a named deployment (`--name`) with no PR. The lockstep cost is real. main-os-e2e.yml has 46 commits, and #3446 had to edit both files again for SPECS_SHARDS. The expression changes are in place (13 lines). Only the push paths list, the alert job and the Save step are new.

(c) No guarantee is dropped. Per-commit runs, no cancelling, runs sharing one cleanup, page jobs taking turns, and never writing to a PR all hold. The last one is now held by PR_NUMBER being empty on a push rather than by the file structure, so the own-prefix test at :1064-1108 has to special-case preview-os.

The candidate's shape is wrong in five places:

- The suite step sets DEPLOYMENT_PREFIX: ${{ inputs.preview-name }} at step level. That overrides a workflow-level DEPLOYMENT_PREFIX, so a push would get an empty prefix.
- Every job `if` (deploy, e2e, specs-shard, specs) currently excludes push. "The PR-only steps already skip" is true of steps, but on a push the whole jobs skip.
- In the deploy job, the checkout ref `format('refs/pull/{0}/head', …)` gives refs/pull//head on a push. The tested-commit step has no `if`, and the deploy passes `--pr "$PR_NUMBER"` unconditionally.
- This is the dangerous one. PREVIEW_AWAIT_DEPLOY_JOB is `(pull_request || action=='deploy') && 'deploy'`, which is empty on a push. The suites would then skip the wait and test the newest existing main deployment, which is the previous commit's, with nothing reporting it.
- The main-only "Save Playwright's browser" step has to move into &suite-steps.

Risk is medium-high. The push path only runs after merge, because Depot registers triggers from the default branch. It has to be pinned by rows with event: 'push' in preview-os-workflow.test.ts's run table, including one that asserts PREVIEW_AWAIT_DEPLOY_JOB=='deploy' on a push.

## The finalizer hands its completeness verdict to the manifest in memory: no second manifest file, second telemetry load, or second 'foreign' rule

- Sweep index: 48; risk: low; payoff: 4/10
- LOC: About −65 to −70 net, including docs:
- finalizer: −20
- test-evidence.ts: about −20 to −25
- packages/shared: −2
- tests: about −15 to −19 (skeptic measured: Prototype formatted with oxfmt using the repo's .oxfmtrc.json; `git diff --no-index --numstat` against origin/main copies. Net −66 across 7 files (+127/−193):

| File                                                | Added | Deleted | Net |
| --------------------------------------------------- | ----- | ------- | --- |
| scripts/ci/test-telemetry-finalizer.ts              | 36    | 54      | −18 |
| scripts/ci/test-evidence.ts                         | 20    | 30      | −10 |
| packages/shared/src/test-support/test-evidence.ts   | 4     | 7       | −3  |
| scripts/ci/test-evidence.test.ts                    | 32    | 59      | −27 |
| scripts/ci/test-telemetry-finalizer.test.ts         | 30    | 35      | −5  |
| docs/test-evidence.md and docs/ci-test-telemetry.md | 5     | 8       | −3  |

By area: product code −31, tests −32, docs −3. This matches the candidate's estimate of −65 to −70, but the split is different: the finalizer tests shrink by only −5 because they are rewritten rather than deleted.)

- Concepts: Before: 2 manifests, 2 loads and 2 'foreign' rules per step. After: 1 of each.

### Evidence

Merges the parallel and heavy hunts.

One verdict goes through a file and back within the same process:

- scripts/ci/test-telemetry-finalizer.ts:45-68 computes completeness and writes test-results/ci-telemetry/manifest.json.
- test-evidence.ts:566-579 `finalize` calls finalizeTestTelemetry in the same process and discards its result (`.then(() => undefined, …)`). The finalizer returns the artifacts at :102.
- test-evidence.ts:70-92 then reloads every artifact and parses the file back.

Two rules define a 'foreign' artifact:

- test-evidence.ts:78-84 matches `depotJobUrl`.
- test-telemetry-completeness.ts:81-83 matches run, attempt and job.

The file has one reader: `testEvidencePaths.telemetryCheck` (packages/shared/src/test-support/test-evidence.ts:21-22) is read only at test-evidence.ts:89.

### Current shape

Inside one `finalize` process, the verdict is written to an intermediate JSON file and the result is dropped. The same artifacts are then reloaded and the verdict read back from that file to build manifest.json.

### Proposed shape

```ts
// finalizer: return { artifacts, completeness: { cancelled, expectedWorkspaces, ...analyzeTestTelemetryCompleteness(artifacts, expectedWorkspaces) }, failures }
// test-evidence finalize
const telemetry = await finalizeTestTelemetry({...}).catch((error: unknown) => ({ error }));
const manifest = await writeManifest({ ..., telemetry: 'error' in telemetry ? undefined : telemetry });
if ('error' in telemetry) throw telemetry.error; else if (telemetry.failures.length) throw new Error(telemetry.failures.join('; '));
```

Drop:

- ci-telemetry/manifest.json
- `telemetryCheck`
- the reload
- the `depotJobUrl` rule
- the 'could not read the finalizer's check' diagnostic

### What changes

- The evidence folder no longer contains ci-telemetry/manifest.json. Its fields are already in manifest.json's `completeness` and `runners`.
- The manual re-check prints its verdict instead of writing it.
- There is one 'foreign' rule. In CI both current rules agree.
- If the finalizer throws, the diagnostic names its error instead of ENOENT. The result stays 'incomplete'.

### Pinned by

- scripts/ci/test-telemetry-finalizer.test.ts: 3 rows
- scripts/ci/test-evidence.test.ts: :65, :136, :193 (deleted), :667-748 (telemetryCheck asserts at 726, 748, 957)

### Skeptic's amended proposal

Finalizer (scripts/ci/test-telemetry-finalizer.ts):

- It no longer writes `manifest.json`. The mkdir/writeFile block and the `relative` import go.
- It still throws on load errors, on no artifacts when not cancelled, and on the suite-summary or headSha checks.
- It returns the completeness failures instead of throwing them:

```ts
const completeness = {
  cancelled,
  expectedWorkspaces,
  ...analyzeTestTelemetryCompleteness(artifacts, expectedWorkspaces),
};
// … suite summary and row budget unchanged …
const failures = cancelled ? [] : [/* missing / incomplete / foreign lines, as today */];
return { artifacts, completeness, failures };
```

`finalize` (scripts/ci/test-evidence.ts):

```ts
const telemetry = await finalizeTestTelemetry({ … }).catch((error: unknown) => ({ error }));
const manifest = await writeManifest({ repoRoot: process.cwd(), environment: process.env, cancelled, telemetry });
// … step outputs as today …
if ("error" in telemetry) throw telemetry.error;
if (telemetry.failures.length > 0) throw new Error(telemetry.failures.join("; "));
```

`writeManifest` passes `telemetry` through. `writeTestEvidence` takes `telemetry: Awaited<ReturnType<typeof finalizeTestTelemetry>> | { error: unknown }` and replaces the reload, the depotJobUrl filter and the check-file read with:

```ts
if ("error" in telemetry)
  diagnostics.push(`the telemetry finalizer: ${describeError(telemetry.error)}`);
const completeness = "error" in telemetry ? undefined : telemetry.completeness;
const artifacts =
  "error" in telemetry
    ? []
    : telemetry.artifacts.filter(
        ({ artifactId }) => !telemetry.completeness.foreignArtifactIds.includes(artifactId),
      );
```

Also:

- Drop `testEvidencePaths.telemetryCheck` and reword the docs of `TestEvidenceCompleteness`, `result` and `diagnostics`.
- Keep the `TestEvidenceCompleteness` schema. Its manifest shape is unchanged, and knip treats shared subpath exports as public.
- Optionally drop `|| completeness?.cancelled` in `testRunResult`, which now just repeats `input.cancelled`.

Docs:

- Drop the `ci-telemetry/manifest.json` line from the tree in test-evidence.md and from its producer table.
- Drop "writes test-results/ci-telemetry/manifest.json" in ci-test-telemetry.md, and say the re-check prints its verdict.

State these behaviour changes in the PR:

- The manual re-check exits 0 when there are failures.
- A throw after the verdict (suite summary or headSha) leaves the manifest incomplete with no `runners`.
- The job-URL anchor for `runners` is replaced by the newest-artifact scope.

Tests that pin the current behaviour, all updated in the prototype:

- scripts/ci/test-telemetry-finalizer.test.ts: 7 rows (11 cases including the table rows) move from `readManifest` or `rejects.toThrow` to asserting `completeness` and `failures` on the return value.
- scripts/ci/test-evidence.test.ts:
  - The files list drops `ci-telemetry/manifest.json` (:117). The runners order in that test follows the in-memory artifacts; in CI both come from the same `loadTestTelemetryArtifacts`.
  - The ENOENT diagnostic (:149) becomes the finalizer's error.
  - The table at :155-191 passes the verdict in memory.
  - The test at :193 is deleted.
  - The nine `check: completeCheck` upload fixtures lose their `check`, and the `write` helper supplies a default `telemetry`.
  - The assertions at :726 and :748 go, and the deadline test at :761 gains a `telemetry` line.

### Skeptic's verdict

The claim holds, and I proved it with a prototype. The file handoff is left over from when the finalizer and the manifest writer ran as separate CI steps. #3294 (d30bc55b5) merged them into one Node process, and nobody removed the file afterwards.

On origin/main b3daf4846 (which includes #3446; #3446 touches none of these files), one `finalize` process does all of this:

- `finalizeTestTelemetry` loads the raw telemetry, computes the verdict, writes `ci-telemetry/manifest.json` (finalizer.ts:49-68) and returns the artifacts.
- `finalize` throws that return value away (test-evidence.ts:576-579).
- `writeTestEvidence` loads the same telemetry again (:70-77), applies its own `depotJobUrl` foreign rule with a diagnostic (:78-84), and reads the verdict back from the file with a schema parse (:85-92).

Nothing else reads `ci-telemetry/manifest.json`. I grepped apps, packages, scripts, docs and .depot. The only hits are `testEvidencePaths.telemetryCheck` and the tests. os-real-model uploads `test-results/ci-telemetry` but never runs the finalizer. The flake dashboard reads only flake records and suite-summary.json.

I built the proposal in scratchpad/skeptic-evh/new and ran it through a symlink farm over wt-main. `tsc` is clean on the scripts project. 218 tests pass across test-evidence, test-telemetry-finalizer, flake-suite-summary and depot-workflows. The rows that spawn the finalize process needed `--testTimeout 60000` because this machine is loaded.

The new shape is genuinely simpler:

- One load, one verdict, one foreign rule and one manifest.
- The `telemetryCheck` constant goes, and so does the `TestEvidenceCompleteness` parse at the call site.
- The manifest schema does not change: `completeness` and `runners` keep their shape.

What it adds:

- A `telemetry: result | { error }` union passed down through `writeManifest`.
- The throw on failures moves from the finalizer into `finalize`, after the manifest is written.

Semantics that change (the candidate missed items 2 and 4):

1. The evidence folder (Depot artifact and R2) loses `ci-telemetry/manifest.json`. Its data is already in the manifest's `completeness` and `runners`, except `artifactCount` and `observedWorkspaces`, which the runners give.
2. The manual re-check (`node scripts/ci/test-telemetry-finalizer.ts --artifact-root …`) prints `{artifacts, completeness, failures}`, as trpc-cli prints any return value. It already printed the artifacts. It now exits 0 when there are failures instead of 1.
3. The foreign rule for `runners` becomes the analyzer's newest-artifact scope (repo, run, run attempt, job name) instead of equality with the job's DEPOT_JOB_URL. The two differ only when another attempt's telemetry is in the folder. That cannot happen on a fresh Depot runner: test-results/ is never restored or downloaded, and specs-shards collect does not touch the raw telemetry. In the impossible case where every artifact came from another attempt, the old manifest said incomplete and the new one could say passed. The separate "another job attempt" diagnostic goes away, because `completeness.foreignArtifactIds` already names those artifacts.
4. The finalizer can still throw after it has its verdict: `TEST_TELEMETRY_HEAD_SHA` missing, or the suite-summary write failing. In that case the manifest now has no `completeness` and no `runners` and says incomplete, with the error as a diagnostic. Today it keeps both and the real result. This is rare: every flake-suite workflow sets `TEST_TELEMETRY_HEAD_SHA`. The step fails either way.
5. When the finalizer throws before its verdict (no artifacts, a parse error, duplicate IDs), the diagnostic names that error instead of ENOENT. The result stays incomplete.

None of these drops a guarantee that actually matters: loop, delivery and security guarantees are untouched, and the step's pass/fail is unchanged.

Payoff is modest: this is CI tooling rather than platform code, and about half the saving is in tests.

## Replace the hand-written zip reader, and the hand-written zip writer its fake needs, with fflate from the catalog

- Sweep index: 49; risk: low; payoff: 4/10
- LOC: About −77 net:
- depot.ts: −55
- fake-depot.ts: −26
- new call sites: +3
- package.json: +1, plus a lockfile entry (skeptic measured: depot.ts 234→179 (−55: 57 lines out, 2 in including the import); fake-depot.ts 227→204 (−23: 28 out, 5 in); scripts/package.json +1; pnpm-lock.yaml about +3. Net about −77 source lines, about −74 including the lockfile.)
- Concepts: 2 hand-written binary codecs that must agree become 0: one library serves both the reader and the fake.

### Evidence

This row merges the parallel and heavy hunts.

The two hand-written halves:

- scripts/ci/depot.ts:180-234 is a 55-line central-directory parser that inflates with DecompressionStream. Its comment says it is 'deliberately not a dependency'.
- It came in with f3d8fe67f (#2571), written for a Worker runtime that no longer exists.
- scripts/monitors/fake-depot.ts:79-104 is a 26-line writer that emits only stored (uncompressed) entries.

Why this matters:

- Depot's real artifacts are deflated. Every fakeDepot test (depot, e2e, health, specs-shards, await-deploy) exercises only uncompressed entries, so the deflate path production depends on is untested.

The replacement is already available:

- fflate 0.8.3 is in the catalog (pnpm-workspace.yaml:58).
- apps/spa and apps/ci-reports already use it.

### Current shape

workflowArtifact downloads a Depot artifact and parses it with a local zip reader. The test fake builds its zips with a local writer that emits only uncompressed entries.

### Proposed shape

```ts
// depot.ts
import { unzipSync } from "fflate";
return unzipSync(new Uint8Array(await response.arrayBuffer()));
// fake-depot.ts
import { strToU8, zipSync } from "fflate";
const zip = zipSync(
  Object.fromEntries(Object.entries(files).map(([path, text]) => [path, strToU8(text)])),
);
```

Add `"fflate": "catalog:"` to scripts/package.json.

### What changes

- The return shape is unchanged.
- Inflation becomes synchronous, over artifacts of about 1 MB.
- fflate also reads zip64 archives, where the old reader threw. The reader's specific error messages go.
- Because the fake now deflates, existing tests cover the path production uses.

### Pinned by

- scripts/ci/depot.test.ts
- scripts/monitors/e2e.test.ts and health.test.ts
- scripts/ci/specs-shards.test.ts and await-deploy.test.ts (all through fakeDepot)

### Skeptic's amended proposal

The proposal is right, with small corrections to how it is specified.

1. In `scripts/package.json`, add `"fflate": "catalog:"` under `dependencies`, not `devDependencies`. `depot.ts` is runtime code for the health, e2e, latency, ttg, prd-fault-alarm and specs-shards jobs.

2. In `scripts/ci/depot.ts`, add `import { unzipSync } from "fflate";` and change line 131 to `return unzipSync(new Uint8Array(await response.arrayBuffer()));`. Delete the doc comment and the `unzip` function at lines 180–234. The 'about 1 MB, no zip64' reasoning goes with them.

3. In `scripts/monitors/fake-depot.ts`, add `import { strToU8, zipSync } from "fflate";`, delete `storedZip` and its comment at lines 79–104, and replace line 72 with:

```ts
const zip = zipSync(
  Object.fromEntries(Object.entries(files).map(([path, text]) => [path, strToU8(text)])),
);
return { url: `data:application/zip;base64,${Buffer.from(zip).toString("base64")}` };
```

The fake now deflates by default, which gives the deflate path its first test coverage.

Corrections to the candidate's evidence:

- apps/ci-reports lists fflate only as a devDependency, for its test fixture. Its runtime reader is @zip.js/zip.js with range requests. The precedent is the fixture use, not a runtime use.
- Add the latin1 name-decoding difference to the semantic delta. It is harmless for the ASCII paths the scripts read.

Measured result: about −77 source lines (depot.ts −55, fake-depot.ts −23, package.json +1), plus about 3 lockfile lines. Concepts go from 2 to 0.

### Skeptic's verdict

The claim holds. I checked it against origin/main at b3daf4846, and PR #3446 does not touch either file or any zip code.

(a) The semantics really are almost identical. I ran the old `unzip` body and fflate 0.8.3 `unzipSync` side by side under node 24.4 on two zips: one from Info-ZIP and one streamed with data descriptors (`zip -fd`). Each held nested dirs, a JSON file and a 270 KB deflated entry. With ASCII names, both readers returned byte-identical output, directory entries included. The old reader also reads fflate's `zipSync` output. Every behaviour that changes:

1. Entry names without the UTF-8 flag (bit 11) are decoded as latin1 by fflate, where the old reader used UTF-8. I confirmed this: `ünï.txt` came back as `Ã¼nÃ¯.txt`. It is harmless here. Every path a caller looks up is fixed ASCII: `state.json`, `suite-summary.json`, `raw/*.json`, `playwright-blob/*.zip` and the latency report. upload-artifact's archiver sets the UTF-8 flag on non-ASCII names anyway.
2. The error text changes. Non-zip input gives fflate's `invalid zip data` (verified) and an unknown method gives `unknown compression type N`, replacing the three bespoke messages. No test pins them.
3. zip64 archives are now read.
4. Inflation is synchronous. That is fine in node CLI scripts over artifacts of roughly 1 MB.
5. Neither reader checks CRCs, so that is unchanged.
6. The fake now deflates with real CRCs, so the five fakeDepot suites cover the deflate path that production uses. Today nothing tests it: no test has a deflated entry.

(b) The new shape is really simpler. Right now two hand-written binary codecs depend on each other. The fake writes zero CRCs because, in its own comment's words, "unzip never checks" them. A test fixture that must mirror a production parser's blind spots is a textbook case of "hard to explain = smell". After the change there are no codecs, just one catalog library that the repo already uses in exactly this fixture role: apps/ci-reports' `artifact.test.ts` uses `zipSync`/`strToU8`, and apps/spa's build script uses `zipSync`. The "deliberately not a dependency" rationale only mattered where the reader originally lived. Today this code runs under node after a full `pnpm install --frozen-lockfile`.

(c) No guarantee is dropped. Nothing checks integrity today, and CI's full install already brings fflate in.

(d) LOC, re-measured with `git diff --no-index` on patched copies:

- `scripts/ci/depot.ts`: −55 (57 lines out, 2 in, 234 → 179).
- `scripts/monitors/fake-depot.ts`: −23 (28 out; 4 in plus 1 import line, 227 → 204).
- `scripts/package.json`: +1.
- The source total is −77, matching the candidate. The `pnpm-lock.yaml` importer entry adds about 3 lines, for about −74 overall.

Payoff is moderate, not high. This is peripheral CI tooling, but it deletes a real concept pair and closes a real coverage hole.

Tests that pin the current behaviour, all through fakeDepot: `scripts/ci/depot.test.ts`, `scripts/ci/specs-shards.test.ts`, `scripts/ci/await-deploy.test.ts`, `scripts/monitors/e2e.test.ts` and `scripts/monitors/health.test.ts`.

## The flake dashboard gets its GitHub App token from @octokit/auth-app, as the platform does, not a hand-signed RS256 JWT

- Sweep index: 50; risk: low; payoff: 2/10
- LOC: About −70 net:
- update.ts:97-149: 53 lines → about 12
- update.test.ts: 59 → about 30
- package.json: +1 (skeptic measured: - update.ts: iterateAppIssuesToken is 53 lines (97-149) now and about 24 after; imports net −1; about −30 in total.
- update.test.ts: 59 → about 50 (−9).
- scripts/package.json: +1.
- pnpm-lock.yaml: +3.
- Net: about −35 lines; hand-written TS about −39. The candidate's −70 is roughly twice the real figure.)
- Concepts: 2 ways to mint a GitHub App token in the repo become 1.

### Evidence

- scripts/ci/flake-dashboard/update.ts:97-149 `iterateAppIssuesToken`:
  - builds an RS256 JWT with createSign;
  - calls /repos/{o}/{r}/installation and /app/installations/{id}/access_tokens with raw fetch;
  - retries neither call.
- apps/os pins @octokit/auth-app 8.3.1 (package.json:36) and uses createAppAuth at secret/durable-object.ts:1260-1266.
- update.test.ts (59 lines) checks our own RS256 signature with createVerify, so it tests the hand-rolled signer rather than dashboard behaviour.

### Current shape

One script hand-signs a GitHub App JWT and exchanges it for a narrowed installation token.

### Proposed shape

```ts
import { createAppAuth } from "@octokit/auth-app";
const auth = createAppAuth({
  appId,
  privateKey: String(createPrivateKey(pem).export({ type: "pkcs8", format: "pem" })),
});
const { data } = await createOctokit(
  (await auth({ type: "app" })).token,
).rest.apps.getRepoInstallation({ owner, repo });
const { token } = await auth({
  type: "installation",
  installationId: data.id,
  repositoryNames: [repo],
  permissions: { issues: "write" },
});
```

Add `"@octokit/auth-app": "8.3.1"` to scripts/package.json. Keep the test row that asserts the token is scoped to issues: write on this repository.

### What changes

- The same two GitHub calls, and the same narrowed token.
- JWT timing margins come from the library.
- The installation lookup gains createOctokit's retries.
- The test stops verifying our own RS256 signature.

### Pinned by

scripts/ci/flake-dashboard/update.test.ts

### Skeptic's amended proposal

The flake dashboard's GitHub App JWT and narrowed installation token come from @octokit/auth-app, the library apps/os already pins at 8.3.1. It stops hand-signing RS256 with createSign and exchanging through raw fetch.

scripts/ci/flake-dashboard/update.ts:

```ts
import { createAppAuth } from "@octokit/auth-app";
// drop: import { createSign } from "node:crypto"; import { z } from "zod";

export async function iterateAppIssuesToken(input: {
  appId: string;
  privateKey: string;
  owner: string;
  repo: string;
}) {
  // auth-app converts GitHub's PKCS#1 key itself on Node: no createPrivateKey/pkcs8 step
  const auth = createAppAuth({ appId: input.appId, privateKey: input.privateKey });
  const app = createOctokit((await auth({ type: "app" })).token);
  // owner/repo only: extra params on a GET become query-string params
  const { data: installation } = await app.rest.apps.getRepoInstallation({
    owner: input.owner,
    repo: input.repo,
  });
  const {
    token,
    permissions,
    repositoryNames = [],
  } = await auth({
    type: "installation",
    installationId: installation.id,
    repositoryNames: [input.repo],
    permissions: { issues: "write" },
  });
  return { token, permissions, repositories: repositoryNames };
}
```

Other files:

- scripts/package.json: add `"@octokit/auth-app": "8.3.1"`, then run `pnpm install` for the lockfile's importer entry.
- update.test.ts: keep the one row that asserts both URLs, the POST body `{repositories:["iterate"],permissions:{issues:"write"}}` and the returned `{token, permissions, repositories}`. The mock responses need `content-type: application/json` and `expires_at`. Drop the createVerify/JWT-signature block.

Proof: a `dry-run=true` dispatch of flake-dashboard.yml. It mints the token and logs `iterate app token for iterate: {"issues":"write","metadata":"read"}`.

Semantic delta:

- JWT iat/exp margins come from the library (−30/+570 instead of −60/+540).
- The installation lookup gains createOctokit's 5xx retries.
- The zod response validation goes.
- Errors become Octokit HttpErrors.

Concepts: the repo keeps one JWT signer (createAppAuth) instead of two. The platform still does its own access_tokens POST through pinnedDispatch, so the exchange is not unified.

### Skeptic's verdict

The candidate holds, but it is small, and its size and concept claims are overstated.

(a) Semantics. I ran @octokit/auth-app 8.3.1 against a mocked fetch with a PKCS#1 key. It makes the same two calls, `GET /repos/iterate/iterate/installation` and then `POST /app/installations/42/access_tokens` with body `{"repositories":["iterate"],"permissions":{"issues":"write"}}`. The JWT verifies against the public key, and the result carries `permissions: {issues: write, metadata: read}` and `repositoryNames: ["iterate"]`. These behaviours change:

- JWT times: iat moves from now−60 to now−30, and exp from now+540 to now+570. Both stay inside GitHub's 10-minute cap.
- The installation lookup gains createOctokit's CI_HTTP retries and `github.platform-failure-retry` warnings. The token POST is still not retried, because auth-app's own request is unwrapped. That matches today.
- The zod parse of GitHub's reply goes. The library's types are trusted instead, and a missing `repositories` becomes [] rather than a throw.
- Errors become Octokit HttpErrors carrying GitHub's message, not `GitHub <path> returned HTTP <n>`.
- Requests carry Octokit's User-Agent.

No caller depends on any of these. The only caller is `update()`, which logs `app.repositories` and `app.permissions`.

(b) Simpler, yes. Our code no longer has the JWT header, claims, base64url segments, createSign, the raw-fetch helper or the two zod schemas. It keeps two library calls. The claim that "2 ways to mint a token become 1" is only half true. The platform (apps/os/src/secret/durable-object.ts:1266-1287) uses createAppAuth only for the JWT, then POSTs access_tokens itself through pinnedDispatch. So what gets unified is the JWT signer, not the whole mint.

(c) No guarantee is dropped. The token is still narrowed to issues: write on this one repository, and a test row still pins the request body. The only loss is the row that checks our own RS256 signature, which would then test the library.

(d) LOC, re-measured by drafting the new code:

- update.ts: the function goes from 53 lines (97-149) to about 24. Imports lose createSign and z and gain createAppAuth, for a net of −1. Total about −30.
- update.test.ts: 59 → about 50. The JWT-verify block goes. The mock gains a content-type header and `expires_at`, because Octokit parses JSON only on that header and auth-app reads `expires_at`.
- scripts/package.json: +1.
- pnpm-lock.yaml: +3 (the scripts importer entry).
- Net: about −35, not the −70 claimed.

The spec had two errors:

- The proposed `createPrivateKey(...).export({type:'pkcs8'})` is unneeded on Node. universal-github-app-jwt 2.2.2's lib/crypto-node.js converts PKCS#1 itself. I checked this with a PKCS#1 key. That conversion exists only in the platform's workerd path.
- Passing `input` straight to getRepoInstallation would put appId and privateKey into the GET's query string, so pass only `{ owner, repo }`.

The original author (#2910) chose "node:crypto, no new dependency" on purpose. The trade is one dependency line, already locked at 8.3.1 for apps/os, against about 30 lines of bespoke crypto and fetch code. This is a real but minor instance of "a bespoke re-implementation of what a library the repo already pins does", in a peripheral hourly CI script. It is not heavy junk.

Risk is low. A dry-run dispatch proves it, because the token is minted before the dry-run branch. The behaviour is pinned by scripts/ci/flake-dashboard/update.test.ts (one row) and by scripts/ci/depot-workflows.test.ts, which covers only the workflow's env and triggers and is unaffected.

## notify.ts pages scheduled workflows through keepPage instead of a hand-rebuilt copy that has drifted

- Sweep index: 51; risk: low; payoff: 4/10
- LOC: About −40 net:
- notify.ts: 46 → about 18 lines
- its test: 55 → about 45 lines (skeptic measured: I built it in a scratch copy of origin/main (b3daf4846) at scratchpad/sim-notify/scripts, formatted with oxfmt, and ran the tests. tsc --noEmit on the scripts package is clean. notify.test.ts and slack.test.ts pass (64 tests). The depot-workflows.test.ts paging rows pass; its one failing row only lacks the .nvmrc symlink in the scratch copy.
- scripts/ci/notify.ts: 629 → 599 (+31 / −61, net −30)
- scripts/ci/notify.test.ts: 453 → 442 (+9 / −20, net −11)
- docs/depot-ci.md:808-809: one clause goes ("a red workflow whose failed jobs change also replies in its thread"), about −1 line
- Net about −41 lines
- The YAML, slack.ts and slack.test.ts do not change.)
- Concepts: 2 keepers of the same red-while-failing page become 1. Together with the DO-cost row, Slack page keepers go from 5 to 3.

### Evidence

- scripts/ci/notify.ts:541-586 (workflowPages, pageWorkflowFailure, resolveWorkflowPage) does find-open, post-or-edit and resolve itself.
- scripts/ci/slack.ts:291-311 `keepPage` does the same job, using `render(openText)` to carry forward `since` and `runs`.
- prd-post-deploy-check.ts:237 and context-sweep.ts:260 already page 'one page while a job is red' through keepPage.
- The two copies differ:
  - keepPage resolves older duplicate pages; notify leaves them open.
  - notify replies in the thread when the set of failing jobs changes; keepPage has no such reply.

### Current shape

kit-firmware.yml and os-crash-hunt.yml page through notify's own find-open/edit/resolve loop. context-sweep.yml's page, which does the same job, goes through keepPage.

### Proposed shape

```ts
async function workflowPage(
  slack: WebClient,
  input: { workflow: string; sha: string; runUrl: string; jobs?: string[]; now: Date },
) {
  return keepPage(slack, {
    marker: `${input.workflow} failed: `,
    sinceHours: WORKFLOW_PAGE_HOURS,
    now: input.now,
    why: `${input.workflow} green again at ${input.sha.slice(0, 7)}`,
    render: async (openText) => {
      if (!input.jobs) return undefined;
      const open = openText ? readWorkflowPage(input.workflow, openText) : undefined;
      return workflowPageText(
        {
          ...input,
          jobs: input.jobs,
          since: open?.since || input.sha,
          runs: (open?.runs ?? 0) + 1,
        },
        false,
      );
    },
  });
}
```

The YAML steps stay the same.

### What changes

- Older duplicate pages are resolved without naming anyone.
- A page that can no longer be edited is re-posted, and the old one is closed once.
- The '<workflow> now fails in <jobs>' thread reply goes; the edited page still names the jobs. An optional escalation hook on keepPage (about 5 lines) would restore it for every user.

### Pinned by

- scripts/ci/notify.test.ts:359-413
- depot-workflows.test.ts: '$file pages a red run on main…'
- slack.test.ts: keepPage rows

### Skeptic's amended proposal

Replace notify.ts:519-586 (readWorkflowPage, workflowPages, pageWorkflowFailure, resolveWorkflowPage) with:

```ts
/** The commit a workflow's page says it is red since, and for how many runs. Pure. */
function readWorkflowPage(text: string) {
  const [, since = "", runs = "0"] = / is red since (\w+), (\d+) runs?$/m.exec(text) || [];
  return { since, runs: Number(runs) };
}

/** Keeps `workflow`'s one page in #error-pulse (keepPage): a red run (its failed `jobs`) posts it
 *  or edits the open one, carrying since and runs forward; a green run resolves it. */
export function keepWorkflowPage(
  slack: WebClient,
  input: { workflow: string; sha: string; runUrl: string; jobs?: string[]; now: Date },
) {
  return keepPage(slack, {
    marker: `${input.workflow} failed: `,
    sinceHours: WORKFLOW_PAGE_HOURS,
    now: input.now,
    render: async (openText) => {
      if (!input.jobs) return undefined;
      const open = readWorkflowPage(openText || "");
      const page = {
        ...input,
        jobs: input.jobs,
        since: open.since || input.sha,
        runs: open.runs + 1,
      };
      return workflowPageText(page, false);
    },
    why: `${input.workflow} green again at ${input.sha.slice(0, 7)}`,
  });
}
```

Other changes:

- workflowFailure and workflowResolved both call keepWorkflowPage. workflowResolved passes no jobs.
- Drop the escalationText import and add keepPage.
- Header lines 13-14: "one page per workflow while it is red (keepPage). A repeat edits it."
- notify.test.ts:359-413:
  - Call keepWorkflowPage, with `jobs: undefined` for green runs.
  - Replace the "now fails in" reply assertion with `expect(page?.replies).toEqual([])` after the job set changes, and check that the edited first line names the new jobs.
- docs/depot-ci.md:808-809: drop "a red workflow whose failed jobs change also replies in its thread".
- No hook is added to keepPage. The YAML does not change.

### Skeptic's verdict

(a) Semantics.

- **Real delta, the escalation reply:** notify.ts:566-570 posts "🚨 <workflow> now fails in <jobs> @jonas @misha" in the page's thread when the failed-job set changes. This goes away.
  - It can never fire for os-crash-hunt.yml, which has one job in `needs`.
  - It can fire only for kit-firmware.yml. There the set is {plan}, {build}, {publish} or {build, publish}, because publish runs `always()` after a failed build.
  - Today it also pings on-call when things get better, e.g. {build, publish} → {build}.
  - The edited page still names the jobs.
  - Pinned only by notify.test.ts:385-388 and the notify.ts:13-14 header, plus the depot-ci.md:808-809 doc clause.
- **Older duplicate open pages:**
  - A red run now resolves them without naming anyone; today they are left open.
  - A green run resolves them without naming anyone; today resolveWorkflowPage (notify.ts:578) sends every duplicate its own reply mentioning both.
  - The new behaviour is what docs/depot-ci.md:789-790 already says every page does ("Older open pages of the same incident are marked resolved naming no one"), so today's code breaks the documented contract.
  - Both workflows have concurrency groups, so duplicates hardly ever happen. This part changes almost nothing in practice.
- **Resolve text:** keepPage marks the history text resolved as it is, instead of parsing and re-rendering it. The output is the same, because markResolved strips `:rotating_light:` and the mentions and the link come through unchanged.
- **Unparseable open page:** `since` falls back to the sha and the run count restarts at 1. Today it would read "red since , N+1 runs". This does not matter.
- **Unchanged:**
  - Edits of frozen or deleted pages still go through editPage.
  - Resolution of a frozen or deleted page still goes through resolvePage.
  - The channel, marker, 168h window, why text, 🧪 test-run paths and YAML steps are all the same.

(b) It is really simpler.

- **Removed:** the workflowPages finder, pageWorkflowFailure's post-or-edit branch, the resolve loop, the job-set comparison, and readWorkflowPage's parsing of jobs and runUrl. That parsing existed only for the comparison and the re-render.
- **Added:** one `keepWorkflowPage` with a render callback over keepPage. prd-post-deploy-check.ts:237, context-sweep.ts:260 and apps/os/scripts/preview.ts:1248 already use keepPage, and the docs describe it as the page convention.
- **Result:** there is one fewer bespoke page keeper, and the copy that had drifted is gone.

(c) No guarantee is dropped.

- The first page still pings, and resolution still pings once.
- Frozen and deleted pages are still handled the same way.
- Only the extra escalation ping, which is noisy and specific to Kit firmware, is lost.

(d) The LOC matches the candidate's figure of about −40.

Amendments to the proposal:

- Shrink readWorkflowPage to `function readWorkflowPage(text) { const [, since = "", runs = "0"] = / is red since (\w+), (\d+) runs?$/m.exec(text) || []; return { since, runs: Number(runs) }; }` and call it as `readWorkflowPage(openText || "")`. That drops the `open?.` / `?? 0` branches from the sketch.
- Do NOT add the escalation hook the candidate suggests for keepPage. It would put back a concept for a Kit-only edge case that pings on improvements too. Take the "almost" and say so.
- The "5 to 3 keepers" figure depends on another candidate. This change alone removes one.

## The evidence upload fans out with mapConcurrent instead of its own byte-budgeted pool

- Sweep index: 52; risk: low; payoff: 3/10
- LOC: About −39 net in test-evidence.ts: −44, +5. No test changes. (skeptic measured: I applied the patch to a scratch copy of scripts/ci/test-evidence.ts and diffed it: 708 → 667 lines, +6 −47, so −41 net. The diff adds one import line and a 5-line mapConcurrent call. It deletes the 3-line UPLOAD_BYTES_IN_FLIGHT constant and comment, the 5-line inPool docstring, the 36-line inPool body with its blank line, and the old 3-line call. docs/test-evidence.md:93 loses the phrase "holding at most 128 MiB of them" (0 lines net). No test file changes.)
- Concepts: 2 concurrency pools, one with a byte budget, become 1.

### Evidence

- scripts/ci/test-evidence.ts:362-402 `inPool` is 41 lines of hand-written scheduling with a failure latch.
- With the constants at :300-306 it caps work at 32 PUTs and 128 MiB of bytes in flight. The byte budget was written for traces and videos of tens of megabytes.
- Videos are off in CI (docs/test-evidence.md:62). Folders hold 10 to 53 files, about 1 MB for a specs job.
- scripts/ci/depot.ts:8-28 `mapConcurrent` is the repo's pool. sync-ci-telemetry.ts (5 places), ttg.ts:368 and flake-dashboard/evidence.ts:203 use it.

### Current shape

The R2 upload schedules its PUTs with a bespoke pool that counts requests and bytes. Every other fan-out in scripts/ci uses mapConcurrent.

### Proposed shape

```ts
await mapConcurrent(
  manifest.files.toSorted((a, b) => b.bytes - a.bytes),
  UPLOAD_CONCURRENCY,
  async (file) =>
    put(`${prefix}${file.path}`, file.path, await readFile(join(root, file.path)), file.sha256),
);
```

Delete `inPool` and `UPLOAD_BYTES_IN_FLIGHT`.

### What changes

- Bytes in flight are no longer capped: up to 32 files are held at once. That is a few MB for today's folders.
- After the first failed PUT, the other workers finish their current PUT and may start queued ones until `failStep` exits.
- The 90 s deadline and the manifest-last ordering are unchanged.

### Pinned by

scripts/ci/test-evidence.test.ts:347, :391, :425, :449, :541

### Skeptic's amended proposal

In scripts/ci/test-evidence.ts, add `import { mapConcurrent } from "./depot.ts";`. Delete UPLOAD_BYTES_IN_FLIGHT (:304-306) and inPool with its docstring (:362-402). Replace the call at :347 with:

```ts
await mapConcurrent(
  manifest.files.toSorted((a, b) => b.bytes - a.bytes),
  UPLOAD_CONCURRENCY,
  async (file) =>
    put(`${prefix}${file.path}`, file.path, await readFile(join(root, file.path)), file.sha256),
);
```

Keep UPLOAD_CONCURRENCY and its measured comment. The uploadTestEvidence docstring ("the largest first and up to UPLOAD_CONCURRENCY at once") stays true.

Drop "holding at most 128 MiB of them" from docs/test-evidence.md:93. Optionally add "and the evidence upload its PUTs" to mapConcurrent's docstring in depot.ts:8-10.

Semantics change:

- There is no byte cap. Worst case, the 32 largest files are held in memory, about 10 MB today.
- After the first failure, the other workers may start queued PUTs, but in production process.exit(1) comes first.

Net −41 LOC. No test changes, and all upload tests pass against the patch.

### Skeptic's verdict

I checked this against origin/main b3daf4846. PR #3446 does not touch scripts/ci/test-evidence.ts or depot.ts.

(a) Semantics. Three things could change.

1. The byte cap goes. It never takes effect in practice. The docs' own sizes (docs/test-evidence.md:223-227) say a folder is 0.33 to 3 MB when it passes and 9.9 MB for a failing 68-file Preview OS attempt. The REQUEST_TIMEOUT_MS comment says the largest file is "a few megabytes". Videos are off in CI, and VIDEO_MODE is set in no workflow. For the cap to bind, the 32 largest files would have to average more than 4 MB. No test pins the budget either: the pool test uses traces of 1 to 40 bytes.
2. After a failure, the remaining workers keep pulling queued files, where inPool's `failed` latch stops new starts. In production this makes no difference. The rejection travels as microtasks: Promise.all, then the await in uploadTestEvidence, then upload's catch, then failStep's synchronous reportStepFailure and process.exit(1). No further PUT can reach the network first. After the deadline, the aborted signal also kills any new request at once. In tests the extra requests happen but break no assertion.
3. No data guarantee is lost. The manifest is still PUT last and only after every file succeeded. A folder without a manifest is incomplete by definition, which inPool's in-flight PUTs already produce. The sha256 re-check, write-once PUTs, retries, the 60 s and 90 s deadlines, and largest-first order (by sorting the input) all stay the same.

I ran it. With the patch in a scratch copy, all 11 upload tests in scripts/ci/test-evidence.test.ts pass on three runs, including the 32-in-flight and largest-first test at :347. That covers the tests at :391, :425, :449 and :489, the token test and the changed-file test at :541. `node` imports the patched module with plain type stripping, and tsc reports no errors in either file. Importing depot.ts is cheap: it brings in the 51-line depot-api and platform-retry, which ci-bucket already loads.

(b) The new shape really is simpler. A 41-line hand-written scheduler with active and bytes counters, a latch, and a "file larger than the budget goes alone" rule that no test covers becomes a call to the pool every other fan-out in scripts/ci already uses (sync-ci-telemetry x6, ttg.ts:368, flake-dashboard/evidence.ts:203). That is two pool concepts down to one.

(c) The only guarantee dropped is the 128 MiB memory bound, and it protects against files CI does not produce. It is a Node process on a CI runner, not a 128 MiB isolate.

Corrections to the candidate's numbers:

- A specs folder is about 2.4 MB when passing and up to 9.9 MB when failing, not "about 1 MB".
- The net is −41, not −39.
- sync-ci-telemetry calls mapConcurrent 6 times, not 5.
- The doc line at docs/test-evidence.md:93 needs its "holding at most 128 MiB" phrase removed.

This is a real but small win in a peripheral CI script, so the payoff is modest.

## loc-report strips comments with the oxc parser it already imports, not a hand-written lexer that eats regex literals

- Sweep index: 53; risk: low; payoff: 3/10
- LOC: About −41 net: loc-report.ts lines 237-285 (49 lines) become about 8. (skeptic measured: I applied the proposal to a scratch copy of scripts/ and formatted it with oxfmt at printWidth 100, where the loop body wraps to 4 lines. scripts/ci/loc-report.ts goes from 425 to 386 lines: 10 insertions, 49 deletions, −39 net. All 15 tests in scripts/ci/loc-report.test.ts pass on both the current and the proposed code. tsc reports no new errors in loc-report.ts. PR #3446 does not touch loc-report.ts.)
- Concepts: 2 source-understanding mechanisms in one file become 1.

### Evidence

- scripts/ci/loc-report.ts:237-285 `stripJsComments` is a 42-line state machine. Its doc admits that a regex containing `//` or `/*` 'will eat the rest of its line'.
- It also treats JSX text as code, so a URL in JSX copy loses its `//…`.
- The same file already imports oxc-parser (:8) and parses TSX with it (:147-167).
- Checked: `parseSync(...).comments` returns every comment with its offsets.

### Current shape

Significant-line counting removes comments with a lexer that tracks string and template state but not regex literals or JSX text.

### Proposed shape

```ts
function stripJsComments(path: string, source: string) {
  let stripped = source;
  for (const { start, end } of parseSync(path, source).comments.toReversed())
    stripped =
      stripped.slice(0, start) +
      source.slice(start, end).replace(/[^\n]/gu, "") +
      stripped.slice(end);
  return stripped;
}
```

### What changes

- Regex literals and JSX text containing `//` or `/*` are no longer truncated, so those lines now count as Significant.
- A file that fails to parse keeps whatever comments oxc recovered.
- Ordinary code counts the same.

### Pinned by

scripts/ci/loc-report.test.ts:91, :117, :138, :155

### Skeptic's amended proposal

The candidate is right, with two amendments.

(1) The semantic delta needs two more lines:

- `#!` hashbang lines drop out of Significant, because oxc reports them as comments. Today this affects only packages/cli/bin/iterate.js.
- A .js file that fails to parse keeps its comments after the error point. That includes JSX in a .js file, since oxc parses .js without JSX. No such file exists on main.

(2) Add one test row that pins the fix, for example: a .ts file whose line `const scheme = /^https?:\/\//i.exec(url); // why` changes only in its trailing comment should give significantAdded 0 and significantRemoved 0. Under the old lexer it counts 1/1.

Shape as measured after oxfmt (scripts/ci/loc-report.ts, replacing lines 237-285, and changing the call at :192 to `stripJsComments(path, content)`):

```ts
/** Blanks every comment oxc finds, keeping its newlines so each line stays where it was. */
function stripJsComments(path: string, source: string) {
  let stripped = source;
  for (const { start, end } of parseSync(path, source).comments.toReversed())
    stripped =
      stripped.slice(0, start) +
      source.slice(start, end).replace(/[^\n]/g, "") +
      stripped.slice(end);
  return stripped;
}
```

This takes the file from 425 to 386 lines (−39 net), with the same 15 tests passing.

Do not add a throw on parse errors. That would fail the whole PR report over one broken .js file, and TS files already throw through transformSync.

### Skeptic's verdict

(a) The semantics are almost identical, and I checked that against the whole repo. I ran the current lexer and the oxc version through the full significantLines pipeline (transform, source map, JSX text) on all 1072 tracked JS and TS files on main:

- 19 files produce different Significant content.
- The Significant line count changes in only 1 file, by 1 line.

Every content difference is a fix of the old lexer:

- **Regexes with `\/\/` are cut off.** Examples: `/^https?:\/\//i` in apps/dash collect-secret.$slug.tsx:309, `.replace(/\//g, "_")` in dummy-petshop/src/seal.ts:39, and module-resolution.ts.
- **A quote inside a regex stops trailing-comment stripping.** A regex containing a quote puts the lexer in string state, so the trailing comment stays. Example: agents.e2e.test.ts:807 `/not a loaded worker's word/ // itx.builtins`.
- **A backtick inside a regex leaves many comments in place.** A regex containing a backtick puts the lexer in template state across many lines, so dozens of whole-line comments are never stripped. Examples: voice-agent.e2e.test.ts:66 `/^[^`]*```json\n|.../`and control-plane-contexts.test.ts:66`/no `?\.?user|.../`. For .ts files the runtime-line filter already drops those comment-only lines, so counts barely move. For .js/.mjs files they would count as Significant.

So the "known limitation" in the docstring is not rare: it affects 19 files on main.

Two deltas are missing from the candidate:

1. **Hashbangs.** oxc reports a hashbang as a Line comment, so `#!/usr/bin/env node` drops out of Significant. That is the one count change, in packages/cli/bin/iterate.js, which is the only hashbang file in the repo.
2. **Parse errors.** On a parse error, oxc only keeps comments that come before the error point, and recovers nothing after it. For example, a `.js` file containing JSX fails, because oxc parses .js without JSX. Every JS/TS file on main parses cleanly (0 errors), and TS files already throw on transform errors. So this only matters for a future syntactically broken .js file, where comments after the error would count as Significant. No test or caller depends on any of these behaviours.

(b) It is genuinely simpler, not a lateral move:

- A hand-written 4-state lexer (42 lines, plus a 7-line doc apologising for its bug) is replaced by 8 lines.
- The new code asks the parser the file already imports (:8) for comment spans. That parser already parses the same content in jsxTextLines (:165).
- Concepts go from 2 ways of reading source to 1.
- The cost is one extra oxc parse per file version: about 2 s across all 1072 files, which is negligible for a CI report.

(c) No guarantee is dropped. This only affects a PR-body LOC report.

(d) Measured −39 net, not "about −41".

The tests do not pin the lexer's bugs. Only test :155 (a JS line comment) exercises stripping directly, and it passes. The tests at :91, :117 and :138 exercise significantLines but do not depend on how comments are stripped.

The payoff is modest (3) because this is a peripheral CI script. It is still a clear instance of "a bespoke re-implementation of something the library already does", and the hand-written version is buggy.
