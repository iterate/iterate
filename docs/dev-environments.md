# Dev environments

How local development, preview environments, and identities work.

## The core model (read this much at minimum)

Every deployed environment is an entry in the root **`envs.ts`** (hostnames,
worker names, accounts, resource IDs) plus a Doppler config of the same name
carrying its secrets. `pnpm --dir apps/os run deploy --env prd` deploys
production; `preview` is the parent Worker every per-PR preview branches from
(`pnpm preview deploy`, below); `dev` runs a fully-local server and never
deploys. Scripts never branch on environment names; envs.ts + the config
supply everything.

Local dev is **fully local**: Durable Objects, KV and R2 run in miniflare
inside your worktree's `apps/os/.wrangler/state`, the server listens on
`http://localhost:8788` (or the `--port` you pass), and there is no external
dependency at all: the OS worker is its own OAuth issuer, and `pnpm dev` hands
it plain dev values instead of secrets. OS is a single worker (the edge,
the issuer's pages, `/api`, `/mcp`, project ingress and every Durable Object
class in one script; see the `description` in `apps/os/package.json`)
running inside wrangler's workerd — production-shaped by construction.
Nothing is contested between worktrees: twenty agents on one machine each run
their own isolated environment, each on its own port.

Identity lives in the **platform's control plane** (users, organizations and
projects in the `CONTROL_PLANE` Durable Object's own SQLite; see
`apps/os/SELF-HOSTING.md`). A deployment signs people in with whichever
mechanisms its `APP_CONFIG.login` enables: a global password, a mailed code,
Google, or Cloudflare. Two deployment secrets let you act as anyone, instantly:
the **password** (`login.password`) signs in as whatever email you type, and
the **operator bearer** (`secrets.adminBearer`) opens an operator session that
reaches every project, optionally as a named user (see
[Acting as users](#acting-as-users-and-admins)).

## Local dev

```bash
# once per worktree/clone
pnpm install

pnpm dev          # fully-local OS dev server on http://localhost:8788
pnpm dev -- --port 8799   # a second worktree, alongside
```

OS local dev needs no Doppler. `doppler.yaml` still maps each app directory to
its Doppler project (`apps/os` → `project-worker`), so `doppler setup` once per
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

- The port is the one you chose (default `8788`); wrangler prints
  `Ready on http://localhost:<port>`. `GET /version` answers
  `<deployment id> <base url>` once the worker is up — poll it before driving
  the server. Playwright's `webServer` waits on the same URL. A second
  `pnpm dev` in the same worktree needs its own `--port`.
- Dev server output is `wrangler dev`'s, in the terminal that started it. Run it
  with output redirected to a file when you need to tail it from elsewhere.
- Project hosts work in the browser as `<proj-slug>.localhost:<port>`
  (Chromium resolves `*.localhost` to loopback, and so does curl on current
  macOS). A client that does not should use `localhost:<port>` with a `Host`
  header. Deployed previews route projects as paths instead
  (`/projects/<slug>/<app>/…`), because workers.dev has no wildcard
  subdomains.
- Local MCP is the platform route: `http://localhost:<port>/mcp`. The
  operator bearer works there (it reaches every project, so every call names
  one). Smoke it with the MCP Inspector:

  ```bash
  npx -y @modelcontextprotocol/inspector --cli http://localhost:8788/mcp \
    --transport http \
    --method tools/list \
    --header "Authorization: Bearer dev-admin-api-secret"
  ```

  If `tools/list` works, call the one tool with the smallest harmless script:

  ```bash
  npx -y @modelcontextprotocol/inspector --cli http://localhost:8788/mcp \
    --transport http \
    --method tools/call \
    --tool-name run \
    --tool-arg project=<project-slug> \
    --tool-arg "script=async (itx) => itx.whoami()" \
    --header "Authorization: Bearer dev-admin-api-secret"
  ```

- Sign in as a human at `http://localhost:<port>/login`: any email, password
  `dev`. The mailed-code option works too: `wrangler dev` simulates the Email
  Sending binding and writes the message to a local file instead of mailing
  it. Google and Cloudflare sign-in exist only where their clients are
  configured (production). The Dash and the other hosted clients are ordinary
  OAuth clients of the platform: to run one against local OS, put
  `ITERATE_ORIGIN=http://localhost:8788` in its gitignored `.dev.vars` (see
  `apps/dash/README.md`) and `pnpm --dir apps/dash dev`.
- Sign in as an agent/test: use the deployment's password or operator bearer
  (next section). Never script the OAuth dance by hand: the e2e fixture
  `oauthSession` in `apps/os/e2e/support/principal.ts` runs the real flow
  (password sign-in, consent, code exchange) when a test needs a real grant.
- Test emails: tests use the reserved test domains (`example.com`, `.test`,
  and the other RFC 2606/6761 names). No deployment ever mails them, because a
  bounce costs the sender's reputation; sign in as them with the deployment's
  password.
- One-click login links: the legacy auth worker's `/test-login` endpoint, which
  signed a test address in server-side and seeded a `pr<N>` user and project,
  went with `apps/auth` in #2837. Its principle carries on in the preview's PR
  body section: every hosted client (Dash, Agents, Notes, Voice) is deployed
  next to the platform preview and wired to it, so a reviewer opens a client
  from the PR body and signs in with any email and the preview's password
  (Doppler `project-worker/preview`, `APP_CONFIG.login.password`; every preview
  inherits its parent's). That grants nothing the password doesn't already
  grant.

- Template-carrying projects: a project can be born from a config template
  still in flight on a PR. `projects.create({ project, configRepoTemplate })`
  takes a public GitHub reference in pnpm's Git dependency syntax, such as
  `github:iterate/iterate#<branch-or-sha>&path:configs-next/<name>`. Dash's
  New project sheet has a custom GitHub template field for the same thing.
  The ref resolves to a commit before the request is recorded, so recovery
  always uses the same source (`apps/os/docs/project-creation.md`). A template
  that cannot be fetched, or has no `worker.ts`, fails the creation visibly
  (`project/create-failed`) instead of silently going stock. The legacy
  `login_hint`/`project_hint` URL and the `-template-<name>` slug convention
  went with the legacy platform.

The issuer is part of the platform: there is no separate auth deployment to
keep in step. Working on sign-in or consent means working on `apps/os`
(`issuer-pages.ts`, `oauth.ts`, `password-and-code-sign-in.ts`, `public/`).

Each app deploys from its own workflow (Deploy OS, Deploy Dash, Deploy Agents,
Deploy Notes, Deploy Voice, and so on). A client identifies itself to the
issuer by its client-metadata URL (`<origin>/.auth/client.json`), so there are
no OAuth clients to seed and no deploy-time coordination between the platform
and its clients.

## Acting as users and admins

For product administration and support, use the operator bearer. It needs only
the selected environment's `secrets.adminBearer` and opens a session with the
`admin` actor, which reaches every project. It does not impersonate a customer
unless you ask it to: `authenticate({ type: "admin-secret", secret, as: { email } })`
acts as that user's session (the projects of their organizations). The e2e
lane's `adminCredentials(as?)` in `apps/os/e2e/support/client.ts` is exactly
this.

The `iterate` CLI (`packages/iterate`) takes the bearer from
`APP_CONFIG_ADMIN_API_SECRET`, ahead of any stored login:

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
(`project-worker/preview` for previews, `project-worker/prd` for production).
Read them under `doppler run`, never into a shared channel.

The deployment's two secrets give you three ways in:

1. **API**: an operator session with the bearer (above), or a user's OAuth
   access token as `Authorization: Bearer <token>` on `/api` and `/mcp`.
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

`pnpm getin` automated the legacy version of this for local dev: it found (or
started) the worktree's dev server, got or created a `test` project, minted
matching claims and opened the signed-in URL. `scripts/getin.ts` went with
#2837. Today the path is two steps and needs no tooling: `pnpm dev`, then
`http://localhost:8788/login` with any email and `dev`.

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
skipped unless `NOTES_BASE_URL` is set) and `suite` (the flake sentinel and
the harness's own specs). Select one with `pnpm spec --project=os-phone`.
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
DEMO_BASE_URL=https://pr<n>-<branch slug>-os-next-preview.iterate-dev-preview.workers.dev \
  doppler run --project project-worker --config preview -- pnpm spec

# a single spec, headed, while working on it
pnpm spec specs/os/auth.spec.ts --headed
```

Against a deployment, the specs validate one env contract. The config reads
the deployment's credentials out of `APP_CONFIG` (the password for sign-in, the
operator bearer for fixture setup), its project routing and MCP origin out of
the `envs.ts` entry the URL falls under, so a per-PR preview inherits its
parent's (`apps/os/e2e/support/deployed-target.ts`). An explicit
`ADMIN_API_SECRET`, `LOGIN_PASSWORD`, `PROJECT_INGRESS_ROUTING` or
`MCP_BASE_URL` still wins. `DEMO_BASE_URL` is the only target override; when it
is unset, Playwright boots the local dev server. It never infers credentials
from redirects.

The legacy `mobile` project (Expo Web and phone-sized baselines under
`specs/mobile/`) went with the mobile app in #2837. The `os-phone` project is its
successor for phone-width browser coverage of the platform's own pages.

### Minting in production

The same mechanism works against **production**: you can open an operator
session on `https://os.iterate.com` to poke around in prd. (Signing in as a
chosen identity there needs `login.password`, and only if production sets one;
its people sign in with Google, Cloudflare or the mailed code.)

```bash
# an operator session against production (reaches every project); the bearer is
# secrets.adminBearer in the APP_CONFIG of Doppler project-worker/prd
APP_CONFIG_ADMIN_API_SECRET=<prd adminBearer> pnpm exec iterate --config prd \
  itx run --project <slug> --eval 'return await itx.whoami();'
```

Production's operator bearer is a **master key**: anyone holding
`secrets.adminBearer` from `project-worker/prd` can act on every project, and
as any user. So is a production `login.password`, if one is ever set: it signs
in as any email. Every run is attributed on the project's root log to the
principal that made it, but the bearer's principal is the operator, not a
person. Guard those Doppler values like any production secret, and prefer a
scoped identity (a real user's OAuth grant) when you can.

Each environment (local dev, the preview parent, prd) has its own
`secrets.key`, bearer and password, so a leak is scoped to one environment;
every per-PR preview shares its parent's. A blank `secrets.adminBearer` turns the operator
door off entirely (a self-host needs none: a personal access token covers
scripting).

## Browsers: the golden path for agents

See [Browser testing](browser-testing.md) for the isolated, visible Chrome for
Testing default; unique concurrent-agent windows; explicit headless operation;
reusable test logins; and the permission required before attaching to a
developer's actual Chrome.

## Preview environments

There is no fleet to expand: every PR gets its own preview, and nothing is
pooled or leased.

Each preview is a complete, isolated stack on the dev/preview Cloudflare
account: a Cloudflare Worker Preview of the parent `os-next-preview`, named
`pr<n>-<branch slug>`, at
`https://pr<n>-<branch slug>-os-next-preview.iterate-dev-preview.workers.dev`,
with Durable Objects, KV, R2 and an Artifacts namespace of its own. The
five hosted clients (Dash, Agents, Notes, Voice, Kit) deploy as previews of their
own parents, wired to it. Previews use workers.dev and have no project hosts:
projects are paths on the one origin. The recipe is cloudflare-os's
(`apps/os/scripts/preview.ts`; commands in `apps/os/README.md`).

### The preview model: one preview per PR, for the PR's whole life

A preview belongs to one PR, named after its number and branch. The
invariants:

- **A PR keeps its preview from first deploy until the PR closes.** Every push
  redeploys it in place (`deploy`); closing the PR deletes it and everything it
  owned (`preview-delete.yml`). The nightly sweep (`preview-sweep.yml`) is the safety valve: it
  deletes a preview whose PR closed without a delete, a preview whose last
  deploy is more than 7 days old, a hand-named preview idle for 24 hours with no
  open PR branch of that name, and any per-preview resource that outlived its
  preview. The rules are a pure table in `apps/os/scripts/preview-sweep.ts`.
  Kept short on purpose, because a live preview costs Cloudflare resources and
  its Durable Objects can keep waking.
- **In-test cleanup is never the guarantee.** Every e2e run provisions its own
  projects under a run id (`E2E_RUN_ID`; CI pins the workflow run and attempt),
  so runs never collide, but a cancelled or killed run cleans up nothing.
  Deleting the preview is the guarantee. `reset` deletes the preview and its
  resources, then deploys fresh; `delete` removes it. Consequence: manual QA
  state on a preview survives pushes (they redeploy in place) and is gone after
  a `reset` or when the PR closes.
- **The preview's name is its identity.** It derives from the PR number and
  branch (`apps/os/scripts/preview-config.ts`). The PR body's managed section
  only _displays_ the URL, deployment and clients; it is never consulted for
  ownership, and a person's text around it is kept verbatim. Teardown looks
  each preview up again right before deleting it, and a GitHub lookup that
  failed never makes a preview stale.
- **Nothing to contend for.** There is no pool, so there is no queue, no
  resting slot and no reclaim. Concurrency is per PR and never cancelled: a
  half-applied preview is worse than a slow one.
- **Everything is attributable and visible.** The PR body names the preview,
  its deployment and a Cloudflare dashboard link; the workflow logs narrate
  each operation; `pnpm preview sweep --dry-run` prints what the sweep would
  delete and why.

  ```bash
  # What would the nightly sweep delete, and why?
  cd apps/os
  doppler run --project project-worker --config preview -- pnpm preview sweep --dry-run
  ```

CI and local machines run the **same preview commands**. Doppler/Cloudflare
deploy access is an operator capability, so deploy from a checkout of the PR's
head.

### Main runs

A push to `main` deploys production directly and waits for nothing else: Deploy
OS runs the deploy script, whose smoke probes (`/version`, OAuth discovery, and
the MCP and `/api` bearer challenges) mutate nothing, then, once `/version`
names the new version, GETs each production project host and pages
#error-pulse on a 421, a 5xx or no answer that four tries 10 s apart do not
clear (`scripts/ci/prd-post-deploy-check.ts`). In parallel, **Main OS e2e**
(`main-os-e2e.yml`) deploys a throwaway preview of the pushed commit, runs the
e2e suite and the browser specs against it, deletes it, and pages #error-pulse
only when main goes red or green again. Its runs never cancel each other: the
pushes that land during a run queue behind it, collapsed to the newest, so
every run that starts reaches a verdict unless someone cancels it by hand. A
job that hangs until its timeout counts as red. The full mutating proof is each
PR's preview. The legacy fleet's main preview runs (a `main-preview` lease,
`preview-main.yml`) went with it in #2837.

What still exercises deployed code on a schedule: the nightly **OS crash hunt**
drives isolate-ceiling rows against prd (`os-next-crash-hunt.yml`), the hourly
**DO duration probe** watches Durable Object cost, the 15-minute **prd fault
alarm** reads production's Workers Logs for 5xx and error bursts, and the
dispatch-only **OS e2e soak** runs the suite N times against one deployed
worker (next story).

### Story 1: CI previews my PR

Opening or pushing a PR that touches preview-relevant paths (the Preview OS
workflow's `paths:` list; see [Depot CI](depot-ci.md)) runs the **Preview OS**
workflow. **deploy** builds and deploys the platform preview and all four
clients, then writes the URL and the operations into the PR body's managed
section. **e2e** then runs as its own job against that deployment, and only
once the deploy succeeded: the Vitest e2e suite and the Playwright specs side
by side (`pnpm preview e2e`). Every push reruns both; a run with no successful
deploy runs no e2e rather than reporting green.

Closing or merging the PR runs `pnpm preview delete`, which deletes the
preview, its Artifacts namespace, KV namespaces and R2 bucket (and any D1 an
older preview left behind), and the client previews.

Preview cleanliness is an **invariant of birth**, not a promise about exits:
every preview is created with resources of its own, so no PR ever inherits
another PR's data. When an exit path skips the delete (a force-closed PR, a
failed cleanup), the sweep collects both the preview and any orphaned resource.

### Story 2: run what CI runs, locally

```bash
cd apps/os

# same lifecycle as CI for PR 1234 (deploy, then e2e):
doppler run --project project-worker --config preview -- \
  pnpm preview deploy --pr 1234 --name <branch> --apps all
doppler run --project project-worker --config preview -- \
  pnpm preview e2e --pr 1234 --name <branch>

# destroy the preview's state and redeploy, or remove it:
doppler run --project project-worker --config preview -- pnpm preview reset --pr 1234 --name <branch>
doppler run --project project-worker --config preview -- pnpm preview delete --pr 1234 --name <branch>
```

These address the same preview CI deployed for the PR (the name is the same),
so a local run redeploys it in place rather than fighting CI.

For a focused flake hunt, reuse the exact deployment and run one test file or
one test repeatedly without redeploying (from `apps/os`):

```bash
PREVIEW=https://pr1234-<branch slug>-os-next-preview.iterate-dev-preview.workers.dev

# one Vitest file, one test (paths are relative to apps/os)
WORKER_BASE_URL=$PREVIEW doppler run --project project-worker --config preview -- \
  pnpm e2e e2e/session.e2e.test.ts -t "projects.create"

# the whole suite N times, tallying every row that did not pass every time
WORKER_BASE_URL=$PREVIEW doppler run --project project-worker --config preview -- \
  pnpm e2e:soak --runs 25 --filter session

# one spec, repeated
DEMO_BASE_URL=$PREVIEW doppler run --project project-worker --config preview -- \
  pnpm spec specs/os/auth.spec.ts --repeat-each 25
```

The soak runs sequentially and writes `output/soak/summary.json` plus a table:
a row that fails once in a hundred is a flake, a row that fails every time is a
bug. All requested runs complete, so the summary preserves the failure rate.
Run it from CI (`os-next-e2e-soak.yml`) when the result matters: from a laptop
the OAuth-cookie rows answer 401, an unexplained laptop-side difference.

### Story 3: pin a PR to a preview

Nothing to pin: the PR's preview name is a function of its number and branch,
so every deploy for that PR, from CI or a laptop, lands on the same preview.
To run a PR's operations by hand, dispatch the workflow with its number:

```bash
depot ci dispatch --org 0p91s0lz49 --repo iterate/iterate \
  --workflow preview-os-next.yml --ref <branch> \
  --input pull-request-number=1234 --input action=reset
```

`action` is `deploy | reset | e2e`; `apps` (`all | auto |
none`) chooses the clients deployed on top. Delete and the nightly sweep are
workflows of their own: dispatch `preview-delete.yml` with
`--input pull-request-number=1234` to delete the preview, `preview-sweep.yml`
to sweep now.

### Story 4: a preview for experiments

Name a preview yourself instead of by PR number. That is what keeps PR
previews from deploying over you and PR cleanups from deleting your work:

```bash
cd apps/os
doppler run --project project-worker --config preview -- pnpm preview deploy --name exp-<you>
# → https://exp-<you>-os-next-preview.iterate-dev-preview.workers.dev

# sign in there with any email and the preview password, drive it as operator,
# or run the specs against it:
DEMO_BASE_URL=https://exp-<you>-os-next-preview.iterate-dev-preview.workers.dev \
  doppler run --project project-worker --config preview -- pnpm spec

# delete it when done; otherwise the sweep takes it 24 h after its last deploy
# (unless an open PR's head branch slugifies to the same name)
doppler run --project project-worker --config preview -- pnpm preview delete --name exp-<you>
```

The OS e2e soak uses exactly this with `--name soak`.

### Story 5: something is stuck

A preview that will not deploy, or whose state is wrong, has three remedies,
from least to most destructive:

- **redeploy** (`deploy`, or push again): same preview, same data, new code;
- **reset** (`reset`): delete the preview and every resource it owns, then
  deploy fresh. Previous projects, agents and schedules are gone, which is the
  point;
- **delete** (`delete`): remove it; the next push or dispatch creates it anew.

```bash
cd apps/os
doppler run --project project-worker --config preview -- pnpm preview sweep --dry-run  # what is stale, and why
doppler run --project project-worker --config preview -- pnpm preview reset --pr 1234 --name <branch>
doppler run --project project-worker --config preview -- pnpm preview sweep            # delete stale previews and orphans
```

Automation never deletes a preview whose PR is open and recently deployed. A
lookup that fails leaves the preview alone rather than guessing. Every
deletion is logged in the job that made it.

### Preview plumbing (secrets and clients)

A preview's configuration is **inherited, not provisioned**: every preview gets
the parent's two secrets (`APP_CONFIG`, `APP_CONFIG_SECRETS__KEY`, the
`os-next-preview` Worker's Previews settings, from Doppler
`project-worker/preview`), and its own `urls` (its origin, projects as paths,
its Dash when deployed) come from the per-preview Wrangler config
`preview.ts` writes. Clients need no registration: each identifies itself by
its client-metadata URL, so the platform preview and its clients need no
deploy-time coordination. The deploy creates the preview's Artifacts
namespace; KV and R2 are provisioned per preview by Wrangler.

More detail on the environments themselves: `envs.ts` (`osEnvs.preview`, the
parent) and `apps/os/README.md`.

## Tunnels and webhooks

Inbound webhooks (Slack, GitHub) and third-party OAuth callbacks need a
public HTTPS hostname — that's the only reason to add a public local URL to
fully-local dev.

The legacy platform had one: the iterate public local gateway (`apps/tunnels`,
a standalone captun worker at `tunnels.iterate.com`) and the captun Vite plugin
that published `https://<name>.tunnels.iterate.com` for a dev server. Their
source went with #2837, and nothing in the retained code uses them. Today, work
that needs a public HTTPS URL runs against a deployed preview (every preview
has one on workers.dev) or production.

The principle stands: public URLs are not scarce, but webhook-source
configuration is (a Slack app points at exactly one delivery URL at a time), so
give any such integration a stable, named target rather than a per-run one.

## Slack end-to-end testing

The retained platform has no Slack end-to-end suite; the legacy Slack tests
and their docs went with #2837. Slack requires public HTTPS webhooks, so any
Slack-facing test runs against a deployed environment, not plain-localhost dev.
