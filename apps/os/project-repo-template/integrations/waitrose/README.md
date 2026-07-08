# Waitrose integration (the reference userspace integration)

An integration your project OWNS: a vendored client in this repo
(client.ts), exposed through the project worker's `waitrose` getter
(worker.ts) as `itx.worker.waitrose.<connection>.<method>(...)`. The project
worker always exists and is rebuilt from this repo, so there is no mount
step and nothing session-owned to expire — the surface is durable by
construction. Use it, or copy the pattern for any provider the platform has
no built-in for: one vendored client file plus one getter on the worker.

## 1. Connect an account

Each connection is one Waitrose account. Its credentials live in a project
secret at the connection's fully qualified path; the `waitrose-session`
refresh strategy makes the secret's own Durable Object log in (the same
`NewSession` mutation the Android app performs — see client.ts) whenever the
stored session is missing or a request answers 401. Waitrose has no refresh
grant: re-login IS the refresh, so an initial session token is not needed —
the first use mints one.

```js
await itx.secrets.get("/secrets/integrations/waitrose/mum/session").update({
  egress: { urls: ["https://www.waitrose.com"] },
  material: { username: "mum@example.com", password: "…" },
  refresh: {
    kind: "waitrose-session",
    graphqlUrl: "https://www.waitrose.com/api/graphql-prod/graph/live",
  },
});
```

The password goes in and never comes out: no code — including this
integration's — can read it back, and the session tokens it mints substitute
into requests only at project egress, toward the pinned host.

## 2. Call it

```js
const context = await itx.worker.waitrose.mum.shoppingContext();
const search = await itx.worker.waitrose.mum.searchProducts("milk", { size: 5 });
await itx.worker.waitrose.mum.addToTrolley(search.products[0].lineNumber, 1);
const trolley = await itx.worker.waitrose.mum.trolley();
```

Every dotted call lands on the worker as one flattened
`invokeCapability({ path, args })`; its userspace walk (see worker.ts)
resolves `waitrose` → the connection's client → the method, all in one
round trip. The client only ever sends a `getSecret(...)` placeholder as its
bearer — the real token substitutes at project egress.

Add methods by editing client.ts (each is one GraphQL operation or one REST
call) — the worker rebuilds from the repo on the next call after a commit.
Every request carries the Android app's User-Agent (`WAITROSE_USER_AGENT`):
Waitrose's edge rejects UA-less requests with HTTP 520, and the GraphQL
gateway rejects hand-slimmed selections with HTTP 400, so the queries are
the app's verbatim.
