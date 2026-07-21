---
state: in-progress
size: small
---

# Tasks app collaboration demo

Status: 10% complete. The isolated worktree and demo scope are defined. The live UI flow, recording, and GitHub verification remain.

Build a deliberately throwaway Playwright spec for `https://tasks--task-demo.iterate.app` that records the tasks app's checkout, collaboration, and commit flow.

## Assumptions

- The spec targets the deployed demo app directly and is excluded from the normal product-spec suite so it cannot create persistent demo data during ordinary CI.
- Task names should be unique per run so rerunning the demo does not collide with existing data.
- “Moves them around” means dragging tasks between the workflow columns exposed by the app.
- Collaboration is proved with a second isolated browser context opened at the first context's checkout URL, then showing a change made in one context appearing in the other.
- The GitHub segment is included only if the app exposes a usable commit link or repository destination without requiring unavailable credentials.
- The final artifact should be a short annotated Playwright video suitable for human review.

## Checklist

- [ ] Inspect the live app and identify stable user-facing locators for checkout creation, task creation, movement, sharing, and commit.
- [ ] Add an opt-in Playwright spec that performs the complete demo without joining normal CI.
- [ ] Create a new checkout and add at least two hole-digging tasks.
- [ ] Move the tasks between columns to demonstrate the board.
- [ ] Open the checkout URL in another browser context and prove live collaboration in both directions.
- [ ] Commit the checkout.
- [ ] Navigate to and show the resulting GitHub commit when the app provides an accessible destination.
- [ ] Run the spec against the deployed app and capture the annotated video.
- [ ] Update the draft PR with the verified behavior and review media.

## Implementation log

- 2026-07-21: Created `throwaway/tasks-app-collaboration-demo` from current `origin/main` in a sibling worktree, preserving unrelated changes in the root checkout.
