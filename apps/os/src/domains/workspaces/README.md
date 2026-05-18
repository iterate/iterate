# Workspaces Domain

Workspaces is currently a skeletal POC codemode provider. The product concept is
not settled because OS already has Projects and Clerk Organizations.

Keep `ctx.workspace` unchanged for now while using this folder to make the
domain boundary visible.

Most durable workspace state should stay in Durable Objects where practical. D1
is for queryable projections, routing lookup, and cross-object indexes.

Cross-domain imports deserve care: these domains may become separate packages in
the future, which would make dependencies explicit.
