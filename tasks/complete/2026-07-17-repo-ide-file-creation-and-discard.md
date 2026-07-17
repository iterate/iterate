---
status: complete
size: medium
---

# Fix repository IDE new-file creation and discard

## Status

Both fixes are complete. Nested file creation preserves the folder's canonical separator, and discarding a new file now confirms before removing it and closing its editor in one interaction.

## Problem

Using the repository IDE folder context menu and choosing **New file** creates a path with a doubled separator. For example, creating `untitled.txt` inside `agents` opens and stages `agents//untitled.txt` instead of `agents/untitled.txt`.

## Scope and assumptions

- Preserve the existing inline rename experience and collision-resistant `untitled-N.txt` placeholders.
- Fix nested folder creation without changing root-level creation, normal renames, uploads, or deletes.
- Treat paths as repository-relative slash-separated paths; do not silently normalize arbitrary malformed paths elsewhere.

## Checklist

- [x] Reproduce the doubled separator through the file-tree rename event used by the folder context menu. _Pierre exposes folder rows as canonical paths such as `agents/`; the old helper appended another slash._
- [x] Add a focused regression test proving a nested new file is created at `folder/name.txt`. _`repo-file-tree.test.ts` feeds Pierre's real canonical directory path into the placeholder path builder._
- [x] Fix the new-file path handoff while preserving ordinary file and folder renames. _`repo-file-tree-paths.ts` reuses an existing trailing separator and still supports bare or root paths._
- [x] Run focused tests, typechecking, linting, and formatting for the affected surface. _Focused Vitest, full repository tests, OS typecheck, lint, and format check all pass._
- [x] Verify the original nested-folder scenario no longer produces a doubled separator. _Visible local browser verification created and opened `agents/untitled.txt` via the folder context menu._

## Implementation log

- 2026-07-17: Copied the user's clipboard screenshot to `/tmp/iterate-ide-new-file-bug.png`; it shows `agents//untitled.txt` in the editor after creating the file beneath `agents`.
- 2026-07-17: Confirmed `@pierre/trees` returns `agents/` from the directory item handle, added a red regression test, and updated placeholder path construction to preserve the canonical separator.
- 2026-07-17: Repeated the original interaction against the local OS app in an isolated headed browser; the editor path was `agents/untitled.txt` and the blank intermediate row was gone.

## New-file discard follow-up

Discarding an uncommitted new file is destructive because its content has no HEAD baseline. It must ask for confirmation with `Are you sure? You may not be able to recover this file`; cancel must preserve the file unchanged, and confirm must remove the working-tree entry and close the now-invalid selected path in one interaction. Tracked-file discard should retain its existing no-confirm revert-to-baseline behavior.

- [x] Reproduce the two-click empty-file behavior in the live Source Control view. _The first click replaced `valuable content` with an empty buffer and kept the row; the second removed the row while leaving the missing path selected._
- [x] Add focused coverage for cancel, confirmed untracked discard, and tracked-file discard. _`repo-file-discard.test.ts` specifies the destructive confirmation and preserves tracked-file revert behavior._
- [x] Route SCM, file-tree, and editor-pane discard actions through one untracked-file policy. _All individual discard entry points call `discardRepoFile`; the editor button no longer bypasses the policy._
- [x] Confirm untracked discard removes the row and closes the selected file after one accepted dialog. _A headed browser run preserved populated content on cancel, then accepted the dialog and observed `No changes.` with no selected file._
- [x] Re-run focused and repository checks, update the draft PR, and return the task to `tasks/complete/`. _Focused tests, UI and OS typechecks, lint, format check, and all 1,814 passing OS tests are green; the PR was updated and the task completed._

## Discard implementation log

- 2026-07-17: Traced the two-click behavior to the controlled CodeMirror wrapper reporting parent-driven value synchronization through `onChange`, which recreated the just-removed file as an empty working change.
- 2026-07-17: Added a shared discard policy with the exact destructive confirmation, selection cleanup, and separate tracked/untracked behavior, then suppressed `onChange` while CodeMirror synchronizes an external `value` prop.
- 2026-07-17: Verified cancel and confirm against the local `scm=true` UI in an isolated headed browser; cancel retained `must survive cancellation`, while confirm removed the SCM row and selected path in one click.
