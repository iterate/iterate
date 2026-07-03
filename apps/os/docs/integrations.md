# Integrations

The unit is a **connection** at a fully qualified path:
`/integrations/<slug>/<connection>` — `/integrations/slack/main-slack`,
`/integrations/google/jonas`. One integration can hold many connections; there
is no implicit or default connection — addressing something means naming it.
The path is simultaneously the itx address, the journal home for that
connection's facts and routed events, and the convention root for its secrets
(`/secrets/integrations/slack/main-slack/bot-token`). This is the platform's
"an address is a stream coordinate" rule applied without exceptions.

## The collection

`itx.integrations` is a collection, like `itx.secrets` and `itx.streams`:

```js
await itx.integrations.slack["main-slack"].chat.postMessage({ channel, thread_ts, text });
await itx.integrations.google["jonas"].gmail.request({ path: "/users/me/messages" });
await itx.integrations.list(); // every connection, built-in and provided
```

Two kinds of member, one address space:

- **Built-in integrations are named getters** (`slack`, `google`) — RpcTargets
  whose code ships with the OS deployment, exactly like the other `Itx`
  builtins. Each is a catalog of connections by name.
- **Everything else resolves through the ordinary ITX capability table** under
  the `integrations` prefix. A project adds its own integration with
  `provideCapability({ path: ["integrations", ...] })` — **data, not
  deployment**. No registry, no provider files, no new dispatch machinery: the
  collection's dynamic path fallback forwards unknown names to
  `invokeCapability({ path: ["integrations", ...] })` and the ITX processor's
  longest-prefix mount resolution does the rest.

The old `itx.slack` / `itx.gmail` builtins are deleted; they were the
un-nameable single-connection special case this model removes.

## Three dimensions, three properties

The design questions integrations raise map onto properties of different
things — none of them needs a framework:

1. **Receives webhooks or not** — a property of the _slug's ingress code_.
   Slack's webhook route (signature verification, ACK-200 doctrine, the team
   directory fold) stays deployment code in the app worker; its job is to land
   routed events on the right `/integrations/slack/<connection>` journal.
   Integrations without first-party ingress (google, waitrose) simply have
   none.
2. **Secrets from deployment appconfig vs the project secret system** — a
   property of the _connection_, visible in where its material lives: Slack's
   OAuth app credentials are deployment appconfig (Iterate's app registration);
   each connection's bot token is a project secret at the connection's path. A
   customer-owned Slack app would flip the first without changing shape.
3. **Code shipped with the deployment vs data** — exactly the getter/table
   split above. Promotion path for a provided integration: reimplement it as a
   named getter (a PR to OS); its addresses don't change.

## Built-in connections (slack, google)

A Slack connection is born at OAuth completion: the callback derives the
connection name from the workspace domain (deterministic — reconnecting the
same workspace updates the same connection), stores the bot token at
`/secrets/integrations/slack/<connection>/bot-token`, appends
`slack/connected` (with the connection) to the connection journal, arms the
webhook-router processor on that journal, and claims the team in the
deployment-wide directory as `teamId → { projectId, connection }`.

Inbound webhooks route by that claim onto the connection journal; the router
processor forwards thread events to
`/agents/slack/<connection>/<channel>/ts-<ts>` agent streams, so a Slack agent
recovers its connection from its own stream path — which is how its replies
pick the right bot token, and how **multiple Slack workspaces in one project
just work**. Google connections are named from the account email; Gmail calls
resolve a fresh access token from the connection's journal (refresh events
land back on the same journal).

Slack Web API calls never hold material: the request carries a
`getSecret({ path })` placeholder for the connection's token and traverses
project egress, which substitutes it inside the Secret Durable Object and
records `secret/used` audit events.

Management verbs live on the collection and are connection-scoped:
`startOAuthFlow({ provider, userId })`,
`getConnection({ provider, connection })`,
`disconnect({ provider, connection })`, plus the OAuth `complete*` callbacks.

## Provided integrations (the waitrose case)

A project implements a whole integration as code in its own repo and mounts it
once:

```js
// integrations/waitrose.js in the project repo
export class WaitroseIntegration extends WorkerEntrypoint {
  invokeCapability({ path, args }) {
    const [connection, ...rest] = path; // /integrations/waitrose/<connection>/...
    // walk `rest` on waitroseSdk(connection), apply args
  }
}
```

```js
await itx.provideCapability({
  path: ["integrations", "waitrose"],
  type: "itx-expression", // durable: a journaled recipe, replayed per call
  flattenNestedPaths: true, // the remaining path arrives as data (workerd RPC
  //                           does not traverse instance fields)
  expression: [
    "workers",
    [
      "get",
      {
        type: "stateless",
        path: "/",
        entrypoint: "WaitroseIntegration",
        source: { type: "repo", repoPath: "/", sourcePath: "integrations/waitrose.js" },
      },
    ],
  ],
});

await itx.integrations.waitrose.family.searchProducts("milk");
await itx.integrations.waitrose.mum.basket.add(itemId);
```

The mount is a `capability-provided` event on the ITX journal — durable,
replayable, revocable, enumerable. The worker's SDK addresses its session
secrets at `/secrets/integrations/waitrose/<connection>/session` with
`getSecret` placeholders and bare `fetch()`; dynamic-worker egress routes
through the project egress door, so **even the project's own integration code
never holds its tokens**. Exercised end-to-end (two connections, substitution
proof, negative controls) in `e2e/vitest/integrations-userspace.e2e.test.ts`.

The one mechanical accommodation: `integrations` is a **namespace builtin** —
`rejectBuiltinCollision` allows mounts at depth ≥ 2 under it (mounting at
`["integrations"]` itself is still a collision).

## Deliberately not built

- **A provider-file registry.** An earlier cut of this work modeled built-ins
  as data-like `IntegrationDefinition` files in a registry array. Rejected:
  it's a second, static capability table beside the real one, only editable by
  deployment. Built-ins are just code (getters); extensions are just
  capability-table entries (the existing provide system).
- **Implicit/default connections.** `itx.integrations.slack.chat.postMessage`
  is an error that tells you to name a connection, not a guess.
- **Webhook ingress for provided integrations** — needs per-project ingress
  transport; the connection journal gives those events a home when it comes.
- **Derived secrets** (OAuth refresh as a generic secret derivation) — a
  secrets-domain change; Google refresh stays in `google-tokens.ts` for now.
