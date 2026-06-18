---
status: in-progress
size: small
---

# Run OS Playwright Specs After Preview Deploy

## Status Summary

Early task definition is complete. Implementation still needs to wire root Playwright specs into the OS preview test lane, regenerate the workflow, and verify the generated YAML/checks.

## Assumptions

- The root `pnpm spec` command is the Playwright spec lane to add to preview CI.
- Specs should run after the OS preview deployment has completed and the deployed URL is known.
- The specs should run under the leased OS Doppler config, e.g. `doppler run --project os --config preview_N -- pnpm spec`, so `APP_CONFIG_BASE_URL`, auth, and admin secrets come from the deployed preview environment.
- Existing preview Vitest e2e coverage should keep running; this change should add Playwright coverage, not replace the current `pnpm preview test` OS checks.
- Fork PRs cannot access Doppler secrets, so Playwright specs should be skipped there just like the current Doppler-only preview e2e step.

## Checklist

- [ ] Inspect existing preview deployment/test workflow and command generation.
- [ ] Add Playwright specs to the OS preview test lane after preview deployment.
- [ ] Regenerate generated GitHub workflow YAML.
- [ ] Run targeted validation for workflow generation and affected preview tests.
- [ ] Push branch and keep the draft PR updated.

## Implementation Notes

- Root `playwright.config.ts` uses `APP_CONFIG_BASE_URL` when present, otherwise it tries to start local OS dev. Running under `doppler run --project os --config preview_N` should therefore target the deployed preview rather than local dev.
- Current `.github/workflows/cloudflare-previews.yml` is generated from `.github/ts-workflows/workflows/cloudflare-previews.ts`.
