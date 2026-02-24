---
state: todo
priority: high
size: medium
tags:
  - jonasland5
  - discovery
  - caddy
dependsOn:
  - discovery-sqlite-config-foundation.md
  - discovery-route-tags.md
---

# Auto-apply Caddy config when route has `caddy` tag

## Scope

- Define reconcile rule: when a route with tag `caddy` is upserted/removed, regenerate Caddy payload and apply to Caddy (`/load`).
- Use central config values (from `config` table) for Caddy admin URL/listen defaults.
- Keep manual `caddyLoadInvocation` RPC for explicit calls.

## Acceptance criteria

- Upserting/removing `caddy`-tagged routes triggers Caddy apply path.
- Non-`caddy` routes do not auto-apply.
- Failure path is explicit (surface error/log; no silent swallow).
- Add tests proving both tagged and non-tagged behavior.
