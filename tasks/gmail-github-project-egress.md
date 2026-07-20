---
status: in-progress
size: small
priority: high
tags: [egress, approvals, integrations, gmail, github, secrets]
---

# Route Gmail and GitHub through project egress

**Status summary:** Specified; implementation has not started. The intended change is limited to the built-in Gmail and GitHub data-call transports. Missing: regression coverage, transport changes, and verification.

Gmail and GitHub currently dispatch credential-bearing requests directly through their connection Secret Durable Objects. That preserves secret confinement and origin pinning, but skips the Project Durable Object's egress policy boundary. Consequently, project egress interceptors and human-approval `hold` rules cannot observe these built-in integration calls.

## Acceptance criteria

- [ ] A Gmail `gmail.request(...)` call enters project egress with its Google connection-secret placeholder intact before any secret substitution.
- [ ] Every wrapped Octokit request enters project egress with its GitHub connection-secret placeholder intact before any secret substitution.
- [ ] The existing Secret Durable Object remains the sole substitution, refresh, origin-pin, and credential-audit authority after project policy permits the request.
- [ ] Existing Gmail request composition and GitHub Octokit behavior remain unchanged, including GitHub's no-retry-on-5xx policy and the Secret DO's one refresh-and-retry on 401.
- [ ] Documentation no longer describes Gmail or GitHub as intentionally bypassing project egress.
- [ ] Focused tests, typecheck, lint, and formatting pass.

## Scope

This task changes the two built-in integration transports only. It does not remove or redesign the public `itx.secrets.get(path).fetch(...)` surface, generalize approvals beyond HTTP, add semantic email approval rendering, or change OAuth/connect-time provider calls.

## Implementation notes

- Assumption: `ProjectDurableObject.fetch()` remains the single outer policy door. After approval/interception, its existing egress implementation selects the referenced Secret Durable Object, which performs substitution and the real outbound request. The Secret DO must not call back into project egress.
- Assumption: existing integration call syntax and return values are public API and must not change.
- Test behavior at the transport boundary: the observable outbound request must arrive at the project fetcher, addressed by project ID, with the expected `getSecret(...)` placeholder. Do not expose or seed private secret storage in tests.
