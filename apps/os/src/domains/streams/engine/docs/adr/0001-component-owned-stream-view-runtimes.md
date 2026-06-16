# Component-owned stream view runtimes

> **Superseded.** The shipped design is the inverse of the title. Browser stream
> runtimes are module-level singletons, not per-view. See the current model below.

## Current model (as shipped)

Browser stream runtimes are module-level singletons keyed by
`(projectId, streamPath, processorSlug)` — the `runtimeRegistry` in
`src/browser/stream-browser-store.ts`. Every React view that mounts the same key
shares one runtime and one capnweb connection, **including two panes of
`/split-stream` that point at the same path + processor**. The OPFS SQLite mirror
is shared one level higher, per `(projectId, streamPath)` (the `databaseRegistry`),
so a stream's processors share one OPFS file.

Cross-tab, Web Locks elect a single writer per key; follower tabs read the mirror
reactively. The split-pane / same-path concern that the original decision tried to
solve with per-view runtimes is handled instead by the processor-slug dimension of
the key plus Web Locks leadership — we do **not** give each mounted view its own
runtime.

## Original decision (rejected)

Each mounted stream view owns its own browser stream runtime: stream client, SQLite worker connection, and change notifications. We deliberately avoid a global per-stream singleton so a route such as `/split-stream?left=...&right=...` can mount two independent stream views side by side, including two views of the same stream path; leadership election must handle that case the same way it handles multiple tabs.
