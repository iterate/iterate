---
state: backlog
priority: high
size: small
dependsOn: []
tags:
  - observability
  - database
---

# Alert on PlanetScale connection pressure in building channel

We need proactive alerts in the building channel when PlanetScale connection pressure spikes so we can react before it causes user-facing errors (`08P01`, session fetch failures, or broad tRPC 5xx).

Scope:

- define a connection-pressure signal + threshold(s) that map to real risk
- send alerts to the building channel with enough context (env, service, trend/window, suggested action)
- include de-duplication/cooldown to avoid alert spam during incidents
- add runbook links so on-call can quickly confirm DB health and mitigate
