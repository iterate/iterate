---
status: in-progress
size: large
---

# Intercept test AI, except the bendy yellow fruit smoke test

Status: project policy and all dependent fixture machinery removed at the user's request. The remaining draft has explicit scripted agent-tool, mobile-chat and deploy-smoke tests. Broad interception of examples, onboarding, Slack and note/media work is still unfinished; the current draft does not meet the original all-tests goal.

## Ask and constraints

Make automated dev/preview AI calls intercepted, with the “bendy yellow fruit” browser test as the sole intended real-model exception. Keep the code simple: use existing intercepted models and test configuration, not a new project policy. The spending cap remains the backstop. Review this branch through its GitHub compare link, with no PR. Put the current proposed PR body at the end of each new commit message; do not rewrite existing commits.

The audit found $14.60 over 24 hours: examples $8.41, Slack $2.31, agent tools $1.97, mobile-note chats $0.84, onboarding $0.46 and smaller calls.

## Checklist

- [x] Remove the project policy, persisted birth fields, live-path allowlist, signup heuristics and core resolver hook. *Core source and generated API files restored byte-for-byte to the branch's starting point.*
- [x] Remove the policy-dependent fixture wrapper and mechanical test rewrites. *Ordinary fixture creation restored; no ineffective default interceptor remains.*
- [x] Keep independently scripted agent-tool, mobile-chat and deploy-smoke tests. *They explicitly append the existing agent/configured event with an intercepted model before sending a message.*
- [x] Preserve the existing real fruit smoke. *Its original useRealLlm fixture option is unchanged.*
- [x] Expose paid-probe coverage tradeoffs. *Gateway-cache probe removed; optional Codex WebSocket and voice probes parked pending scripted providers.*
- [ ] Configure examples, onboarding, Slack and note/media tests without changing core model selection.
- [ ] Verify full deployed tests and gateway logs once that remaining configuration is implemented.

## Implementation log

- 2026-09-17: Created `codex/intercept-test-ai` in `../worktrees/iterate/intercept-test-ai` and opened draft PR #2715 after committing the initial specification.
- Initial implementation added an immutable project AI policy and a resolver before request journaling. The user rejected that design: the spending cap is the policy, and the core must stay simple. Removed the entire policy and its dependent setup instead of replacing it with another enforcement mechanism.
- Before removal, head `badaf22c` passed core tests, typecheck and 220 OS API tests (ten expected failures, four skips). Browser failures remained: an Expo port prompt, mobile signup timeouts, and an unexpectedly passing expected-failure test. Those results apply to the withdrawn implementation, not this reduced draft.
- A gateway audit of the earlier preview run found twelve cached onboarding calls and four paid note/media calls ($0.00037559) escaping the email-only signup rule. That rule and its slug-based replacement have both been removed. This remains useful evidence of which test paths still need explicit configuration.
- Rollback validation: full workspace typecheck, six existing model-interception unit tests, scoped lint and formatting pass. No deployed suite or gateway audit was rerun for this reduced draft.
- Review workflow: closed PR #2715 at the user's request; keep `codex/intercept-test-ai` and its worktree. Continue with compare links and the proposed PR body in each new commit message.
