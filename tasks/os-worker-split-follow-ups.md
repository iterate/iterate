---
state: todo
priority: medium
size: small
tags: [os, workers, observability]
---

# Worker-split follow-ups (small items)

Leftovers deliberately deferred from the per-DO worker split PR
(worker-topology.md):

- **evlog in DO workers**: only the app and project workers emit wide
  events today. The DO workers rely on Cloudflare invocation logs/traces
  (full sampling). Decide whether stream/agent/slack workers want
  evlog-shaped logging (needs `nodejs_als` on each).
- **Ingress bundle slimming**: the ingress router bundles ~540KB, almost
  all zod via `parseConfig`. A hand-rolled reader for the three config
  fields it needs (mcp base URL, project hostname bases, base URL) would
  get it under 50KB. Only worth it if ingress cold starts ever show up in
  traces — it is route-bound and essentially always warm.
- **`nodejs_compat` trimming**: workspace/repo/agent carry full
  `nodejs_compat`. Audit whether `nodejs_als` + targeted polyfills suffice
  once upstream deps (@cloudflare/shell, openai) clarify their
  node-builtin usage.
- **Dashboards/queries**: PostHog and any saved Cloudflare observability
  queries that filter on `service = os-prd` need the per-worker names
  (os-prd-app, os-prd-agent, …).
