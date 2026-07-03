# Integrations & journal-backed Secrets — design doc

> **Status:** built, green, mergeable (PR #1508), running on preview. Written
> _after_ the build so it can be reviewed _as a design_ — annotate anything you
> disagree with and we'll fold the feedback back into both the code and this
> doc. Every section that's a genuine choice (not a fact of the platform) is
> marked **[DECISION]**; everything I'm unsure about is marked **[OPEN]**.
>
> Companion docs: the build narrative lives in
> [`integrations-and-secrets-spike.md`](./integrations-and-secrets-spike.md);
> the worker split it sits on is [`worker-topology.md`](./worker-topology.md).

---

## 0. TL;DR

Three ideas, each replacing a pile of special-cased code:

1. **An integration is a provider file that is, at ingress, a _partial fetch
   function_.** `(request) → Response | null`. It verifies its own signature,
   answers its own handshakes, and has exactly one side effect: `capture(...)`.
   Adding Linear is one file plus one line in a registry array. No interfaces
   interpreted by generic machinery.

2. **Connections, routing, and secrets are event-sourced** — journals folded by
   Durable Objects, not D1 rows. A request is an event; the reaction lives in a
   stream processor's `processEvent`, idempotency-keyed and replay-safe. D1 is a
   _directory_ ("where does `ctx_…` live"), never the authority on state.

3. **Credential material is physically confined to Secret Durable Objects.**
   SDKs and project code hold `getSecret({ key })` _placeholders_; substitution
   happens server-side in the egress pipe, hop by hop, with the final hop doing
   the outbound fetch. `describe()`, the journal, and application isolates never
   see plaintext.

The unifying move behind all three: **the processor owns the logic, the DO is
its host.** Requests append facts; reactions read folds and append more facts;
DO RPC verbs only do the things a host uniquely can (hold crypto keys, dial
sibling namespaces, set alarms).

---

## 1. Problem statement — why touch this at all

The pre-existing model stored connections and secrets as **D1 rows** and
special-cased every provider:

- a bespoke `SlackIntegrationDurableObject` with Slack-specific wiring;
- a hand-rolled Google token refresh (`getFreshGoogleAccessToken`);
- a `project_secrets` table read directly by capabilities, with material
  crossing application code on every use;
- `project_connections` and `oauth_states` tables;
- per-provider ingress glue with no shared spine.

The costs that motivated the rewrite:

- **It doesn't generalize.** Every new integration = new tables, new refresh
  code, new ingress glue. The marginal cost of provider N+1 never dropped.
- **Credential material flowed through application code.** Capabilities read
  `project_secrets` and held plaintext to make calls. The blast radius of any
  bug in an isolate included every secret it could read.
- **No event spine.** Webhooks, gateway sockets, and OAuth callbacks each had
  ad-hoc handling; nothing was journaled, replayable, or auditable in a uniform
  way; reacting-to-the-world had no home.
- **Refresh was a special case** instead of an instance of a general idea.

**[DECISION]** We treat this as a _clean cut_, not a migration. The legacy D1
tables and DOs are deleted; prd gets a stage reset rather than a compatibility
bridge. Rationale: prd can be redeployed/reset, and backcompat shims for a model
we're deleting wholesale are pure carrying cost. **[OPEN]** if there's prod data
worth preserving that I'm not aware of, this is the assumption to challenge
first.

---

## 2. Goals & non-goals

**Goals**

- One mechanism for _all_ integrations: first-party (iterate's GitHub App),
  customer-owned (their own Slack app), and userspace (a project defines its
  own integration in its own worker).
- One mechanism for _all_ credentials: PATs, OAuth refresh tokens, password
  exchanges, plain config vars, iterate-owned keys.
- Material confinement as an _architectural invariant_, not a coding discipline:
  it should be structurally impossible for an agent or project isolate to read a
  secret, because the plaintext never enters its address space.
- Capture-first ingest: a provider's webhook `200` waits only on a durable
  append, never on cold downstream DOs (the Slack-latency lesson).
- Auditability and replay for free, because everything is a journal.

**Non-goals (for this PR)**

- A management UI beyond the oRPC demo surface.
- GitHub App installation-token minting (App JWT → hourly token).
- Token _revocation_ at the provider on disconnect.
- The customer-owned webhook ingress _transport_ (the structure is there; the
  per-project host mounting isn't wired).
- Replaying already-captured events to a route claimed _after_ capture.

---

## 3. Design principles

These are the load-bearing opinions. If any of these is wrong, large parts of
the design are wrong, so they're the highest-value things to push on.

**[DECISION] Conventions over frameworks.** Providers _rhyme_; they don't
implement a spec object that a generic engine interprets. N imperative
implementations sharing primitives beats one abstract machine. This is a direct
application of the house style (see the integrations spike precedent: an
integration = a partial fetch function, full stop).

**[DECISION] Everything that is state is a journal folded by a DO.** Connection
status, routing tables, secret lifecycle — all event-sourced. The DO is a _fold
host_, not the source of truth; the stream is. This buys replay, audit, and a
uniform reaction model, at the cost of "just read a row" simplicity.

**[DECISION] The processor owns the logic; the DO is its host.** Requests are
events (`connect-requested`, `derive-requested`); reactions live in
`processEvent` — idempotency-keyed from the source event, fold-gated, replay-safe
behind the side-effect anchor. DO RPC verbs only append facts, read folds, and
supply host-only deps (crypto keys, cross-namespace dials, alarms). This is the
single rule that makes connect, refresh, routing, and repo-sync all look the
same.

**[DECISION] Capture is total and unfiltered.** Raw provider events land
verbatim on a global stream before anything interprets them. Selectivity belongs
_downstream_ of capture, never at the door. Streams are built for appends; the
GitHub App alone (28 installs incl. our own CI) will push thousands of
check_run/workflow events a day and that's fine.

**[DECISION] Secret material is confined by physics, not policy.** The only
isolates that ever hold plaintext are Secret DOs. Everyone else — agents,
project workers, even first-party SDK construction — holds placeholders. Egress
substitutes by _delegating into_ the Secret DO chain.

---

## 4. The shape in one picture

```
            ┌─ FIRST-PARTY INGRESS (os.iterate.com) ───────────────────┐
 GitHub  ──▶│ each integration = a PARTIAL FETCH FUNCTION:             │
 Discord ──▶│   verify sig → answer handshakes → capture(...)         │
            └───────────────────────────┬─────────────────────────────┘
 Discord gateway ws ─▶ DiscordGatewayDO ─┤   (same capture primitive)
                                         ▼
        GLOBAL ns   /integrations/{slug}/webhooks      raw, verbatim;
                                         │             the append GATES the 200
                     integration-ingress processor     (IntegrationIngressDO)
                     folds route-registered claims →
                     routingKey → (projectId, account)
                                         │  cross-namespace forward
                                         ▼
        PROJECT ns  /integrations/{slug}/{account}     connected / disconnected /
                                         │             event-received
                     integration processor (IntegrationDO)
                     connection state + per-provider fan-out
                     (slack-route → agent streams, github-route → repo streams)

        PROJECT ns  /secrets/{slug}                    set / rotated / used /
                     secret processor (SecretDO)          derive-requested
                     fold + derivation + audit;         material ALWAYS encrypted
                     egress delegates substitution IN   in payloads

 itx.integrations.github.octokit.rest.issues.create({...})   IntegrationsCapability:
 itx.integrations.discord.api.channels.createMessage(id,{})  builds the real SDK in a
 itx.integrations["google/jonas"].gmail.request({...})       loopback; token is a
                                                             getSecret() placeholder
```

---

## 5. Integrations

### 5.1 An integration _is_ a provider file

One file per provider in `domains/integrations/providers/{slug}.ts`, exporting
one `IntegrationDefinition`. Three faces:

- **`fetch(ctx)` — the partial fetch function.** From the ingress worker's view,
  an integration is `(request) → Response | null`. It owns its whole webhook
  story imperatively: URL match, signature scheme (GitHub HMAC-256, Discord
  ed25519), protocol handshakes (Discord PING→PONG). Its only side-effect
  channel is `capture({ transport, routingKey, idempotencyKey, body })`.
- **`providedSecrets`** — the secret _names_ this integration writes into
  `/secrets/{slug}/{account}/{name}` once connected (integrations are _secret
  providers_).
- **`createSdk(ctx)`** — the well-known SDK object `itx.integrations.{slug}.**`
  path-replays into. GitHub → `{ octokit }`; Discord → `{ api, rest }`. The SDK
  authenticates with `ctx.secretRef(name)` placeholders and routes through
  `ctx.fetch` (the egress pipe). It never holds material.

`registry.ts` is _just the list_. Adding Linear = one provider file + one array
entry.

```ts
// domains/integrations/providers/github.ts (shape)
export const githubIntegration: IntegrationDefinition = {
  slug: "github",
  displayName: "GitHub",

  async fetch({ request, config, capture }) {
    if (new URL(request.url).pathname !== "/api/integrations/github/webhook") return null;
    const bodyText = await request.text();
    const sig = request.headers.get("x-hub-signature-256");
    const ok =
      sig != null &&
      (await verifyGithubSignature(
        config.integrations.github!.webhookSigningSecret.exposeSecret(),
        bodyText,
        sig,
      ).catch(() => false));
    if (!ok) return Response.json({ error: "Invalid signature." }, { status: 401 });
    const body = JSON.parse(bodyText) as { installation?: { id?: number | string } };
    await capture({
      transport: "webhook",
      routingKey: body.installation?.id == null ? null : `installation:${body.installation.id}`,
      idempotencyKey: request.headers.get("x-github-delivery"),
      body, // verbatim — no edge filtering, ever
    });
    return Response.json({ ok: true });
  },

  createSdk(ctx) {
    return {
      octokit: new Octokit({
        auth: ctx.secretRef("access-token"), // a getSecret(...) PLACEHOLDER
        request: { fetch: ctx.fetch }, // every call rides the egress pipe
      }),
    };
  },

  providedSecrets: [{ name: "access-token", description: "GitHub installation token / PAT." }],
};
```

**[OPEN]** `createSdk` hand-picks an SDK (octokit, @discordjs/core). That's
great for the head of the distribution and bad for the long tail. Executor
generates a typed tool surface from OpenAPI/GraphQL specs. Do we want a
generated-SDK path for long-tail providers, or is "pick a good SDK per provider"
the right amount of effort forever? (See §13.)

### 5.2 Capture first, interpret later

Provider events — webhook bodies _and_ Discord gateway dispatches, transport
blind — land verbatim on `{global}:/integrations/{slug}/webhooks`. **Only that
durable append gates the webhook 200.** Providers retry slow webhooks; nothing
cold (no DO wake, no routing) may sit in front of the ack.

**[DECISION]** Gateway dispatches reuse the _same_ `capture(...)` call from the
`DiscordGatewayDurableObject`, so everything downstream of capture is
transport-blind. A listening transport and a called transport converge at the
capture stream.

### 5.3 Route by fold, not by D1

The `integration-ingress` processor reduces `route-registered` claims (appended
at connect time) into a `routingKey → (projectId, account)` table, and
cross-posts each captured event to the owning account's
`/integrations/{slug}/{account}` stream. The routing table is itself
event-sourced on the same stream it routes.

**[DECISION] First claim wins; takeover is consented, never silent.** The fold
rejects a claim on an already-owned key unless the claim carries
`takeover: true`, which is the _outcome of an interstitial flow_: when an OAuth
callback finds a workspace already routed elsewhere, it seals the connect into
an AES-GCM token (credentials ride encrypted; codes are single-use so it can't
be redone later) and bounces to a "workspace X is connected to project A —
really move it to B?" confirm/cancel page. Confirming replays the sealed connect
with `takeover: true`. Both paths are journaled; the losing claim stays on the
stream as evidence.

**[OPEN]** Routing-claim verification is a _snapshot read_ at connect time: two
simultaneous connects for the same key can both pass the pre-append guard, and
the fold settles the tie (first wins) without telling the loser. Closing the
window means tracking the claim offset and waiting for the router checkpoint on
every connect — cross-DO latency for a millisecond race whose recovery path (the
takeover flow) already exists. I chose to leave it. Reasonable to disagree.

### 5.4 An integration is a domain object

A connected integration is a domain object in exactly the sense a Secret is: a
journal `/integrations/{slug}/{account}` + one `IntegrationDurableObject` folding
it. That DO _is_ the integration-in-this-project, where its three faces meet:

- its **journal** — connection lifecycle + every routed provider event;
- its **SDK** — `call({ path, args })` builds the provider SDK holding no
  material (token = placeholder, fetch = terminal egress pipe dialed as a
  loopback);
- its **fan-out seam** — provider-specific reaction to routed events
  (`slack-route`, `github-route`) as another processor on the account stream.

`IntegrationsCapability` is a thin **router**: registry slug → that integration's
DO; anything else → the project's worker (userspace). No integration logic lives
in the capability.

| thing                             | identity                                                  |
| --------------------------------- | --------------------------------------------------------- |
| the provider _type_               | code — a provider file in the registry                    |
| github _in a project_             | `IntegrationDurableObject` + its journal                  |
| one credential                    | `SecretDurableObject` + `/secrets/{slug}`                 |
| the deployment-wide routing table | `IntegrationIngressDurableObject` + global capture stream |
| a userspace integration           | the project worker (code-as-domain-object)                |

**[OPEN] Known trade-off:** SDK calls serialize through the per-account DO. For a
hot integration the SDK surface can move back to a stateless loopback that
consults the DO's fold — the DO stays the identity either way. Is per-account
serialization an acceptable default, or should the stateless-SDK path be the
default from day one?

### 5.5 Accounts: integration = _type_, account = _instance_

"Google" is an integration; "google as jonas@nustom.com" is an **account**, and a
project can hold many accounts of one integration. The account dimension is built
into every identity from the start:

- domain object = the **(project, integration, account)** triple;
- journal = `/integrations/{slug}/{account}`; accounts enumerate as child paths
  of `/integrations/{slug}`;
- secrets = `/secrets/{slug}/{account}/{name}` (definitions declare _names_; the
  system composes account-scoped slugs);
- itx address carries the account in its first segment: `itx.integrations.google`
  = account `default`; `itx.integrations["google/jonas"]` = account `jonas`. The
  address under `itx.integrations` _is_ the journal path under `/integrations`.

A bare `itx.integrations.google` resolves the **implicit account**: the sole
connected one, or a loud `AmbiguousIntegrationAccountError`, or — with nothing
connected — `NoConnectedIntegrationAccountError` (fail closed). **[DECISION]** I
changed implicit resolution to fail closed on zero connected accounts rather than
silently returning `default`; a non-existent default account is a bug we want
loud.

**Multiple Slacks just work:** the callback derives the account from the
workspace team id (deterministic — reconnecting the same workspace updates the
same account); the ingress router stamps the claiming account onto every
forwarded envelope; thread streams nest under it
(`/agents/slack/{account}/{channel}/ts-{ts}`); the slack-agent host recovers its
workspace account from its own stream path to pick the right bot token.

### 5.6 Userspace integrations

A project can implement a whole integration in its own worker; unknown slugs
forward to its `integrations({ slug, account, path, args })` export — **one
method call, not a deep property walk** (workerd RPC doesn't traverse instance
fields, so the project walks the path on its concrete SDK locally).

```ts
// in the project's worker
export default {
  integrations: ({ slug, account, path, args }) =>
    slug === "waitrose" ? waitroseSdk(account)[path[0]](...args) : undefined,
};
// from an agent — identical ergonomics to a platform integration
await itx.integrations.waitrose.searchProducts("milk");
await itx.integrations["waitrose/mum"].basket.add(itemId);
```

The userspace SDK authenticates with `getSecret({ key })` placeholders in bare
`fetch()` headers, so **even the customer's own integration code never holds its
tokens** — substitution happens in the terminal egress pipe. A userspace
integration is structurally a customer-owned integration whose definition lives
in the project repo instead of the registry; the promotion path is "move the
provider file." Exercised end-to-end (two accounts) in `waitrose-userspace.test.ts`.

### 5.7 Connect: one event in, choreography out

Connecting an account is **one append**: `integration/connect-requested` on the
account stream, carrying everything (encrypted credentials, routing keys,
identity). The processor reacts with the whole choreography:

1. each credential → `secret/set` cross-posted to `/secrets/{slug}/{account}/{name}`;
2. the account → `integration/connected` on its own stream;
3. each routing-key claim → the global capture stream (host dep).

Every reaction append is idempotency-keyed from the source event, so replays
dedupe instead of double-connecting. `connect.ts` is just the edge: encrypt the
material, append the request, wait for the fold. A provider OAuth callback
reduces to "exchange the code, append connect-requested." **[DECISION]** I added
`displayName` to the connect idempotency digest so re-connecting with a new
display name isn't silently deduped as a no-op.

### 5.8 First-party vs customer-owned

**[DECISION]** Ownership is a property of the **connection** (carried on the
`integration/connected` event), not the definition — the same provider file
serves both.

|                     | first-party (today)               | customer-owned (same shape)                                          |
| ------------------- | --------------------------------- | -------------------------------------------------------------------- |
| app registration    | iterate's (Doppler config)        | the customer's                                                       |
| oauth client secret | deployment env                    | a project Secret                                                     |
| webhook ingress     | `os.iterate.com` partial fetch fn | `{slug}.{project}.iterate.app/webhooks` — _same_ fn, project-mounted |
| gateway scope       | one ws per deployment             | one ws per project bot                                               |
| secret role         | provides tokens                   | provides tokens _and_ consumes its own client creds                  |

The customer-owned webhook _transport_ isn't wired; the structure (ownership on
the event, env-vs-Secret resolution, gateway DO scoping) is.

---

## 6. Secrets

### 6.1 A Secret is a domain object

A stream `{project}:/secrets/{slug}` + a `SecretDurableObject` folding it. Slugs
are **stream-path segments**: lowercase `^[a-z0-9_-]+(/[a-z0-9_-]+)*$`, may be
slash-nested (`github/default/access-token` groups under its integration). Not
the old free-form D1 key. **[DECISION]** the lowercase-segment constraint is what
makes secret addresses _be_ stream coordinates; it cost an e2e-test rename
(`CLOUDFLARE_API_TOKEN` → `cloudflare/api-token`) but the uniformity is worth it.

### 6.2 Material is encrypted on the journal

`secret/set` and `secret/rotated` carry an AES-256-GCM envelope
(`secret-crypto.ts`, deployment key `SECRETS_ENCRYPTION_KEY`). Journals replicate
freely; plaintext exists only transiently inside the DO.

**[DECISION] `SECRETS_ENCRYPTION_KEY` is required and permanent.** Once secrets
are encrypted with it, it can never rotate without re-encrypting every secret. It
is set for `os/preview` + `os/dev_jonas`; **prd is intentionally held** pending
your go-ahead (it must be a stable, audited key). The project-create path guards:
if the key is absent it warns and skips the example-egress-secret seed rather than
crashing project creation. **[OPEN]** key _rotation_ strategy is unspecified — do
we ever need it, and if so, do we want a versioned-envelope scheme now or never?

### 6.3 Material never leaves the Secret DO

The headline invariant. Two consumers, one rule:

- **SDKs** take the placeholder as their token (octokit `auth`, discord REST
  `setToken`) and a substituting `fetch` — pretend the placeholder _is_ the
  secret.
- **The egress pipe** doesn't hold material either: it parses `getSecret({ key })`
  references and **delegates the request into the referenced secrets' own DOs** —
  each hop substitutes its own reference (re-deriving if stale) and the _last hop
  performs the outbound fetch_. Material exists only inside Secret DOs and on the
  wire to the API.

The narrow trapdoor `revealForPlatformUse({ usedBy })` remains for the _one_ case
fetch-substitution can't cover: the Discord gateway identify frame needs the
token as **bytes in a websocket message** (no fetch hop to substitute at), plus
sibling DOs resolving derivation sources. Both are inside the secret system; both
are audited.

**[OPEN]** `revealForPlatformUse` is the one hole in "material never leaves." It's
narrow and audited, but it _is_ a reveal. Is the websocket-identify case worth
keeping the trapdoor for, or should the gateway DO itself be modeled as living
"inside" the secret boundary some other way?

### 6.4 Derived secrets — the unifying theory

A Secret's material is either a **fact** (a password, a PAT, a refresh token, a
plain config var) or **derived** — computed from _other_ secrets via an exchange,
valid for a while, recomputed on demand. One idea (`secret-derivation.ts`)
subsumes what looked like separate features:

- **OAuth access tokens aren't special.** "POST the token endpoint with
  `getSecret({ key: "google/refresh-token" })` + `getSecret({ key:
"google/oauth-client-secret" })`, read `access_token`/`expires_in`" is one
  `http-exchange` derivation. The refresh token and client secret are ordinary
  sibling Secrets. Google's bespoke `getFreshGoogleAccessToken` is _deleted_.
- **Password-exchange sessions (Waitrose).** No refresh token; re-login with
  username/password, sessions last ~5 min: `http-exchange(generateSession
referencing waitrose/username + waitrose/password, ttlSeconds: 300)`.
- **Doppler-style config vars** are the degenerate case: a fact with
  `sensitivity: "plain"` (still enveloped on the stream; `describe()` shows the
  value).

**[DECISION] Derivation is stream-processor logic, not DO code.** Needing fresh
material is itself an event: a stale use (or expiry alarm) appends
`secret/derive-requested` — **idempotency-keyed by the stale version, so N
concurrent stale uses collapse into ONE refresh** — and the processor reacts
(checks the fold; runs the http-exchange; appends `secret/rotated`). Because a
derivation's `getSecret` references resolve through the _source_ secrets' own
DOs, **derivations chain**: a token from a token from a password, lazily, hop by
hop, fully audited. Derivation _is_ egress substitution, one hop further down,
performed by the secret system on itself.

A `script` derivation kind (project code computes `{ material, expiresAt }`) is
declared but not executable yet — the fully general escape hatch.

### 6.5 Two-tier substitution groundwork

Secrets carry `tier: "project" | "iterate"`. The intended end state is two
substitution hops:

- project egress substitutes **project-tier** secrets — customer material their
  _agents_ must never see (today's EgressPipe property);
- a platform-terminal hop substitutes **iterate-tier** secrets — first-party API
  keys / client secrets that _customers and their agents_ must never see.

The PR journals the tier and keeps single-secret substitution in the Secret DO.
**[OPEN]** the iterate-tier terminal hop isn't built. Is the two-tier model the
right framing, or is "iterate-tier secret" better modeled as "a secret owned by
the iterate system project that a project is granted _use_ (not _read_) on"?

---

## 7. The egress pipe

`EgressPipe` is the terminal hop. It:

1. receives a request whose url/headers/body may contain `getSecret({ key })`
   placeholders (also accepts `\"key\"` — templates embedded in
   `JSON.stringify`'d bodies carry escaped quotes);
2. for each referenced key, dials that key's Secret DO and asks it to substitute
   its own slot (re-deriving inline if stale);
3. the last hop performs the real outbound fetch and returns a serializable
   response snapshot.

It's resolved via `ctx.exports`, which is why every itx-hosting worker that can
originate egress re-exports the **loopback surface**
(`src/workers/shared/loopback-exports.ts`) and carries `loopbackUnionBindings`.

**[OPEN]** the egress resolver pays a DO-catalog D1 read per referenced key per
request. Hot paths with several secrets per request will feel it. Cache the
key→DO mapping? It's a directory lookup, so caching is safe-ish, but cache
invalidation on secret deletion needs thought.

---

## 8. Worked consumer: GitHub as a repo _remote_

The first real consumer of the github fan-out: an iterate repo can declare a
GitHub repository as its **remote** — push to GitHub and the repo's Cloudflare
artifact mirrors automatically. Entirely stream-processor land.

```
POST /repos/{slug}/remotes/github            (oRPC configureGithubRemote)
  └─ repo/remote-configured ────────────────▶ {project}:/repos/{slug}
       └─ REPO processor: github/repo-route-configured
            ───────────────────────────────▶ {project}:/integrations/github/{account}

git push ─▶ webhook ─▶ global capture ─▶ ingress route
  ─▶ {project}:/integrations/github/{account}
       └─ GITHUB-ROUTE processor folds declared links, forwards the envelope
            ─────────────────────────────▶ {project}:/repos/{slug}
              └─ REPO processor: pull policy "auto" ─▶ repo/remote-sync-requested
                   └─ host dep pullFromGithub: octokit getContent per changed
                      file at headSha, chain-fetched through the Secret DO, then
                      ONE artifact commit ─▶ repo/remote-synced | remote-sync-failed
```

**[DECISION]** reconfiguring a repo onto a _different_ account emits
`github/repo-route-removed` on the prior account (computed from
`previousState.remotes[...]`), so a stale route doesn't keep forwarding. The
`github-route` fold fans out — several iterate repos can mirror one GitHub repo.
`repo/remote-push-requested` (reverse mirror) is a declared seam, not wired.

---

## 9. What the Discord gateway teased out

Discord exists in the design specifically because its gateway websocket surfaces
requirements webhooks don't:

- **A listening transport needs a home with a lifetime beyond a request** — a DO
  holding the websocket (`DiscordGatewayDurableObject`: identify, heartbeat,
  resume, alarm-based reconnect). **[OPEN]** a client websocket pins the DO awake;
  that's a standing cost. Accept it for the few gateway providers? Move to a
  container? Worth an explicit decision.
- **Reconnection is _our_ responsibility** where webhook retries are the
  provider's — sequence tracking, session resume, backoff alarms.
- **The identify frame needs the token as bytes in a websocket message** — which
  is exactly the requirement that shaped the audited `revealForPlatformUse`
  trapdoor (§6.3).

---

## 10. Worker topology (the merge reconciliation)

This branch was reconciled onto main's per-DO worker split (every DO is its own
small worker, for cold-start speed) and the "a context _is_ a stream coordinate"
itx refactor. New/changed workers in `alchemy.run.ts`:

| Worker                | Owns                                                                                                                                                                                                              | Notable bindings                                                                        |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `integration`         | `IntegrationDurableObject` — per-(project,integration,account) lifecycle + account processors (incl. Slack thread router). SDK egress dials `EgressPipe` via `ctx.exports`, so it re-exports the loopback surface | loopback union + `SLACK_AGENT`                                                          |
| `integration-ingress` | `IntegrationIngressDurableObject` — global capture + routing table                                                                                                                                                | `STREAM`, `INTEGRATION`, `INTEGRATION_INGRESS`, `GLOBAL_STREAM_NAMESPACE`, `DO_CATALOG` |
| `secret`              | `SecretDurableObject` — journal-backed envelopes; egress delegates _in_                                                                                                                                           | `SECRET`, `STREAM`, `SECRETS_ENCRYPTION_KEY`, `DO_CATALOG`                              |
| `discord-gateway`     | `DiscordGatewayDurableObject` — holds the gateway websocket                                                                                                                                                       | `DISCORD_GATEWAY`, `STREAM`, `INTEGRATION_INGRESS`, `SECRET`, …                         |

`slack-agent` and `repo` also gained `SECRET` (their DOs reveal journaled
tokens). **[OPEN]** there's a binding-gap _class_ of bug here: a DO that calls a
helper using the global `env` needs the binding even if it never names it
directly. I audited and fixed four (discord-gateway, integration-ingress,
slack-agent, repo), but the gap is invisible to typecheck/lint/review and only
shows up at runtime. Worth a lint rule or a runtime assertion?

---

## 11. Alternatives considered & prior art

**Studied executor (rhyssullivan/executor)** — an OSS integration layer for AI
agents (unified tool catalog over OpenAPI/GraphQL/MCP, pluggable secret
providers, sandboxed code exec, tools as `tools.github.user.personal.issues.list()`).

Where we _independently agreed_ (good sign):

- fetch-with-substitution (creds resolve at invocation, invisible to sandboxed
  code) — our DO boundary is stricter (their cloud workers still materialize
  values in the calling isolate);
- capability _fields_ over generic provides/requires machinery;
- integration-as-address resolved lazily at call time.

Where we _deliberately differ_:

- **They have no ingress** — no webhook receivers (explicit v1 non-goal), no
  event streams, no stateful processors. Our capture → route → project-stream
  spine + gateway connections + journaled replay is exactly the half they skip,
  and the half "agents reacting to the world" needs.
- **Their tokens refresh in core code per OAuth template; ours are derived
  secrets** — one mechanism for OAuth, password exchanges, and anything
  `http-exchange` expresses.

Worth stealing later (→ §13): curated remote integration registry (add a
provider with no deploy); transcript-based black-box testing; tool generation
from OpenAPI/GraphQL; pause/resume for mid-call elicitation (OAuth popup /
approval).

**Rejected alternatives:**

- _Keep D1, add a generic provider interface._ Rejected: keeps material in
  application code and a per-provider table sprawl; the interface becomes the
  framework we're trying not to build.
- _A single "integrations DO" per project._ Rejected: couples unrelated
  integrations' lifecycles and folds; the (project, integration, account) triple
  is the natural unit.
- _Secrets as a library, not a DO._ Rejected: a library can't enforce
  confinement — the calling isolate would hold plaintext. The DO boundary _is_
  the guarantee.

---

## 12. Migration, deploy, testing

**Clean cut (deleted):** `project_secrets` / `project_connections` /
`oauth_states` tables (migration `0018`); `SecretsCapability`, `secrets-store`,
`integration-api`, `integration-streams`, `oauth.ts`, `GmailCapability`,
`SlackIntegrationDurableObject`, dead `secrets-capability-call.ts`. Slack's thread
router is now `slack-route` (slack-agent pipeline downstream byte-compatible).
Google refresh is a derivation. OAuth state is a signed stateless token.

**Deploy notes (prd):**

- set `SECRETS_ENCRYPTION_KEY` (stable, permanent) — _still pending your call_;
- **stage reset**, not rolling update: prd journals reference removed namespaces
  (e.g. subscriptions dialing the deleted `SLACK_INTEGRATION` ns).

**Testing:** unit tests cover the symmetry contract, both providers' real
HMAC/ed25519 fetch functions, the ingress router fold, the secret lifecycle
fold, and the crypto envelope. The itx e2e suite (`itx-mcp-auth`, `itx-egress`)
proves the headline end-to-end against live preview: secret stored once →
`getSecret(...)` placeholder in the address → substituted server-side → real
authenticated call succeeds → `describe()`/journal negative controls confirm the
material appears nowhere. 322 tests passing; preview deploy + e2e green.

---

## 13. Open questions worth your feedback (consolidated)

The **[OPEN]** flags above, gathered so you can annotate the list directly:

1. **Clean cut vs. migration** (§1) — is there prod data I shouldn't drop?
2. **Generated SDKs for the long tail** (§5.1, §11) — hand-pick forever, or build
   an OpenAPI→SDK path?
3. **Per-account DO serialization for SDK calls** (§5.4) — acceptable default, or
   stateless-SDK-over-fold from day one?
4. **Routing-claim race** (§5.3) — leave the snapshot-read window (recovery exists)
   or close it with offset tracking?
5. **`SECRETS_ENCRYPTION_KEY` rotation** (§6.2) — versioned envelopes now or never?
6. **`revealForPlatformUse` trapdoor** (§6.3) — keep it for websocket identify, or
   model the gateway DO inside the secret boundary differently?
7. **Two-tier vs. owned-secret-with-use-grant** (§6.5) — which framing for
   iterate-owned secrets?
8. **Egress D1 read per key per request** (§7) — cache the key→DO directory?
9. **Gateway DO kept awake by a pinned websocket** (§9) — accept the standing
   cost, container, or other?
10. **Binding-gap bug class** (§10) — lint rule / runtime assertion to catch
    DOs that use a binding via global `env` without declaring it?
11. **`secret/used` audit growth** (§6, §12) — every dereference appends an audit
    event: unbounded for hot secrets. Sample? Fold counters?
12. **Userspace promotion path** (§5.6) — is "move the provider file" really all
    it should take, or do we want a registry-promotion ceremony?

---

## 14. Appendix: where things live

- providers: `apps/os/src/domains/integrations/providers/{github,discord,slack,google}.ts`
- integration DO + processors: `apps/os/src/domains/integrations/durable-objects/`,
  `.../stream-processors/`
- ingress: `apps/os/src/domains/integrations/ingress.ts`, `integration-ingress` processor
- secrets: `apps/os/src/domains/secrets/` (`secret-crypto.ts`, `secret-derivation.ts`, SecretDO)
- egress: `EgressPipe` + `src/workers/shared/loopback-exports.ts`
- repo remote: `apps/os/src/domains/repos/stream-processors/repo-stream-processor.ts`
- wiring: `apps/os/alchemy.run.ts` (workers, DO namespaces, `loopbackUnionBindings`)
- e2e: `apps/os/src/itx/e2e/{itx-mcp-auth,itx-egress}.e2e.test.ts`
- userspace: `apps/os/src/domains/integrations/waitrose-userspace.test.ts`,
  `iterate-config-repo/apps/waitrose/worker.js`
