---
status: complete
size: medium
---

# Retire preview DOs, then restore the tested deployment

Experiment complete: full preview passed, showed green 72s before cleanup ended,
and restored fresh namespaces. Failure/cancellation, application use and recovery
were verified. The draft PR records provider/container limits and an unrelated
expired-test CI failure. No merge is authorized.

## Request and decisions

- Start from current main, not the closed storage-wipe experiment. Keep the
  existing class-retirement reset, then redeploy the real app code/configuration
  on the same slot. Do not resurrect deleted namespaces or restore old data.
- Limit the new behavior to post-test cleanup. Pre-deploy reset and final
  PR-close/expiry reclamation retain their existing behavior. Keep the lifecycle
  lock until restoration finishes, and refuse stale-head/foreign-lease writes.
- Prefer the existing deploy machinery so secrets, assets, service bindings,
  container metadata and DO exports are restored consistently. Determine whether
  a direct snapshot/re-upload is actually simpler before adding another deploy
  implementation. Use the exact tested checkout and record new Worker versions.
- After all consumers settle and their results are validated, let test success
  show green while post-test work continues. Do not overwrite a failed test or
  another attempt's result. Investigate updating the exact Depot-owned check;
  a same-named commit status does not replace that check. If this cannot work
  reliably, use an explicit test result and separate cleanup reporting instead.
- Cleanup/restoration failure must produce red on the originating commit.
  Verify success, failure, cancellation and stale-run behavior experimentally;
  do not quietly swallow errors or change repository protection settings.
- Restore application usability, not merely HTTP 200. Prove old non-container
  namespace IDs were retired, fresh project/stream work succeeds, deployed
  versions and bindings match, and leftover work is not burning resources.
  Existing retained container-class limitations must be stated explicitly.
- Produce a clear report and PR body with measured test-green time, cleanup/
  restoration time, platform constraints, cancellation behavior and verdict.
  A negative result is acceptable; avoid product hacks to force success.

## Work

- [x] Research current restore machinery and GitHub/Depot check ownership. *Reuse app deploy commands; job token can update its exact Depot check.*
- [x] Implement and test the smallest post-test park/restore path. *`preview erase --restore` retires first, then restores Auth, OS and Streams from the tested checkout.*
- [x] Implement and test honest early-green/final-failure reporting. *`status.ts tests-passed`; live checks 105090329542 and 105090616821 changed from success to failure/cancelled.*
- [x] Run preview experiments, including an injected cleanup failure and recovery. *First full run restored successfully; dirty-checkout guard refused only after retirement, then clean recovery passed.*
- [x] Validate resulting namespaces, fresh application behavior and activity. *Ten namespaces replaced; fresh project, schedule and login worked. Retained containers were quiet in the measured window; ordinary OS analytics lacked a positive control.*
- [x] Complete local checks, independent review and CI/review follow-up. *360 scripts tests and all preview jobs passed; only the unrelated expired-test check remains red. Global PR monitor retains follow-up ownership.*
- [x] Publish report, update PR and mark task complete. *`docs/preview-park-restore-experiment.md` records successful/failed traces, timing, state, telemetry and limitations.*

## Implementation log

- Base: main `8f8ff8d695`. Previous experiment PR #2693 is closed. The change-type
  planner branch is preserved separately and is not part of this experiment.
- Acceptance distinguishes GitHub's check status from Depot's real job state;
  advancing the former must not release locks or start consumers early.
- GitHub Check Run 105090329542 was completed/success at 05:41:59Z while Depot
  workflow `gkjq471vd3` remained running, then failure at 05:43:00Z. Check
  105090616821 was success at 05:44:26Z, then cancelled at 05:46:19Z. Both
  synthetic probes used no preview resources and intentionally ended non-green.
- Independent review caught and fixed two safety issues: restoration validation
  must follow ordinary retirement, and its deployment config must come from the
  semaphore lease rather than editable PR state.
- Local typecheck, lint and knip passed before the final review adjustments;
  the scripts suite passed all 360 tests. Full tests reveal an existing expired
  parked test in `specs/repo-ide-jsonc.spec.ts` (revisit by 2026-09-16); this
  experiment does not hide or renew it.
- Full workflow `xg4ww10ws2` on `827ee33e9`: all six browser shards and all
  218 OS e2e tests passed. Streams' anonymous `openConnection` test failed twice:
  after waiting for the expected event it assumed the latest callback batch was
  still that event, but a background feed projection arrived afterwards. The
  small assertion fix checks delivery by offset and still checks closed-client
  exclusion; a focused authenticated live rerun passed.
- The failed test correctly prevented early green. Retirement took 17.0s and
  Auth/OS/Streams restoration 56.6s. All ten ordinary OS/Streams namespaces
  changed; six Sandbox namespaces stayed. Fresh project creation, scheduled
  script-to-stream delivery and real Auth-to-OS login passed afterwards.
- Deliberately dirtying only this task file made `erase --restore` retire first
  (27.7s), then fail the clean-checkout guard. Both Workers served 503. The file
  was restored byte-for-byte; clean recovery completed at 06:00:24Z. Probe state
  was retired too. No probe/failure switch is shipped in product code.
- Full workflow `lnhxm1vn0t` on `151dc2f93`: all nine preview jobs passed.
  Finish check 105095187178 went green at 06:07:46.779Z while Depot kept running
  until 06:08:59Z. Reset took 18.2s and restoration 45.1s. Namespace readback
  again showed ten replacements and six retained Sandbox namespaces.
- Final reporting adjustment publishes the parked state before checking restore
  provenance, so an intentionally refused restore cannot leave an old success
  notice. Independent review approved this ordering; scripts tests/typecheck pass.
