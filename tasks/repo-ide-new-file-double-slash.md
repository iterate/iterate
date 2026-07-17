---
status: in-progress
size: small
---

# Fix nested IDE file creation paths

## Status

Reproduction is confirmed from the supplied screenshot. The fix and regression coverage are still missing.

## Problem

Using the repository IDE folder context menu and choosing **New file** creates a path with a doubled separator. For example, creating `untitled.txt` inside `agents` opens and stages `agents//untitled.txt` instead of `agents/untitled.txt`.

## Scope and assumptions

- Preserve the existing inline rename experience and collision-resistant `untitled-N.txt` placeholders.
- Fix nested folder creation without changing root-level creation, normal renames, uploads, or deletes.
- Treat paths as repository-relative slash-separated paths; do not silently normalize arbitrary malformed paths elsewhere.

## Checklist

- [ ] Reproduce the doubled separator through the file-tree rename event used by the folder context menu.
- [ ] Add a focused regression test proving a nested new file is created at `folder/name.txt`.
- [ ] Fix the new-file path handoff while preserving ordinary file and folder renames.
- [ ] Run focused tests, typechecking, linting, and formatting for the affected surface.
- [ ] Verify the original nested-folder scenario no longer produces a doubled separator.

## Implementation log

- 2026-07-17: Copied the user's clipboard screenshot to `/tmp/iterate-ide-new-file-bug.png`; it shows `agents//untitled.txt` in the editor after creating the file beneath `agents`.
