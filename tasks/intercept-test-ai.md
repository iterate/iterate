---
status: in-progress
size: large
---

# Intercept test AI, except the bendy yellow fruit smoke test

Status: strawman implemented; first preview run passed every browser shard but exposed three API-fixture regressions. Local fixes pass; deployed revalidation of the API fixtures and mobile signup spending gap is pending. The PR now explains each core runtime change and its tradeoffs separately.

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

- [x] Inventory real AI paths and establish how fixture-created and application-created agents select models. *The leak was indirect births bypassing `createAgent`.*
- [x] Add regression coverage for intercepted defaults and the explicit real-model exception. *Policy unit cases, journal/dispatch regression, and deployed `test-project-ai` proof.*
- [x] Convert examples, mobile notes, Slack, agent tools, onboarding and remaining automated AI requests. *Test projects select intercepted models before journaling; fixtures script required replies.*
- [x] Preserve meaningful assertions with explicit scripted model output and controlled external responses. *Tool and Slack API proofs pass locally; media checks explicitly cover plumbing rather than model quality.*
- [ ] Run required local checks and deployed preview tests; inspect gateway evidence for unwanted real calls.
- [ ] Handle submitted reviews, update the PR description and complete this task on the branch.

## Implementation log

- 2026-09-17: Created `codex/intercept-test-ai` from `origin/main` in `../worktrees/iterate/intercept-test-ai`. Scope follows the user’s request; no implementation changes yet.

- Strawman tradeoff: remove the paid Gateway-cache probe (cache unit contracts remain); disable optional live Codex/voice probes until they have scripted WebSocket providers. Media tests assert plumbing with scripted output, not model quality.
- Initial signup onboarding can request before the test installs its handler. The birth policy prevents spending; normal bounded model retries cover the connection gap. Preview evidence must check whether this causes visible failures.

- Validation: full workspace `pnpm test`, typecheck, lint, knip and format passed. OS unit suite: 3,183 passed, 20 expected failures, one existing skip; the added signup-scope regression subsequently passed its targeted run.
- Live local worker: both agent-tools tests passed; Slack reply/egress and three project-pool tests passed; the project-policy proof passed, including background onboarding isolation and failure after handler release. Proof project: `prj_ba20a229c70d4002b35da40bb31661fc`.
- Local browser startup failed before test execution (`config.webServer exited early`); deployed preview browser jobs are the remaining acceptance check.
- Fixture interceptors ignore template onboarding so its concurrent turn cannot consume a test-specific response. The onboarding spec uses the raw interceptor explicitly.

- Preview `3867f6a`: core CI and all six Playwright shards passed. OS had 215 passing tests, ten expected failures, four skips, and three failures: the default live interceptor caused 4901 socket closes in two restart tests; the protocol test still expected empty create arguments. Typecheck also found an optional event-payload access.
- Replace the default live callback with a worker-backed `itx-call` responder. Its mount survives stream restart without a live pager on the test's socket; the creating session still owns its lifetime. Custom scripted interceptors retain their existing live lifecycle.
- Gateway telemetry for preview_3 at 14:45–14:48 UTC found four paid direct note/media requests totaling $0.00037559 plus twelve cached onboarding requests (and the permitted cached fruit request). Mobile OAuth access tokens omit email, so signup's email-only policy opt-in missed them. Mobile fixtures now use an explicit `intercepted-e2e-` project slug and assert the stored policy before test actions; the camera-roll note spec also scripts its note/media analysis.
- Added live proofs for default-responder survival across stream restart and signup interception without an email claim. These and the existing journal/direct-call/handler-release proof pass locally (three tests); four pure policy cases pass. OS and browser-spec typechecks and scoped lint pass.
- At the user's request, expanded the PR's Change / Purpose table with a separate rationale for each core file. It calls out why fixture-only model overrides miss app-created agents, why selection precedes journaling, production host wiring, and the extra Project DO lookup even in ordinary projects.

- The original wire-format test and parked-egress restart test both pass locally after the fixes. The literal array in the Cap’n Web wire assertion needs its encoded `[[]]` representation. The oversized-event restart case requires deployed preview.
