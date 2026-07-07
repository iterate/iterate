# Integrations & secrets — v6

Sixth round, after the grill. v5 tried to make secret workers safe by making
them blind (no `read()`, substitution membrane over bodies and WS frames,
exit scanning as defense). v6 rejects that direction — verified buildable,
rejected for simplicity (ADR 0005) — and replaces it with two blunt
statements:

1. **A secret worker reads its own material.** Confinement is the jail's
   host pin, not byte-hiding. Jail code can at worst leak the project's own
   material to the project itself; the steganography race is accepted as a
   self-leak, with a tripwire, not fought.
2. **Platform bytes never enter a jail.** Anything holding first-party
   credentials is platform code, or the credential rides a header
   placeholder substituted en route under its own host pin.
3. **Integrations are just secret providers.** The secret system has no
   concept of an integration; an integration is ordinary code that installs
   secrets (and optionally secret workers) and vends handles. The dependency
   points one way — integrations → secrets — and never back.

The other big v6 simplification: the `refresh()` convention is deleted.
**`fetch()` is the entire worker interface** — refresh is what a worker's
fetch does to itself when the provider says no.

Borrowed principles, with sources: attenuation = hand a narrower object
(Cap'n Web); env holds live objects, the parent constructs each child's env
(Dynamic Workers / Code Mode); use `fetch()` and plain requests as the
driving interface, never bespoke lifecycle verbs (Workers idiom throughout);
config interpreted by generic machinery is the anti-pattern — per-integration
plain code is the intended cost (workerd nanoservices; house rule).

---

## 0. Taxonomy

Five nouns.

- **Secret** — one Durable Object at `/secrets/…`. Holds **material: any
  serializable value** — write-only, encrypted at rest as one blob, replaced
  whole through the single write verb `update` (there is no `store()`, no
  field-level write, no per-field metadata; if a worker cares about expiry
  it keeps `expiresAt` inside its own material) — plus optional readable
  `public` companions (client ids), a pinned host list (immutable in MVP;
  delete to retarget), and its own stream (audit + facts).
- **Secret worker** — optionally, a secret hosts **one stateless dynamic
  worker** (existing `DynamicWorkerRef`, stored as one stream fact, declared
  at install time — the trust event), loaded by the Secret DO through the
  existing `DynamicWorkerRunner`. Not a DO facet, no storage of its own:
  in-memory state only; eviction means reload. It **overrides the secret's
  `fetch()`** and that is its entire interface. §2.2.
- **Integration** — a capability at `integrations.<slug>` (first-party =
  real member of the tree; userspace = provided mount; the slug names an
  _instance_). It installs secrets and secret workers at connect time, vends
  connection handles, owns webhook routing. Integrations are secret
  providers.
- **Connection** — one connected external account: a stream at
  `/integrations/<slug>/<connection>` (lifecycle facts + inbound events) and
  a secret at `/secrets/integrations/<slug>/<connection>`. App-tier
  credentials live at the bare slug path `/secrets/integrations/<slug>` for
  userspace and in deployment env for first-party (surfaced as platform
  secrets, below).
- **Platform secret** — `/secrets/platform/**`: read-only, deployment-env
  backed, resolved virtually (a prefix check in resolution — no DO, no
  storage, no provisioning). Usable **only through header substitution**,
  under its own host pin (the provider's token endpoint). Never readable,
  never updatable, never handed into a jail.

The jail: an isolate whose entire network reach is one secret's pinned
hosts. `globalOutbound` = pin check + header substitution; `connect()` is
rejected outright (raw TCP would bypass the pin's TLS assumptions — one
`if`). Env is whatever the installing integration hands (§2.2).

---

## 1. Requirements

- **R1** — One authoring model for first-party and userspace integrations —
  including that **every integration is also deployable as a userspace
  integration** with user-supplied app credentials.
- **R2** — Weird transports are day-one implementations: the Discord gateway
  (credential inside a WS frame), the OpenAI Realtime relay (two WS legs),
  the Waitrose exchange (password → short-lived token), and the full
  userspace-OAuth proof (R5).
- **R3** — Secrets must not leak **across a trust boundary**. Two tiers:
  _project-tier_ material may reach project code only through a jail pinned
  to the secret's hosts (self-leak accepted, tripwired); _platform-tier_
  material never enters a jail or any project-reachable code path, period.
- **R4** — Credential tiers: app tier (OAuth client, signing secret) is
  deployment env for first-party and the integration's own secret for
  userspace; connection tier is per-account.
- **R5** — Bring-your-own OAuth client, callback and webhooks on your own
  project worker; explicitly including two instances of the same
  integration with two clients and multiple connections each (§3 petshop).
- **R6** — Webhook verification without handing signing secrets to arbitrary
  code (`hmac`/`matches` compute methods).
- **R7** — Integrations sit on secrets; secrets never know about
  integrations.
- **R8** — Password→short-token exchanges are common and OAuth-refresh
  shaped; same code shape (§3 Google vs Waitrose).
- **R9** — Refresh on 401 day one, implemented _inside the worker's fetch_;
  timers later (additive: the DO alarm just sends the worker a request).
- **R10** — Non-secret companion values ride along readably (`public`).
- **R11** — **Plain secrets stay plain.** Nothing here may make ordinary
  secret management heavier.

---

## 2. The model

### 2.1 The secret

Today's `SecretDurableObject`, kept: write-only material, pinned hosts, own
stream, header placeholder substitution, terminal egress fetch, audited
platform reveal. Changes:

```ts
export type SecretUpdateInput = {
  /** Any serializable value. Write-only, encrypted at rest as one blob,
   *  replaced whole. The one write verb — there is no store(). */
  material?: unknown;
  /** Readable companions (client ids, public keys). */
  public?: Record<string, unknown>;
  /** Immutable once material exists (MVP): delete the secret to retarget. */
  egress?: { urls: string[] };
  /** The secret's worker, if any (§2.2). Install-time is the trust event. */
  worker?: DynamicWorkerRef;
};
```

**Placeholder grammar** — today's incantation plus field addressing into
structured material: `getSecret("/secrets/…", "accessToken")`
(dotted paths for nesting). **Substitution is header-only, everywhere,
forever** — no body scanning, no frame scanning, no content-type awareness.
This is not a limitation that will grow later; it is the design line: header
= substitutable reference, body = bytes the composer legitimately holds.

**Header chaining ("substitute until exhaustion, headers only").** A request
may reference several secrets across its headers; resolution hops through
each referenced secret's resolver in turn — each hop substitutes its own
placeholders and enforces **its own host pin** against the terminal
destination — and the last hop performs the terminal fetch. In practice the
chain is two hops (connection outbound → app/platform secret → provider).
Today's `multiple_secret_paths_not_supported` rejection is replaced by the
chain. A WS _handshake_ is a fetch, so upgrade-time headers chain the same
way; frames are never touched.

**Compute methods** — ordinary RPC methods on the Secret capability, safe to
expose because they attenuate "the key" into "answers computed under the
key":

```ts
/** Keyed digest over caller-supplied bytes. A MAC cannot be inverted to its key. */
hmac(input: { field?: string; algo: "sha1" | "sha256"; payload: string | Uint8Array }): Promise<string>;
/** Constant-time equality of a caller value against a field (URL tokens etc.). */
matches(input: { field?: string; value: string }): Promise<boolean>;
```

That is the whole webhook-verification story (GitHub `sha256=` hex, Slack
`v0:` basestring, Stripe `t=/v1=`, Svix/Resend/Shopify base64, Twilio SHA1 —
all "HMAC over a basestring composed without secrets, compare digests";
Discord inbound is Ed25519 against a _public_ key, no secret at all). No
jail in the ingress path.

### 2.2 The secret worker

Every secret has a `fetch()`: the default implementation substitutes header
placeholders (chaining as above), enforces the pin, and performs the
terminal fetch. Installing `worker` **overrides that fetch**. The Secret
DO's entire dispatch is:

```
worker installed ? workerStub.fetch(request) : defaultFetch(request)
```

The worker is loaded on demand by the Secret DO via `DynamicWorkerRunner`
with:

- **`globalOutbound`** = pin check + header substitution + `connect()`
  rejected. Requests the worker composes carry real bytes for material it
  holds, and header placeholders for material it must never hold (app-tier).
- **`env`** = what the installing integration hands (the parent constructs
  each child's env). Convention:
  - `SECRET` — a stub over its own secret: `read()`, `update(input)`,
    `fetch(request)` (the default fetch, for wrapping).
  - Plain string bindings the integration chooses, e.g. `APP_SECRET_PATH`
    (which app-tier secret its header placeholders should reference — a
    userspace app secret path or a `/secrets/platform/…` path; same worker
    file either way).
  - `APP` — _userspace only, optional_: a read-only stub over the user's own
    app secret, for the rare provider whose token endpoint refuses header
    client auth (§3 fallback note). **Never for platform secrets.**
  - `CAPTURE` — only for workers that emit inbound events (Discord): an
    append-only stub on the connection stream.

**`fetch()` is the entire interface.** No RPC methods reachable from
anywhere, no flattened dispatch into the jail, no `refresh()` convention.
Request and Response are plain data — a function cannot cross the boundary
in either direction. Consequences:

- **Refresh is private worker code.** Consumer traffic flows through the
  worker's fetch (a passthrough wrap of `SECRET.fetch`); the 401 surfaces
  _inside the worker_, which refreshes and retries as it sees fit —
  single-flight is an in-memory promise dedup (one worker instance per
  secret; the DO serializes to it). First-mint (Waitrose's empty material)
  is the same code path. The platform ships zero refresh machinery.
- **A secret without a worker doesn't refresh.** A 401 on a plain secret
  (Resend) surfaces to the consumer — correct; there is no code to refresh
  with.
- **Command surfaces are fetch routes the worker defines.** Discord's
  `…/ensure` raises the gateway socket; later, alarm-driven liveness or
  proactive refresh is just the DO's alarm sending the same kind of
  request. No new verbs, ever.

**The trust statement (R3):** the worker reads its own project-tier
material; its network reach is the pin; its outputs (Responses to callers,
`CAPTURE` appends) land inside the project. It can at worst leak the
project's own material to the project itself. The **exit tripwire** —
worker-authored Responses and capture appends scanned against the secret's
material (and any handed `APP` material) — makes naive self-leaks fail
loudly; it is a tripwire, not a wall, and the doc says so.

### 2.3 Integrations

> **Status:** this `Integration` interface is the TARGET shape — it is not yet
> wired. The shipped proof (S5) drives the secrets layer directly
> (`project.secrets.get(path).update({ worker })` + `project.egress.fetch`),
> which is all the model needs. A _pre-v6_ integrations tree also already
> exists in the repo (`src/domains/integrations/`: the capability-host Slack/
> Google/GitHub builtins); replacing it with this interface is S3+S6 (§8).

Plain RpcTargets, constructor args, like everything in rpc-targets.ts:

```ts
export interface Integration extends Describable {
  // __describe() returns Description & { integration: IntegrationInfo }
  // (title, logoUrl, connectForm?) — the dashboard is a tree walk.
  /** Form-shaped integrations complete in this one call (Waitrose, Resend).
   *  OAuth-shaped ones return the URL and finish in completeConnect. */
  connect(input: {
    connection?: string;
    form?: Record<string, string>;
  }): Promise<{ connected: true; connection: string } | { authorizationUrl: string }>;
  /** OAuth re-entry, invoked by the callback door. Only implemented when
   *  connect() can return authorizationUrl. */
  completeConnect?(input: {
    code: string;
    state: VerifiedOAuthState;
  }): Promise<{ connection: string }>;
  get(connection: string): IntegrationConnection;
  list(): Promise<ConnectionEntry[]>;
  /** Webhook terminus, invoked by the project worker's router (userspace). */
  handleWebhook?(request: Request): Promise<Response>;
}
```

Exactly two method names are conventions invoked by platform doors:
`completeConnect` (OAuth callback door) and `handleWebhook` (webhook
terminus).

**The code exchange, both lanes.** First-party `completeConnect` is
in-process platform code: env credentials directly, no jail, no secret
system involved. Userspace `completeConnect` runs in the user's integration
code and uses the app secret through a **Basic-auth header placeholder** —
RFC 6749 makes header client auth the required-to-support method, so the
app secret stores the composed value and the exchange is ordinary header
substitution:

```ts
await itx.egress.fetch("https://petshop.example/oauth/token", {
  method: "POST",
  headers: {
    authorization: `Basic getSecret("/secrets/integrations/petshop-home", "basicAuth")`,
    "content-type": "application/x-www-form-urlencoded",
  },
  body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri }).toString(),
});
```

The body carries only the one-time code; the response tokens land in the
user's own code (their tokens — at the trust ceiling) and are written into
the new connection secret. `clientId` for the authorize URL is not secret
and lives in the app secret's `public` companions.

At connect time an integration installs things: **claim the external id**
(§2.4 — throws `external_id_already_claimed` if another project holds it),
write the connection secret (material + pins + worker), append
`integration/connected` carrying the external id. There is no lifecycle
projection: the connection page reads two streams it already owns — the
connection stream (facts + inbound events) and the paired secret stream,
where refresh activity already lives as audit facts (plus one small add:
the default fetch appends a fact on 401s so "credential failing" is visible
without worker cooperation).

`disconnect(connection)` lives on the Integration (the thing that installed
uninstalls): optional per-integration upstream revocation first, then
unclaim the external id (webhooks stop routing), append
`integration/disconnected`, delete the connection secret (material must not
outlive the connection; deleting the DO also kills its worker and any held
socket). The connection stream is never deleted — it is history, and
reconnecting the same name appends a new `integration/connected` to it.

SDK surfaces stay the proven pattern: a connection RpcTarget exposes
`get octokit()` returning the real SDK with `auth` = a placeholder string
and `request.fetch` = `itx.egress.fetch`, reached via flattened
`invokeCapability` — the SDK never holds material.

### 2.4 Ingress

A webhook terminates where the integration's code lives.

- **First-party — the OS worker is a router, nothing more.** The shared
  resource is the one first-party OAuth client (and its webhook signing
  secret) in deployment env. Every provider event carries an external id
  (Slack team, GitHub installation, Discord guild); the **fan-in directory**
  maps external id → `{ projectId, connection }`, with a hard uniqueness
  rule: **one external id binds to at most one project per integration.**
  Mechanically this is today's deployment-wide directory stream
  (integration-streams.ts: claim/unclaim events, folded on read, single DO
  so appends serialize) with one behavior change: `completeConnect` claims
  _before_ recording the connection and **throws
  `external_id_already_claimed`** when a different project holds the id —
  today's code silently steals (latest claim wins), which is a bug. Since
  the OAuth round-trip just proved the connector owns the external resource,
  the claim conflict can later power a takeover interstitial ("steal this
  integration?") — steal = forced re-claim (the latest-wins fold already
  supports it) + `integration/disconnected` appended to the loser; deferred,
  on the record. Same-project re-claims stay allowed. The door
  (`…/api/integrations/<slug>/webhook`) verifies the signature in platform
  code against env credentials, folds the directory, appends the verbatim
  `integration/event-received`, ACKs-and-drops unclaimed ids. Claims and
  unclaims are written synchronously by connect/disconnect — no maintaining
  processor. The sibling `…/<slug>/callback` verifies HMAC state (existing
  oauth-state.ts), resolves the slug through the tree, calls
  `completeConnect`. Userspace integrations own their whole door, so the
  same uniqueness rule is theirs to enforce as a convention in their own
  `completeConnect` (petshop demonstrates it); the platform registry covers
  only the shared first-party door.
- **Userspace — the project worker**, the one public route guaranteed fully
  under user control. Its `fetch()` routes
  `/integrations/<slug>/(callback|webhook)` by slug to whatever is mounted
  there; verification is a compute-method call; the integration appends to
  the connection stream.

---

## 3. Archetypes

> The **shipped, proven** archetype is the petshop secret worker in
> `apps/os/e2e/vitest/petshop-support.ts` (`petshopWorkerSource`) — a ~20-line
> `fetch()`-override that reads its own tokens, substitutes the access token,
> and on a 401 refreshes with the app credential as a `Basic getSecret(...)`
> header, chaining to a userspace app secret OR a platform secret (only the
> path differs). The samples below are the same shape for other providers,
> written in future tense — none of these specific files exist yet, and
> `google-tokens.ts` is not deleted until the Gmail conversion (§8, deferred).

**Resend (the floor).** `connect({ form })` writes
`{ material: { apiKey }, egress: { urls: ["https://api.resend.com/"] } }`,
appends the connected fact. `send()` = `itx.egress.fetch` with a placeholder
Authorization header. No worker. A 401 means the key is bad and the caller
sees it.

**Google (OAuth refresh — one worker file, both lanes).**

```ts
// google-worker.ts — identical in both lanes; only APP_SECRET_PATH differs
// (userspace: /secrets/integrations/<slug> · first-party: /secrets/platform/google).
export default class GoogleWorker extends WorkerEntrypoint<SecretWorkerEnv> {
  #refreshing?: Promise<void>;

  async fetch(req: Request) {
    let res = await this.env.SECRET.fetch(req); // substitute + pinned send
    if (res.status === 401) {
      await (this.#refreshing ??= this.#refresh().finally(() => (this.#refreshing = undefined)));
      res = await this.env.SECRET.fetch(req);
    }
    return res;
  }

  async #refresh() {
    const m = (await this.env.SECRET.read()) as { refreshToken: string };
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        // App-tier creds ride a header placeholder, substituted en route under
        // the app secret's own pin. The worker never holds them.
        authorization: `Basic getSecret("${this.env.APP_SECRET_PATH}", "basicAuth")`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: m.refreshToken,
      }).toString(),
    });
    const t = (await res.json()) as { access_token: string };
    await this.env.SECRET.update({ material: { ...m, accessToken: t.access_token } });
  }
}
```

This deletes `google-tokens.ts` (whose header comment names the original
gap). Consumers just placeholder `accessToken` in headers; the 401→refresh
→retry happens invisibly inside the worker's fetch.

**Waitrose (the R8 poster child).** `connect({ connection: "mum", form })` —
one call, no OAuth dance: write `{ email, password }`, pin the Waitrose
hosts, install the worker. Same file shape as Google with a different URL
and body — **and no app tier at all**, so no placeholders anywhere:

```ts
async #refresh() {
  const m = (await this.env.SECRET.read()) as { email: string; password: string };
  const res = await fetch("https://www.waitrose.com/api/token/v1/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: m.email, password: m.password }),
  });
  const t = (await res.json()) as { accessToken: string };
  await this.env.SECRET.update({ material: { ...m, sessionToken: t.accessToken } });
}
```

Its fetch wrap additionally treats "material has no sessionToken yet" as a
refresh trigger — first-mint and re-mint are the same private code path.
That sameness is the R8 answer.

**GitHub, both lanes.** Webhook verification from any code, no jail:

```ts
const digest = await itx.secrets.get(appPath).hmac({ algo: "sha256", payload: rawBody });
const ok = timingSafeEqual(`sha256=${digest}`, request.headers.get("x-hub-signature-256"));
```

App-JWT installation-token minting: userspace = the worker `read()`s its
own private key and signs with WebCrypto in-jail; first-party = platform
code (env key, reveal lane) — platform bytes never enter a jail.

**Discord.** _Userspace:_ the connection secret holds the user's own bot
token; the worker holds the gateway socket (in-memory, re-IDENTIFY on
eviction), builds IDENTIFY/RESUME frames from `SECRET.read()` — legal, its
isolate reaches only Discord — appends dispatches via `CAPTURE`, and exposes
`fetch("…/ensure")` as its command surface (connect() fires it once; the
in-worker reconnect loop holds the socket; a future DO alarm sends the same
request). _First-party:_ one bot = one gateway receiving all guilds' events
— that is platform infrastructure by architecture (the spike's gateway DO),
not per-connection jail code; the fan-in directory routes guild → project.

**OpenAI Realtime.** _Userspace:_ the worker's fetch accepts the consumer's
WebSocket, dials `wss://api.openai.com/v1/realtime` (its own key from
`read()`, or a header placeholder — either is in-model), relays frames
verbatim. Ephemeral `ek_` client secrets are a plain substituted POST from
integration code — no worker method needed. _First-party-credentialed:_
platform code.

**Petshop ×2 (the userspace proof, R5).** One class, exported from a dynamic
worker, mounted twice:

```
integrations.petshop_home  ·  /secrets/integrations/petshop-home        ← client A (basicAuth field, public clientId)
                              /secrets/integrations/petshop-home/jonas
                              /secrets/integrations/petshop-home/emma
integrations.petshop_work  ·  /secrets/integrations/petshop-work        ← client B
                              /secrets/integrations/petshop-work/ops
```

Each mount is constructed with its own app-secret path; connections' secret
workers get it as `APP_SECRET_PATH`. The project worker routes callback and
webhook by slug. Nothing platform-side knows it exists. This is the final
acceptance test.

---

## 4. Platform secrets (shrunken to their final form)

`/secrets/platform/**` is a prefix check in resolution, not data: no DO, no
storage, no provisioning — adding one is adding a config key. They
participate **only as header-substitution hops** (the Basic placeholder in
the Google worker), pinned to their provider's token endpoint, and are
never readable, never updatable, **never handed into a jail as env or
stubs**. The v5 idea that arbitrary project scripts could borrow deployment
credentials via placeholder is dead — a misfeature.

Why this is safe even though jail code can _reference_ them: substitution
happens en route, after the request leaves the isolate; the platform
secret's own pin applies at its hop; so a malicious worker holding the
incantation can only aim it at the provider's token endpoint, where the
only thing it achieves is refreshing its own connection's tokens.

The residue, stated honestly: a provider whose token endpoint refuses
header client auth (RFC 6749 requires support, but outliers exist) splits
by lane for that provider only — first-party refresh falls back to
in-process platform code (env + audited reveal, today's shape); userspace
falls back to `env.APP` in their own jail (their creds, allowed). A
documented per-provider exception, not a second architecture.

---

## 5. The graveyard (cumulative, with reasons)

Killed in v6:

- **The `refresh()` convention + all supervisor refresh machinery**
  (401-intercept, single-flight, retry-once, explicit `refresh()` surface) —
  the 401 surfaces inside the worker's own fetch wrap; refresh is a private
  method nobody else calls. Fetch is the entire interface.
- **`store()` / field-level writes / per-field expiry** — one write verb,
  whole-object material; expiry is the worker's own business inside its
  material until alarms arrive (then: one optional secret-level hint).
- **The no-`read()` membrane (v5→A′: body + WS-frame substitution,
  `sign()`, substitution-on-write, exit scanning as defense)** — verified
  buildable at workerd source level (~100–130 lines), rejected: ADR 0005.
  Deep body inspection is a cost nobody pays; the jail's pin is the
  boundary.
- **Copy-at-connect for app credentials** — rotation fanout across every
  connection secret; replaced by header placeholders resolved at call time.
- **`env.APP` for platform credentials** — a project-swappable worker could
  read platform bytes; unacceptable. `APP` survives userspace-only.
- **Facet hosting** — the worker is a stateless dynamic worker loaded by
  the Secret DO; no DO facets, no `StatefulWorkerDurableObject`, no worker
  storage.
- **`worker.options`** — nothing real to put in it.
- **Pathless placeholders** — they existed for jail-side self-reference
  under the no-read model; a worker reads its own material instead.

Killed in v4–v5 (kept for the record): `SecretProgram` + lanes ("why not
just not implement fetch" — v6 finished the thought); `VAULT`/`LIB`
bindings; builtin modules; recipes; the `run` primitive (call-time code is
an extraction oracle; install-time declaration is the `worker` field);
saved-run engine; `IntegrationRuntime`/`platformRuntime`; `itx.lib` (every
candidate was sugar over a one-liner); the `SECRET` grant menu;
`mintClientSecret` worker method; `kind` enum; `verify` on the Secret
capability; `/secrets/integrations/<slug>/app` (bare slug path instead);
arbitrary RPC methods on secret workers.

---

## 6. Decisions

Locked this round: material = whole-object, one write verb · `read()` stays,
jail pin is the boundary, tripwire not wall · platform bytes never enter a
jail (ADR 0005) · substitution is header-only forever, with chaining across
referenced secrets, each hop under its own pin · app-tier creds ride Basic
header placeholders; same worker file both lanes via `APP_SECRET_PATH` ·
platform secrets = virtual, header-hop-only · fetch is the entire worker
interface; refresh is private worker code; zero platform refresh machinery ·
secret worker = stateless dynamic worker under the Secret DO (no facets) ·
first-party Discord/OpenAI credentialed infrastructure is platform code by
architecture · `field` stays in the placeholder grammar.

Locked in the lifecycle round: disconnect = optional per-integration
revocation → unclaim → `integration/disconnected` fact → delete the
connection secret; streams never deleted · no lifecycle projection (the UI
reads the connection stream and the paired secret stream) · external-id
uniqueness: one external id ↔ at most one project per integration, claimed
synchronously in `completeConnect`, `external_id_already_claimed` on
conflict (today's silent latest-claim-wins steal is a bug) · the directory
stays the existing global stream, fold-on-read, written by connect/
disconnect, no maintaining processor.

Locked at the zoom-out (2026-07-06): everything wipes — zero migration code,
prd database gets deleted · Slack ports LAST but is in scope (S6); the
current Slack path runs untouched until then · userspace mounts = durable
capability registration written at install; `apps/dummy-petshop` is the
proof vehicle and grows whatever the proof needs · Discord = userspace
bot-token-only day one, holding a real gateway WebSocket from the jail ·
Gmail swaps guts only; the `itx.gmail` surface may be renamed freely as
long as every prompt/reference is updated · dummy-petshop is a real,
fully-deployed app (it will grow OpenAPI + MCP later) · e2e specs live in
new separate files with their own well-documented helpers · UI is minimal
but includes deep-linkable connect URLs (render the connect form for one
integration, linkable by agents) · all implementation continues on PR
#1508.

Worker provenance (H2, simplest version): a `DynamicWorkerRef` is
**content-pinned** — userspace refs are built from a project-repo file by
the existing worker build pipeline and the install fact records the
artifact hash; pushing to the repo does NOT change installed workers (the
fact is the trust event); changing code = explicit `update({ worker })`,
after which the Secret DO drops its cached stub and the next request loads
the new code (socket-holders reconnect exactly as they do on deploys).
First-party refs point into the deployment's built assets and follow
deploys — a deploy is the platform's trust event.

Tripwire scope (H4, simplest version): exact-substring scan of
worker-authored Response headers+bodies and `CAPTURE` payloads against the
string leaves (≥ 8 chars) of the secret's material and any handed `APP`
material, raw and base64 forms; a hit replaces the response with an error
and appends `secret/leak-blocked`.

## Future work (on the record, not day one)

- The takeover interstitial ("steal this integration?" — forced re-claim +
  disconnected fact to the loser; the OAuth round-trip already proved
  external ownership).
- Alarm-driven liveness and proactive refresh (the Secret DO's alarm sends
  the worker an ordinary request; `expiresAt` hint on update).
- Atomic conditional-claim on the directory DO (day-one check-then-append
  is fine at human connect speed) · a D1 index over the directory if
  fold-on-read gets hot.
- More tripwire encodings (base64url, hex, URL-escaped) beyond raw+base64.
- Integration-authored worker-upgrade helpers (re-install refs across
  connections after a repo fix).
- Chains longer than two hops, if any archetype ever wants one.
- The `env.APP` in-jail fallback for providers refusing header client auth
  — build when the first such provider shows up.
- The real Waitrose integration — day one, dummy-petshop's `legacy-login`
  endpoint (email+password → short-TTL token) stands in as the R8 proof
  with deterministic e2e.
- First-party shared-bot Discord (one platform gateway, guild fan-in) —
  day one Discord is userspace-token-only.

---

## 7. Process

- **S0** `apps/dummy-petshop` — the dummy third party, a real fully-deployed
  app (OAuth provider cribbed from the zero-trust-mcp try's ~140-line
  `dummy-oauth`: sealed stateless tokens, consent page, both grants,
  **Basic client auth at the token endpoint**; short-TTL tokens,
  `legacy-login` email+password→token endpoint standing in for Waitrose,
  HMAC-signed outbound webhooks, `/__backdoor` console: mint additional
  OAuth clients, expire tokens, revoke, rotate signing secret, fire
  good/bad-signature webhooks, fail the token endpoint N times). Grows
  OpenAPI + MCP later.
- **S1** Secret changes: serializable whole-object material · `public` ·
  `field` addressing in header substitution · header chaining with per-hop
  pins (replaces `multiple_secret_paths_not_supported`) · immutable egress ·
  `hmac`/`matches` · the virtual platform-secret resolver.
- **S2** Secret worker runtime: Secret DO loads the stateless dynamic worker
  (`DynamicWorkerRunner`), `worker ? worker.fetch : defaultFetch` dispatch,
  pin + `connect()` rejection at the jailed outbound, env construction
  (`SECRET`, strings, optional userspace `APP`/`CAPTURE`), exit tripwire.
  **Proof:** the Google worker (both lanes) replaces `google-tokens.ts`,
  Gmail e2e green; the Waitrose twin.
- **S3** Integrations tree: real RpcTargets, Octokit surface,
  `IntegrationInfo` describe extras, canonical facts, generic callback
  door, external-id claim-with-conflict-error, durable userspace mounts,
  minimal UI with deep-linkable connect URLs.
- **S4** Discord userspace gateway worker (real WS from the jail) + OpenAI
  relay worker.
- **S5** The userspace proof: dummy-petshop ×2 in a project repo — two
  slugs, two clients, multiple connections, callback/webhook routed by
  slug, backdoor-forced expiry proving in-fetch refresh, bad-signature
  webhooks proving verification, one worker-code update proving the
  provenance loop.
- **S6** Port the live Slack path (connect-flows.ts, slack-webhook-api.ts,
  the agent's Slack capability) onto the integrations tree; the old path
  runs untouched until this stage. Then delete it.

E2e for every stage lives in new, separate spec files with their own
well-documented helpers (no retrofitting into existing suites). All stages
land on PR #1508.

---

## 8. Implementation status (2026-07-06)

Built and proven (PR #1508):

- **S0 `apps/dummy-petshop`** — deployed (preview_3:
  `https://dummy-petshop.iterate-preview-3.com`). OAuth 2.0 (Basic client
  auth), Waitrose-style `/api/legacy-login`, bearer API, HMAC-signed
  webhooks, a `/__backdoor` console, **plus** an MCP server (`/mcp`),
  oRPC + OpenAPI (`/rpc`, `/api/v2`, `/openapi.json`), and a Discord-style
  **WebSocket gateway** (`/gateway`, credential in an IDENTIFY frame).
- **S1** — secret material is any serializable value; `getSecret(path[, field])`
  header placeholders; multi-secret header chaining with per-hop pins;
  `hmac`/`matches`; the virtual platform-secret resolver.
- **S2** — the secret worker runtime: a stateless dynamic worker overrides
  the secret's `fetch()`, jailed via one `SecretEntrypoint` stub that is both
  `env.SECRET` (read/update/fetch) and the pinned `globalOutbound`. Refresh
  is private worker code (401 → refresh → retry); no `refresh()` convention.
- **S4 (petshop half)** — the Discord-style frame-credential transport exists
  on the third-party side (petshop `/gateway`).
- **S5** — the round trip, proven live against preview_3
  (`integrations-petshop.e2e.test.ts`): **userspace** lane (two OAuth clients,
  two connections, connect → authed call → backdoor-forced-expiry refresh →
  webhook verify) and the **first-party** lane (same worker, app credential
  from the platform secret). Plus a Playwright consent spec
  (`e2e/playwright/petshop-oauth-consent.spec.ts`). The OS-side proof consumes
  only petshop's OAuth + bearer API + webhook-signing surface; petshop's MCP,
  oRPC/OpenAPI, and WS gateway are self-tested by petshop's own suites and
  stand ready as targets for the deferred OS-side work below.

S1, S2, S3a (platform resolver), and S5 (the petshop round trip) are done and
proven live. The remaining work — §9 — lands on this same PR, all at once.

---

## 9. The all-at-once plan (this PR)

Decisions locked in the 2026-07-06 grill (all subject to "no back-compat,
prd is destroyed on rollout"):

- **D1** Collapse the _credential_ layers of the builtins (connect, token,
  webhook ingress) onto v6. The Slack **agent/router machinery** that consumes
  the connection stream (`slack-agent-processor-*`, the router that triggers
  agents and posts replies) is OUT of scope and untouched.
- **D2** No generic `Integration` interface/registry. Integrations stay
  rhyming imperative per-slug code over the shared primitives (secret,
  `getSecret`, compute methods). §2.3's interface is documentation of that
  convention, not machinery.
- **D3** An integration _brokers a service through secrets_; connections are
  the feature per-account services add. Connectionful (slack/google/github/
  petshop) vend `<connection>` handles + secrets at
  `/secrets/integrations/<slug>/<connection>`; connectionless (parallel/exa)
  are one platform-key call, not in `list()`.
- **D4** Inbound webhooks route through each integration's OWN imperative
  `fetch(request, config)` handler — verify however it likes, own its
  sub-paths (Slack's Events API + interactivity + url_verification), stick
  things on a stream or not. NOT a webhook framework (no `{verify, extract,
buildEvent}` spec run by a generic loop — not every integration is "one
  verifiable stream"). The door is a tiny chain returning the first handler to
  claim the request. The one shared piece is a provider-agnostic fan-in
  directory keyed `(slug, externalId) → {projectId, connection}` (fold-on-read,
  synchronous claim at connect, `external_id_already_claimed` on conflict) plus
  a plain `routeIntegrationWebhook(slug, externalId, event)` helper a handler
  CALLS to append to the claimed connection's stream.
- **D5** First-party GitHub connects via **App installation** (external id =
  `installation_id`), replacing the OAuth-user flow. Its installation token is
  minted **in a jailed worker** that signs the App JWT via a new **`sign()`**
  compute method — the App private key never enters the jail (ADR 0006).
- **D6** petshop gains **three** WS credential shapes and the OS side proves
  each: `/gateway` (token in IDENTIFY frame — worker `read()`s + sends bytes),
  `/gateway-header` (token in the `Authorization` upgrade header — placeholder
  substituted at the jailed outbound), `/gateway-subprotocol` (token in
  `Sec-WebSocket-Protocol`). One `#egressFetch` WS branch (substitute upgrade
  headers → dial upstream → relay frames verbatim) covers all three.
- **D7** Minimal `__describe`-driven connect UI: a Connect button per
  connectionful integration, connectionless shown as available; deep-linkable
  `/projects/:slug/integrations?connect=<slug>`.
- **D8** Rollout = prd destroy; no migration, no compat shims, delete freely.
- **D9** If petshop proves all three WS shapes end-to-end, **Discord the
  integration is out of scope** (its frame shape is petshop-proven); the WS
  jail branch and the OpenAI-shaped relay stay in.
- **D10** The itx caller SDK for a connectionful integration WRAPS THE REAL
  VENDOR SDK and replays the caller's dotted path onto it — Slack = a real
  `@slack/web-api` WebClient, GitHub = a real `@octokit/rest` Octokit — never a
  hand-mapped method table. Each SDK's transport is redirected through the
  connection secret's jailed egress with a `getSecret(...)` placeholder auth
  header (Octokit via `request.fetch`; WebClient via a custom Axios `adapter`),
  so the token never leaves its Secret DO. `invokeCapability({ path, args })` →
  `replayPathCall(instance, { path, args })`. Both bundle + run on workerd
  (nodejs_compat) because the custom transport bypasses their Node HTTP layer.

**Stages (each independently green; e2e in new spec files):**

- **P1 — `sign()` + compute-only `env.APP`.** Add `sign({ field?, algo, payload })`
  (WebCrypto RS256; ES256 later) to the Secret capability + the platform
  resolver. New env binding `APP` = compute-only stub (sign/hmac/matches, no
  read/update/fetch) — safe for platform tier, retires "APP is
  userspace-only". Unit-tested.
- **P2 — Generic webhook door + directory.** `(slug, externalId)` directory
  stream + fold; generic `/api/integrations/<slug>/webhook` dispatching to
  per-slug verify+extract; `external_id_already_claimed` on conflict.
- **P3 — WS jail branch + petshop 3 WS shapes.** `#egressFetch` WS branch;
  petshop `/gateway-header` + `/gateway-subprotocol` (+ keep `/gateway`); an
  OS-side generic "relay/gateway" secret worker proving all three against
  petshop. **This subsumes Discord + the OpenAI relay shape (D9).**
- **P4 — GitHub onto v6.** App-installation connect + callback claiming
  `installation_id`; jailed sign-worker mints/refreshes the installation
  token; `github.api.request` through the connection secret; generic webhook
  door verifies the App webhook secret. Replaces the OAuth-user path. e2e:
  a petshop-backed GitHub-App stand-in (petshop grows an `/app/.../access_tokens`
  - JWT-verify shape) so the sign→mint→call→webhook loop runs hermetically.
- **P5 — Gmail onto v6.** Jailed refresh worker (the §3 Google archetype),
  delete `google-tokens.ts`; `itx.integrations.google[...].gmail.request`
  unchanged on the surface. Gmail e2e is the gate.
- **P6 — Slack onto v6.** Connect + bot-token secret + webhook ingress via the
  generic door/directory; agent machinery untouched. Slack e2e
  (webhook→agent→reply) is the gate. Delete the Slack-specific directory fold
  and old connect branches.
- **P7 — Connect UI + deep-link** (D7).
- **P8 — Tidies + deletions.** Narrow the stored worker type to
  `StatelessDynamicWorkerRef` (drop the double stateless guard); drop
  petshop's `?? []` back-compat default; retire dead pre-v6 connect-flow
  branches as each provider lands. Keep net non-test OS additions lean.
- **Rollout:** prd destroy + redeploy; reconnect integrations by hand.
