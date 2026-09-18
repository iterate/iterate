# EXPERIMENT: real preview CI comparison

Status: both full CI runs finished, passed and restored their previews. The treatment reached green 94.554s (24.2%) sooner than the control. This supersedes the local serial timing comparison for CI decisions. No PR and no default-main/PR policy change.

The branch invokes the existing `preview-main.yml` / `preview-run.yml` pipeline: parallel six-app deployment, shared readiness, app tests, all six browser shards, test verdict/trace collection, then ordinary post-test erase and restoration. Package publishing now includes this exact branch; each CI run uses its own SHA's packages.

Experiment dispatches have their own concurrency group and per-run lease holder. They cannot take the `main-preview` holder. No production Semaphore changes. The experimental receipt accepts only this branch, a slot parked for at least 150s before release, unchanged release timestamps before and after a non-forced claim, and a live 503 Worker with exactly six sandbox classes and no ordinary OS or streams DO namespaces.

The treatment skips entry erasure and the 90s gate only after that proof. The control uses ordinary acquisition/erasure and the existing guard. Preparation runs outside CI and its cost is reported separately. This comparison does not implement a production background cleanup scheduler or service tags.

Control head: `45cfbc024541cddfbf2acf413843d170fd3bbb3a`.
[Control workflow](https://depot.dev/orgs/0p91s0lz49/workflows/hbhqf2t6bz), run `9773d9q0hm`.
[Control trace](https://depot-01a0b662-9f5c-715d-8143-1ee956452358--iterate.iterate.app/).
Treatment head: `16f37f3ed829b92530ea04fcbb479effbb710c38`, [workflow](https://depot.dev/orgs/0p91s0lz49/workflows/bs27zm4zhm), run `z3jn76jx8p`.

## Measurements

| Run                                | Time to green test verdict | Shared readiness | OS deploy |
| ---------------------------------- | -------------------------: | ---------------: | --------: |
| Recent main, `97ffd6fd65`          |                   430.652s |         115.693s |   85.546s |
| Experimental control, `45cfbc024`  |                   391.084s |         121.508s |   74.177s |
| Aged parked treatment, `16f37f3ed` |                   296.530s |          36.939s |   68.428s |

All three runs include all browser shards and app tests. The control's rollout-settle subprocess took 94s; its smoke subprocess took 121s including the gate. The treatment took 0s and 36s respectively. Acquisition/entry cleanup fell from 10.060s to 2.301s. There were no job reruns, but two individual treatment tests needed retries (details below). Time to green comes from the trace's acknowledged GitHub-check timestamp, not the later cleanup completion. Preparation of treatment slot 8 took 168.999s, including the 150s rest; that cost is outside CI and must be supplied by a future pool-retirement mechanism.

[Treatment trace](https://depot-01a0b669-d0af-796f-97d1-8fa36bbd5941--iterate.iterate.app/).

This is one control/treatment pair, not a reliability estimate. The product source is the same; CI wiring and package SHAs differ. Slot, deployment and test timing also vary. The directly measured readiness saving was 84.569s, which accounts for most of the 94.554s total saving. Against the recent main run, the total saving was 134.122s.

The 168.999s preparation happened before dispatch. A cold, serial preparation plus treatment would be 465.529s before queue gaps, so this only improves the commit path when the pool already contains rested slots. It does not prove that a 150s park is the minimum safe rest or that this holds under pool exhaustion.

[Recent main workflow](https://depot.dev/orgs/0p91s0lz49/workflows/s7r9sxkwnr).

## Commands

Depot registers automatic workflow triggers from main. Adding a Depot push trigger only on this branch would not start it; use the existing dispatch entry point. The GitHub package publisher's exact branch push trigger does run on the branch.

```sh
# Control: no receipt, ordinary 90s gate.
depot ci dispatch --org 0p91s0lz49 --repo iterate/iterate \
  --workflow preview-main.yml --ref codex/experiment-preview-lease-cycling

# Prepare a candidate from an explicitly allowed list, never evicting a holder.
RUN_LEASE_CYCLING=1 doppler run --project _shared --config prd -- \
  pnpm exec tsx experiments/preview-lease-cycling/prepare-ci.ts \
  my-ci-experiment preview-4,preview-6

# Treatment: use the non-secret receipt, after this head's package publish passes.
depot ci dispatch --org 0p91s0lz49 --repo iterate/iterate \
  --workflow preview-main.yml --ref codex/experiment-preview-lease-cycling \
  --input "lease-cycling-receipt=$(cat experiments/preview-lease-cycling/evidence.ignoreme/my-ci-experiment/ci-receipt.json)"
```

A competing claim invalidates the receipt. Do not edit the timestamps to make it pass; prepare another available slot and retain the failed dispatch as evidence. Normal finalization erases test data and restores a human-usable preview under its existing lease. The final audit below records actual owners and expiry times.

Raw workflow logs, artifacts and preparation journals stay in `evidence.ignoreme/ci-sept18/`. No generated artifacts are committed.

## Treatment telemetry and retries

The Cloudflare query returned **zero** records matching `Durable Object reset because its code was updated` for `os-preview-8`, from OS deployment completion (21:23:20.823 UTC) to the acknowledged green verdict (21:26:19.530 UTC). This is bounded telemetry evidence, not proof that no reset can happen later or outside captured logs.

The finalizer reported two tests that each passed after one retry:

- Root stream restart/re-install test: expected a consumed/locked response error but got `Promise did not settle within 2000ms`.
- Mobile chat-title browser test: title locator timed out with a 1ms remaining timeout.

Neither reported the code-update-reset message. Their causes were not established in this experiment; they are not silently counted as first-attempt passes or declared harmless. The normal control had no retry notice.

Validation of the branch-only policy: 60 focused tests, scripts typecheck, preparer typecheck, and focused lint passed.

## Control reset incident

The normal 90s control still had one StreamDurableObject alarm code-update reset, 169.742s after the CI deployment command completed. Two telemetry records represent the same incident. The suite passed; recovery of that alarm has not been proved. [Exact evidence and follow-up](../../tasks/preview-alarm-reset-after-rollout-gate.md). Do not describe the control as reset-free or the guard as a guarantee.

## Restoration and ownership audit

Both `preview-settled` statuses are successful with `tests=success; deployment=restored`. Control settled at 21:20:47 UTC (8m50s from workflow start); treatment at 21:28:14 UTC (6m51s). These include the later cleanup/restoration, which the time-to-green numbers deliberately exclude.

At 21:28:33 UTC, both restored OS health endpoints returned 200 with their new post-test versions:

| Slot       | Holder                          | Lease expires (UTC, Sep 19) | Restored OS version                    |
| ---------- | ------------------------------- | --------------------------- | -------------------------------------- |
| preview-12 | `lease-cycling-181895276484469` | 00:18:33                    | `ed0fc532-416e-4469-99d4-2a8e26795905` |
| preview-8  | `lease-cycling-573139975417461` | 00:26:24                    | `95935ae0-9afe-4776-a057-b33d2f2ec406` |

These are intentionally retained human-usable previews under the normal three-hour CI leases. The preparer's lease was released before CI claimed preview-8; it has no leftover ownership. No main-preview lease was taken. There was no forced claim or Worker deletion in these CI runs.

A separate observer sampled the control preview 78 times, from 21:22:07.199 to 21:28:42.361 UTC, spanning treatment deployment, testing and restoration. Every sample returned 200 and the same restored OS version. This proves sampled HTTP availability/version continuity, not continuous application-write correctness. The observer was stopped after treatment settlement.

## What to do with this result

Continue the pool-lifecycle experiment: the real parallel CI path saved about 95s with a pre-rested slot. Keep the production 90s default while investigating the control alarm incident and treatment retries and collecting more representative runs. Automated retirement, slot metadata, exhaustion handling and proof that human previews remain useful between commits are still separate implementation work; this branch does not claim to deliver them.

## Follow-up: depth-ten Plan checkout

Plan now uses `fetch-depth: 10` unconditionally. If the fetched graph has no common ancestor with main, or main is not present, the planner selects a fresh deploy before looking up inherited results or reusable deployments. Available ancestry still supports reuse; unrelated Git failures still throw.

At head `d22ce69c0`, a [Plan-only Depot probe](https://depot.dev/orgs/0p91s0lz49/workflows/1gr09jtb7s) passed (run `z22nr9pnbp`). It copied the actual Plan job and runner image, supplied full-preview inputs and explicit branch metadata, and omitted deployment/test jobs. Fetching took **1.008s** (21:53:34.707–21:53:35.715 UTC), versus **28.165s** in the earlier full-history treatment Plan job. This measures checkout, not another end-to-end CI speedup.

24 focused workflow/planner tests, scripts typecheck and focused lint passed. Real shallow-clone tests cover absent main, a merge base beyond the ten-commit window, and successful inheritance when the merge base is available. The two missing-history cases failed before the change.

Three earlier isolated probes (`jkd793dfj8`, `g6q37pk1hv`, `z5x988xldw`) failed while wiring dispatch inputs/branch metadata; they did not deploy anything. The successful probe supplies the branch directly to the command because the local-run provider overrides the workflow-level GitHub ref environment. Raw probe YAML, statuses and logs remain in `evidence.ignoreme/depth10/`. No PR.
