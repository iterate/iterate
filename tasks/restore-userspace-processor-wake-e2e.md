---
state: todo
priority: medium
size: medium
dependsOn: []
---

# Restore focused userspace processor wake coverage

PR #2144 deliberately reduced Guestbook to a minimal React SPA plus Worker and
removed its template-coupled processor wake test. Restore that runtime lane as
a focused fixture rather than making a sample app special again.

Done when an inline stateful `createWorker` fixture imports
`iterate/processors`, declares its own `zod` dependency, and proves a stream
append wakes `workers.get(ref).processor.wakeStreamProcessor` through the
deployed Worker Loader. Assert the resulting processor state and the shared
zod class identity. Keep the fixture independent of Todo and Guestbook.
