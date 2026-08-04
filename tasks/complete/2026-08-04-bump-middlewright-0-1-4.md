---
status: done
size: small
branch: bump-middlewright-0-1-4
base: main
---

# Bump Middlewright to 0.1.4

## Status

Complete. The workspace now exact-pins published `middlewright@0.1.4`; the
lockfile contains only the matching registry resolution changes. The existing
spinner patch remains because neither local fix is present in the release.

## Goal

Replace the temporary pkg.pr.new Middlewright build with the published `0.1.4`
release. Keep only local patching that is still absent upstream.

## Assumptions

- `0.1.4` is intended to supersede the current `https://pkg.pr.new/middlewright@14`
  pin.
- The existing `patches/middlewright.patch` must be compared with the published
  package before deciding whether to retain, shrink, or remove it.
- This dependency-only change does not need product screenshots or a preview.

## Checklist

- [x] Inspect the published `0.1.4` package against the local Middlewright patch.
      _The tarball lacks the handoff-race and disappearance-wait fixes._
- [x] Pin `middlewright` to `0.1.4` and regenerate the pnpm lockfile.
      _`package.json` uses an exact pin; the lockfile resolves the npm integrity hash._
- [x] Remove or update the local patch registration and file as required.
      _Retained unchanged; frozen install applies it cleanly to `0.1.4`._
- [x] Run focused install, typecheck, lint, format, and relevant Playwright-support checks.
      _Frozen install, typecheck, lint, knip, format check, Playwright test discovery,
      and the full workspace test suite all pass._
- [x] Record verification, move this task to `tasks/complete/`, and update the PR body.
      _Completion recorded here; final PR update follows the implementation commit._

## Implementation log

- 2026-08-04: Created branch/worktree from `origin/main`; no product code changed yet.
- 2026-08-04: Compared the npm tarball with `patches/middlewright.patch`. Published
  `0.1.4` still needs both local spinner-waiter fixes, and pnpm applies the patch cleanly.
- 2026-08-04: Exact-pinned `0.1.4` and reduced the lockfile update to its importer,
  package, and snapshot records.
- 2026-08-04: Passed `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`,
  `pnpm knip`, `pnpm format:check`, `pnpm spec --list`, and `pnpm test`.
