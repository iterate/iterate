# Integrations & Secrets — spike

A working prototype of the integration system and the journal-backed Secret
domain object, built to show the **shape of things**, not to ship. GitHub and
Discord are the two concrete integrations; Discord exists specifically because
its gateway websocket teases out requirements webhooks don't.

Everything here is conventions and symmetry, deliberately not a framework:
providers rhyme with each other instead of implementing interfaces that
generic machinery interprets.

## The shape in one picture

```
                         ┌─ FIRST-PARTY INGRESS (os.iterate.com) ──────────────┐
  GitHub POST ──────────▶│ each integration = a PARTIAL FETCH FUNCTION:        │
  Discord POST ─────────▶│   verify sig → handshakes → captureIntegrationEvent │
                         └──────────────────────┬──────────────────────────────┘
  Discord gateway ws ─▶ DiscordGatewayDO ───────┤   (same capture primitive)
                                                ▼
                 GLOBAL ns   /integrations/{slug}/webhooks      ← raw, verbatim;
                                                │                 capture gates the 200
                              integration-ingress processor      (IntegrationIngressDO)
                              folds route-registered events
                              into routingKey → projectId
                                                │  cross-namespace forward
                                                ▼
                 PROJECT ns  /integrations/{slug}/{account}      ← connected/disconnected/
                                                │                  event-received
                              integration processor (IntegrationDO)
                              connection state + the fan-out seam
                              (where the Slack thread-router pattern plugs in)

                 PROJECT ns  /secrets/{slug}                     ← set/rotated/used/deleted,
                              secret processor (SecretDO)          material ALWAYS encrypted
                              fetch-with-substitution, refresh     in payloads
                              alarms, audit trail

  itx.integrations.github.octokit.rest.issues.create({...})     ← IntegrationsCapability
  itx.integrations.discord.api.channels.createMessage(id, {...})  builds the well-known SDK
                                                                   inside a platform loopback,
                                                                   token via SecretDO trapdoor
```

## What an integration is

One file per provider (`domains/integrations/providers/{slug}.ts`) exporting an
`IntegrationDefinition` (definition.ts):

- **`fetch(ctx)` — the partial fetch function.** From the ingress worker's
  perspective an integration is nothing more than `(request) → Response | null`.
  The provider owns its whole webhook handling imperatively — URL match,
  signature scheme (GitHub HMAC, Discord ed25519), protocol handshakes
  (Discord PING→PONG) — and has exactly one side-effect channel:
  `capture({ transport, routingKey, idempotencyKey, body })`, which appends the
  raw event to the global capture stream. The worker hook
  (`ingress.ts:handleIntegrationIngress`) just tries each integration in turn.
- **`providedSecrets`** — what the integration provides into `/secrets/…` once
  connected (integrations are _secret providers_).
- **`createSdk(ctx)`** — builds the well-known SDK object that
  `itx.integrations.{slug}.**` path-replays into. GitHub returns
  `{ octokit: new Octokit(...) }`; Discord returns `{ api: new API(rest), rest }`
  from @discordjs/core. Agents get the SDK's behavior, never its token.

`registry.ts` is just the list. Adding Linear = one provider file + one line.

## An integration IS a domain object

A connected integration is a domain object in exactly the sense Secrets are:
a journal (`{projectId}:/integrations/{slug}`) plus ONE Durable Object folding
it — and after the cleanup pass, `IntegrationDurableObject` is genuinely the
integration, not just a fold host. It implements the itx calling convention,
so `itx.integrations.github.**` terminates in github-in-this-project's own DO,
where its three faces meet:

- its **journal**: connection lifecycle + every routed provider event;
- its **SDK**: `call({ path, args })` builds the provider SDK holding NO
  material — its token is a `getSecret({ key })` placeholder and its fetch is
  the terminal egress pipe (dialed as a loopback), where substitution with
  inline derivation happens. First-party SDKs authenticate exactly like
  userspace ones;
- its **fan-out seam**: provider-specific reaction to routed events (the
  Slack thread-router pattern) plugs into the hosted processor.

`IntegrationsCapability` is now a thin ROUTER with no integration logic:
registry slug → that integration's DO; anything else → the project's worker
(userspace). What deliberately does NOT live in the DO: webhook signature
checks (stateless, per-request), the global routing hop (one ingress-router
DO per integration per deployment), and secret material at rest (the Secret
DOs). The split of identities:

| thing                                | identity                                                      |
| ------------------------------------ | ------------------------------------------------------------- |
| the provider TYPE ("what github is") | code — a provider file in the registry                        |
| github IN A PROJECT                  | `IntegrationDurableObject` + its journal                      |
| one credential                       | `SecretDurableObject` + `/secrets/{slug}`                     |
| the deployment-wide routing table    | `IntegrationIngressDurableObject` + the global capture stream |
| a userspace integration              | the project worker (the project's code-as-domain-object)      |

The deeper rule the cleanup converged on: **the processor owns the logic,
the DO is its host.** Requests are events (`connect-requested`,
`derive-requested`); reactions live in `processEvent` (idempotency-keyed from
the source event, fold-gated, replay-safe behind the side-effect anchor); DO
RPC verbs only append facts and read folds, plus supply the deps only a host
has (crypto keys, cross-namespace streams, sibling dials, alarms).

Known trade-off: SDK calls serialize through the per-account DO. For a hot
integration the SDK surface can move back to a stateless loopback that
consults the DO's fold — the DO stays the identity either way.

## Integration vs instance: ACCOUNTS

"Google" is an integration; "google as jonas@nustom.com" is an **account** —
and a project can hold many accounts of one integration. The account is the
instance dimension, built into every identity from the start:

- the domain object is the **(project, integration, account)** triple;
- its journal is `/integrations/{slug}/{account}` (accounts enumerate as the
  child paths of `/integrations/{slug}`);
- provided secrets live at `/secrets/{slug}/{account}/{name}` — definitions
  declare secret NAMES ("access-token"), the system composes account-scoped
  slugs;
- routing claims resolve a routing key to **(project, account)** — one key,
  one owner, but a project's accounts each claim their own keys;
- the itx address carries the account in its first segment:
  `itx.integrations.google.**` is account `default`,
  `itx.integrations["google/jonas"].**` is account `jonas` — the address
  under `itx.integrations` IS the journal path under `/integrations`, so the
  same coordinate read through `itx.streams.get("/integrations/google/jonas")`
  is the account's journal. The unnamed
  single-account case never sees the dimension;
- userspace mirrors it: the forwarded call carries `account`, and an app's
  `integrations` entry can be a factory `(account) => sdk`
  (`itx.integrations["waitrose/mum"]` in the template);
- customer-owned gateway scopes are `project:{projectId}:{account}` — two
  Discord bots, two sockets.

`connectIntegration` takes `account` (default `"default"`): connecting a
second Google account is the same three appends under a different account
name. The two-account Waitrose flow is exercised end to end in
`waitrose-userspace.test.ts`.

## The event flow

1. **Capture, globally, before anything else.** Provider events land verbatim
   on `{global}:/integrations/{slug}/webhooks` and only that durable append
   gates the webhook 200 (the Slack latency lesson — provider retries must
   never queue behind cold DOs). Gateway dispatches go through the _same_
   capture call from the gateway DO, so downstream is transport-blind.
2. **Route by fold, not by D1.** The `integration-ingress` processor reduces
   `route-registered` events (appended at connect time) into a
   `routingKey → projectId` table and cross-posts each captured event to the
   owning project's `/integrations/{slug}` stream. The routing table is itself
   event-sourced on the same stream it routes.
3. **Live in the project.** The `integration` processor folds connection state
   and routed events. Its `onIntegrationEvent` dep is the seam where
   provider-specific fan-out (the Slack thread-router → agent streams pattern)
   plugs in; the spike leaves it open.

## Secrets as domain objects

A Secret is a stream at `{project}:/secrets/{slug}` plus a `SecretDurableObject`
folding it (slugs can be segmented: `github/access-token` groups under the
integration that provided it).

- **Encrypted in event payloads.** `secret/set` and `secret/rotated` carry an
  AES-256-GCM envelope (`secret-crypto.ts`, deployment key
  `SECRETS_ENCRYPTION_KEY`). Journals replicate freely; plaintext exists only
  transiently inside the DO.
- **Material never leaves the DO** in the normal path:
  `fetchWithSecret({ request, usedBy })` substitutes `{{secret}}` in
  url/headers/body and performs the fetch inside the DO, returning a
  serializable response snapshot.
- **The trapdoor is narrow.** SDKs do NOT need material in hand: they take the
  placeholder as their token (octokit's `auth`, discord REST's `setToken`)
  and a substituting fetch — pretend the placeholder IS the secret. And the
  egress pipe doesn't need it either: it delegates the fetch into the Secret
  DO chain. `revealForPlatformUse({ usedBy })` remains for the Discord
  gateway's identify frame (a websocket message has no fetch hop to
  substitute at) and sibling DOs resolving derivation sources — both inside
  the secret system, both audited.
- **Refresh is the DO's job** — via derivation (next section): a secret
  carrying a derivation re-derives inline whenever a use finds it stale, and
  proactively via an alarm at expiry-minus-leeway, each run appended as
  `secret/rotated`. Derivation sources are other Secrets, dereferenced through
  their own DOs — the secret system consuming itself, on purpose.

## Derived secrets — the unifying theory

A Secret's material is either a **fact** (set directly: a password, a PAT, a
refresh token, a plain config variable) or **derived**: computed from the
material of OTHER secrets via an exchange, valid for a while, recomputed on
demand. That one idea (`secret-derivation.ts`) subsumes what looked like
separate features:

- **OAuth access tokens aren't special.** "POST the token endpoint with
  `getSecret({ key: "google/refresh-token" })` and
  `getSecret({ key: "google/oauth-client-secret" })`, read `access_token` and
  `expires_in`" is just one `http-exchange` derivation. The refresh token and
  client secret are ordinary sibling Secrets.
- **The Waitrose case.** No refresh tokens — you re-login with
  username/password and sessions last ~5 minutes:
  `waitrose/access-token = http-exchange(generateSession mutation referencing
waitrose/username + waitrose/password, ttlSeconds: 300)`.
- **Doppler-style variables** are the degenerate case: a fact with
  `sensitivity: "plain"` (still enveloped on the stream; `describe()` shows
  the value).

Derivation is STREAM-PROCESSOR logic, not DO code: needing fresh material is
itself an event. A stale use (or the expiry alarm) appends
`secret/derive-requested` — idempotency-keyed by the stale version, so N
concurrent stale uses collapse into ONE request — and the secret processor
reacts: it checks the fold (already rotated past that version? request
satisfied, do nothing), runs the http-exchange, and appends `secret/rotated`.
The DO's verbs only append facts and read the fold; the DO supplies the two
capabilities only a host has (the encryption key, sibling-secret dials) as
processor deps. Every run is on the journal as a requested → rotated pair;
every source dereference appends `secret/used` on the source's own stream.
And because a derivation's `getSecret({ key })` references resolve through
the SOURCE secrets' own domain objects, **derivations chain**: a token
derived from a token derived from a password, lazily, hop by hop, fully
audited.

The placeholder language is the same one project egress speaks — derivation IS
egress substitution, one hop further down, performed by the secret system on
itself. (One wrinkle worth knowing: templates embedded in `JSON.stringify`'d
bodies carry escaped quotes, so the reference parser accepts
`\"key\"` too.) A `script` derivation kind is declared but not executable yet —
the fully general escape hatch where project code computes
`{ material, expiresAt }`.

The terminal EgressPipe never touches journaled material: it parses
`getSecret({ key })` references and DELEGATES the request into the referenced
secrets' own DOs — each hop substitutes its own reference (re-deriving inline
if stale) and the LAST hop performs the outbound fetch. Material only ever
exists inside Secret DOs and on the wire to the API. There is no other
secret store: the legacy D1 layer is gone. That is what makes the headline
work: a project worker writes
`authorization: Bearer getSecret({ key: "waitrose/default/access-token" })`
and gets automatic inline token refresh without any isolate outside the
secret system ever holding a credential.

## Userspace integrations — the Waitrose case

A customer can define a whole integration in their own project worker, and
`itx.integrations.waitrose` simply exists. Same surface as github/discord, two
resolution tiers:

- Slugs in the platform registry build their SDK inside the first-party
  loopback (tokens via the Secret DO trapdoor).
- **Any other slug forwards to the project's own worker** as one call:
  `worker.integrations({ slug, path, args })` (one method call, not a deep
  property walk — workerd RPC doesn't traverse instance fields). The project
  walks the path on its concrete SDK object locally.

The userspace SDK authenticates with `getSecret({ key })` placeholders in bare
`fetch()` headers — so even the customer's own integration code never holds
its tokens; substitution (with inline derivation) happens in the terminal
egress pipe, and live `fetch` shadows still only ever see placeholders.

The working example is in the project template
(`iterate-config-repo/apps/waitrose/worker.js`, wired through the root
worker's `integrations` export, modeled on github.com/jonastemplestein/waitrose):

```js
// one-time: itx.worker.connectWaitrose({ username, password })
await itx.secrets.set({ slug: "waitrose/username", material: username, sensitivity: "plain" });
await itx.secrets.set({ slug: "waitrose/password", material: password });
await itx.secrets.set({
  slug: "waitrose/access-token",
  derivation: {
    kind: "http-exchange",
    request: {
      /* generateSession mutation,
    credentials as getSecret refs */
    },
    extract: { materialPointer: "/data/generateSession/accessToken", ttlSeconds: 300 },
  },
});

// henceforth, from anywhere in the project:
await itx.integrations.waitrose.searchProducts("milk");
```

`itx.secrets` (SecretsJournalCapability) is the deliberately reveal-free
surface that makes this possible from userspace: set, describe,
fetch-with-substitution — never material. The whole loop is exercised in
`src/domains/integrations/waitrose-userspace.test.ts`: connect → first search
derives a session inline → second search reuses it → six minutes later the
next search re-derives, with the SDK provably holding only placeholders
throughout.

This is also where first-party and customer-owned integrations meet: a
userspace integration is structurally a customer-owned integration whose
definition lives in the project repo instead of the platform registry. The
promotion path (userspace → registry) is "move the provider file".

## Connect: one event in, the choreography out

Connecting an account is ONE append: `integration/connect-requested` on the
account's stream, carrying everything (encrypted credentials, routing keys,
identity). The integration PROCESSOR reacts with the whole choreography:

1. each credential → `secret/set` cross-posted to `/secrets/{slug}/{account}/{name}`
2. the account → `integration/connected` on its own stream
3. each routing-key claim → the global capture stream (host dep)

Every reaction append is idempotency-keyed from the source event, so replays
dedupe instead of double-connecting. `connect.ts` is just the edge: encrypt
the material, append the request, wait for the fold. A provider OAuth
callback reduces to "exchange the code, append connect-requested". The spike
exposes it via oRPC (`project.integrations.connect`) so you can connect
GitHub with a PAT from `pnpm cli rpc` and watch events flow.

## First-party vs customer-owned

Deliberately a property of the **connection**, not the definition — the
`integration/connected` event carries `ownership: "first-party" | "customer"`:

|                      | first-party (today's spike)                | customer-owned (same shape)                                                                                                                              |
| -------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| app registration     | iterate's (Doppler config)                 | the customer's                                                                                                                                           |
| oauth client secret  | deployment env                             | a project Secret (`{slug}/oauth-client-secret`)                                                                                                          |
| webhook ingress      | os.iterate.com, the partial fetch function | `{slug}.{project}.iterate.app/webhooks` — the SAME partial fetch function mounted on the project host, verification secret resolved from project Secrets |
| gateway scope        | `"first-party"` (one ws per deployment)    | `"project:{id}"` (one ws per project bot)                                                                                                                |
| secret provider/user | provides tokens                            | provides tokens AND consumes its own client creds                                                                                                        |

The customer-owned webhook path and OAuth flows are not wired in the spike;
the structure (ownership on the event, env-vs-Secret resolution, gateway DO
scoping) is.

## Two-tier substitution groundwork

Secrets carry `tier: "project" | "iterate"`. The intended egress picture is two
substitution hops:

- project egress substitutes **project-tier** secrets — customer-provided
  material their _agents_ must never see (agents see `{{secret}}` /
  `getSecret(...)` placeholders only; this is today's EgressPipe property);
- a platform-terminal hop substitutes **iterate-tier** secrets — first-party
  API keys and client secrets that _customers and their agents_ must never
  see.

The spike journals the tier and keeps single-secret substitution inside the
Secret DO. The unification path: EgressPipe's keyed `getSecret({ key })`
substitution resolves each key to a Secret DO and asks it to substitute, hop
by tier — material then never sits in D1 rows at all.

## What the Discord gateway teased out

- An ingress **transport that listens instead of being called** needs a home
  with a lifetime beyond any request: a DO holding the websocket
  (`DiscordGatewayDurableObject` — identify, heartbeat, resume, alarm-based
  reconnect). A client websocket pins the DO awake; that's a real cost to
  discuss (vs. e.g. a container, or accepting it for the few
  gateway-transport providers).
- Reconnection is **our** responsibility where webhook retries are the
  provider's — hence sequence tracking, session resume, and backoff alarms.
- The identify frame needs the token as **bytes in a websocket message** —
  fetch substitution can't cover it. That requirement is what shaped the
  Secret DO's audited `revealForPlatformUse` trapdoor.
- Flood control is open: the spike captures all dispatches under the
  configured intents; a real version probably filters per connection.

## Compared with executor (rhyssullivan/executor)

Studied at `~/src/github.com/rhyssullivan/executor` — an open-source
integration layer for AI agents: a unified tool catalog over OpenAPI/GraphQL/
MCP sources, with connections (credential + integration pairs), pluggable
secret providers (file, keychain, 1Password, WorkOS Vault), sandboxed code
execution (QuickJS-WASM / Deno subprocess), and tools addressed as
`tools.github.user.personal.issues.list()`.

Where the designs agree (independently arrived at — good sign):

- **Fetch-with-substitution.** Their connections store provider+item-id, never
  values; credentials resolve at invocation time and are substituted into the
  authenticated request, invisible to sandboxed code. Same principle as our
  placeholder substitution — though our Durable Object boundary is stricter
  (their cloud workers still materialize values in the calling isolate).
- **Capability fields over generic abstraction.** Their plugin spec
  deliberately has typed fields (`secretProviders`, `routes`, `handlers`)
  instead of a generic provides/requires machinery — the same
  conventions-over-frameworks instinct as our partial-fetch-function providers.
- **Integration-as-address.** `tools.<integration>.<owner>.<connection>.<tool>`
  rhymes with `itx.integrations.<slug>.<sdk path>`; both resolve lazily at
  call time.

Where we differ, deliberately:

- **They have no ingress.** No webhook receivers (explicitly a v1 non-goal),
  no event streams, no stateful processors — executor is a pull-only tool
  catalog. Our capture-stream → router → project-stream spine, gateway
  connections, and journaled audit/replay are exactly the half they're
  missing, and the half agents-reacting-to-the-world needs.
- **Their tokens refresh in core code per OAuth template; ours are derived
  secrets** — one mechanism for OAuth, password-exchange sessions, and
  anything `http-exchange` can express, journaled as rotations.

Worth stealing later:

- **Curated remote integration registry** (integrations.sh JSON, 12h cache):
  pre-configured auth templates + source URLs per provider, so "add Linear"
  needs no deploy. Our registry could merge a remote catalog the same way.
- **Transcript-based testing** (testkit/): black-box tests through the MCP
  surface that emit a replayable chat transcript as the artifact. Great fit
  for our agent flows.
- **Tool generation from OpenAPI/GraphQL sources** — we hand-pick SDKs
  (octokit, @discordjs/core); generating a typed surface from a provider's
  OpenAPI spec would make long-tail userspace integrations cheaper.
- **Pause/resume execution for mid-call elicitation** (OAuth popup, approval)
  — relevant to our human-in-the-loop egress policy plans.

## Spike boundaries / open questions

- ~~Slack and Google still run their bespoke wiring~~ — DONE: both are
  provider files in the registry now. Slack's thread router is the
  `slack-route` processor on the account stream (the slack-agent pipeline
  downstream is byte-compatible); Google's access token is a derived Secret
  (the old `getFreshGoogleAccessToken` is deleted). The legacy D1 tables
  (`project_secrets`, `project_connections`, `oauth_states`) are dropped;
  OAuth state is a signed stateless token. Caveat: existing prd journals
  carry subscriptions dialing the deleted SLACK_INTEGRATION namespace —
  per the no-backcompat rule, prd gets a stage reset rather than a bridge.
- GitHub App installation-token minting (app JWT → hourly token) isn't
  implemented; the Secret refresh loop is where it belongs.
- Late route claims don't retroactively forward earlier captured events
  (claims are forward-looking, like Slack team claims today). Replay-on-claim
  is a possible upgrade since the capture stream has everything.
- Every secret dereference appends a `secret/used` audit event — unbounded
  journal growth for hot secrets. A real version probably samples or folds
  counters; the egress resolver also pays a DO-catalog D1 read per referenced
  key per request.
- No UI; the oRPC procedures (`connect`, `getIntegrationState`,
  `describeJournaledSecret`, `ensureDiscordGateway`) are the demo surface.

## Demo

```bash
# connect github with a PAT (or rely on APP_CONFIG_GITHUB_TOKEN fallback)
pnpm cli rpc project integrations connect \
  --project-slug-or-id my-project --integration github \
  --external-id installation-1234 --routing-keys '["installation:1234"]' \
  --secrets '[{"name":"access-token","material":"ghp_..."}]'
# a SECOND github account: same command with --account work-org

# watch state fold
pnpm cli rpc project integrations getIntegrationState \
  --project-slug-or-id my-project --integration github
pnpm cli rpc project integrations describeJournaledSecret \
  --project-slug-or-id my-project --slug github/default/access-token

# in a project itx session:
#   await itx.integrations.github.octokit.rest.issues.create({...})
#   await itx.integrations.discord.api.channels.createMessage(channelId, { content: "hi" })

# hold the discord gateway open (first-party bot from APP_CONFIG_DISCORD_BOT_TOKEN)
pnpm cli rpc project integrations ensureDiscordGateway --project-slug-or-id my-project

# waitrose (userspace): in a project itx session —
#   await itx.worker.connectWaitrose({ username: "...", password: "..." })
#   await itx.integrations.waitrose.searchProducts("milk")
# or set a derived secret directly from the CLI:
pnpm cli rpc project integrations setJournaledSecret \
  --project-slug-or-id my-project --slug waitrose/password --material 'hunter2'
pnpm cli rpc project integrations describeJournaledSecret \
  --project-slug-or-id my-project --slug waitrose/default/access-token   # audit + rotations, no material
```

Unit tests cover the symmetry contract, both providers' partial fetch
functions (real HMAC / ed25519), the ingress router fold, the secret lifecycle
fold, and the crypto envelope:
`apps/os/src/domains/integrations/**/*.test.ts`,
`apps/os/src/domains/secrets/**/*.test.ts`.
