# Integrations: Slack, Google, Cloudflare, GitHub

Paths are relative to `core/os`.

A project connects a provider account through iterate's own app (its keys are APP_CONFIG
`integrations.{slack,google,github}`) or its own app. A connection is a
name the project picks (`src/integrations/`):

- its credential is the secret `/secrets/<provider>-<connection>`. Outbound calls use the real SDK
  with `getSecret("/secrets/<provider>-<connection>", { field: "accessToken" })` as the token,
  through egress. For a project's own app, the same secret also holds the app's credentials
  (`clientId`, `clientSecret`, and Slack's `signingSecret` or GitHub's `appId`, `privateKey` and
  `webhookSecret`). iterate's client secret never enters project material: the secret facet
  attaches it from APP_CONFIG, and only toward that app's provider.
- its record is two platform facts on the project root, `events.iterate.com/<provider>/connected`
  and `…/disconnected`, which the project processor folds into `state.integrations` (the Dash's
  list).
- its inbound events land on the plain log `/integrations/<provider>/<connection>`, stamped
  `source.platform`.

```ts
const { authorizationUrl, connection } = await itx.integrations.connect("slack", {
  // or "google", "cloudflare", "github"
  connection: "acme", // optional: a fresh name when absent
  client: "iterate", // the default; or "project": the app in /secrets/slack-acme
  next: "https://dash.iterate.com/…",
});
// the human consents; the provider's callback stores the credential, names the account,
// routes it (iterate's app), appends slack/connected on / and redirects to `next`
await itx.integrations.disconnect("slack", "acme");
```

`itx.integrations.connect` and `disconnect` are the one way to connect and disconnect: they run on the
owner's root (a project's `/`, a person's `/users/<id>`), and the `project` and `account` facets
publish neither method they call (`src/context/built-ins.ts`). The callback finishes the connection,
so an agent or the CLI that starts a connect needs no second call. Slack and Google come back to
`/api/integrations/<provider>/callback`, the URL iterate's apps are registered with. The secret
facet exchanges the code, then the project facet names the account: Slack's `auth.test` or Google's
userinfo. GitHub comes back to `/api/integrations/github/callback`, the App's Callback URL. With
"Request user authorization (OAuth) during installation", GitHub sends the `code` beside the
`installation_id` in one redirect. Without it, the callback sends the human on to authorize the App.
The user token then has to show that the human administers the installation's account: it is their
own user, or an organization they are an active admin of. After that it is discarded, and the
secret's `github-app-installation` strategy mints installation tokens instead. With iterate's key it
mints only for an installation the control plane routes to this project.

A GitHub installation iterate's App already has connects without GitHub's configure page (which
asks for sudo and carries no state of ours back): `itx.integrations.connect("github",
{ installationId, … })` sends the human straight to authorize the App, back to the platform origin
the call reached, and the code proves they administer it as above. A project's own GitHub App also
passes its public half, `{ client: "project", connection, appSlug, clientId }`. The Dash lists
those installations from the person's GitHub sign-in (`GET /user/installations` with its token,
through their own egress).

An account another project holds is not refused, for either provider with webhook routes. A GitHub
installation is offered once the human proved they administer it. A Slack workspace is offered once
Slack's own consent finished: Slack lets only someone who may install apps there install into it,
which is the proof. The token Slack issued is never stored in this project first: iterate's Slack
app's token for a workspace another project holds is held aside in the secret facet, encrypted and
unused, until the move admits it (`admitHeldToken`), and dropped when the move fails or the secret is
written again. Either callback lands on `next` with a signed, ten-minute offer (`?move=`, naming the
holder only when the human can see it), and the project facet's `confirmIntegrationMove({ offer })`
moves the route in one D1 batch that re-points it only while the holder still holds that account
(`moveIntegrationRoute`), connects it here, and disconnects the holder's connection only while it
still names that account through iterate's app (`<provider>/disconnected { reason: "moved" }`, its
secret gone). Slack keeps one bot token per app and workspace, so the moved workspace's token is not
revoked, and an ordinary Slack disconnect revokes only when its own release of the route wins (one
D1 statement, which a move of the route and the release never both win) and no project routed the
workspace since. A move that fails to connect puts the routes back (to the holder only while its
connection still names the account and holds no other route, `restoreIntegrationRoute`), the
destination's previous one included, and keeps no token here.
When the holder's cleanup fails, the confirmation says so and the same offer retries the cleanup
alone; the offer works once otherwise, and the callback again lands on the same offer. The cleanup
holds no queue of the destination's connection and waits at most 10 s on the holder connection's,
so a move and a move back crossing between the same connections both finish at once, and a cleanup
never disconnects a connection that holds the account's route again. A failed move's undo waits on no other project: it restores
from the mover's side and releases again if the holder disconnected meanwhile. Either way
the holder stops using the account: a secret facet re-reads the route of an iterate-App
installation, or of iterate's Slack app's workspace, at most every 30 s of use and refuses a token
for one routed to another project (`#assertInstallationRouted`, `#assertWorkspaceNotMoved`, which
reads the workspace its record names). The human need not be a member of the holder.

iterate's apps each receive every account's webhooks on one URL
(`POST /api/integrations/slack/webhook` and `/interactivity-webhook`, and
`POST /api/integrations/github/webhook`). The control plane's `integration_routes` sends each
delivery on: an account belongs to one connection, and the first to connect it wins. A project's
own app posts to `…/webhook/<projectId>/<connection>` and signs with the secret's key. A delivery
for another team or installation is ignored. The status codes follow one rule (`rules.ts`). A bad
signature is a 401. A delivery that is signed but unusable is a 200 with `ignored`. A failed append
throws, so the provider retries. A deployment without the app answers 503. A per-PR preview's apps
are the dummy pet shop's fakes (`scripts/preview-{slack,google,github}-app.ts`), which
`test/vitest/os/integrations.e2e.test.ts` drives.

## Sign-in keeps tokens · your accounts in a project

One OAuth client per provider serves signing in and connecting, because a refresh token only works
with the client that issued it: `login.<provider>` holds only the scopes a sign-in asks for, and the
client is `integrations.<provider>`. A provider's sign-in button shows only when both are set. A
sign-in with Google, Cloudflare or GitHub (the GitHub App's user authorization) keeps its token as
the person's own connection: the secret `global:/users/<id>/secrets/<provider>-<subject>` and a
platform `<provider>/connected` on `/users/<id>`, which the account folds into `state.integrations`,
the same row a project keeps (`src/integrations/contract.ts`), with the scopes the provider granted.
Google issues a refresh token only on a consent, so a first sign-in without one goes back once for
the consent screen; every Google and GitHub sign-in shows the provider's account picker. A provider
pointed at a fake signs in addresses under `login.testEmailDomain` alone. Identities stay keyed
by (provider, subject).

A sign-in links a provider's account to a person once by its verified email, so a GitHub account
whose primary address is not the person's would sign in as someone new. A signed-in person adds it
to their own account instead: `/.auth/identity/<provider>?link=<userId>&next=<url>` on the issuer
(the Dash's /sessions "Connect GitHub", and "Add GitHub sign-in" on a project's GitHub sheet, each
naming the Dash session's person). Nobody signed in there is sent to sign in first, and a browser
signed in to the issuer as someone else is refused; `next` must be on the platform's origin or the
Dash's. The flow cookie carries the person, and the callback adds the account only while the browser
is still signed in to the issuer as them, after Google's consent screen when it shows one
(catalog.ts `addIdentity`): refused when it already signs in to someone else, or when they have
another account of that provider. `session.info().signInProviders` says which providers can be
added. It keeps the token as a sign-in does, and the person stays signed in as they were, back on
`next` (`?error=` when refused). Their email never changes, then or on a later sign-in with the
added account (the one email write, queries/users.sql `updateUserEmail`, refuses it in its `where`),
and `login.allowedEmails` asks nothing of the added account's
own address; signing in with it later is an ordinary sign-in, which does.

A project uses a member's own account when they connect it there, on the project's root:

```ts
const { authorizationUrl, connection } = await project.integrations.connect("google", {
  account: "ada@example.com", // one of YOURS, as session.user's state.integrations names it
  scopes: ["https://www.googleapis.com/auth/contacts.readonly"], // beyond iterate's app's, optional
  next: "https://dash.iterate.com/…",
});
// no authorizationUrl: connected. Else Google adds what the account lacks, on your own connection
// (include_granted_scopes, login_hint, the same account or refused), and the callback connects it.
await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
  headers: {
    authorization: `Bearer getSecret("/secrets/google-${connection}", { field: "accessToken" })`,
  },
});
await project.integrations.disconnect("google", connection);
// the project stops using it; it stays yours
```

Only the person themselves connects an account of theirs: their own grant must hold the `account`
scope (a key bound to projects, an admin signed in as them, and the admin secret are refused), and
the account is picked from their own connections alone. It is connected at once when it holds the
scopes the project asks for: iterate's app's (`session.info().iterateAppScopes`), plus `scopes`
(`iterate/integration-scopes` `missingScopes`). Otherwise the consent runs on the person's own connection; its
callback finishes the attempt it completed (keyed by the OAuth nonce), records the scopes the token
response says were granted (`grantedScopesOf`, never the ones asked), and connects the account to the
project only when those cover what it needs, the human who consented is the person with the `account`
scope, and — for an account the project already had — the project has not disconnected it
meanwhile. The project then lists it as `<provider>/connected { ownerUserId, ownerEmail }` on its
root (`client` stays the OAuth app's, iterate's), and its path `/secrets/<provider>-<connection>`
holds only a pointer to the person's secret: one token, whose every use is forwarded to the person's
context over its `fetch`, signed with the deployment's key in `x-itx-lend-use` (60 s; every egress
strips `x-itx-lend*`, so no caller can speak for one). The person's secret facet admits the use
(connected to this project, the person still a member), refreshes and dispatches it. The project's
use ends when it disconnects the account (or deletes the path), when the person disconnects their
account (on the Dash's /sessions page), or when they leave the organization; each lands
`<provider>/disconnected` on the project's root. Each step's facts are keyed by the lend, so a retry
after a partial failure lands what is missing once, and a lend ended at the person's secret stays
recorded there (`EndingLends`) until its project has been told: a retry of the revocation or of the
disconnect finishes it. A consent callback claims its finish before calling anything out, so a
second callback for the same consent never connects the account again. Two limits: a WebSocket already open through the
pointer keeps the material it dialled with until it closes (the end refuses the next use, not the
open socket), and a membership check may answer from the control plane's five-second cache. Under
the hood the pointer is the same lend the deployment's own keys use (`secret/lent`, `secret/borrowed`
and `secret/lend-revoked` on both sides), and `itx.secrets.lend` is the operator's alone.

`itx.integrations.connect(provider, { scopes?, connection?, next? })` otherwise connects the
context's owner (a project's root, or `session.user`) through iterate's app and answers
`{ authorizationUrl, connection }`; again for a connection that exists asks for more on the same
account and refuses another account's tokens. `itx.integrations.disconnect(provider, connection)`
on `session.user` disconnects the person's own connection, and every project's use of it ends.
`itx.integrations.requestFromUser(provider, { scopes? })` answers a Dash link
(`?connect=<provider>`) that asks a person to connect their account, or another, to the project. On
the Dash's Integrations page each provider's one action is Connect: a sheet that offers the person's
own accounts first ("Use ada@example.com", or what the provider will ask to add), then another
account through iterate's app (`ConnectButton`, `packages/ui`), then "Use your own app". It offers
iterate's app only for the providers in `session.info().iterateAppProviders` (APP_CONFIG
`integrations`); a deployment without them, such as a self-host, connects through "Use your own
app". GitHub's callback URL is the origin the callback request reached, so it needs no `urls.os`.

## Instance lends

The deployment keeps keys of its own at `global:/secrets/<name>` (Parallel, Exa, the OpenAI key a
realtime voice socket needs) and lends them to projects. Only the operator sets and lends them: the
admin bearer, or a platform admin holding the `admin` scope, both through `session.global`; a
person is refused (`src/context/built-ins.ts` `assertOperatorOfGlobalSecrets`). The global root's
`instance` facet folds their catalog, which `global.secrets.list()` reads.

```ts
await session.global.secrets.set("/secrets/openai", key, { urls: ["https://api.openai.com"] });
await session.global.secrets.lend("/secrets/openai", { to: projectId, as: "/secrets/openai" });
const { lendId, everyProject } = await session.global.secrets.lend("/secrets/openai", {
  to: "every-project",
  as: "/secrets/openai",
}); // { borrowed, kept, failed }
await session.global.secrets.revokeLend("/secrets/openai", lendId);
```

A lend to every project records `secret/lent { to: "every-project" }`. Every existing project then
borrows it, ten at a time, and so does each project `projects.create` makes later. A project whose
path already holds a key of its own keeps that key (`kept`); a project that has no key at the path
and no lend never falls back to the deployment's. A borrow that fails is reported
(`itx.secrets.every-project-borrow`) and listed in `failed`; it never fails a project's creation.
A project returns a lend by deleting its path, which ends the lend for that project alone.
`revokeLend` ends it for every borrower, whose next use is a 502. A use works like any other lend,
WebSocket upgrades included, and appends `secret/used { borrower }` to the deployment's secret. Every
project's calls therefore append to that one Durable Object, which becomes a hot object once many
projects use one key. The Dash's Integrations page lists them under "From this deployment".

## WebSockets through a secret

An upgrade through egress is a dispatch like any other, the project's own secret or a pointer: every hop is a fetch
channel, because a 101's socket cannot cross a Workers-RPC call. Dial with `https://` and
`Upgrade: websocket`; workerd's `fetch` refuses a `wss://` URL. A credential on the upgrade (a
header, a subprotocol) is substituted like any header. A credential inside the frames, such as
Discord's IDENTIFY, needs the upgrade to name its secret:

```ts
const response = await fetch("https://gateway.discord.gg/?v=10&encoding=json", {
  headers: { upgrade: "websocket", "x-itx-secret-frames": 'getSecret("/secrets/discord")' },
});
const socket = response.webSocket!;
socket.accept();
socket.send(JSON.stringify({ op: 2, d: { token: 'getSecret("/secrets/discord")', intents: 513 } }));
```

The secret's facet then holds the upstream socket, hands the caller its own, and substitutes the
placeholder in every client-to-server text frame (JSON-escaped inside a JSON string, so RESUME
works too); a frame naming another secret closes both sides with 1008. The upstream is pinned to the
secret's origins. An open outbound socket keeps every Durable Object on its path resident: 2 for
the project's own secret (the dialler's context and the secret's), 3 for a person's account or
the deployment's key (plus the context that holds the token). A deploy closes it, so a bot reconnects on close.

## Session logins: exchange code

Some vendors have no OAuth: a username and password buy a short session, and logging in again is
the refresh (a grocer's GraphQL `NewSession` mutation, a Tesco-shaped CSRF form). The secret holds
the credential and the facet logs in on first use and on a 401, never per call, by the secret's own
exchange code: an ES module exporting `exchange(material, fetch)` that returns the next material. No
vendor's login is built in; a vendor's code lives in userspace (github.com/jonastemplestein/iterategrations
has some). This Tesco-shaped login is the pet shop's (`/api/tesco/login`):

```ts
await itx.secrets.set(
  "/secrets/tesco",
  { email, password },
  {
    urls: ["https://dummy-petshop.iterate.workers.dev"],
    refresh: {
      kind: "worker",
      source: `export async function exchange(material, fetch) {
        const form = await fetch("https://dummy-petshop.iterate.workers.dev/api/tesco/login");
        const { csrf } = await form.json();
        const cookie = form.headers.get("set-cookie").split(";")[0];
        const response = await fetch("https://dummy-petshop.iterate.workers.dev/api/tesco/login", {
          method: "POST",
          headers: { cookie },
          body: new URLSearchParams({ email: material.email, password: material.password, _csrf: csrf }),
        });
        return { ...material, accessToken: (await response.json()).access_token };
      }`,
    },
  },
);
```

The facet runs it in a jail (`src/secret/exchange-jail.ts`). The jail loads the code through Worker
Loader with `env: {}` and caps each call at 1 s of CPU and 16 subrequests. Its only egress is
`PinnedOutbound`, which sends a request to the secret's pinned origins and refuses every other.
A refused fetch fails the refresh even if the code catches it, and `secret/refreshed` records
`ok: false`. Worker Loader cannot turn a loaded worker's logs off, so the jail silences `console`
before the code's module runs. A thrown error comes back with every string of the material cut
out. Only the returned object is kept. The source is sealed in the record, so changing it is a
`set`. The catalog shows its SHA-256, and the Dash shows "refreshed by code (<sha>)". Each
(deployment, secret, pin, source) gets its own isolate, and each is one billed Dynamic Worker.
