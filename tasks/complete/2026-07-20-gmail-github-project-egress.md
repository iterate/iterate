---
status: complete
size: small
priority: high
tags: [egress, approvals, integrations, gmail, github, secrets]
---

# Route Gmail and GitHub through project egress

**Status summary:** Complete. Gmail and GitHub data calls now enter project egress with credential placeholders intact; focused tests, full workspace checks, and preview deployment/e2e pass. No implementation pieces remain.

Gmail and GitHub currently dispatch credential-bearing requests directly through their connection Secret Durable Objects. That preserves secret confinement and origin pinning, but skips the Project Durable Object's egress policy boundary. Consequently, project egress interceptors and human-approval `hold` rules cannot observe these built-in integration calls.

## Acceptance criteria

- [x] A Gmail `gmail.request(...)` call enters project egress with its Google connection-secret placeholder intact before any secret substitution. _`gmail-api.test.ts` drives the real request composer against the root project fetcher._
- [x] Every wrapped Octokit request enters project egress with its GitHub connection-secret placeholder intact before any secret substitution. _`github-api.test.ts` drives real Octokit request, REST, GraphQL, pagination, and write-failure paths._
- [x] The existing Secret Durable Object remains the sole substitution, refresh, origin-pin, and credential-audit authority after project policy permits the request. _Only the outer transport changed; project egress's existing secret-reference lane still delegates to the Secret DO._
- [x] Existing Gmail request composition and GitHub Octokit behavior remain unchanged, including GitHub's no-retry-on-5xx policy and the Secret DO's one refresh-and-retry on 401. _Focused transport/repo-link tests and the full OS suite pass._
- [x] Documentation no longer describes Gmail or GitHub as intentionally bypassing project egress. _Updated both integration guides and stale source/test comments._
- [x] Focused tests, typecheck, lint, and formatting pass. _24 focused tests plus full `pnpm typecheck`, `pnpm lint`, `pnpm format`, and `pnpm test` are green._
- [x] Preview CI confirms the integration transports cross the production-shaped project egress boundary without new trace or test errors. _PR #2159 deployed preview-4 and passed its full production-shaped e2e suite (56 browser specs; 15m53s job)._

## Scope

This task changes the two built-in integration transports only. It does not remove or redesign the public `itx.secrets.get(path).fetch(...)` surface, generalize approvals beyond HTTP, add semantic email approval rendering, or change OAuth/connect-time provider calls.

## Implementation notes

- Assumption: `ProjectDurableObject.fetch()` remains the single outer policy door. After approval/interception, its existing egress implementation selects the referenced Secret Durable Object, which performs substitution and the real outbound request. The Secret DO must not call back into project egress.
- Assumption: existing integration call syntax and return values are public API and must not change.
- Test behavior at the transport boundary: the observable outbound request must arrive at the project fetcher, addressed by project ID, with the expected `getSecret(...)` placeholder. Do not expose or seed private secret storage in tests.

## Implementation log

- Added a Gmail transport spec proving the composed `messages/send` request reaches the root project fetcher with its Google access-token placeholder.
- Retargeted wrapped Octokit from the connection Secret namespace to the root Project namespace and updated its real-Octokit transport coverage.
- Retargeted `callGmailApi` to own project-egress dispatch; the RPC layer can no longer inject the inner Secret DO fetcher.
- Updated the repo-link fake to preserve its public behavior at the new project-egress seam.
- Local verification: 24 focused tests; full workspace typecheck, lint, format, and tests; OS reports 2,055 passed, 6 expected failures, and 1 skip.
- Preview verification: preview-4 deployed auth, dummy-petshop, and OS successfully; all preview e2e checks passed, including 56 OS browser specs.
