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
just work**. Google connections are named from the account email; tokens live
in the connection secret, refreshed on 401 by the Secret DO's shared
`oauth-refresh-token` strategy (nothing token-shaped ever lands on a journal).

Slack Web API calls never hold material: the request carries a
`getSecret(path)` placeholder for the connection's token and traverses
project egress, which substitutes it inside the Secret Durable Object and
records `secret/used` audit events. There is **no fallback token** — a typo'd
or disconnected connection name errors loudly instead of silently posting with
a deployment-wide credential.

**Status is a journal tail-fold for every provider** — one machine, no
per-provider mechanism: `getConnection` pages backwards from the journal head
(`streamEventsNewestFirst`) and stops at the first lifecycle fact
(connected/disconnected). Nothing snapshots a processor: the slack router's
whole state is its `channel:thread_ts → streamPath` routing table.

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
once. Every seeded repo carries a real one — `integrations/waitrose/`
(`apps/os/project-repo-template`): a vendored Waitrose GraphQL client
(`client.ts`, the reverse-engineered Android app's operations) plus the
entrypoint:

```js
// integrations/waitrose/worker.ts in the project repo
export class WaitroseIntegration extends WorkerEntrypoint {
  invokeCapability({ path, args }) {
    const [connection, ...rest] = path; // /integrations/waitrose/<connection>/...
    // walk `rest` on waitroseClient(connection), apply args
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
        source: {
          files: { type: "repo", repoPath: "/", include: ["integrations/waitrose/**"] },
          options: { entryPoint: "integrations/waitrose/worker.ts" },
        },
      },
    ],
  ],
});

await itx.integrations.waitrose.mum.shoppingContext();
await itx.integrations.waitrose.family.trolley(orderId);
```

The mount is a `capability-provided` event on the ITX journal — durable,
replayable, revocable, enumerable. The client addresses its session secrets at
`/secrets/integrations/waitrose/<connection>/session` with `getSecret`
placeholders and bare `fetch()`; dynamic-worker egress routes through the
project egress door, so **even the project's own integration code never holds
its tokens**. The connection secret holds only `{ username, password }` plus
the `waitrose-session` refresh strategy — Waitrose has no refresh grant, so
the Secret DO re-runs the login itself: mint on first use, re-mint on 401.
Exercised end-to-end in `e2e/vitest/integrations-userspace.e2e.test.ts`: the
echo lane (two connections, substitution proof, negative controls) plus the
seeded-template lane live against petshop's Waitrose-shaped GraphQL fixture
(`apps/dummy-petshop/src/waitrose.ts`).

The one mechanical accommodation: `integrations` is a **namespace builtin** —
`rejectBuiltinCollision` allows mounts at depth ≥ 2 under it (mounting at
`["integrations"]` itself is still a collision).

## GitHub: the third builtin

GitHub connects as a **GitHub App installation** (deep-link to
`github.com/apps/<appSlug>/installations/new` → callback with an
`installation_id`; no code exchange, no user token):

- **Connect**: the callback claims the installation — connection named
  `install-<id>`, empty material in the connection secret plus the
  `github-app-installation` refresh strategy (App id + installation id are
  public strategy config; the App private key resolves from
  `APP_CONFIG_INTEGRATIONS__GITHUB` at mint time), `github/connected` on the
  journal, `installation_id` claimed in the directory. One exchange half +
  one `recordConnection` call — the shape every provider pays.
- **API calls**: `itx.integrations.github["<connection>"]` is a real wrapped
  Octokit (`rest.*`, `request(...)`, `graphql(...)`) whose transport carries a
  `getSecret` placeholder through the connection secret's fetch. The Secret
  DO mints the installation token on first use and re-mints on 401 — trusted
  DO code signing the App JWT, no worker, no jail.
- **Inbound App webhooks** land on the door, verify `x-hub-signature-256`
  with plain WebCrypto, and route on `installation_id`.
- **`gh` in sandboxes** works automatically, with no byte handoff: ALL
  container egress (HTTPS included, MITM'd with the container CA) routes
  through the project egress door, so a sandbox holds only a placeholder
  `GH_TOKEN` and substitution + re-mint happen en route. The sandbox DO plants
  `GH_TOKEN` per container start when the project has a GitHub connection (the
  connection secret's `accessToken` as a `getSecret` placeholder;
  lexicographically first connection when several exist), and `gh` reads it
  from the env natively. `git` gets a
  `git http."https://github.com/".extraheader` with a raw Bearer placeholder
  (set by the warm-up script) — deliberately not a credential helper or
  `gh auth setup-git`, which send Basic auth (base64) and would hide the
  placeholder from header substitution.

The provided-lane exhibits remain in the catalogue: `github-mcp-connect`
(GitHub's MCP server mounted under the `github-mcp` slug — built-in slugs
cannot be shadowed) and `github-webhooks-project-worker` (deliveries landing
on the project host's own worker).

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
  tokens are the workaround. The userspace verification story returns with the
  jail lane (ADR 0005), not as a compute method on the public secret.
- **A generic refresh framework.** Refresh is named strategies in the
  Secret DO (`oauth-refresh-token`, `github-app-installation`,
  `waitrose-session`) — one shared imperative implementation per protocol,
  parameterized per secret. A provider whose dance fits none of them gets its
  own small strategy (that is how `waitrose-session` landed), not a strategy
  interpreter.
