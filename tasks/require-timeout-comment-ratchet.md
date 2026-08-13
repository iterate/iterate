---
status: ready
size: medium
---

# Burn down the require-timeout-comment exclusion list

`middlewright/require-timeout-comment` is on for all of `specs/**`, except a
legacy exclusion list in `.oxlintrc.json` (the override setting the rule
"off"). Those files predate the rule and carry ~91 unexplained explicit
timeouts.

For each file: prefer REMOVING the timeout (add loading UI so spinnerWaiter
covers the wait) over annotating it. Only keep a timeout with a nearby
`// ...timeout... spinner waiter...` comment when a product or middlewright
limit genuinely prevents that — the comment must say why. See
https://github.com/iterate/middlewright#dont-fix-slow-tests-with-longer-timeouts

Each checked file gets removed from the exclusion override in `.oxlintrc.json`
in the same change. Violation counts as of 2026-08-13:

- [ ] specs/seeded-apps.spec.ts (17)
- [ ] specs/workspace-lens-board.spec.ts (12)
- [ ] specs/stream-cache-before-live.spec.ts (10)
- [ ] specs/stream-resume-after-suspend.spec.ts (8)
- [ ] specs/clients-os-app.spec.ts (7)
- [ ] specs/mobile/notifications.spec.ts (6)
- [ ] specs/test-support/email-otp-signup.ts (5)
- [ ] specs/mobile/approvals.spec.ts (5)
- [ ] specs/create-project.spec.ts (4)
- [ ] specs/agent-chat.spec.ts (4)
- [ ] specs/repo-ide-svg-index-preview.spec.ts (3)
- [ ] specs/repl-lazy.spec.ts (3)
- [ ] specs/repo-ide-markdown-preview.spec.ts (2)
- [ ] specs/repo-ide-jsonc.spec.ts (2)
- [ ] specs/repo-ide-json-schema.spec.ts (2)
- [ ] specs/repo-ide-html-preview.spec.ts (2)
- [ ] specs/repl-examples.spec.ts (2)
- [ ] specs/test-support/repo-tree.ts (1)
- [ ] specs/signup.spec.ts (1)
- [ ] specs/forged-session-repl.spec.ts (1)

Changed files need their spec lane run to prove the removed timeouts weren't
load-bearing.
