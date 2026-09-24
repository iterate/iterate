# Project configuration

`worker.ts` serves this project's homepage. A commit to `main` publishes it.
Every host of the project reaches its `fetch`; the `x-iterate-routing-slug` header
names the host (`blog` for `blog--<project>`, absent on the apex), so route on it
with a plain `if`.
Files execute as JavaScript; sibling modules use `.js`. The worker receives the
project's `itx` through `this.env.ITX.get()` and handles root events through
`processEventBatch(events, range)`. This project has no agents installed.
