# EXPERIMENT: real preview CI comparison

Status: control running; treatment prepared and awaiting dispatch. This supersedes the local serial timing comparison for CI decisions. No PR and no default-main/PR policy change.

The branch invokes the existing `preview-main.yml` / `preview-run.yml` pipeline: parallel six-app deployment, shared readiness, app tests, all six browser shards, test verdict/trace collection, then ordinary post-test erase and restoration. Package publishing now includes this exact branch; each CI run uses its own SHA's packages.

Experiment dispatches have their own concurrency group and per-run lease holder. They cannot take the `main-preview` holder. No production Semaphore changes. The experimental receipt accepts only this branch, a slot parked for at least 150s before release, unchanged release timestamps before and after a non-forced claim, and a live 503 Worker with exactly six sandbox classes and no ordinary OS or streams DO namespaces.

The treatment skips entry erasure and the 90s gate only after that proof. The control uses ordinary acquisition/erasure and the existing guard. Preparation runs outside CI and its cost will be reported separately. This comparison does not implement a production background cleanup scheduler or service tags.

Control head: `45cfbc024541cddfbf2acf413843d170fd3bbb3a`.
[Control workflow](https://depot.dev/orgs/0p91s0lz49/workflows/hbhqf2t6bz), run `9773d9q0hm`.

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

A competing claim invalidates the receipt. Do not edit the timestamps to make it pass; prepare another available slot and retain the failed dispatch as evidence. Normal finalization erases test data and restores a human-usable preview under its existing lease. The final audit will record actual owners and expiry times.

Raw workflow logs, artifacts and preparation journals stay in `evidence.ignoreme/ci-sept18/`. Results pending.
