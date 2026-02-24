---
state: todo
priority: medium
size: small
tags:
  - jonasland5
  - sandbox
  - security
dependsOn: []
---

# Drop network-admin privileges after iptables bootstrap

## Scope

- Keep current startup behavior where iptables redirect rules are installed early at boot.
- After rules are set, switch to a dedicated non-root runtime user (pseudo-root UX is fine) and run pidnap/services as that user.
- Ensure runtime process cannot mutate network config (`NET_ADMIN` unavailable, no root fallback path in normal operation).

## Acceptance criteria

- Container still boots and ingress/egress routing behavior is unchanged.
- Runtime process user is non-root after bootstrap step.
- Attempts from runtime process to run iptables/network mutation fail as expected.
- Add/adjust e2e assertion proving network policy works while privilege drop is effective.
