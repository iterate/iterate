---
status: research and prototype in progress
size: medium
branch: mobile-ide-poc
---

# Mobile repo IDE POC

**Status summary:** scoped and ready to implement. The spike will research current React Native editor/file-tree options, then put a deliberately throwaway repo-file manager into `apps/mobile`: browse the project's config repo, open/edit files, and commit a batch. Missing: research verdict, implementation, device/browser verification, and screenshots.

## Ask

Worktreeify an experimental IDE for the mobile app. It does not need desktop feature parity; it should make managing repo files from the phone plausible. Search broadly for usable off-the-shelf React Native code editors and file trees, and use a WebView if the native ecosystem cannot provide a credible editing experience.

## Prototype question

Can a phone-native repo browser/editor be useful enough with an off-the-shelf React Native component, or should Iterate explicitly use a WebView-backed web editor?

The POC should make the answer visible in the running app, not merely assert it in notes. Where practical, compare three structurally different mobile IDE layouts from one project-scoped route, selected with a prototype switcher. The editor-engine choice itself will follow the research rather than forcing three weak dependencies into the bundle.

## Assumptions

- “My repo” means the selected project's config repo (`itx.projects.get(projectId).repo`), because that is the repo whose commits drive the project worker/site and it already exposes `listFiles`, `readFile`, and `commitFiles`.
- POC mutations are real and explicit: edits remain local until the user taps Commit and supplies a commit message. There is no autosave-to-main.
- v1 supports UTF-8 text files only. Binary preview, image editing, branches, diffs, merge-conflict resolution, LSP, shell access, and GitHub sync are out of scope.
- File operations required for the spike: browse/search paths, open, edit, create, delete, review pending changes, and commit them as one batch.
- Expo Go compatibility is preferred. If the best native package requires a custom native build, that is evidence against it for this POC rather than permission to silently change the mobile app's distribution model.
- This is throwaway prototype code. The durable output is the research/verdict recorded here; productionizing the winner requires a separate pass with tests and product-grade failure handling.

## Checklist

- [ ] Research maintained React Native code editors, syntax-highlighting text inputs, file-tree components, and WebView-hosted editors — record license, maintenance/activity, Expo compatibility, mobile ergonomics, and integration risks with primary-source links
- [ ] Select an editor engine and document why the rejected options are not credible for this POC
- [ ] Add a project-scoped IDE entry point to the mobile app
- [ ] Load the config repo's file list and text contents through the existing authenticated itx session
- [ ] Support browse/search, open, edit, create, delete, pending-change review, and a user-triggered batch commit
- [ ] Provide three meaningfully different layouts behind an obvious prototype switcher, without duplicating repo state/mutation logic
- [ ] Keep prototype state in memory and clearly label the surface as experimental
- [ ] Verify typecheck, formatting/lint, Expo bundle health, and the focused mobile tests
- [ ] Exercise the POC against a real local/preview project and capture visual evidence for the PR
- [ ] Record the verdict and the smallest credible production follow-up

## Implementation log

- 2026-07-17: created from `origin/main` in `/Users/mmkal/src/worktrees/iterate/mobile-ide-poc`. Scope intentionally favors learning about editor technology and phone interaction over desktop IDE parity.
