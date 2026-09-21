# Stream alarm reset after the normal 90s rollout guard

Status: observed and correlated, not fixed. A full real-CI control passed while a StreamDurableObject alarm reported a code-update reset after the guarded readiness phase.

- [x] Correlate the reset with its exact deployed version and time. *Workers Logs and OTel contain two representations of one incident, sharing trace `4d0f711fc3ea8d682955ad5839fe06f9`.*
- [ ] Determine whether this alarm's work recovered completely, and which deployment/assignment transition caused the reset.
- [ ] Add a production-shaped regression/probe for the affected behavior before claiming the rollout guard prevents all resets.

[CI control](https://depot.dev/orgs/0p91s0lz49/workflows/hbhqf2t6bz), head `45cfbc024541cddfbf2acf413843d170fd3bbb3a`, slot preview-12. OS version `4f5b52ec-fc43-4442-ae75-cf6c400b0001` matches the prepared CI plan and the reset event.

- Cloudflare deployment record: 2026-09-18 21:13:25.951 UTC.
- CI deployment command completed: 21:14:05.756 UTC.
- Guarded smoke passed: 21:16:08.455 UTC.
- Alarm reset: 21:16:55.498 UTC — 169.742s after CI deployment completion, 209.547s after the Cloudflare deployment record.
- Post-test erase/restore started later, at 21:18:31.776 UTC. Deployment history shows no intervening deployment before the reset.

The stack is `#readFacetAlarmAtMs → #mergeFacetAlarmDesire → StreamDurableObject.alarm`. Durable Object ID: `dfe3a6a720e063a818c13df4229c70800cb3515791c1167ba2cc4eda30ce7c79`.

[Cloudflare trace](https://dash.cloudflare.com/376ef7ed81b0573f93524de763666c15/observability/traces/4d0f711fc3ea8d682955ad5839fe06f9).
Raw evidence stays ignored in `experiments/preview-lease-cycling.ignoreme/evidence.ignoreme/ci-sept18/`: `control-reset-query.json`, `control-plan.json`, `control-deployment-history.json`, and CI logs. This is an unexplained alarm incident, not an observed test failure and not evidence introduced by removing the gate.

Session: Codex 01a0b054-bdd8-7d52-9c01-30d9b92576c8.
