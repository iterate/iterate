---
status: in-progress
size: small
---

# Show native dialogs in Iterate video-mode recordings

## Status

The preview package is integrated and the unchanged repository IDE spec is verified in video mode. Local and CI validation are green; matching clips exist locally, with only authenticated PR media upload and final review monitoring remaining.

## Goal

Consume the dialog-aware middlewright build in Iterate so video-mode Playwright artifacts pause on JavaScript alerts/confirms/prompts, including the repository IDE's new-file discard confirmation.

## Assumptions

- This change should exercise the existing `repo-ide` product spec rather than duplicate its discard coverage.
- The temporary dependency should use middlewright PR #4's `pkg-pr-new` URL until the package change is merged and released.
- The Iterate before/after clips should run the same merged IDE discard scenario; only the middlewright version should differ.

## Checklist

- [x] Preserve the merged Iterate IDE discard video as the consumer “before” artifact. *The 0.1.2 run is saved under the ignored media workspace; its two discard clicks have no dialog annotations.*
- [x] Upgrade Iterate to the functional `pkg-pr-new` build from middlewright PR #4. *The root dependency and minimal lockfile entries now use `https://pkg.pr.new/middlewright@4` at middlewright commit `2cb2a4e`.*
- [x] Run the existing repository IDE Playwright scenario in video mode and verify the warning, pause, pointer click, and accepted outcome. *The unchanged spec passed; the rendered artifact pauses first on Cancel and then on OK with the real warning text.*
- [x] Run focused typecheck/spec validation and package-manager integrity checks. *Frozen install, root typecheck/lint/format, the full workspace test suite, and the focused video-mode spec are green.*
- [ ] Open a draft PR with a reviewer-oriented body and matching before/after video attachments.
- [ ] Monitor CI and review threads; address or reply to every item.

## Implementation log

- 2026-07-17: Worktree created from current `origin/main` at `fix/video-mode-dialog-recordings`. The merged source scenario is `specs/repo-ide.spec.ts` from PR #2058.
- 2026-07-17: Recorded the same current-main scenario before and after the package change. The after metadata includes separate dismissed and accepted confirm annotations, and inspected frames show the pointer on the matching Cancel/OK buttons.
- 2026-07-17: CI is green for preview deploy/e2e, lint/typecheck, tests, formatting autofix, LOC reporting, publishing, and the package preview. No review threads are open at this point.
