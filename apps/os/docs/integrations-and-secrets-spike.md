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
                 PROJECT ns  /integrations/{slug}                ← connected/disconnected/
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
  from @discordjs/core. The SDK is constructed inside the
  `IntegrationsCapability` loopback (platform code); agents get its behavior,
  never its token.

`registry.ts` is just the list. Adding Linear = one provider file + one line.

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
- **The audited trapdoor.** Some platform-trusted consumers need bytes in hand
  — Discord's identify frame, SDK constructors in first-party loopbacks.
  `revealForPlatformUse({ usedBy })` exists for exactly that, and both paths
  append `secret/used` audit events (who, which host, when — never material).
- **Refresh is the DO's job.** A material version carrying an OAuth refresh
  config arms the DO's alarm at expiry-minus-leeway; the alarm POSTs the token
  endpoint and appends `secret/rotated`. The refresh token rides encrypted; the
  OAuth _client secret_ is another Secret referenced by slug — the secret
  system consuming itself, on purpose.

## Connect: the symmetric heart

`connect.ts:connectIntegration` is the whole choreography, for every provider
and both ownership modes — three appends:

1. each provided credential → `secret/set` on `/secrets/{slug}`
2. the connection → `integration/connected` on `/integrations/{slug}`
3. each routing-key claim → `integration/route-registered` on the global
   capture stream

A provider OAuth callback should reduce to "exchange the code, then call
`connectIntegration`". The spike exposes it directly via oRPC
(`project.integrations.connect`) so you can connect GitHub with a PAT or
Discord with a bot token from `pnpm cli rpc` and watch events flow.

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

## Spike boundaries / open questions

- Slack and Google still run their bespoke wiring; migration = re-express each
  as a provider file (Slack's thread router becomes the project-side
  `onIntegrationEvent`), then delete `project_connections`/`project_secrets`
  reads in favor of the journals.
- GitHub App installation-token minting (app JWT → hourly token) isn't
  implemented; the Secret refresh loop is where it belongs.
- Late route claims don't retroactively forward earlier captured events
  (claims are forward-looking, like Slack team claims today). Replay-on-claim
  is a possible upgrade since the capture stream has everything.
- The capability dial currently exposes `itx.integrations.*` wherever itx
  reaches; per-project "is this integration actually connected" gating should
  consult the project's `/integrations/{slug}` fold before building SDKs.
- No UI; the oRPC procedures (`connect`, `getIntegrationState`,
  `describeJournaledSecret`, `ensureDiscordGateway`) are the demo surface.

## Demo

```bash
# connect github with a PAT (or rely on APP_CONFIG_GITHUB_TOKEN fallback)
pnpm cli rpc project integrations connect \
  --project-slug-or-id my-project --integration github \
  --external-id installation-1234 --routing-keys '["installation:1234"]' \
  --secrets '[{"slug":"github/access-token","material":"ghp_..."}]'

# watch state fold
pnpm cli rpc project integrations getIntegrationState \
  --project-slug-or-id my-project --integration github
pnpm cli rpc project integrations describeJournaledSecret \
  --project-slug-or-id my-project --slug github/access-token

# in a project itx session:
#   await itx.integrations.github.octokit.rest.issues.create({...})
#   await itx.integrations.discord.api.channels.createMessage(channelId, { content: "hi" })

# hold the discord gateway open (first-party bot from APP_CONFIG_DISCORD_BOT_TOKEN)
pnpm cli rpc project integrations ensureDiscordGateway --project-slug-or-id my-project
```

Unit tests cover the symmetry contract, both providers' partial fetch
functions (real HMAC / ed25519), the ingress router fold, the secret lifecycle
fold, and the crypto envelope:
`apps/os/src/domains/integrations/**/*.test.ts`,
`apps/os/src/domains/secrets/**/*.test.ts`.
