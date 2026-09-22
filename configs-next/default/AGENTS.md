# Project configuration

`worker.ts` serves this project's homepage. A commit to `main` publishes it.
Files execute as JavaScript; sibling modules use `.js`. The worker receives the
project's `itx` through `this.env.ITX.get()` and handles root events through
`processEventBatch(events, range)`. This project has no agents installed.
