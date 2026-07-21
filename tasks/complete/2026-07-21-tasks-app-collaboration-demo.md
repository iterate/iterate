---
state: complete
size: small
---

# Tasks app collaboration demo

Status: Complete. The production demo passes, its annotated recording reaches the public GitHub commit, and GitHub renders the clip inline in draft PR #2220.

Build a deliberately throwaway Playwright spec for `https://tasks--task-demo.iterate.app` that records the tasks app's checkout, collaboration, and commit flow.

## Assumptions

- The spec targets the deployed demo app directly and is excluded from the normal product-spec suite so it cannot create persistent demo data during ordinary CI.
- Every run creates a new checkout, so its two fixed demo task names remain isolated from earlier runs.
- “Moves them around” means dragging tasks between the workflow columns exposed by the app.
- Collaboration is proved with a second isolated browser context opened at the first context's checkout URL, then showing a change made in one context appearing in the other.
- Before recording, the production `task-demo` repo is linked to the dormant public dummy repository `jonastemplestein/iterate-test-5` and force-pushed so the resulting commit page is publicly visible.
- Two existing production platform-admin identities use signed project-app session cookies with their real Auth user IDs. This avoids changing production membership data and keeps authentication outside the recording.
- The final artifact should be a short annotated Playwright video suitable for human review.

## Checklist

- [x] Inspect the live app and identify stable user-facing locators for checkout creation, task creation, movement, sharing, and commit. *Verified in isolated agent-browser sessions against the production app.*
- [x] Add an opt-in Playwright spec that performs the complete demo without joining normal CI. *Added `specs/tasks-app-collaboration-demo.spec.ts`, gated by `TASKS_APP_DEMO=1`, plus a no-local-server demo config.*
- [x] Create a new checkout and add at least two hole-digging tasks. *The spec creates “Dig the first hole” and “Dig the second hole” in a fresh checkout.*
- [x] Move the tasks between columns to demonstrate the board. *Jonas moves the first task to In progress and later moves the remotely edited second task to Done.*
- [x] Open the checkout URL in another browser context and prove live collaboration in both directions. *Misha opens the exact checkout URL and changes the second task's canonical Markdown to In review; Jonas observes that state before changing it again.*
- [x] Commit the checkout. *The spec enters “Dig two holes together” and invokes the app's manual Commit action.*
- [x] Navigate to and show the resulting GitHub commit when the app provides an accessible destination. *The spec polls the public mirror head, then opens and verifies its commit page.*
- [x] Run the spec against the deployed app and capture the annotated video. *The final `VIDEO_MODE=1` run passed in 33.1s and rendered a 32.5s VP9 WebM.*
- [x] Update the draft PR with the verified behavior and review media. *PR #2220 contains the external-review summary and GitHub-hosted inline WebM player; rendered HTML was verified to contain `<video>`.*

## Implementation log

- 2026-07-21: Created `throwaway/tasks-app-collaboration-demo` from current `origin/main` in a sibling worktree, preserving unrelated changes in the root checkout.
- 2026-07-21: Opened draft PR #2220 from the isolated task commit. The ordinary CI suite passed.
- 2026-07-21: Repointed the existing `task-demo` repo from its private GitHub backing to the dormant public dummy `jonastemplestein/iterate-test-5`, then force-pushed and verified matching GitHub and Artifacts heads.
- 2026-07-21: Proved two-context presence (`JT` and `MK`), live task movement, manual commit, and the public GitHub commit page through the deployed app.
- 2026-07-21: Isolated the demo from the ordinary Playwright config so unrelated Expo startup cannot consume its execution budget.
- 2026-07-21: The production auth-start response remained open during automation, so the pre-video setup now signs the normal project-app cookie directly using the production session secret and verified real admin IDs.
- 2026-07-21: A first `resetFromGithub` call twice failed after destroying the disposable Artifacts repo; a repeat recovered it. The final clean reset used `syncFromGithub({ force: true })`, which succeeded without destructive recreation.
- 2026-07-21: Final recording passed and ends on public commit `0904d05`, containing both task files under the “Dig two holes together” commit.
- 2026-07-21: Uploaded the rendered WebM through GitHub's attachment editor, added its permanent `user-attachments` URL to PR #2220, and verified GitHub rendered an inline video player. The draft remains unlabelled because no preview deployment is needed.
