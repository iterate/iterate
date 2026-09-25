# Project configuration

`worker.ts` serves this project's homepage. A commit to `main` publishes it.
Every host of the project reaches its `fetch`; the `x-iterate-routing-slug` header
names the host (`blog` for `blog--<project>`, absent on the apex), so route on it
with a plain `if`. It first asks `itx.fetchRoutes.match(request)` and forwards a
matched request to the route's itx expression, `route.target`, with
`env.ITX.fetch` (`iterate tunnel <port>` sets a route per tunnel); keep those
lines at the top of `fetch`.
Files may be TypeScript or JavaScript and import each other by relative path.
Import packages by name: `iterate/*` and `zod` come from the platform; list any
other package in `package.json` and it loads from npm through esm.sh (packages
that need Node.js builtins are refused). The worker extends `ConfigWorker` from
`iterate/sdk`. It reaches the project's `itx` through
`this.withItx((itx) => …)`: one round trip, after which everything the call
reached is released. Never keep a value from `this.env.ITX.get()`, and answer
data, not handles, from `withItx`: a kept value keeps the project's context, and
any facet holding it, resident after the project goes idle. Root events the
worker subscribes to arrive one at a time in `processEvent({ event, itx })`.
This project has no agents installed.
Type-check locally with `npm install && npx tsc`; the loader strips types but never checks them.
