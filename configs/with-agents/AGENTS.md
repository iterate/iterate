# Project configuration with agents

`worker.ts` serves the homepage and installs the agents app on `project/created`.
It extends `ConfigWorker` from `./processor.js` and reaches the project's `itx`
through `this.withItx((itx) => …)`, or the `itx` that `processEvent({ event, itx })`
is handed; both release everything the call reached when it returns. Never keep
a value from `this.env.ITX.get()`, and answer data, not handles, from `withItx`:
a kept value keeps the project's context, and any facet holding it, resident
after the project goes idle.
`agents.js` is a runnable bundle of `apps/agents/runtime`, copied into this project.
The app mounts `itx.agents` through a rewrite rule and owns its catalog and facets.
Edit this repository to customize it; upstream template changes do not replace it.
`worker.ts`'s `fetch` first asks `itx.fetchRoutes.match(request)` and forwards a matched
request to the route's itx expression, `route.target`, with `env.ITX.fetch`
(`iterate tunnel <port>` sets a route per tunnel); keep those lines at the top of `fetch`.
