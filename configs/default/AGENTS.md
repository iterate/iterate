# Project configuration

`worker.ts` serves this project's homepage. A commit to `main` publishes it.
Every host of the project reaches its `fetch`; the `x-iterate-routing-slug` header
names the host (`blog` for `blog--<project>`, absent on the apex), so route on it
with a plain `if`. It first asks `itx.ingressRoutes.match(request)` and forwards a
matched request to its route with `env.ITX.fetch` (`iterate tunnel <port>` sets a
route per tunnel); keep those lines at the top of `fetch`.
Files execute as JavaScript; sibling modules use `.js`. The worker receives the
project's `itx` through `this.env.ITX.get()` and handles root events through
`processEventBatch(events, range)`. This project has no agents installed.
