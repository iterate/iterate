---
state: todo
priority: low
size: medium
dependsOn: []
tags: [cli, iterate-package, code-health]
---

# Split packages/iterate/src/cli.ts (1,518 lines)

The package's remaining 1k-line-rule offender (flagged by #2063's
thermo-nuclear review after the PR deleted the previous one). Natural seams
visible today: OAuth/session management (~500 LOC — see
`tasks/iterate-auth-oauth-session-dedupe.md`, which removes most of it),
project resolution/setup, the chat launcher, and command registration.
`DEFAULT_CHAT_AGENT_PATH` also re-duplicates the onboarding path literal that
`apps/os/src/lib/onboarding-agent.ts` owns — one exported constant should
serve both.

Do this after (or as part of) the auth dedupe so the split follows the real
boundaries rather than inventing new ones.
