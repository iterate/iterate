---
status: in-progress
size: medium
---

# Flake ingestion: check_run trigger + Depot artifact pull

**Status summary:** Supersedes #2571's `workflow_run` design, which never fires for this repo: the test suites run on Depot CI, whose jobs are GitHub *check runs*, not GitHub Actions workflow runs — no `workflow_run` webhook, and `upload-artifact` lands in Depot's store, not GitHub's. Verified empirically: GitHub's workflow-runs API lists only `.github/workflows` (pkg.pr.new, Claude Assistant). Since #2571 merged, no CI flake records flow at all (the push-lane reporter is deleted).

## Design (all facts verified against depot/cli source + a live prd webhook sample)

- **Trigger:** `github/webhook-received` with `delivery.name === "check_run"`, `action === "completed"`, conclusion success/failure. Live sample carries everything needed: `check_run.head_sha`, `check_run.check_suite.head_branch`, `repository.full_name`. Suite-agnostic — a new suite needs only an artifact upload step, no server change.
- **Resolution:** Depot Connect RPC as plain JSON POSTs from the worker (`https://api.depot.dev/depot.ci.v1.CIService/<Method>`, `Authorization: Bearer <token>` + `x-depot-org`): `ListRuns {repo, sha}` (sha matches either merge sha or head_sha) → `run_id` → `ListArtifacts` → filter `flake-records-*` → `GetArtifactDownloadURL` → short-lived signed HTTPS URL → fetch zip → existing unzip/parse/append path.
- **Auth:** a Depot org API token as a platform-held project secret (`/secrets/depot-ci-token`), revealed at ingest time. CI still holds zero iterate credentials; the *project* holding a Depot read credential is the accepted trust shape.
- **Idempotency:** run-recorded keys stay `flakes/run:<depot run_id>-<artifact.attempt>:<suite>`. Multiple check_runs completing on one Depot run each trigger a scan — repeated downloads are bounded (5MB cap, few checks per run) and repeated appends dedupe on the key.

## Checklist

- [ ] contract.ts: `CheckRunWebhookEvent` replaces `WorkflowRunWebhookEvent`
- [ ] worker.ts: ingestion reworked — depot RPC calls, secret reveal, run resolution; unzip/parse/append unchanged
- [ ] Tests reworked: check_run webhook shape, stubbed fetch for the depot RPCs + signed download, zip fixtures kept
- [ ] tasks/flake-webhook-ingestion.md post-merge ops corrected (its confirmation steps can never pass)

## Post-merge ops

- [ ] Create the project secret: an org API token from Depot (same kind as `DEPOT_CI_TELEMETRY_TOKEN` in Doppler `_shared/preview`) stored as `/secrets/depot-ci-token` on the iterate prd project
- [ ] After the next prd deploy + config-worker rebuild, confirm a real CI run's records arrive via check_run ingestion, then delete the `FLAKE_REPORT_*` Doppler secrets (push-lane fully retired)
