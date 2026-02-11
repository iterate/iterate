---
state: todo
priority: medium
size: small
dependsOn: []
---

# Make Local Dev Parallel-Clean

Goal: make it possible to run multiple `apps/os` dev servers locally, in parallel, without URL/redirect breakage.

## Context

- Reverted prior experimental changes in:
  - `apps/os/alchemy.run.ts`
  - `apps/os/package.json`
  - `README.md`
  - `apps/os/app/AGENTS.md`
- Next thing to solve: public URL handling when Vite chooses its own port dynamically.
- Desired behavior:
  - local/no tunnel: public URL should resolve to actual local origin (`localhost:<real-vite-port>`)
  - tunnel enabled: public URL should resolve to tunnel URL
  - no brittle Doppler/static-port dependency for local parallel runs

## Open Questions

- Where should canonical request origin come from for backend-generated absolute URLs?
- Can origin be request-derived for OAuth/auth/billing flows, vs env-derived?
- Which flows require stable absolute URL before first incoming request?
