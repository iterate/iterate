---
state: todo
priority: medium
size: medium
tags: [ci, e2e, tui, quarantine, flake]
---

# Restore the quarantined TUI e2e lane

The TUI lane was quarantined on 2026-07-21 while landing PR #2169. This is
unrelated to that PR's preview deploy and browser/Vitest parallelisation work.
`apps/os/e2e/tui-test/run.ts` is an explicit logged skip until this task is
complete; the specs remain beside it.

## Evidence

- `@microsoft/tui-test` 0.0.4 reuses a worker it has already terminated when a
  timed-out test retries, so the retry cannot be trusted.
- The framework hardwires shared mutable state under the working directory and
  temporary directory. Concurrent workflow processes race on its transformed
  spec cache and zsh dotfiles.
- Making two workflows reliable in parallel required a package patch and a
  bespoke isolation/retry harness larger than the product surface currently
  justifies.
- The terminal UI also has known product bugs and currently has no users. Its
  headless shared-data-layer smoke remains available independently.

## Work

- Reduce each framework defect to a minimal upstream reproduction and check
  whether a newer release fixes it; otherwise upstream focused fixes.
- Fix the known `iterate chat` product failures exposed by the retained specs.
- Restore a small runner that builds and exercises the published CLI, gives
  every workflow attempt a disposable project, and owns no hidden retry layer.
- Keep concurrent cases isolated without a repository-local package patch or
  a copied-spec harness.

## Exit criteria

- Remove the no-op skip from `apps/os/e2e/tui-test/run.ts`.
- Both retained workflows pass against a fresh preview on their first attempt.
- A retry-disabled repeated preview run shows zero TUI flakes, no shared-state
  races, and no unexplained errors.
- `docs/testing.md` again describes the lane as active coverage.
