# Estates

This directory contains several different estate configurations.

## Notable Estates

- **`estates/template/`** - Starter config that new customers get when they sign up for Iterate. Automatically synced to `iterate-com/template-estate` on each merge to main (see below).
- **`estates/iterate/`** - Iterate's own company config.
- **`estates/garple/`** - A real toy business we sometimes use for testing

## Template syncing

The `estates/template/` directory is automatically synced to the `iterate-com/template-estate` repository via GitHub Actions.

**Workflow**: `.github/workflows/sync-template-estate.yml`

**Trigger**: Pushes to main that modify `estates/template/**`

**Authentication**: Uses `TEMPLATE_ESTATE_SYNC_TOKEN` secret (personal access token from Jonas's github account) with repo permissions to push to `iterate-com/template-estate`.

**Process**:

- Removes all files from target repo (except `.git`)
- copies all files from `estates/template/`
- updates package.json with new main version of `@iterate-com/sdk` that is built in CI
- commits with reference to source commit SHA, and pushes.

> **Warning:** The `TEMPLATE_ESTATE_SYNC_TOKEN` used for authentication will expire on **January 31, 2026**. Make sure to renew or replace this token before that date to avoid disruptions in the template syncing workflow.
