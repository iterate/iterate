# Streams Domain

Streams is the OS project-bound adapter around the shared namespace/path stream
runtime in `packages/shared/src/streams`.

OS uses the stable Project ID as the stream namespace for project streams, but
stream paths remain project-local and must not encode `/projects/{projectId}`.

Most durable stream state should stay in Durable Objects where practical. D1 is
for queryable projections, routing lookup, and cross-object indexes.

Cross-domain imports deserve care: these domains may become separate packages in
the future, which would make dependencies explicit.
