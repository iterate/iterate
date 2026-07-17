---
status: in-progress
size: small
---

# Show native dialogs in Iterate video-mode recordings

## Status

Just started. The merged repository IDE discard spec is available as the consumer repro; the middlewright preview upgrade, verification, media, and pull request are still outstanding.

## Goal

Consume the dialog-aware middlewright build in Iterate so video-mode Playwright artifacts pause on JavaScript alerts/confirms/prompts, including the repository IDE's new-file discard confirmation.

## Assumptions

- This change should exercise the existing `repo-ide` product spec rather than duplicate its discard coverage.
- The temporary dependency should use middlewright PR #4's `pkg-pr-new` URL until the package change is merged and released.
- The Iterate before/after clips should run the same merged IDE discard scenario; only the middlewright version should differ.

## Checklist

- [ ] Preserve the merged Iterate IDE discard video as the consumer “before” artifact.
- [ ] Upgrade Iterate to the functional `pkg-pr-new` build from middlewright PR #4.
- [ ] Run the existing repository IDE Playwright scenario in video mode and verify the warning, pause, pointer click, and accepted outcome.
- [ ] Run focused typecheck/spec validation and package-manager integrity checks.
- [ ] Open a draft PR with a reviewer-oriented body and matching before/after video attachments.
- [ ] Monitor CI and review threads; address or reply to every item.

## Implementation log

- 2026-07-17: Worktree created from current `origin/main` at `fix/video-mode-dialog-recordings`. The merged source scenario is `specs/repo-ide.spec.ts` from PR #2058.
