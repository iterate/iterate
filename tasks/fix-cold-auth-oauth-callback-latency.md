---
state: todo
priority: high
size: medium
tags: [os, auth, e2e, ci, performance]
---

# Cold auth OAuth-callback latency (signup / create-project specs, ~30-90s)

#1601 fixed the cold-slot _create_ saga (create-project.spec now passes on
fresh slots), but the auth **OAuth callback** path is still slow on freshly
deployed slots: `specs/signup.spec.ts` ("can sign up with an email one-time
passcode") failed all 3 attempts at ~33s each on a fresh preview slot
(2026-07-02, PR #1589 validation) — the browser parked on
`/api/iterate-auth/callback` past its budget. `tasks/os-cold-create-latency.md`
flagged this as the "same family, second data point": the callback (token
exchange / auth DO / os-side fetch) is cold on first touch.

This is the last thing making preview e2e red on a truly-cold slot; the vitest
engine lane is green. Fix it similarly to #1601 (heal/warm the cold path,
batch/parallelize, or restore a sane budget) so signup + first-org onboarding
land within the spec timeout on fresh deploys.

Related: [[project_preview_e2e_speedup]], tasks/os-cold-create-latency.md,
tasks/raise-e2e-maxconcurrency.md (the auth callback + create latency are what
kept e2e concurrency pinned low).
