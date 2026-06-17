---
status: complete
size: small
---

# PR Preview Status Table

## Status Summary

Complete in this branch. The preview PR body renderer now emits one Markdown table for app status rows, while preserving lease details, hidden state, message summaries, and failure detail blocks.

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

- [x] Locate the renderer that writes per-app PR preview status. _Found in `scripts/preview/state.ts`, via `renderCloudflarePreviewSection`._
- [x] Update renderer output to a Markdown table. _Added `renderPreviewAppTable` and table-row helpers in `scripts/preview/state.ts`._
- [x] Update focused tests for the new PR body format. _Updated `scripts/preview/state.test.ts` to assert the table header, row links, and failure detail summary._
- [x] Run the relevant preview script tests. _Passed `apps/os/node_modules/.bin/vitest run scripts/preview/state.test.ts --root .`._

## Implementation Notes

- The table columns are `app`, `status`, `commit`, `preview`, `deploy duration`, `test duration`, `cleanup duration`, `workflow run`, `updated`, and `summary`.
- Failure details remain below the table in collapsible `<details>` blocks for non-deployed/non-released statuses with message details.
