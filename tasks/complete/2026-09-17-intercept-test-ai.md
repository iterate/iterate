---
status: complete
size: large
---

# Intercept test AI, except the bendy yellow fruit smoke test

Status: implementation and targeted local validation complete. Broad interceptions use explicit caller models; the project policy and agent-host hook remain removed. Full typecheck, lint and knip pass, as do the focused API and browser checks. Full preview-suite and gateway-spend verification remain unrun. Review stays on the branch compare link, with no PR.

## Ask and constraints

Make automated dev/preview AI calls intercepted, with the “bendy yellow fruit” browser test as the sole intended real-model exception. Keep the code simple: use existing intercepted models and test configuration, not a new project policy. The spending cap remains the backstop. Review this branch through its GitHub compare link, with no PR. Put the current proposed PR body at the end of each new commit message; do not rewrite existing commits.

The audit found $14.60 over 24 hours: examples $8.41, Slack $2.31, agent tools $1.97, mobile-note chats $0.84, onboarding $0.46 and smaller calls.

## Checklist

- [x] Keep prefix-only interception and remove the project policy, allowlist and agent-host hook. *Agent-host and agent processor source match the branch base.*
- [x] Restore shared project setup across OS, mobile, browser and example fixtures. *`interceptor.createProject` configures onboarding, mounts a durable no-op response and edits the test project's ordinary newborn configuration.*
- [x] Restore scripted Slack, tool and mobile chat responses. *Slack explicitly creates/configures its known caller before the webhook; its first-ever router birth stays covered by processor tests.*
- [x] Configure note and media analysis explicitly. *App workers expose model settings; `ai.toMarkdown` accepts an intercepted conversion model because it previously had no caller-selectable model.*
- [x] Keep the bendy-yellow-fruit smoke as the intended real-model exception. *Wait for fixture birth configuration, then select the real model explicitly.*
- [x] Expose paid-probe coverage tradeoffs. *Gateway-cache probe removed; optional Codex WebSocket and voice probes parked pending scripted providers.*
- [x] Verify browser/signup and live note/media flows and record validation for the compare branch. *Fruit, signup, voice onboarding, mobile notes and camera-roll browser specs pass; live notes/media/retrieval pass. The proposed body accompanies the restoration commit.*

## Implementation log

- 2026-09-17: Created `codex/intercept-test-ai` in `../worktrees/iterate/intercept-test-ai` and opened draft PR #2715 after committing the initial specification.
- Initial implementation added an immutable project AI policy and a resolver before request journaling. The user rejected that design: the spending cap is the policy, and the core must stay simple. Removed the entire policy and its dependent setup instead of replacing it with another enforcement mechanism.
- Before removal, head `badaf22c` passed core tests, typecheck and 220 OS API tests (ten expected failures, four skips). Browser failures remained: an Expo port prompt, mobile signup timeouts, and an unexpectedly passing expected-failure test. Those results apply to the withdrawn implementation, not this reduced draft.
- A gateway audit of the earlier preview run found twelve cached onboarding calls and four paid note/media calls ($0.00037559) escaping the email-only signup rule. That rule and its slug-based replacement have both been removed. This remains useful evidence of which test paths still need explicit configuration.
- Rollback validation: full workspace typecheck, six existing model-interception unit tests, scoped lint and formatting pass. No deployed suite or gateway audit was rerun for this reduced draft.
- Review workflow: closed PR #2715 at the user's request; keep `codex/intercept-test-ai` and its worktree. Continue with compare links and the proposed PR body in each new commit message.
- Restoration: the user clarified that removing the policy must preserve the broad test interceptions. Restore the scripted responses and shared test setup; do not restore the project policy.
- User chose to preserve prefix-only interception. Restore explicit caller model configuration rather than broadening `ai.intercept` to real models. Agent host, turn loop and project policy remain untouched.

- Restoration validation: 12 live interceptor contracts (five existing expected failures), two tool tests, Slack smoke, both default/matrix onboarding-newborn proofs, fast-path creation, six core API tests and the expected concurrent-create regression pass. Notes/media: 42 unit tests pass. Existing prefix dispatch: six unit tests pass. Full workspace typecheck (including specs and templates), lint and knip pass. Three pool and 64 example generation/typecheck tests pass.
- Local multi-file e2e runs expose an existing server-recycle problem: memory cleanup kills the server after a file and following files cannot discover a base URL. Running each affected file on a fresh server passes. The worktree's earlier local Wrangler state is backed up at `/tmp/intercept-test-ai-state-20260917-1720`.
- Signup setup holds the real Auth response only to configure the known onboarding caller. The browser still starts OS bootstrap with the real signed-in user. After the birth event, the fixture updates the new project's newborn model setting.

- Browser checks: real fruit smoke passes; signup and voice-template onboarding pass after fixing fixture polling and giving the deliberately held Auth response an explicit network-wait budget. Live notes, media analysis and media retrieval pass with intercepted `processedBy` values. Retrieval exposed a pre-existing example that ignored `media/uploaded`; updated its fallback reader and regenerated the catalogue.

- Mobile browser checks: notes and camera-roll attachment specs pass. Consent runs alongside signup observation so OAuth can return and start OS bootstrap. The note-chat spec asserts the first request on its actual `/agents/mobile/note-*` path uses an intercepted model.
- Final audit: the storefront synthetic-turn test also explicitly selects an intercepted model; its hour-long debounce alone did not prevent a later paid request.
- Validation limit: focused local runs are green; no full final preview-suite run or fresh gateway-spend audit was performed. The local multi-file server-recycle issue remains outside this change.
