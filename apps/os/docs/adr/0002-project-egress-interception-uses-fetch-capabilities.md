# Project Egress Interception Uses Fetch Capabilities

The old intercept-route design was deleted once `fetch` became an ordinary
shadowable itx capability. A live `fetch` cap intercepts all project egress with
the same session-bound semantics and the same secret-withholding property
(placeholders reach the interceptor unsubstituted). See `apps/os/docs/itx-next.md`
§9.

OS no longer stores an external egress proxy URL on Projects. Tests and operator
debugging pass a live fetch capability into the Project runtime instead. This
keeps outbound interception scoped to one Project Durable Object, removes
persistent proxy configuration from the product model, avoids external transport
plumbing in e2e tests, and lets OS withhold Secret Material while still showing
the original `getSecret(...)` incantation to the intercepting test.

Captun PR stack: https://github.com/iterate/captun/pull/1

Amendment (itx-v4 replacement): the decision carried over; the current
mechanism is `itx.egress.intercept(handler)` (`ProjectEgress.intercept` in
`apps/os/src/next/types.ts`) — a live, last-writer-wins replacement installed
on the Project Durable Object with the same session-bound semantics and the
same secret-withholding property.
