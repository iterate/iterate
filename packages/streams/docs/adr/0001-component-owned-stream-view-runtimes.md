# Component-owned stream view runtimes

Each mounted stream view owns its own browser stream runtime: stream client, SQLite worker connection, and change notifications. We deliberately avoid a global per-stream singleton so a route such as `/split-stream?left=...&right=...` can mount two independent stream views side by side, including two views of the same stream path; leadership election must handle that case the same way it handles multiple tabs.
