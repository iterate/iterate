# Repos Domain

Repos is currently a POC codemode tool-provider domain for repo handles exposed
through `ctx.repos.get({ slug })`.

Most durable repo state should stay in Durable Objects where practical. D1 is
for queryable projections, routing lookup, and cross-object indexes.

Cross-domain imports deserve care: these domains may become separate packages in
the future, which would make dependencies explicit.
