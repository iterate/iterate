---
status: in-progress
size: small
---

# Run OS Playwright Specs After Preview Deploy

## Status Summary

Implementation is complete and pushed to draft PR #1564. The OS preview test lane now runs root Playwright specs after the existing Vitest preview checks, workflow generation is clean, and focused validation passes; the remaining proof is the PR's actual preview CI run.

## Assumptions

- The root `pnpm spec` command is the Playwright spec lane to add to preview CI.
- Specs should run after the OS preview deployment has completed and the deployed URL is known.
- The specs should run under the leased OS Doppler config, e.g. `doppler run --project os --config preview_N -- pnpm spec`, so `APP_CONFIG_BASE_URL`, auth, and admin secrets come from the deployed preview environment.
- Existing preview Vitest e2e coverage should keep running; this change should add Playwright coverage, not replace the current `pnpm preview test` OS checks.
- Fork PRs cannot access Doppler secrets, so Playwright specs should be skipped there just like the current Doppler-only preview e2e step.

## Checklist

- [x] Inspect existing preview deployment/test workflow and command generation. _The preview CLI stores the leased `preview_N` config in PR state and runs app tests under `doppler run --project <app> --config preview_N`._
- [x] Add Playwright specs to the OS preview test lane after preview deployment. _`scripts/preview/apps.ts` now installs Chromium and runs root `pnpm spec` after the existing OS Vitest preview lanes._
- [x] Regenerate generated GitHub workflow YAML. _`pnpm workflows` completed; no generated YAML changed because the existing preview workflow already executes the preview runner._
- [x] Run targeted validation for workflow generation and affected preview tests. _Passed `pnpm --dir .github/ts-workflows build`, `pnpm workflows`, formatter check, and `pnpm --dir apps/os exec vitest run --root ../.. scripts/preview/preview.test.ts`._
- [x] Push branch and keep the draft PR updated. _Draft PR #1564 is open with the implementation commit pushed and the body updated with the CI shape plus local validation._

## Implementation Notes

- Root `playwright.config.ts` uses `APP_CONFIG_BASE_URL` when present, otherwise it tries to start local OS dev. Running under `doppler run --project os --config preview_N` should therefore target the deployed preview rather than local dev.
- Current `.github/workflows/cloudflare-previews.yml` is generated from `.github/ts-workflows/workflows/cloudflare-previews.ts`.
- Preview configs use underscores (`preview_N`), not hyphenated names.
- The first focused Vitest attempt from the repo root failed because `vitest` is not installed at root. The working command uses the OS workspace binary with `--root ../..`.
