---
name: monitor-fly-io-usage
description: Monitor Fly machine health with small focused playbooks; report notable issues to #monitoring.
---

# Monitor Fly.io usage

## Playbook entrypoints

- `playbooks/investigate-crash-loops.md`
- `playbooks/investigate-high-memory.md`
- `playbooks/reporting.md`

Pick the best match.

## Authoring rules (AI)

- Treat playbooks as static runbooks.
- Keep playbooks small and focused; avoid one giant notes file.
- Keep the playbook set minimal unless recurring signal justifies expansion.
- Do not append findings to playbook files.
- Append to the active task only when needed (blocked/deferred/repeat issue).
- Keep task updates short and evidence-based.
- No duplicated guidance across files.
- Prefer concrete metrics/log links over narrative.

## Required checks per run

- Use Fly machine/app health data if available.
- Use Cloudflare worker observability data if available.
- If one source is unavailable for any reason, continue with the other and note the gap briefly.
- If both are unavailable, continue with available local signals and note the missing access.

## Secrets/auth

- Use env vars first.
- If credentials are missing, use Doppler: `doppler run --config <env> -- <command>`.

## Escalation policy

- Always post to Slack `#monitoring` when anything needs P1 or P2 attention.
- P1/P2 threshold details and thread format are in `playbooks/reporting.md`.
