---
status: complete
size: medium
---

# Remove Archil

Status summary: Implementation is complete locally. Active OS runtime, Alchemy provisioning, sandbox startup, package dependency, and historical experiment/doc references were removed; PR CI remains the external confirmation point.

## Goal

Remove all Archil-specific code, configuration, environment variables, bindings, scripts, tests, and documentation from the active application surface. Archil is a dead codepath and should not be provisioned, configured, or referenced by runtime code.

## Checklist

- [x] Remove Archil Cloudflare/Alchemy resources and Worker bindings. _Removed the `R2Bucket("archil-data")` resource plus `ARCHIL_R2_\*`bindings from`apps/os/alchemy.run.ts`.\_
- [x] Remove Archil runtime environment variables, schemas, and backend usage. _Removed `ArchilApiKeys`, region config fields, env typing, and machine-creation disk provisioning._
- [x] Remove Archil API key/global-secret seeding and related docs. _No global secret config remained; deleted the customer config source doc that was centered on Archil sync options._
- [x] Remove Archil tests, helpers, scripts, and package dependencies that are no longer used. _Deleted the OS integration module, sandbox mount script, benchmark experiment, Dockerfile install step, and `@archildata/client` dependency._
- [x] Search the repo for remaining Archil references and either remove them or explicitly justify any historical references left behind. _`rg` only finds this completed task file after the lockfile regeneration._
- [x] Run targeted typecheck, lint, and tests for touched workspaces. _Ran OS/sandbox/pidnap typechecks, oxlint, sandbox tests, focused pidnap test, focused OS webhook test, and `git diff --check`._
- [x] Update the pull request title/body with the net behavior change and validation. _Done after implementation commit._

## Assumptions

- Archil-backed project filesystem/persistence is no longer used by production or local development.
- It is acceptable for any old persisted Archil configuration to become inert and ignored after this PR.
- Historical references in closed task files or generated artifacts can be left only if removing them would create unrelated churn.

## Implementation Notes

- 2026-05-11: Created from the request to unblock repeated CI/local-dev failures caused by Archil R2 provisioning for `os-archil-data-dev-nobody`.
- 2026-05-11: Removed active provisioning and sandbox mount code, deleted old experiments/docs, regenerated `pnpm-lock.yaml`, and validated touched packages.
