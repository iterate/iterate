---
status: in-progress
size: small
---

# PR Preview Status Table

## Status Summary

Spec committed first for worktree review. Implementation still needs to update the PR preview body renderer and tests so per-app preview state is shown as a Markdown table instead of repeated field blocks.

## Goal

The managed preview section on pull requests currently renders one mini-block per app:

```md
Auth
Status: deployed
Commit: a63e4e7
Preview: https://auth.iterate-preview-2.com
Deploy duration: 24.3s
Test duration: 472ms
Workflow run
Updated: 2026-06-17T11:08:57.653Z
```

Change that section to a Markdown table with columns roughly:

```md
| app | status | commit | preview | deploy duration | workflow run | updated |
```

## Assumptions

- Keep this scoped to the existing managed PR preview comment/body renderer.
- Preserve existing status labels, commit links, preview links, workflow links, and updated timestamps.
- Include test duration if the current renderer already has it; a compact `test duration` column is preferable to dropping the data.
- Do not change preview deployment behavior, lease behavior, or workflow routing.

## Checklist

- [ ] Locate the renderer that writes per-app PR preview status.
- [ ] Update renderer output to a Markdown table.
- [ ] Update focused tests for the new PR body format.
- [ ] Run the relevant preview script tests.
