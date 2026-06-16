---
status: todo
size: medium
---

# Local dev public callback tunnels

Normal OS dev is localhost-first:

- `pnpm dev` runs `apps/os` through `pnpm cli dev`.
- The dev server chooses a free localhost port.
- `.alchemy/dev-server.json` records the base URL so CLI scripts and tests can
  discover the running server.

Public callback URLs are opt-in. Use a preview deployment for shared review or
captun for local third-party callbacks that must reach a developer machine.
Captun should not become the default `pnpm dev` path.

## Goal

Keep the localhost dev path boring, fast, and parallel-worktree safe, while
making explicit captun callback work easy to start and easy to document.

## Current Rules

- `pnpm dev` stays local and records `http://localhost:<port>`.
- `dev` and `dev_<user>` Doppler configs do not set app/MCP/project-host URL
  overrides for normal dev.
- Personal `dev_<user>` configs may carry personal integration secrets or a
  stable `CAPTUN_TUNNEL_NAME`.
- Use preview or production when the full deployed routing shape matters.

## Scope

- Document the exact captun command/env needed for a local public callback.
- Keep `CAPTUN_ENABLED` / `CAPTUN_TUNNEL_NAME` behavior explicit and opt-in.
- Verify OAuth/webhook flows that need a public callback can use captun without
  changing the default `pnpm dev` behavior.

## Non-goals

- Replacing localhost dev with a tunnel.
- Reintroducing Cloudflare Tunnel as the normal OS dev route.
- Teaching deploy commands to run through local dev scripts.
