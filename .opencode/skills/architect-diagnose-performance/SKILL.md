---
name: architect-diagnose-performance
description: Diagnose latency, saturation, and throughput regressions.
---

# Diagnose Performance

Use when there are latency spikes, timeout increases, throughput drops, or capacity pressure.

## Inputs

- Cloudflare Observability MCP (latency/error distributions)
- PostHog MCP (user-facing impact/error trends)
- Fly signals (machine health/usage)
- Recent git commits/PRs for regression correlation

## Workflow

1. Identify worst affected route/service and incident window.
2. Compare baseline vs incident for latency, errors, saturation.
3. Determine bottleneck stage and likely trigger.
4. Propose smallest safe remediation.

## Output

- impacted service/path
- before/after metrics
- bottleneck hypothesis + confidence
- remediation plan
