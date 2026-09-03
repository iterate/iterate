---
status: in-progress
size: medium
---

# Flake records: webhook-pull ingestion, no CI credential

**Status summary:** Replaces the just-merged push-lane (CI holds the project API key, POSTs to `/flakes` via itx) with a pull-lane: CI only uploads a workflow artifact, and the platform ingests it when GitHub's `workflow_run: completed` webhook arrives. Kills the `FLAKE_REPORT_*` secrets entirely.

## Why

The push lane made CI hold the project API key — the project's root credential — when all these jobs should be able to affect is what GitHub already lets them affect. The platform already receives signed GitHub webhooks as `events.iterate.com/github/webhook-received` events on `/integrations/github/<connection>` streams (verified empirically on prd: `workflow_run` deliveries are already flowing), and the App's installation token has Actions read (verified: can list workflow runs + artifacts). So the trust statement shrinks to "GitHub said this run produced these records", authenticated entirely platform-side.

## Design

- CI (test.yml): keep `FLAKE_RECORD_DIR`; replace the doppler reporter post-step with `actions/upload-artifact` of the record dir, artifact name `flake-records-<suite>` (`if-no-files-found: ignore`). Delete `packages/iterate/scripts/report-flake-records.ts`.
- Mapper (flake-dashboard starter app, config-worker side): on `github/webhook-received` with `delivery.name === "workflow_run"` and `action === "completed"`, list the run's artifacts; for each `flake-records-*` artifact, download the zip (App installation token), unzip (`fflate`), parse `.jsonl` lines against the `FlakeRecord` schema (bad lines skipped), and append one `flakes/run-recorded` per artifact with idempotency key `flakes/run:<run_id>-<run_attempt>:<suite>` — webhook redeliveries and event-delivery retries dedupe. Branch/commit come from the webhook's `workflow_run` payload; birth certificate offered from the webhook's repository (+ its `default_branch`).
- No changes to the processor, contract events, or dashboard render.

## Checklist

- [ ] Mapper in the flake-dashboard app + `fflate` bundled into the configured worker
- [ ] Unit tests: real zip bytes (fflate zipSync) through a fake octokit → appended run-recorded; non-matching webhooks ignored; bad lines skipped; idempotency key shape
- [ ] test.yml: upload-artifact step replaces the doppler reporter step; reporter script deleted
- [ ] Task/docs updates (`tasks/flake-dashboard.md` ops list: FLAKE_REPORT_* secrets no longer needed — unset from `_shared/prd`)

## Post-merge ops

- [ ] Unset `FLAKE_REPORT_*` in `_shared/prd` Doppler (push-lane reporter is gone) — and consider rotating the project API key (a fragment echoed into a local session transcript during setup)
- [ ] Update the live iterate project's config worker to the new package build (the mount is already live; the mapper rides the same `iterate@main` bump)
- [ ] Confirm ingestion on a real CI run: `flakes/run-recorded` appears after the workflow_run webhook, issue updates
