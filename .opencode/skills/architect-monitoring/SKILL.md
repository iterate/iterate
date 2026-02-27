---
name: architect-monitoring
description: "Monitoring workflow for architect: Fly/Cloudflare checks, task updates, and Slack escalation."
---

# Architect Monitoring

Use this when the task is sandbox & OS health/usage monitoring.

## Inputs and playbooks

- `skills/monitor-fly-io-usage/SKILL.md`
- `skills/monitor-fly-io-usage/playbooks/*.md`

Read the relevant playbook and execute it. Do not duplicate playbook content.

## Evidence handling

- Playbooks are static runbooks; do not append findings to playbooks.
- Add findings to the active task only when needed (blocked/deferred/ambiguous/repeated issue).
- Keep task updates concise and evidence-only.

## Data sources

- Use Fly, Cloudflare, and PostHog observability when available.
- If one source is unavailable for any reason, continue with available data and note the gap.
- Use env vars first; if credentials are missing, use Doppler: `doppler run --config <env> -- <command>`.

## Fly SSH deep dive

- Fly CLI SSH docs: https://fly.io/docs/flyctl/ssh/
- You are allowed to SSH into Fly machines to inspect runtime state and run diagnostic commands.
- Fly machines run the daemon and associated sandbox programs; check process health and runtime logs.
- Useful checks include `top`/`btop` (if available), process list, disk/memory pressure, and relevant log files (for example `daemon-backend.log`, `opencode.log`).

## Reporting

### When to report in Slack

Start a new thread in `#monitoring` when there is meaningful risk, active degradation, or likely user impact.

Always post when severity is P1 or P2.

Severity guardrails:

- **P1**: active major outage, broad user impact, or ongoing data-loss/security risk.
- **P2**: significant degradation with user impact risk, fast-growing error rate, or clear near-term incident risk.

Common triggers:

- elevated 5xx/error rate
- sustained latency increase
- capacity saturation (CPU/memory)
- crash loops or readiness failures
- new/rising exception signatures in PostHog

### Thread template

- summary: one sentence
- severity: P1 | P2 | P3
- impact/risk: low | medium | high
- affected apps/machines:
- evidence: metrics/log links, request IDs, deploy IDs
- immediate mitigation:
- next action + owner:

### If healthy

If nothing notable happened, do not spam Slack. Mark task complete with a short note and the checked window.
