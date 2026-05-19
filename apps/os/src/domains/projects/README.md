# Projects Domain

Projects own the stable OS Project identity, slug projection, ingress bootstrap,
and project-scoped access boundaries.

Most durable project state should stay in Durable Objects where practical. D1 is
for queryable projections, routing lookup, and cross-object indexes.

Cross-domain imports deserve care: these domains may become separate packages in
the future, which would make dependencies explicit.
