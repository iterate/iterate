# Ingress Domain

Ingress owns host routing and fetch-callable dispatch concepts that map public
requests to project-bound runtime behavior.

It may remain partly intertwined with Projects until the boundary grows clearer.

Most durable ingress state should stay in Durable Objects where practical. D1 is
for queryable projections, routing lookup, and cross-object indexes.

Cross-domain imports deserve care: these domains may become separate packages in
the future, which would make dependencies explicit.
