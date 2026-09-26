# OS

`apps/os` is the Iterate platform at https://os.iterate.com. One Cloudflare Worker provides
the OAuth issuer, `/api`, `/mcp`, project ingress, and the Durable Objects that hold project
contexts. First-party clients authenticate through this issuer and use `iterate/*`.

For selected-project backups and recovery after a deliberate erase, see
[project recovery seeds](docs/project-seeds.md).

## Develop and test

Run from the repository root:

```sh
pnpm install
pnpm dev
pnpm typecheck
pnpm test
pnpm os e2e
pnpm spec
```

`pnpm dev` starts a local platform. The package commands below are useful while working only on
the platform:

```sh
pnpm --dir apps/os build
pnpm --dir apps/os typecheck
pnpm --dir apps/os test
pnpm --dir apps/os e2e
```

The Worker is a TanStack Start app built by Vite: `src/worker.ts` serves the platform, and the
pages people see (`/`, `/login`, the `/oauth2/auth` consent) are server-rendered routes in
`src/routes/` using the shared `@iterate-com/ui` components. The build emits the Worker and its
`dist/server/wrangler.json`, which the tests, deploys and previews use. `WORKER_BASE_URL` selects a deployed target for integration tests; browser tests
(`pnpm spec`, [specs/](../../specs/AGENTS.md) at the repo root) use `DEMO_BASE_URL`. See
[testing](../../docs/testing.md) for the suite boundary and required evidence.

## Configuration and deployment

`envs.ts` owns managed deployment names, URLs, and resource IDs. Doppler supplies secrets. Build
before deploying so the generated Wrangler configuration matches the selected environment:

```sh
pnpm --dir apps/os build
pnpm --dir apps/os run deploy --env <environment>
```

Production uses `https://os.iterate.com` as its OAuth issuer and
`https://mcp.iterate.com` for MCP. Register these identity-provider callbacks before a hostname
cutover: `https://os.iterate.com/.auth/identity/callback` for Google,
`https://os.iterate.com/.auth/identity/cloudflare/callback` for Cloudflare and
`https://os.iterate.com/.auth/identity/github/callback` for GitHub. The production Doppler
`APP_CONFIG` email-code sender must use a verified Iterate sending domain. Project ingress and the
Cloudflare for SaaS fallback use `iterate.app`; custom apexes hosted in other accounts point at
`cname.iterate.app` and must show an active hostname and certificate on that zone.
The proxied `*.iterate.com` DNS record and Worker route serve the `iterate` project's config worker;
named Worker routes such as `os.iterate.com`, `mcp.iterate.com`, `dash.iterate.com`, and
`k.iterate.com` take precedence. The zone has an active `*.iterate.com` edge certificate.

The Preview OS workflow's Deploy preview job deploys a platform preview and all five hosted clients
(Dash, Agents, Notes, Voice, Kit); then its E2E tests job runs the integration suite and its Browser
specs job the browser specs against them, side by side, each a required check. A PR that changes no
preview path deploys nothing and skips both. The commands to run them from a checkout or from CI are
below.

A PR's previews are named `pr<n>`: `https://pr<n>-os.iterate-dev-preview.workers.dev` for the
platform, `https://pr<n>-dash.iterate-dev-preview.workers.dev` and so on for the clients. Each is a
Cloudflare Worker Preview of a parent Worker named after its app (`os`, `dash`, …; envs.ts
`<app>Envs.preview`). The parents are main on the dev/preview account: the Preview parents workflow
deploys them from every push to main that a PR's preview would run for, and
`https://dash.iterate-dev-preview.workers.dev` signs in against
`https://os.iterate-dev-preview.workers.dev`. What people leave there is erased nightly
(`pnpm preview reset-parent`, in the Preview sweep workflow); PR previews keep their data and keep
serving through it. A platform preview has its own Durable Objects, D1, KV, R2, and Artifacts namespace. Closing the PR deletes the preview and its resources. The nightly sweep also removes stale previews and orphaned resources;
see `scripts/preview-sweep.ts` for the rules. Previews use workers.dev and have no project hosts.
Main OS e2e, the latency guard and the real-model suite each keep one preview, `main`, `latency` and
`real-model`, which every run redeploys in place, its readiness gate waiting until the preview runs
the new version ([why](../../docs/depot-ci.md#main-os-e2e-keeps-one-preview)). Leave those names to
CI.

A new Durable Object class needs care. An existing preview cannot gain a class it lacked when it was
created: `wrangler preview` fails with Cloudflare 10061 ("Cannot create binding for class … not
exported by the script"). The deploy then deletes that preview and its resources and creates it
again, once. A new preview does not need the class on its parent. To deploy the parents by hand,
from a checkout: `pnpm preview deploy-parents`.

Run preview operations from this directory under the parent Doppler config:

```sh
doppler run --project os --config preview -- \
  pnpm preview deploy --pr <number> --apps all
doppler run --project os --config preview -- \
  pnpm preview e2e --pr <number>
doppler run --project os --config preview -- \
  pnpm preview specs --name main
doppler run --project os --config preview -- \
  pnpm preview sweep
doppler run --project os --config preview -- \
  pnpm preview deploy-parents
```

Use `e2e` (the vitest e2e suite) or `specs` (the Playwright specs) in place of `deploy` to test a
preview as it is deployed, named by PR number or, without `--pr`, by its name (`--name main` is the
one Main OS e2e keeps). CI does the same without redeploying:

```sh
depot ci dispatch --org 0p91s0lz49 --repo iterate/iterate --workflow preview-os.yml --ref ci-soak/<name> \
  --input pull-request-number=<number> --input action=test
depot ci dispatch --org 0p91s0lz49 --repo iterate/iterate --workflow preview-os.yml --ref ci-soak/<name> \
  --input preview-name=main --input action=e2e
```

`action=test` runs both suites, `e2e` or `specs` one of them. Dispatch from a scratch branch cut
from main ([Run CI without a PR](../../docs/depot-ci.md#run-ci-without-a-pr)), never from main,
whose head would carry the result, and one suite alone never from the PR's branch
([why](../../docs/depot-ci.md#run-the-suites-against-a-deployed-preview)). `reset` destroys that
preview's state before redeploying; `delete` removes it. CI publishes URLs and operation links in
the PR body, under a status line (deploying, deployed, deploy failed, with the CI job) and a line
per suite (`E2E tests` and `Browser specs`: passed or failed, each with its CI job),
with `Sign in ↗` links as the PR's test person, `pr<N>@preview.iterate.test`, for whoever
confirms at prd that they are `*@nustom.com` (`src/test-link-admins.ts`), and
one-click "New project from template" links into the Dash
([dev environments](../../docs/dev-environments.md), `src/test-link.ts`).
For an operational change, verify the preview's resulting state and telemetry as well as its checks.
The [engineering invariant](../../docs/engineering-invariants.md) defines the required standard.

## The control plane's database

The control plane — users, identities, organizations, memberships, projects, invitations, custom
hostnames and the OAuth provider's grants — is one D1 per deployment, bound as `DB`: `os-prd-db`,
`os-parent-db`, `os-<preview>-db` for each preview, and `os-dev-db` locally
(`src/control-plane/db/`). prd's and the parent's primaries are in western Europe; a preview's is
created near the job that creates it, which for CI is where its suites run (`scripts/d1.ts`).
[sqlfu](https://github.com/mmkal/sqlfu) authors it: the schema is
`definitions.sql`, the migrations `migrations/*.sql`, and every query a named statement in
`queries/*.sql`, typed into `queries/.generated/` (committed); `db/index.ts` says why each write is
one statement or one batch.

To change the schema, edit `definitions.sql`, write the next migration (`pnpm --dir apps/os db:draft`
drafts it), then:

```sh
pnpm --dir apps/os db:check     # the migrations replay to definitions.sql
pnpm --dir apps/os db:generate  # the typed queries; commit what changes
pnpm --dir apps/os db:migrate   # this worktree's local D1 (`pnpm dev` runs it too)
```

Wrangler migrates a deployment's D1 when it deploys, and a preview's when the preview deploys,
before the code that reads it uploads (`scripts/d1.ts`): a migration must keep the running version
working until then. D1 Time Travel restores a database to any minute of the last 30 days.

## Projects and MCP

`session.projects.create()` starts a durable project-creation saga. Each project has a config
repository; commits to `/repos/config` publish the pinned `worker.ts` revision. A repo can remember
a git remote as its origin and `pull()` or `push()` it, fast-forward only unless `force`, keeping one
history with the same commits on both ([a config repo on GitHub](docs/project-creation.md#a-config-repo-on-github)). The optional
`configs/with-agents` template adds userspace agents. See [project creation](docs/project-creation.md).

A context hosts Durable Object classes as facets (`itx.facets.get(name, { source, className })`, or
a processor's row). A caller reaches a facet by itx expression only through the methods its class
lists in `static publicMethods`: extend `FacetDurableObject` or `StreamProcessorDurableObject` from
`iterate/sdk` and add your own (`[...super.publicMethods, "send"]`); the platform's own calls
go around the list (`src/context/facet-public-methods.ts`).

Anything a caller or a facet keeps can hold a context resident and billed after its last call.
[Context residency](docs/residency.md) explains the seven mechanisms that prevent, end or record
that.

The MCP endpoint is `/mcp` on each platform deployment (production also serves
https://mcp.iterate.com). It exposes `run({ project?, script })`, where `script` is an
`async (itx) => …` function. The deployed integration test
[shows runnable examples](e2e/mcp-project-root.e2e.test.ts). An MCP client signs in with OAuth or
presents a personal access token; [credentials](docs/credentials.md) says which bearer works
where, and why the operator bearer is `/api`'s alone.

## Integrations: Slack, Google, Cloudflare, GitHub

A project connects a provider account through iterate's own app (APP_CONFIG
`integrations.{slack,google,github}`, the legacy platform's keys) or its own app. A connection is a
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
const project = itx.facets.get("project");
const { authorizationUrl } = await project.connectIntegration({
  provider: "slack", // or "google", "github"
  connection: "acme",
  client: "iterate", // or "project": the app in /secrets/slack-acme
  next: "https://dash.iterate.com/…",
});
// the human consents; the provider's callback stores the credential, names the account,
// routes it (iterate's app), appends slack/connected on / and redirects to `next`
await project.disconnectIntegration({ provider: "slack", connection: "acme" });
```

The callback finishes the connection, so an agent or the CLI that starts a connect needs no second
call. Slack and Google come back to `/api/integrations/<provider>/callback`, the legacy URL
iterate's apps are registered with. The secret facet exchanges the code, then the project facet
names the account: Slack's `auth.test` or Google's userinfo. GitHub comes back to
`/api/integrations/github/callback`, the App's Callback URL. With "Request user authorization
(OAuth) during installation", GitHub sends the `code` beside the `installation_id` in one redirect.
Without it, the callback sends the human on to authorize the App. The user token then has to show
that the human administers the installation's account: it is their own user, or an organization
they are an active admin of. After that it is discarded, and the secret's
`github-app-installation` strategy mints installation tokens instead. With iterate's key it mints
only for an installation the control plane routes to this project.

A GitHub installation iterate's App already has connects without GitHub's configure page (which
asks for sudo and carries no state of ours back): `connectIntegration({ provider: "github",
installationId, platformOrigin, … })` sends the human straight to authorize the App, and the code
proves they administer it as above. The Dash lists those installations from the person's GitHub
sign-in (`GET /user/installations` with its token, through their own egress). An installation
another project holds is not refused: once the human proved they administer it, the callback lands
on `next` with a signed, ten-minute offer (`?move=`, naming the holder only when the human can see
it), and the project facet's `confirmGithubMove({ offer })` moves the route in one D1 batch that
re-points it only while the holder still holds that installation (`moveIntegrationRoute`), connects
it here, and disconnects the holder's connection only while it still names that installation
(`github/disconnected { reason: "moved" }`, its secret gone). A move that fails to connect puts both
installations' routes back, the destination's previous one included. When the holder's cleanup
fails, the confirmation says so and the same offer retries the cleanup alone; the offer works once
otherwise. Either way the holder stops using the installation: a secret facet re-reads an
iterate-App installation's route at most every 30 s of use (`#assertInstallationRouted`) and refuses
a token for one routed elsewhere, from any secret path. The human need not be a member of the
holder. Slack still refuses a team another project holds.

iterate's apps each receive every account's webhooks on one URL
(`POST /api/integrations/slack/webhook` and `/interactivity-webhook`, and
`POST /api/integrations/github/webhook`). The control plane's `integration_routes` sends each
delivery on: an account belongs to one connection, and the first to connect it wins. A project's
own app posts to `…/webhook/<projectId>/<connection>` and signs with the secret's key. A delivery
for another team or installation is ignored. The status codes follow one rule (`rules.ts`). A bad
signature is a 401. A delivery that is signed but unusable is a 200 with `ignored`. A failed append
throws, so the provider retries. A deployment without the app answers 503. A per-PR preview's apps
are the dummy pet shop's fakes (`scripts/preview-{slack,google,github}-app.ts`), which
`e2e/integrations.e2e.test.ts` drives.

### Sign-in keeps tokens · your accounts in a project

One OAuth client per provider serves signing in and connecting, because a refresh token only works
with the client that issued it: `login.<provider>` holds only the scopes a sign-in asks for, and the
client is `integrations.<provider>`. A provider's sign-in button shows only when both are set. A
sign-in with Google, Cloudflare or GitHub (the GitHub App's user authorization) keeps its token as
the person's own connection: the secret `global:/users/<id>/secrets/<provider>-<subject>` and a
platform `<provider>/connected` on `/users/<id>`, which the account folds into `state.integrations`,
the same row a project keeps (`src/integrations/contract.ts`), with the scopes the provider granted.
Google issues a refresh token only on a consent, so a first sign-in without one goes back once for
the consent screen; every Google and GitHub sign-in shows the provider's account picker. A provider
pointed at a fake signs in addresses under `login.testLink.emailDomain` alone. Identities stay keyed
by (provider, subject).

A sign-in links a provider's account to a person once by its verified email, so a GitHub account
whose primary address is not the person's would sign in as someone new. A signed-in person adds it
to their own account instead: `/.auth/identity/<provider>?link=1&next=<url>` on the issuer (the
Dash's /sessions "Connect GitHub", and "Add GitHub sign-in" on a project's GitHub sheet). Nobody
signed in there is sent to sign in first; `next` must be on the platform's origin or the Dash's.
The flow cookie carries the person, and the callback adds the account only while the browser is
still signed in to the issuer as them (catalog.ts `addIdentity`): refused when it already signs in
to someone else, or when they have another account of that provider. It keeps the token as a
sign-in does, and the person stays signed in as they were, back on `next` (`?error=` when refused).
Their email never changes, then or on a later sign-in with the added account, and
`login.allowedEmails` asks nothing of the added account's own address; signing in with it later is
an ordinary sign-in, which does.

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
await project.facets.get("project").disconnectIntegration({ provider: "google", connection });
// the project stops using it; it stays yours
```

Only the person themselves connects an account of theirs: their own grant must hold the `account`
scope (a key bound to projects, an admin signed in as them, and the admin secret are refused), and
the account is picked from their own connections alone. It is connected at once when it holds the
scopes the project asks for: iterate's app's (`session.info().iterateAppScopes`), plus `scopes`
(`rules.ts` `missingScopes`). Otherwise the consent runs on the person's own connection; its
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
account and refuses another account's tokens. `itx.integrations.requestFromUser(provider,
{ scopes? })` answers a Dash link (`?connect=<provider>`) that asks a person to connect their account,
or another, to the project. On the Dash's Integrations page each provider's one action is Connect:
a sheet that offers the person's own accounts first ("Use ada@example.com", or what the provider
will ask to add), then another account through iterate's app (`ConnectButton`, `packages/ui`), then
"Use your own app". It offers iterate's app only for the providers in
`session.info().iterateAppProviders` (APP_CONFIG `integrations`); a deployment without them, such as
a self-host, connects through "Use your own app". GitHub's callback URL is the origin the callback
request reached, so it needs no `urls.os`.

### Instance lends

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

`scripts/seed-instance-secrets.ts --env <name> [--pr <n>] [--lend-to-every-project]` sets
`/secrets/exa`, `/secrets/parallel` and `/secrets/openai` from Doppler: `os-legacy-2026-04`'s
`APP_CONFIG_INTEGRATIONS__EXA` and `__PARALLEL`, and `os`'s `OPENAI_API_KEY`. `--env` has no
default, and `--env prd` also needs `--confirm-prd`.

### WebSockets through a secret

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

### Session logins: Waitrose and exchange code

Some vendors have no OAuth: a username and password buy a short session, and logging in again is
the refresh. The secret holds the credential and the facet logs in on first use and on a 401, never
per call. Waitrose's login is bundled (`refresh: { kind: "waitrose-session", graphqlUrl }`,
`src/integrations/waitrose.ts`). The Dash connects Waitrose for a project or a person with a
username and password, and a person's is connected to a project like Google. Any other vendor is the secret's own
exchange code, an ES module exporting `exchange(material, fetch)` that returns the next material.
This Tesco-shaped login is the pet shop's (`/api/tesco/login`):

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

For a deployment in another Cloudflare account, follow [self-hosting](SELF-HOSTING.md).
