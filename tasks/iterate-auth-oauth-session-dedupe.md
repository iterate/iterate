---
state: todo
priority: medium
size: medium
dependsOn: []
tags: [auth, cli, mobile, iterate-package, consolidation]
---

# Dedupe the CLI + mobile OAuth session plumbing (candidate `iterate/auth`)

`packages/iterate/src/cli.ts` carries ~500 LOC of OAuth session management
(PKCE + dynamic client registration + authorization-code grant + refresh with
rotation) that `apps/mobile/src/lib/auth.ts` (242 LOC) reimplements: same
RFC 8707/9728 resource discovery, same `StoredSession` shape (token,
refreshToken, clientId, expiresAt), same refresh grant against
`/api/auth/oauth2/token`. Only the redirect mechanics differ (localhost
loopback vs `iterate://` deep link) — and those should stay per-platform.

## What to do

- Extract the pure token/HTTP flow (`refreshSession`, resource discovery,
  request/response shaping) into a shared module — a new `iterate/auth`
  subpath entry or part of `iterate/client`.
- Rotation discipline is the invariant to preserve: the refreshed token must
  persist BEFORE the new access token is released to callers (both current
  implementations do this correctly; the extraction must not lose it).
- File I/O (`config.ts`) stays CLI-side; mobile keeps `expo-secure-store`.

This is security-critical plumbing — small steps, tests first.

Context: PR #2063's consolidation-sweep findings.
