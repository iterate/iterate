---
status: in-progress
size: medium
---

# Remove Archil

Status summary: Task is specified and ready for implementation. The goal is to remove the dead Archil codepath completely so local dev and CI no longer try to provision Archil R2 resources.

## Goal

Remove all Archil-specific code, configuration, environment variables, bindings, scripts, tests, and documentation from the active application surface. Archil is a dead codepath and should not be provisioned, configured, or referenced by runtime code.

## Checklist

- [ ] Remove Archil Cloudflare/Alchemy resources and Worker bindings.
- [ ] Remove Archil runtime environment variables, schemas, and backend usage.
- [ ] Remove Archil API key/global-secret seeding and related docs.
- [ ] Remove Archil tests, helpers, scripts, and package dependencies that are no longer used.
- [ ] Search the repo for remaining Archil references and either remove them or explicitly justify any historical references left behind.
- [ ] Run targeted typecheck, lint, and tests for touched workspaces.
- [ ] Update the pull request title/body with the net behavior change and validation.

## Assumptions

- Archil-backed project filesystem/persistence is no longer used by production or local development.
- It is acceptable for any old persisted Archil configuration to become inert and ignored after this PR.
- Historical references in closed task files or generated artifacts can be left only if removing them would create unrelated churn.

## Implementation Notes

- 2026-05-11: Created from the request to unblock repeated CI/local-dev failures caused by Archil R2 provisioning for `os-archil-data-dev-nobody`.
