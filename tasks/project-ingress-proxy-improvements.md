---
state: todo
priority: high
size: medium
dependsOn:
  - project-ingress-proxy-secret-auth
---

# Project ingress proxy improvements

Follow-up work after initial step-0 ingress rollout.

## Immediate next steps

- Enforce machine-side auth header validation on `apps/project-ingress-proxy`.
- Add `iterate.config.ts` ingress hostname auth policy (`auth` vs `public`) so OS can skip Better Auth on explicitly public hosts.
- Add request correlation + structured logs for end-to-end ingress debugging.
- Add integration coverage for hostname forms in OS resolver + machine proxy path.
- Validate and finalize `.iterate.app` ingress once domain ownership is available.

## Near-term improvements

- Split ingress traffic into a dedicated skinny worker once auth/session requirements are clear.
- Reduce lookup latency for hostname -> machine resolution (edge cache, KV, or D1-backed mapping).
- Define customer-facing service hostname model (`<service>.<project>.iterate.app`).

## Operational checks

- Confirm wildcard DNS/cert coverage for current active domains.
- Add an explicit runbook for ingress outage triage (OS logs + machine logs + DNS/TLS checks).
