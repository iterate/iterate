# Waitrose integration (the reference userspace integration)

An integration your project OWNS: ordinary code in this repo, mounted once
into the project's integrations collection and then addressed exactly like a
built-in — `itx.integrations.waitrose.<connection>.<method>(...)`. Use it, or
copy the pattern for any provider the platform has no built-in for.

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

## 2. Mount the integration (once)

```js
await itx.provideCapability({
  path: ["integrations", "waitrose"],
  type: "itx-expression", // durable: a journaled recipe, replayed per call
  flattenNestedPaths: true,
  instructions:
    "Waitrose grocery integration. Address a connection first: itx.integrations.waitrose.<connection>.shoppingContext() / .trolley(orderId?).",
  expression: [
    "workers",
    [
      "get",
      {
        type: "stateless",
        path: "/",
        entrypoint: "WaitroseIntegration",
        source: {
          files: { type: "repo", repoPath: "/", include: ["integrations/waitrose/**"] },
          options: { entryPoint: "integrations/waitrose/worker.ts" },
        },
      },
    ],
  ],
});
```

## 3. Call it

```js
const context = await itx.integrations.waitrose.mum.shoppingContext();
const trolley = await itx.integrations.waitrose.mum.trolley(context.customerOrderId);
```

Add methods by editing client.ts (each is one GraphQL operation) — the mount
is late-bound to the repo, so the next call after a commit runs the new code.
