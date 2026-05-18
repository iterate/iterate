# Codemode Domain

Codemode owns the session runtime, script execution, default/example tool
providers, and the oRPC capability that exposes `os.project.*` as `ctx.os.*`.

The oRPC capability is a tool-provider adapter: it injects the bound Project ID,
removes `projectSlugOrId` from generated caller types, and calls the real oRPC
router in-process.

Most durable codemode state should stay in Durable Objects where practical. D1
is for queryable projections, routing lookup, and cross-object indexes.

Cross-domain imports deserve care: these domains may become separate packages in
the future, which would make dependencies explicit.
