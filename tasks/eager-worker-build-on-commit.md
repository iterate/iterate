---
state: todo
priority: high
size: medium
dependsOn: []
---

# Eager worker build on commit

Today the first delivery/fetch after a repo head change pays the cold
container build (~10-45s in the builder pool; delivery specs carry 180s waits
for exactly this). Kick a background build when the head moves — repo
commit/push event → dispatchBackgroundBuild for the new head's build key — so
by the time delivery or a browser arrives the artifact is warm. Prior art:
worker-loader.ts already has dispatchBackgroundBuild + the in-flight marker;
the delivery-stampede guard (same-key waiters) makes the eager build the
leader everyone else joins. Follow-up listed on PR #2083.
