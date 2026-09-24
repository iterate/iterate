# Project configuration

`worker.ts` serves this project's homepage. A commit to `main` publishes it.
Every host of the project reaches its `fetch`; the `x-iterate-routing-slug` header
names the host (`blog` for `blog--<project>`, absent on the apex), so route on it
with a plain `if`. It first asks `itx.ingressRoutes.match(request)` and forwards a
matched request to its route with `env.ITX.fetch` (`iterate tunnel <port>` sets a
route per tunnel); keep those lines at the top of `fetch`.
Files execute as JavaScript; sibling modules use `.js`. The worker extends
`ConfigWorker` from `./processor.js`. It reaches the project's `itx` through
`this.withItx((itx) => …)`: one round trip, after which everything the call
reached is released. Never keep a value from `this.env.ITX.get()`, and answer
data, not handles, from `withItx`: a kept value keeps the project's context, and
any facet holding it, resident after the project goes idle. Root events the
worker subscribes to arrive one at a time in `processEvent({ event, itx })`.
This project has no agents installed.
