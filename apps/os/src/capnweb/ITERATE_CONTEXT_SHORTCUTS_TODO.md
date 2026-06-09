# IterateContext Shortcut Coverage To Re-Add

This branch is currently hardening the raw `IterateCapability` tree. The e2e
suite should use fully qualified capability paths while that contract settles.

Re-add these as `IterateContext` shortcut and mount tests when the context layer
is explicitly built on top of `IterateCapability`:

- `ctx.project` resolves the current Project when the context has exactly one
  Project namespace in scope.
- `ctx.streams` is a project-narrowed stream collection in a single-project
  context.
- `ctx.repos` is a project-narrowed repo collection in a single-project context.
- `ctx.workspace` resolves the current/default Workspace in a single-project
  context.
- `ctx.worker` resolves the current Project Worker in a single-project context.
- Mounted roots such as `ctx.slack.chat.postMessage(...)` still work when backed
  by a parent-provided capability.
- Dynamic-worker mounts preserve the same path/proxy behavior through
  `/api/captnweb/run`.
