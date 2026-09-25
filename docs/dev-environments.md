# Dev environments

How local development, preview environments, and identities work.

## The core model (read this much at minimum)

Every deployed environment is an entry in the root **`envs.ts`** (hostnames,
worker names, accounts, resource IDs) plus a Doppler config of the same name
carrying its secrets. `pnpm --dir apps/os run deploy --env prd` deploys
production; `preview` is main on the dev/preview account, whose Doppler config
every per-commit deployment ships (`pnpm preview deploy`, below); `dev` runs a
fully-local server and never deploys. Scripts never branch on environment names; envs.ts + the config
supply everything.

Local dev is **fully local**: Durable Objects, D1, KV and R2 run in miniflare
inside your worktree's `apps/os/.wrangler/state` (`pnpm dev` migrates the local D1 first,
`pnpm --dir apps/os db:migrate`), the server listens on
`http://localhost:8788` (or the `--port` you pass), and there is no external
dependency at all: the OS worker is its own OAuth issuer, and `pnpm dev` hands
it plain dev values instead of secrets. OS is a single worker (the edge,
the issuer's pages, `/api`, `/mcp`, project ingress and every Durable Object
class in one script; see the `description` in `apps/os/package.json`)
running inside wrangler's workerd — production-shaped by construction.
Nothing is contested between worktrees: twenty agents on one machine each run
their own isolated environment, each on its own port.

Identity lives in the **platform's control plane** (users, organizations and
projects in the deployment's D1, `apps/os/src/control-plane/db/`; see
`apps/os/SELF-HOSTING.md`). A deployment signs people in with whichever
mechanisms its `APP_CONFIG.login` enables: a global password, a mailed code,
Google, or Cloudflare. Two deployment secrets let you act as anyone, instantly:
the **password** (`login.password`) signs in as whatever email you type, and
the **operator bearer** (`secrets.adminBearer`) opens an operator session on
`/api` that reaches every project, optionally as a named user (see
[Acting as users](#acting-as-users-and-admins)). `login.allowedEmails` limits
who may sign in by any of them (`["*@iterate.com"]`, or the var
`APP_CONFIG_LOGIN__ALLOWED_EMAILS=*@iterate.com,*@nustom.com`); a live grant or
personal access token for an address it stops naming is refused at its next
use. The operator bearer is not limited by it. People, agents and MCP clients
use a **personal access token** instead of the bearer:
[credentials](../apps/os/docs/credentials.md) says which works where.

## Local dev

```bash
# once per worktree/clone
pnpm install

pnpm dev          # fully-local OS dev server on http://localhost:8788
pnpm dev -- --port 8799   # a second worktree, alongside

pnpm dev start --detach   # the same, in the background; returns once /version answers
pnpm dev status           # pid, port, URL (exit 1: not running)
pnpm dev attach           # follow its log, apps/os/.wrangler/dev.log
pnpm dev kill             # or `restart`
pnpm getin                # a browser signed in as test@preview.iterate.test, in project `test`
pnpm -s getin --print     # the one-click sign-in URL alone, for Playwright and agents
```

OS local dev needs no Doppler. `doppler.yaml` still maps each app directory to
its Doppler project (`apps/os` → `os`), so `doppler setup` once per
worktree scopes the monorepo for the deploy, preview and seed commands that do
read secrets.

- **Config selection**: `pnpm dev` runs `apps/os/scripts/dev.ts`, which builds
  once (`scripts/build.ts`: the generated `wrangler.jsonc` and modules) and then
  starts `wrangler dev` with the local deployment's configuration as plain
  `--var`s: the `APP_CONFIG` object (sign-in password `dev`, the mailed code,
  operator bearer `dev-admin-api-secret`), `APP_CONFIG_SECRETS__KEY`, the
  platform URL and subdomain ingress under `localhost`. Extra arguments go to
  `wrangler dev`: `pnpm dev -- --port 8799`.
- **Which config?** There is one local configuration, and it lives in
  `scripts/dev.ts`. There are no personal `dev_<you>` configs for OS. A
  project's integration credentials are project secrets (Dash's
  `/projects/<slug>/secrets`, the platform's `itx.secrets`), not dev config.

  Generated configuration owns derived values: `scripts/build.ts` writes
  `wrangler.jsonc` from `envs.ts`, and deploy scripts ship the two secrets
  (`APP_CONFIG`, `APP_CONFIG_SECRETS__KEY`). Do not hand-edit generated files
  or pin copies of derived values in Doppler: a manually pinned copy can only
  drift.

- **Detached and `getin`**: the running server is recorded in
  `apps/os/.wrangler/dev-server.json` (`{pid, port, baseUrl, startedAt, detached}`), which
  is how `status`, `kill` and `pnpm getin` find it. Without `--port` the port is
  the worktree's last recorded one, else `8788`, else a free one. `pnpm getin`
  (`scripts/getin.ts`) starts the server if need be, creates the project as the
  person through the operator bearer (idempotent), and opens a one-click sign-in
  link (below) signed with the local key. With a local Dash up at
  `http://localhost:5173` whose `APP_CONFIG_URLS__OS` is this server, it lands on the
  Dash's project page with no Allow page; else on `/login`. `-e`/`-p` pick
  another `@preview.iterate.test` person and project; `--dash` another Dash.
  `pnpm -s getin --token` prints a personal access token for that person and
  project instead (30 days): their bearer at `/api`, `/mcp` and the project's
  hosts.
- The port is the one you chose (default `8788`); wrangler prints
  `Ready on http://localhost:<port>`. `GET /version` answers
  `<deployment id> <base url>` once the worker is up — poll it before driving
  the server. Playwright's `webServer` waits on the same URL. A second
  `pnpm dev` in the same worktree needs its own `--port`.
- Dev server output is in the terminal that started it; a detached server's is
  in `apps/os/.wrangler/dev.log` (`pnpm dev attach`).
- Project hosts work in the browser as `<proj-slug>.localhost:<port>`
  (Chromium resolves `*.localhost` to loopback, and so does curl on current
  macOS). A client that does not should use `localhost:<port>` with a `Host`
  header. Deployed previews route projects as paths instead
  (`/projects/<slug>/<routingSlug>/…`), because workers.dev has no wildcard
  subdomains.
- Local MCP is the platform route: `http://localhost:<port>/mcp`. It takes a
  person's bearer: a personal access token (`pnpm -s getin --token`), or an
  MCP client's own OAuth sign-in. The operator bearer is refused there. Smoke it
  with the MCP Inspector:

  ```bash
  TOKEN=$(pnpm -s getin --token)
  npx -y @modelcontextprotocol/inspector --cli http://localhost:8788/mcp \
    --transport http \
    --method tools/list \
    --header "Authorization: Bearer $TOKEN"
  ```

  If `tools/list` works, call the one tool with the smallest harmless script
  (the key reaches one project, so `project` may be omitted):

  ```bash
  npx -y @modelcontextprotocol/inspector --cli http://localhost:8788/mcp \
    --transport http \
    --method tools/call \
    --tool-name run \
    --tool-arg "script=async (itx) => itx.whoami()" \
    --header "Authorization: Bearer $TOKEN"
  ```

  Drive it from Claude Code: after `pnpm exec iterate config set --name local --os-base-url http://localhost:8788`,
  `ITERATE_BEARER_TOKEN=$TOKEN pnpm exec iterate --config local mcp claude`
  checks `tools/list` and prints the `claude --mcp-config … --strict-mcp-config` command (`--exec` runs it).

- Sign in as a human at `http://localhost:<port>/login`: any email, password
  `dev`. The mailed-code option works too: `wrangler dev` simulates the Email
  Sending binding and writes the message to a local file instead of mailing
  it. Google and Cloudflare sign-in exist only where their clients are
  configured (production). The Dash and the other hosted clients are ordinary
  OAuth clients of the platform: to run one against local OS, put
  `APP_CONFIG_URLS__OS=http://localhost:8788` in its gitignored `.dev.vars` (see
  `apps/dash/README.md`) and `pnpm --dir apps/dash dev`.
- Sign in as an agent/test: use the deployment's password or operator bearer
  (next section). Never script the OAuth dance by hand: the e2e fixture
  `oauthSession` in `apps/os/e2e/support/principal.ts` runs the real flow
  (password sign-in, consent, code exchange) when a test needs a real grant.
- Test emails: tests use the reserved test domains (`example.com`, `.test`,
  and the other RFC 2606/6761 names). No deployment ever mails them, because a
  bounce costs the sender's reputation; sign in as them with the deployment's
  password.
- One-click sign-in: every hosted client (Dash, Agents, Notes, Admin, Voice,
  Kit) is deployed next to the platform in each per-commit deployment and wired
  to it, and the PR body's section carries `Sign in ↗` links: one per worker
  (apps/os's into the Dash's project), and with the Dash one per `configs`
  template ("New project from template"), which lands in the Dash's New project sheet with that
  template chosen (`/projects?new=1&template=<name>`). A template the PR
  changes is linked at the PR head instead
  (`template=github:iterate/iterate#<head>&path:configs/<name>`, the
  custom field prefilled), so the project is born from the unmerged template.
  The PR body is public, so a link alone signs nobody in: a click first sends
  the browser to prd (`os.iterate.com`) to confirm it's an `*@nustom.com`
  person, through an OAuth grant that can only read who they are (prd's
  `/oauth2/userinfo` resource; `apps/os/src/test-link-admins.ts`). Then it
  signs the browser in as the PR's test person, `pr<N>@preview.iterate.test`,
  and lands inside project `pr<N>`, with no password and no Allow page on the
  preview. An agent without an admin's prd session signs in to a preview with
  its password instead (Doppler `os/preview`, `APP_CONFIG` `login.password`).
  CI seeds that person and project on every deploy
  (`apps/os/scripts/preview.ts` `seedSignIn`). The link is
  `/.auth/test-link?t=<token>` (`apps/os/src/test-link.ts`), signed with the
  deployment's `secrets.key` and bound to its origin, so a link for one
  deployment is refused on another even though every deployment ships the same
  key. It is also bound to that one address, expires in 14 days (every push
  mints a fresh one) and goes with its deployment. The route exists only where
  `login.testLink` is set. A per-commit deployment's config (envs.ts
  `previewDeployment`'s `testLinks`, with its admins) and local dev set it in code,
  never in Doppler, and `parseAppConfig` refuses it unless `urls.os` is a
  workers.dev or localhost origin, so prd answers 404, and off localhost
  refuses it without `login.testLink.admins`, the issuer and email patterns
  that gate it. Local dev redeems a link at once. Locally, mint one with
  the dev key (`specs/os/test-link.spec.ts` shows how). Anyone can still sign
  in with any email and the preview's password (Doppler
  `os/preview`, `APP_CONFIG.login.password`).

- Template-carrying projects: a project can be born from a config template
  still in flight on a PR. `projects.create({ project, configRepoTemplate })`
  takes a public GitHub reference in pnpm's Git dependency syntax, such as
  `github:iterate/iterate#<branch-or-sha>&path:configs/<name>`. Dash's
  New project sheet has a custom GitHub template field for the same thing.
  The ref resolves to a commit before the request is recorded, so recovery
  always uses the same source (`apps/os/docs/project-creation.md`). A template
  that cannot be fetched, or has no `worker.ts`, fails the creation visibly
  (`project/create-failed`) instead of silently going stock.

The issuer is part of the platform: there is no separate auth deployment to
keep in step. Working on sign-in or consent means working on `apps/os`
(`issuer-pages.ts`, `oauth.ts`, `password-and-code-sign-in.ts`, `public/`).

Each app deploys from its own workflow (Deploy OS, Deploy Dash, Deploy Agents,
Deploy Notes, Deploy Voice, and so on). A client identifies itself to the
issuer by its client-metadata URL (`<origin>/.auth/client.json`), so there are
no OAuth clients to seed and no deploy-time coordination between the platform
and its clients.

## Acting as users and admins

As yourself, on projects you belong to, use your own login
(`iterate login`) or a personal access token (`ITERATE_BEARER_TOKEN`; locally
`pnpm -s getin --token`); see [credentials](../apps/os/docs/credentials.md).

For automation, and for a project you are not a member of, use the operator
bearer on `/api` (`/mcp`, project hosts and a secret's OAuth callback refuse
it). It needs only the selected environment's
`secrets.adminBearer` and opens a session with the `admin` actor, which reaches
every project. It does not impersonate a customer unless you ask it to:
`authenticate({ type: "admin-secret", secret, as: { email } })` acts as that
user's session (the projects of their organizations). The e2e suite's
`adminCredentials(as?)` in `apps/os/e2e/support/client.ts` is exactly this.

**Platform admins** are people, not the bearer: the exact emails in `APP_CONFIG`
`admins` (`["jonas@iterate.com"]`; local dev lists `test@preview.iterate.test`).
Signed in to the admin app (`apps/admin`), which asks for the `admin` scope, an
admin reaches every project and person, and the global namespace as
`session.global` (its `cd` walks `/users/<id>…` and `/organizations/<id>…`), for
12 hours. To use any app as someone else, sign in to it again (the account
menu's **Switch account…**): the issuer's consent page offers an admin, and
nobody else, **Sign in as someone else…** — their email, then a confirm that
names who the client is (its verified host, where the code goes, the resource,
the permissions) and warns about anything that is not one of our apps. It works
for any client, third parties and `/mcp` included. The grant is the person's, for
an hour: every event names the admin in `source.principal.impersonatedBy`, their
Sessions list it as started by the admin, their account records
`account/impersonation-started` and the admin's `account/impersonation-performed`
(both with the grant's id), and the shell shows **Signed in as … / You are …**
with Stop impersonating. Removing an address from `admins` ends both at its next
request. `admins` beside `login.password` or paths ingress routing is refused
except on a preview or local dev: anyone with the password could sign in as an
admin, and under paths a project's own code runs on the issuer's origin.

The `iterate` CLI (`packages/cli`) takes the bearer from
`APP_CONFIG_ADMIN_API_SECRET`, ahead of `ITERATE_BEARER_TOKEN` and any stored
login:

```bash
# point a named CLI config at the local server once
pnpm exec iterate config set --name local --os-base-url http://localhost:8788

# a session REPL as operator: itx is the session, so you can create projects
APP_CONFIG_ADMIN_API_SECRET=dev-admin-api-secret pnpm exec iterate --config local repl
# itx> const p = await itx.projects.create({ project: "my-proj" }); await p.whoami()

# a script inside one project
APP_CONFIG_ADMIN_API_SECRET=dev-admin-api-secret pnpm exec iterate --config local \
  itx run --project my-proj --eval 'return await itx.whoami();'
```

Against a deployment, the bearer and the password are that environment's
secrets, inside the `APP_CONFIG` of its Doppler config
(`os/preview` for previews, `os/prd` for production).
Read them under `doppler run`, never into a shared channel.

The deployment's two secrets give you three ways in:

1. **API**: an operator session with the bearer on `/api` (above); a person's
   personal access token as `Authorization: Bearer <token>` on `/api`, `/mcp`
   and the hosts of the projects it covers; or an app's OAuth access token on
   the one resource it was issued for: `/api` (and the projects' hosts) or
   `/mcp`.
2. **Browser**: `POST /login` with an email and the deployment's password —
   the sign-in page's own form post — sets the issuer session cookie.
   `issuerCookie` in `apps/os/e2e/support/principal.ts` does this for tests;
   in a real browser, just use the `/login` page. This is THE way to point a
   browser at a local dev server or preview as a chosen identity.
3. **Membership**: authorization follows the directory. A user reaches the
   projects of their organizations, and an OAuth grant reaches the projects
   ticked at consent.

**A new user has no organization.** A human creates one in the Dash's New
project sheet, or on the consent page when a client such as Claude Code first
asks for access (`specs/os/auth.spec.ts`). An agent that
needs a project a particular user can reach creates it as that user through the
operator session: `session().authenticate(adminCredentials({ email })).projects.create({ project })`,
as `apps/os/e2e/support/project-host.ts` does.

For local dev: `pnpm dev`, then `http://localhost:8788/login` with any email and
password `dev`.

A signed-in _human_ never gets stuck on the missing organization: the Dash
and the consent page both create one on the way.

The password and the operator bearer are master credentials for their
deployment. Treat any URL, cookie or token they produce as a secret: it can
appear in browser history and edge request logs, so don't paste it into shared
channels. The local values in `scripts/dev.ts` are public dev values.

### Playwright specs against local dev or previews

The root Playwright config runs every app's browser specs from the root
`specs/` directory, and `pnpm spec` runs them from the repo root. It has one
project per app host: `os` (Desktop Chrome, `specs/os/`), `os-phone` (Pixel 7,
with touch, for the sign-in and consent specs), `notes` (`specs/notes/`,
skipped locally unless `NOTES_BASE_URL` is set), `voice` (`specs/voice/`,
skipped locally unless `VOICE_BASE_URL` is set) and `suite` (the flake sentinel
and the harness's own specs). Select one with `pnpm spec --project=os-phone`.
Playwright owns the server lifecycle: for a localhost target it runs
`pnpm dev -- --port <DEMO_PORT, default 8788>`, reuses an already running
server outside CI, and waits on `/version`.

Specs sign in through the real `/login` password step and stamp their own
identities, so in CI files and tests run side by side (`fullyParallel`, six
workers, one retry); locally they run on one worker so a single dev server
isn't hammered. The target is the only thing that changes between local and
deployed runs:

```bash
# local dev: starts or reuses the local OS dev server
pnpm spec

# deployed preview: the Doppler config supplies the preview's APP_CONFIG
DEMO_BASE_URL=https://pr<n>-os.iterate-dev-preview.workers.dev \
  doppler run --project os --config preview -- pnpm spec

# a single spec, headed, while working on it
pnpm spec specs/os/auth.spec.ts --headed
```

Against a deployment, the specs validate one env contract. The config reads
the deployment's credentials out of `APP_CONFIG` (the password for sign-in, the
operator bearer for fixture setup), its project routing and MCP origin out of
`envs.ts`: the entry the URL is, or the per-commit deployment it names
(`apps/os/e2e/support/deployed-target.ts`). `DEMO_BASE_URL` is the
only target override; when it is unset, Playwright boots the local dev server.
It never infers credentials from redirects.

The `os-phone` project covers the platform's own pages at phone width.

### Minting in production

For your own projects in **production**, mint yourself a personal access token
and use it like any key:

```bash
# signs you in in the browser with the `account` scope for this one call
pnpm exec iterate --config prd tokens create --name debugging --project <slug>
ITERATE_BEARER_TOKEN=itk_… pnpm exec iterate --config prd \
  itx run --project <slug> --eval 'return await itx.whoami();'
```

(https://dash.iterate.com's Sessions page mints the same key.) For a project you
are not a member of, the same mechanism works with an operator session on
`https://os.iterate.com`. Production sets no `login.password`: its people sign
in with Google, Cloudflare or the mailed code, each of which proves the email,
and only as an address `login.allowedEmails` names. The operator bearer's `as`
acts as a chosen user instead.

```bash
# an operator session against production (reaches every project); the bearer is
# secrets.adminBearer in the APP_CONFIG of Doppler os/prd
APP_CONFIG_ADMIN_API_SECRET=<prd adminBearer> pnpm exec iterate --config prd \
  itx run --project <slug> --eval 'return await itx.whoami();'
```

Production's operator bearer is a **master key**: anyone holding
`secrets.adminBearer` from `os/prd` can act on every project, and
as any user. Every run is attributed on the project's root log to the
principal that made it, but the bearer's principal is the operator, not a
person. Guard those Doppler values like any production secret, and prefer a
scoped identity (your own login or personal access token) when you can.

Each environment (local dev, main on dev, prd) has its own `secrets.key`,
bearer and password, so a leak is scoped to one environment; every per-commit
deployment ships main on dev's. A blank `secrets.adminBearer` turns operator
access off entirely (a self-host needs none: a personal access token covers
scripting).

## Browsers: the golden path for agents

See [Browser testing](browser-testing.md) for the isolated, visible Chrome for
Testing default; unique concurrent-agent windows; explicit headless operation;
reusable test logins; and the permission required before attaching to a
developer's actual Chrome.

## Preview environments

Every tested commit of a PR gets a deployment of its own. Nothing is pooled,
leased or redeployed in place.

A deployment is a complete, isolated set of plain Workers on the dev/preview
Cloudflare account, named `<prefix>-<sha7>`: `pr<n>` and the first 7 digits of
the commit CI tests (the PR merged into main). apps/os is
`https://pr<n>-<sha7>-os.iterate-dev-preview.workers.dev`, with Durable
Objects, a D1, KV, R2 and an Artifacts namespace of its own. The six hosted
clients (Dash, Agents, Notes, Admin, Voice, Kit) are `pr<n>-<sha7>-<app>`: each
signs in against that apps/os, and every link between them names the same
deployment's apps. The name decides everything (`previewDeployment` in
`envs.ts`), and the build and deploy are prd's (`apps/os/scripts/deploy.ts`,
`deployApp`). Deployments use workers.dev and have no project hosts: projects
are paths on the one origin. Commands: `apps/os/README.md`.

### The model: a fresh deployment per tested commit

- **Every push deploys a new set; the old one goes once the new one is ready.**
  Beside the suites, **Clean up superseded** deletes the PR's older
  deployments. Closing the PR deletes all of them (`preview-delete.yml`). The
  nightly sweep (`preview-sweep.yml`) is the safety valve: it deletes a
  deployment whose PR closed without a delete, one an hour older than its
  PR's newest, one more than 7 days old, and a hand-named one idle for
  24 hours with no open PR branch of that name. The rules are a pure table in
  `apps/os/scripts/preview-sweep.ts`. Kept short on purpose: every deployment
  is 7 workers, and the account allows 500.
- **Data does not survive a push.** Manual QA state lives as long as its
  deployment. The PR body's `Sign in ↗` link re-seeds the test person and
  project `pr<n>` on every deploy.
- **In-test cleanup is never the guarantee.** Every e2e run provisions its own
  projects under a run id (`E2E_RUN_ID`; CI pins the workflow run and attempt),
  so runs never collide, but a cancelled or killed run cleans up nothing.
  Deleting the deployment is the guarantee.
- **The name is its identity.** Every worker and resource of a deployment is
  `<prefix>-<sha7>-<member>`, and every delete finds them by that name. The PR
  body's managed section only _displays_ the URL, version and clients; it is
  never consulted, and a person's text around it is kept verbatim. A GitHub
  lookup that failed never makes a deployment stale.
- **Nothing to contend for.** There is no pool, so there is no queue, no
  resting slot and no reclaim. Concurrency is per PR: a push cancels the PR's
  run in progress, and the next run deploys a set of its own.
- **Everything is attributable and visible.** The PR body names the
  deployment, its version and a Cloudflare dashboard link; the workflow logs
  narrate each operation; `pnpm preview sweep --dry-run` prints what the sweep
  would delete and why.

  ```bash
  # What would the nightly sweep delete, and why?
  cd apps/os
  doppler run --project os --config preview -- pnpm preview sweep --dry-run
  ```

CI and local machines run the **same preview commands**. Doppler/Cloudflare
deploy access is an operator capability, so deploy from a checkout of the PR's
head.

### Second pushes

What the push before leaves behind, and what deletes it. A deployment is
whatever of its members exist, so a half-made one is deleted like a whole one
(`apps/os/scripts/preview-sweep.test.ts` pins each row).

| The push before                                  | What it left                                                | What deletes it                                                                                                                                       |
| ------------------------------------------------ | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| deployed; its tests passed or failed             | a whole deployment                                          | this push's Clean up superseded, once this push's deployment is ready                                                                                 |
| was cancelled halfway through deploying          | some of its D1, R2 bucket, Artifacts namespace, KV, workers | the same                                                                                                                                              |
| failed to deploy                                 | the same; the PR body says `deploy failed`                  | the same. Until then the push before it, the last to deploy, stays: the sweep never counts a deployment without its apps/os worker as the PR's newest |
| is still deploying when this push's cleanup runs | members created after this push's                           | nothing yet: the cleanup deletes only deployments made entirely before its own                                                                        |
| had its own cleanup cancelled or failing         | the deployment before it                                    | this push's cleanup, else the nightly sweep an hour later                                                                                             |

### Main runs

A push to `main` deploys production directly and waits for nothing else: Deploy
OS runs the deploy script, whose smoke probes (`/version`, OAuth discovery, and
the MCP and `/api` bearer challenges) mutate nothing, then, once `/version`
names the new version, GETs each production project host and pages
#error-pulse on a 421, a 5xx or no answer that four tries 10 s apart do not
clear (`scripts/ci/prd-post-deploy-check.ts`). In parallel, **Main OS e2e**
(`main-os-e2e.yml`) deploys the pushed commit as `main-<sha7>`, runs the e2e
suite and the browser specs against it, deletes the `main-…` deployments
before it, and pages #error-pulse only when main goes red or green again. Its
runs never cancel each other: the pushes that land during a run queue behind
it, collapsed to the newest, so every run that starts reaches a verdict unless
someone cancels it by hand. A job that hangs until its timeout counts as red.
The full mutating proof is each PR's deployment.

**Main on dev** (`os`, `dash`, … at `*.iterate-dev-preview.workers.dev`,
`osEnvs.preview` in `envs.ts`) is main on the dev/preview account, redeployed
in place by `preview-parents.yml` from every such push and erased nightly. People
use it by hand; nothing a PR deploys depends on it. (The workflow and the
`deploy-parents` command keep the name from when every PR's Worker Preview
branched off these workers.)

What still exercises deployed code on a schedule: the nightly **OS crash hunt**
drives isolate-ceiling rows against prd (`os-crash-hunt.yml`), the hourly
**DO duration probe** watches Durable Object cost, the 15-minute **prd fault
alarm** reads production's Workers Logs for 5xx and error bursts, and the
dispatch-only **OS e2e soak** runs the suite N times against one deployed
worker (next story).

### Story 1: CI previews my PR

Every push to a PR runs the **Preview OS** workflow. When the PR touches
preview-relevant paths (`previewPaths` in `scripts/ci/preview-paths.ts`; see
[Depot CI](depot-ci.md#which-prs-get-a-preview)), **Deploy preview** deploys
the tested commit's apps/os and all six clients. It folds the PR body's
managed section into a `<details>` first, so the links there read as the
previous commit's, and writes the new deployment's section once it lands: a
row per worker with its one-click `Sign in ↗` and Cloudflare dashboard links,
and the template quick-launch links. A deploy that fails leaves the previous
section folded. **E2E tests** (the Vitest e2e
suite, `pnpm preview e2e`) and **Browser specs** (the Playwright specs,
`pnpm preview specs`) then run side by side against that deployment, each its
own job and required check; **Clean up superseded** deletes the PR's older
deployments beside them. A deploy that did not succeed turns both suites red
rather than letting them report green. The verdicts live in those checks; the
section holds links only.

Closing or merging the PR runs `pnpm preview delete`, which deletes every
deployment of the PR: its workers, D1, Artifacts namespace, KV namespaces and
R2 bucket.

Cleanliness is an **invariant of birth**, not a promise about exits: every
deployment is created with resources of its own, so no PR or push ever inherits
another's data. When an exit path skips the delete (a force-closed PR, a failed
cleanup), the sweep collects what is left. One exit is Cloudflare's: an
Artifacts namespace it will not delete (an empty repos list, yet `DELETE` keeps
answering 409/10202 "Namespace is not empty"). The delete and the sweep log
`preview.platform-failure-stuck-namespace` and carry on; the sweep pages
#error-pulse to escalate it to Cloudflare and tries again the next night. The
run goes red only when the sweep could not act.

### Story 2: run what CI runs, locally

The `pnpm preview` commands CI runs (`deploy`, `e2e`, `specs`, `delete`,
`sweep`) run from `apps/os` under Doppler `os/preview`; they are in
[apps/os/README.md](../apps/os/README.md). Given the PR's number, `deploy`
deploys your checkout's commit as `pr<n>-<sha7>`: the same deployment CI makes
when your checkout is the commit CI tests, a deployment of its own otherwise.
`e2e` and `specs` test the PR's newest deployment unless PREVIEW_DEPLOYMENT
names one.

For a focused flake hunt, reuse the exact deployment and run one test file or
one test repeatedly without redeploying (from `apps/os`):

```bash
PREVIEW=https://pr1234-a1b2c3d-os.iterate-dev-preview.workers.dev

# one Vitest file, one test (paths are relative to apps/os)
WORKER_BASE_URL=$PREVIEW doppler run --project os --config preview -- \
  pnpm e2e e2e/session.e2e.test.ts -t "projects.create"

# the whole suite N times, tallying every row that did not pass every time
WORKER_BASE_URL=$PREVIEW doppler run --project os --config preview -- \
  pnpm e2e:soak --runs 25 --filter session
```

One spec, repeated, from the repo root (`pnpm spec` is the root's script):

```bash
DEMO_BASE_URL=$PREVIEW doppler run --project os --config preview -- \
  pnpm spec specs/os/auth.spec.ts --repeat-each 25
```

After each run of the suite the soak runs the perf budgets (`apps/os/perf`)
alone. It runs sequentially and writes `output/soak/summary.json` plus a table:
a row that fails once in a hundred is a flake, a row that fails every time is a
bug. All requested runs complete, so the summary preserves the failure rate.
Run it from CI (`os-e2e-soak.yml`) when the result matters: from a laptop
the OAuth-cookie rows answer 401, an unexplained laptop-side difference.

### Story 3: run a PR's operations by hand

Nothing to pin: a PR's deployments are named for its number. To run its
operations by hand, dispatch the workflow with that number:

```bash
depot ci dispatch --org 0p91s0lz49 --repo iterate/iterate \
  --workflow preview-os.yml --ref <branch> \
  --input pull-request-number=1234 --input action=deploy
```

`action` is `deploy | test | e2e | specs` (`test`, `e2e` and `specs` run the
suites against the PR's newest deployment:
[Depot CI](depot-ci.md#run-the-suites-against-a-deployed-preview)); `apps`
(`all | none`) chooses whether the clients are deployed on top. Delete and the
nightly sweep are workflows of their own: dispatch `preview-delete.yml` with
`--input pull-request-number=1234` to delete the PR's deployments,
`preview-sweep.yml` to sweep now.

### Story 4: a deployment for experiments

Name a prefix yourself instead of a PR number. That keeps PR runs from
deleting your work:

```bash
cd apps/os
doppler run --project os --config preview -- pnpm preview deploy --name exp-<you>
# → https://exp-<you>-<sha7>-os.iterate-dev-preview.workers.dev, for your checkout's commit

# sign in there with any email and the preview password, drive it as operator,
# or run the specs against it:
DEMO_BASE_URL=https://exp-<you>-<sha7>-os.iterate-dev-preview.workers.dev \
  doppler run --project os --config preview -- pnpm spec

# delete it when done; otherwise the sweep takes it 24 h after it was made
# (unless an open PR's head branch slugifies to the same name)
doppler run --project os --config preview -- pnpm preview delete --name exp-<you>
```

Deploying from another commit makes another deployment beside it; the sweep
takes the older one an hour later. The OS e2e soak uses exactly this with
`--name soak`.

### Story 5: something is stuck

A deployment that will not deploy, or whose state is wrong, has two remedies:

- **deploy again** (push again, or `deploy` from a checkout of a new commit): a
  fresh deployment, with nothing of the old one's data. Deploying the same
  commit again redeploys the same deployment in place;
- **delete** (`delete`): remove every deployment of the prefix; the next push
  or dispatch creates one anew.

```bash
cd apps/os
doppler run --project os --config preview -- pnpm preview sweep --dry-run  # what is stale, and why
doppler run --project os --config preview -- pnpm preview delete --pr 1234
doppler run --project os --config preview -- pnpm preview sweep            # delete stale deployments
```

Automation never deletes a PR's newest deployment while the PR is open and it
is less than 7 days old. A lookup that fails leaves a deployment alone rather
than guessing. Every deletion is logged in the job that made it.

### Deployment plumbing (secrets and clients)

A deployment's configuration comes from `envs.ts` like any other environment's:
`previewDeployment(name)` derives apps/os's env (its origin, its Dash, projects
as paths, the one-click sign-in links on, one test admin) and each app's, and
the deploy ships Doppler `os/preview`'s two secrets (`APP_CONFIG`,
`APP_CONFIG_SECRETS__KEY`) with apps/os. Clients need no registration: each
identifies itself by its client-metadata URL. The deploy creates apps/os's D1
(then migrates it), R2 bucket and Artifacts namespace by name; wrangler
provisions its KV namespaces on the first deploy.

## Public webhooks

Inbound webhooks (Slack, GitHub) and third-party OAuth callbacks need a public
HTTPS hostname, which fully-local dev does not have. Work that needs one runs
against a deployed preview (every preview has one on workers.dev) or
production; a Slack-facing test runs against a deployed environment, not
plain-localhost dev.

Public URLs are not scarce, but webhook-source configuration is (a Slack app
points at exactly one delivery URL at a time), so give any such integration a
stable, named target rather than a per-run one.
