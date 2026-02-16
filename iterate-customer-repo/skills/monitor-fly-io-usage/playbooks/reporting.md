# reporting

## When to report in Slack

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

## Thread template

- summary: one sentence
- severity: P1 | P2 | P3
- impact/risk: low | medium | high
- affected apps/machines:
- evidence: metrics/log links, request IDs, deploy IDs
- immediate mitigation:
- next action + owner:

## If healthy

If nothing notable happened, do not spam Slack. Mark task complete with a short note and the checked window.

## Secrets/auth

- Prefer env vars.
- Use Doppler when needed: `doppler run --config <env> -- <command>`.
