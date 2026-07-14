# Integrations & secrets

The current model, after the v7 reshape. Decisions and rejected designs:
[ADR 0005 — The Secret Cell Invariant](adr/0005-the-secret-cell-invariant.md).
The caller-facing surface: [integrations.md](integrations.md).

Four invariants carry the whole design:

1. **The secret cell invariant.** Material goes in; nothing comes out except a
   request to a pinned host. No read lane, no reveal lane, no compute lane, no
   cross-secret chaining.
2. **Platform credentials are code + config, not secrets-system objects.** A
   deployment-owned credential is a typed AppConfig value plus an
   allowed-origin pin in one closed registry. No virtual paths, no synthetic
   DOs.
3. **Built-ins are native.** Slack, Google, and GitHub are plain first-party
   code: imperative connect flows, direct config reads, trusted refresh. The
   jail exists for code we didn't write, and no built-in uses one.
4. **One egress decision point.** Dynamic-worker `globalOutbound`, project
   worker egress, and sandbox container catch-all outbound (MITM'd TLS) all
   converge on the Project DO's `fetch()` — one substitution + pin function,
   three callers.

## 1. The secret

One Durable Object per path under `/secrets/**` (`secret-durable-object.ts`).
Folded state: encrypted material (one JSON blob, write-only), an egress URL
allowlist, an optional refresh strategy, an audit record.

- `update({ material, egress, refresh? } | { egress?, refresh? })` — the only
  write verb. Replacement material always carries its complete egress policy.
- Ciphertext is authenticated to its project, secret path, exact egress
  origins, and storing event offset. Every update without replacement material
  clears it (including refresh-only updates); copied ciphertext cannot be
  re-pinned or replayed.
- `__describe()` — the node's self-report, metadata only (hasMaterial,
  egress, refresh kind, audit); material never leaves, in snapshots or pushes.
- `fetch(request)` — the only lane material travels. Every request must carry
  at least one `getSecret({ path[, field] })` placeholder for THIS secret in
  its headers or its URL path (one request, one secret); the DO substitutes
  from decrypted material and dispatches, after checking the destination
  origin against the pin. Substitution reaches headers plus the URL PATH
  (added for Telegram, whose Bot API authenticates in the path
  `/bot<token>/…`) — never the query string, never the body; a placeholder
  elsewhere in the URL is rejected loudly rather than passed through.
- Credential-bearing fetches follow at most five same-origin redirects, with
  every hop requested manually and revalidated before rebuilding the request.
  Cross-origin redirects are rejected rather than forwarding headers or bodies.
- Secret streams accept user-appended events, including
  `events.iterate.com/secret/*`. Forged facts may change public metadata or
  clear material, but cannot install usable ciphertext outside its authenticated
  project/path/policy/event context.

### Refresh strategies

A secret optionally carries ONE named strategy, run by the DO's own trusted
code (single-flight) when a substituted request 401s or a referenced field is
missing (the first-use mint):

- `oauth-refresh-token` — RFC 6749 refresh grant: `tokenEndpoint` (must be
  within the pin), Basic client credential from `clientCreds` — `"material"`
  (clientId/clientSecret fields of this secret's own material; the
  bring-your-own-app case) or `{ platform: "<configPath>" }` (built-ins).
- `github-app-installation` — sign an App JWT (RS256, iss = `appId`), POST to
  `{apiBase}/app/installations/{installationId}/access_tokens`, store the
  token. `privateKey` is `"material"` (bring-your-own App) or
  `{ platform: "integrations.github" }` (the first-party App, pinned to
  api.github.com). The installation id is public and lives in the strategy
  config, not in material.
- `waitrose-session` — the username/password → session-token archetype's
  first instance: POST the vendor's `NewSession` login mutation to
  `graphqlUrl` (must be within the pin) with `username`/`password` from this
  secret's own material, store the returned `accessToken`. Waitrose has no
  refresh grant — re-login IS the refresh — so one strategy covers the
  first-use mint and the 401 re-mint. Material-only by nature: a Waitrose
  account is always the user's own.

Exchange endpoints falling within the secret's own pin is what keeps refresh
inside the cell: refresh moves bytes only toward pinned hosts, like any use.
The selected strategy and reducer-owned update offset must still match current
state before provider I/O, and the result is compare-appended at the snapshotted
next event offset. Any intervening update at either side of that snapshot—even
one repeating the same strategy—prevents stale material from being minted or
restored.
One shared implementation per protocol replaces the per-secret worker that
used to be copied into every secret; configuring the strategy is the trust
event.

## 2. Platform credentials

`platform-secrets.ts` — a known, closed registry over typed AppConfig:

- **API keys** (`integrations.exa.apiKey`, `integrations.parallel.apiKey`):
  substitutable into project egress as
  `getSecret({ platform: "<configPath>" })` header references, resolved at
  the project egress door, each pinned to its provider origins. Adding one is
  adding a config key + a row.
- **The internal OpenAI key is not in this registry.** The Agent Durable
  Object may use it only through its hardcoded Cloudflare AI Gateway model
  transport; project egress cannot reference or receive it.
- **OAuth client credentials** (`integrations.google`,
  `integrations.petshop`): resolved by the `oauth-refresh-token` strategy.
  The registry's origin pin means even a hostile `secret.update` configuring
  a platform ref can only make the DO run a normal refresh against the
  provider's real token endpoint.
- **The GitHub App key** (`integrations.github`): resolved by the
  `github-app-installation` strategy, only toward `api.github.com`.

Platform credential bytes are handled only by trusted platform code and never
sit in project material. Built-in connect flows read config directly — no
reference grammar at all on that lane.

## 3. Integrations

An integration is ordinary imperative per-slug code — there is no integration
framework, no generic `Integration` interface, no declarative webhook
pipeline. Connections are NAMED: a project can hold several Slack workspaces /
Google accounts / GitHub installations, each at
`/secrets/integrations/<slug>/<connection>` with facts on the
`/integrations/<slug>/<connection>` stream.

- **Connect** (`connect-flows.ts`): per-provider exchange half + the shared
  `recordConnection` storage half (write the connection secret, append the
  connected fact, arm the router subscription, claim the directory entry).
- **Outbound calls**: the itx caller surface replays dotted paths onto real
  vendor SDK instances — a real `@slack/web-api` WebClient, the all-in-one
  `octokit` SDK — whose transport carries a `getSecret(...)`
  placeholder through the connection secret's `fetch()`. Full SDK surface for
  free; tokens never leave the DO.
- **Inbound webhooks** (`integration-webhook-api.ts` + per-provider
  handlers): a tiny chain of imperative `fetch` handlers. Each verifies
  however its provider requires (plain WebCrypto in platform code), extracts
  the external id, and calls the shared `routeIntegrationWebhook`. The
  ACK-and-drop rule holds per handler: validly-signed-but-unclaimed → 200
  with an `ignored` reason; bad signature → 401 (the one non-2xx).
- **The directory** (`integration-streams.ts`): one deployment-wide
  `(slug, externalId) → { projectId, connection }` stream, claimed at
  connect, folded on read by the webhook door.

### The three built-ins

- **Slack** — bot token in the connection secret, no refresh (Slack bot
  tokens don't expire). Webhook door serves Events + interactivity +
  url_verification.
- **Google/Gmail** — `{ accessToken, refreshToken }` + the
  `oauth-refresh-token` strategy against `oauth2.googleapis.com` with the
  platform client credential.
- **GitHub** — a GitHub App installation (deep-link → `installation_id`
  callback, no code exchange). Empty material + the `github-app-installation`
  strategy; the token mints on first use and re-mints on 401. Inbound App
  webhooks verify `x-hub-signature-256` and route on `installation_id`.

## 4. The userspace lane

What ships now:

- **Placeholder egress**: any project code (dynamic workers, project worker,
  sandboxes) composes requests with `getSecret(...)` placeholders; the
  project egress door routes them to the referenced secret. The composing
  code never holds bytes.
- **Provided integrations**: `provideCapability({ path: ["integrations",
"<name>"] })` mounts project-authored integrations into the same collection
  and address shape as built-ins (the ocado echo e2e). The other userspace
  shape is a getter on the project worker (`itx.worker.<getter>.<method>()`):
  durable by construction, no mount step — a project commits the dep + getter
  to its own repo first (the worker-build e2e). Waitrose itself is a builtin
  (`itx.integrations.waitrose`, vendored client in
  `domains/integrations/waitrose-api.ts`); see integrations.md.
- **Shared refresh strategies**: a standards-shaped userspace provider
  configures `oauth-refresh-token` with `clientCreds: "material"` — no worker
  needed (the petshop userspace e2e). A provider-specific dance is another
  small named strategy, not a framework: `waitrose-session` closes the
  username/password → session archetype (mint on first use, re-login on 401),
  proven against petshop's GraphQL session-login door — one more way into
  petshop's one pets API — in the waitrose-session e2e lane. The waitrose
  builtin itself talks to the real Waitrose.

Deferred to the userspace-integrations PR (see ADR 0005):

- **The jail**: per-secret project-authored workers with in-jail
  `read()`/`update()` for bespoke exchanges the platform carries no named
  strategy for (the username/password → session archetype itself is now the
  `waitrose-session` strategy above; petshop's `legacy-login` stays the
  fixture for the jailed variant). Extends the cell to DO + jail; the
  boundary stays "bytes only leave toward pinned hosts"; worker install gated
  like a material write.
- **Frame-authenticated WebSocket protocols** (for example Discord IDENTIFY):
  frame placeholders are sent literally because application frames are opaque.
  Header-authenticated HTTP/1.1 upgrades use the existing `fetch()` surface
  and native socket response; frame payloads remain opaque. A trusted
  first-frame API is still deferred. See
  [sandbox-websocket-egress.md](./sandbox-websocket-egress.md).
- **A userspace webhook-verification story** (the compute-methods question
  returns here, answered inside the jail rather than on the public secret).

## 5. Sandboxes

ALL container egress — including HTTPS, MITM'd with the Cloudflare container
CA (`interceptHttps`) — routes through the project egress door. So sandboxes
need no token bytes: the sandbox DO plants a placeholder `GH_TOKEN` per
container start when the project has a GitHub connection, and the warm-up
script sets a `git http.extraheader` with Basic auth
(`x-access-token` + base64 of the placeholder — GitHub git rejects Bearer).
Egress peels Basic Authorization headers so the placeholder is still
discoverable and substitutable. Substitution + refresh-on-401 happen en route
under the pin, exactly as for any other caller. There is no reveal lane, and
none is needed.

## 6. The proof (apps/dummy-petshop)

A real deployed third party — OAuth 2.0 (Basic at token, sealed tokens,
refresh, legacy login), bearer API, HMAC webhooks, a GitHub-App-installation
stand-in, a Waitrose-shaped GraphQL login/session surface (short-TTL sessions
so re-mint-on-401 proves fast), three WebSocket credential shapes, MCP,
oRPC/OpenAPI, and a `/__backdoor` console for deterministic failure
injection. The e2e lanes
(`integrations-petshop`, `integrations-github`, `integrations-userspace`)
prove connect → authed call → forced-expiry refresh against it live; the
gateway shapes wait for the userspace-lane PR.
