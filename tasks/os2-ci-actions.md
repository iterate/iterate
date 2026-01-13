---
state: todo
tags:
  - infrastructure
  - ci
dependsOn:
  - tasks/deprecate-apps-os.md
priority: high
size: medium
difficulty: low
---

# CI Actions for os2

Add GitHub Actions workflows for os2:

## 1. Deploy os2

Create a deploy workflow for os2 (similar to the existing `deploy-os` job in `.github/workflows/deploy.yml` but pointing to `apps/os2`).

- Deploy using `apps/os2/alchemy.run.ts`
- Should support staging (`stg`) and production (`prd`) stages
- Needs Doppler setup for environment variables (project likely needs to be `os2` or reuse `os`)
- Already has `GITHUB_OUTPUT` support for worker URL (see `alchemy.run.ts` lines 243-247)

## 2. Update Daytona Snapshot

Create a workflow to build and publish the sandbox snapshot:

- Run `apps/os2/sandbox/daytona-snapshot.ts` to create/update the Daytona snapshot
- Requires `DAYTONA_API_KEY` environment variable
- Builds from `apps/os2/sandbox/Dockerfile`
- Snapshot names are derived from stage + timestamp, and the app uses `DAYTONA_SNAPSHOT_PREFIX`

### Considerations

- Snapshot prefix is configured via `DAYTONA_SNAPSHOT_PREFIX` in `alchemy.run.ts`
- Snapshot updates should probably be manual/on-demand rather than on every deploy
- Need to coordinate snapshot version bumps with deploys that reference them

## Implementation Notes

The existing `deploy.yml` is auto-generated (see comment on line 1), so check if there's a `deploy.ts` generator script that needs updating, or if we should create a separate workflow for os2.
