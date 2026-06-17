---
status: in-progress
size: small
---

# Fix forged-session headed spec hang

## Status

In progress. The goal is to make `pnpm spec forget --headed` finish cleanly for the forged-session REPL spec. Main unknown is whether the hang is in Playwright's `--headed` browser interaction, the local auth/OS web server startup, or project cleanup.

## Checklist

- [ ] Reproduce the hang with `pnpm spec forget --headed`.
- [ ] Minimise the failing command or test path.
- [ ] Fix the cause without widening the Playwright helper API unnecessarily.
- [ ] Verify the headed command and the focused headless command.

## Assumptions

- `forget` is intended to grep-match the new forged-session spec.
- The fix should stay inside the Playwright spec/helper layer unless diagnosis points at a real app bug.
- Existing uncommitted forged-session files are part of the current task branch; unrelated user edits should not be changed.

## Implementation Notes

- Started by checking root `pnpm spec` wiring and the files under `specs/`.
