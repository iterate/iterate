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

Two kinds of member, one address space — every dotted call is
`{slug}.{connection}.{...method}`:

- **Built-in slugs are dispatch branches** (`slack`, `google`) in the
  collection's `invokeCapability` — plain imperative branches whose code ships
  with the OS deployment. Not classes: their only callers are untyped dotted
  scripts, so a typed per-provider class ladder bought nothing (an earlier cut
  had one; it was deleted). `BUILTIN_INTEGRATION_SLUGS` is the single constant
  the dispatch, `list()`'s labeling, and the mount collision guard all share.
- **Everything else resolves through the ordinary ITX capability table** under
  the `integrations` prefix. A project adds its own integration with
  `provideCapability({ path: ["integrations", ...] })` — **data, not
  deployment**. No registry, no provider files, no new dispatch machinery: the
  ITX processor's longest-prefix mount resolution does the rest. Mounting
  UNDER a built-in slug (`["integrations", "slack", ...]`) is rejected loudly
  at provide time — the dispatch would shadow it, making the mount durable,
  journaled, and silently unreachable.

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
records `secret/used` audit events. There is **no fallback token** — a typo'd
or disconnected connection name errors loudly instead of silently posting with
a deployment-wide credential.

**Status is a journal tail-fold for both providers** — one machine, no
per-provider mechanism: `getConnection` pages backwards from the journal head
(`streamEventsNewestFirst`) and stops at the first lifecycle fact
(connected/disconnected). Google's token state is the same fold with refresh
events layering onto the connected fact across page boundaries. Nothing
snapshots a processor: the slack router's whole state is its
`channel:thread_ts → streamPath` routing table.

**`list()` = journals ∪ mounts, deduped by path.** Every
`/integrations/<slug>/<connection>` stream in the project's catalogue is one
entry (`source: "builtin"` for slack/google, `"provided"` otherwise — the path
shape is the truth, deliberately not filtered), plus every capability-table
mount under `integrations` (`connection: null` for an integration-level
mount). A provided integration whose webhooks journal at the same path as its
mount is one entry. Journals persist after disconnect, so entries carry a
status, not existence: the dashboard counts `status.connected`.

Management verbs live on the collection: `getConnection` and `disconnect`
are connection-scoped; `startOAuthFlow({ provider, userId })` and the
provider-blind `completeConnect({ provider, code, state, userId })` are not —
the connection name is _derived_ at completion, per above.
Each provider contributes only its exchange half; the storage half (secrets by
argument into Secret DOs, the connected fact, router arming, the directory
claim) is the shared imperative `recordConnection(...)` helper — a function,
deliberately not an event choreography: connect is synchronous (a browser is
waiting on the callback), and credential material travels by parameter to
exactly one confined home, never onto journals.

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

## GitHub is the worked example of "no builtin needed"

GitHub ships as two example-catalogue entries (`github-mcp-connect`,
`github-webhooks-project-worker`), zero platform code. API calls: a
fine-grained PAT in a Secret DO + one durable mount of GitHub's official MCP
server (`expression: ["mcp", ["connect", { url, headers: { authorization:
"Bearer getSecret({ path })" } }]]`) — the agent calls
`itx.integrations.github.main.create_issue({...})` at the same address shape
as a builtin, and no isolate ever holds the token. Webhooks: per-project
ingress already exists — the project host routes to the repo-backed
`worker.js`, whose fetch appends deliveries to the connection's
`/integrations/github/<connection>` journal (an unguessable URL token stands
in for HMAC verification, which worker code cannot do without holding the
signing secret). Builtins earn their place through deployment-owned OAuth
apps + first-party ingress; PAT-based GitHub needs neither.

## Deliberately not built

- **A provider-file registry.** An earlier cut of this work modeled built-ins
  as data-like `IntegrationDefinition` files in a registry array. Rejected:
  it's a second, static capability table beside the real one, only editable by
  deployment. Built-ins are just code (dispatch branches); extensions are just
  capability-table entries (the existing provide system).
- **A connect event choreography.** A proposed follow-up expressed the shared
  storage half of connect as a `connect-requested` event + processor reaction.
  Rejected on the platform's own doctrine: connect is synchronous, `-requested`
  events are for asynchronous side effects, sealed credentials on journals
  would be a second un-shreddable durable home, and an interactive OAuth
  callback must not block on a cold cross-DO wake chain. The invariance lives
  in `recordConnection(...)`, a plain function.
- **Implicit/default connections.** `itx.integrations.slack.chat.postMessage`
  is an error that tells you to name a connection, not a guess.
- **Webhook signature verification in project workers** — worker code cannot
  hold the HMAC secret (substitution is egress-header-only); capability-URL
  tokens are the workaround. The clean platform close, when demanded, is a
  small `secret.verifyHmac({ payload, signature })` op on the Secret DO.
- **Derived secrets** (OAuth refresh as a generic secret derivation; hourly
  GitHub App installation tokens) — a secrets-domain change; Google refresh
  stays in `google-tokens.ts` for now, reading the journal tail newest-first
  so per-call cost does not grow with refresh history.
