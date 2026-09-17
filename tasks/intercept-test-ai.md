---
status: in-progress
size: large
---

# Intercept test AI, except the bendy yellow fruit smoke test

Status: investigation and scope recorded; implementation and validation pending.

## Ask

Worktreeify a strawman draft PR that makes all automated dev/preview AI calls intercepted, with `specs/agent-chat.spec.ts` ("Name the most obvious bendy yellow fruit") as the sole real-model exception.

The spend audit found $14.60 in 24 hours: example-message tests $8.41, Slack tests $2.31, agent-tool tests $1.97, mobile-note chats $0.84, onboarding $0.46 and smaller calls. Several tests pay for replies they never assert. Mobile note agents can keep editing after the UI moves on; Slack agents investigate intentionally invalid credentials.

## Decisions / assumptions

- Scope is automated test traffic, including agents born through the UI, project configuration and integration handlers, plus direct AI calls. Ordinary dev/preview product use and production models keep their existing behavior.
- Use the existing intercepted-model system and explicit scripted responses, preserving real message delivery, agent execution, tools and UI behavior.
- Keep the fruit test's real provider call explicit and narrow; no additional silent live-model exceptions.
- Where a test checks model quality rather than application behavior, expose that tradeoff in the draft instead of claiming scripted output proves model quality.
- An early draft begins with this specification; implementation commits and the final PR body will describe the concrete approach and validation.

## Checklist

- [ ] Inventory real AI paths and establish how fixture-created and application-created agents select models.
- [ ] Add regression coverage for intercepted defaults and the explicit real-model exception.
- [ ] Convert examples, mobile notes, Slack, agent tools, onboarding and remaining automated AI requests.
- [ ] Preserve meaningful assertions with explicit scripted model output and controlled external responses.
- [ ] Run required local checks and deployed preview tests; inspect gateway evidence for unwanted real calls.
- [ ] Handle submitted reviews, update the PR description and complete this task on the branch.

## Implementation log

- 2026-09-17: Created `codex/intercept-test-ai` from `origin/main` in `../worktrees/iterate/intercept-test-ai`. Scope follows the user’s request; no implementation changes yet.
