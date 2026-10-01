# OS

`core/os` is the Iterate platform at https://os.iterate.com. One Cloudflare Worker provides
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
pnpm --dir test e2e
pnpm spec
```

`pnpm dev` starts a local platform. The package commands below are useful while working only on
the platform:

```sh
pnpm --dir core/os build   # no presets; `pnpm os:build` at the root builds with iterate's configs/
pnpm --dir core/os typecheck
pnpm --dir core/os test
pnpm --dir test e2e
```

The Worker is a TanStack Start app built by Vite: `src/worker.ts` serves the platform, and the
pages people see (`/`, `/login`, the `/oauth2/auth` consent) are server-rendered routes in
`src/routes/` using core/os's own components: shadcn's in `src/components/ui/`, written by its CLI
and never edited ([packages/ui/AGENTS.md](../../packages/ui/AGENTS.md#vendored-shadcn-components)),
and ours beside them. Its UI is the auth flow and nothing more: a component only another app needs,
or anything first-party and opinionated (stream views, app shells), belongs in packages/ui. The
build emits the Worker and its `dist/server/wrangler.json`, which the tests, deploys and previews
use. `WORKER_BASE_URL` selects
a deployed target for the integration tests and the browser tests (`pnpm spec`,
[test/playwright/](../../test/playwright/AGENTS.md) at the repo root). See [testing](../../docs/testing.md) for the
suite boundary and required evidence.

## Configuration and deployment

`envs.ts` owns managed deployment names, URLs, and resource IDs. Doppler supplies secrets. Build
before deploying so the generated Wrangler configuration matches the selected environment:

```sh
pnpm --dir core/os build
pnpm os:deploy --env <environment>
```

Production uses `https://os.iterate.com` as its OAuth issuer and
`https://mcp.iterate.com` for MCP. Register these identity-provider callbacks before a hostname
cutover: `https://os.iterate.com/.auth/identity/callback` for Google,
`https://os.iterate.com/.auth/identity/cloudflare/callback` for Cloudflare and
`https://os.iterate.com/.auth/identity/github/callback` for GitHub. The production Doppler
`APP_CONFIG` email-code sender must use a verified Iterate sending domain. Project ingress and the
Cloudflare for SaaS fallback use `iterate.app`; custom apexes hosted in other accounts point at
`cname.iterate.app` and must show an active hostname and certificate on that zone.
A project's email is `<slug>@iterate.app` (src/integrations/email.ts): the zone is onboarded for
Email Sending, and its Email Routing catch-all rule delivers every inbound message to `os-prd`'s
`email()` handler. iterate.com is the `iterate` project's (the project wildcard's) email domain too:
it is onboarded for Email Sending, so that project sends from any iterate.com address, and its
catch-all also delivers to `os-prd`, which records every message on that project's
`/integrations/email` and forwards it to `projectWildcard.forwardEmailTo` (envs.ts).
The proxied `*.iterate.com` DNS record and Worker route serve the `iterate` project's config worker;
named Worker routes such as `os.iterate.com`, `mcp.iterate.com`, `dash.iterate.com`, and
`k.iterate.com` take precedence. The zone has an active `*.iterate.com` edge certificate.

The Preview OS workflow's Deploy preview job deploys the tested commit's platform and all seven hosted
clients (Dash, Agents, Notes, Docs, Admin, Voice, Kit). Beside it, its E2E tests job sets up the integration
suite and its Browser specs job the browser specs, and each runs its suite against them once the
deploy has finished, each a required check; after the deploy, Clean up superseded deletes the PR's
older deployments. A PR that changes no preview path deploys nothing and passes both without testing.
The commands to run them from a checkout or from CI are below.

Every tested commit gets a deployment of its own, a set of plain Workers named `<prefix>-<sha7>-<app>`
on the dev/preview account (envs.ts `previewDeployment`): for PR 3144 at `a1b2c3d`,
`https://pr3144-a1b2c3d-os.iterate-dev-preview.workers.dev` for the platform,
`https://pr3144-a1b2c3d-dash.iterate-dev-preview.workers.dev` and so on for the clients, which sign
in against it. The platform has its own Durable Objects, D1, KV, R2 and Artifacts namespace, and
deploys through `scripts/os/deploy.ts` like prd (`pnpm os:deploy --env pr3144-a1b2c3d` works too).
Nothing is redeployed in place and no data survives a push. Closing the PR deletes its deployments;
the nightly sweep removes superseded, stale and half-made ones (`scripts/os/preview-sweep.ts` for the
rules). Deployments use workers.dev and have no project hosts. Main OS e2e, the latency guard and
the real-model suite use the prefixes `main`, `latency` and `real-model`; leave those names to CI.

Main on the dev/preview account is `os`, `dash`, … (envs.ts `<app>Envs.preview`): the Preview parents
workflow redeploys them in place from every push to main that a PR's deployment would run for, and
`https://dash.iterate-dev-preview.workers.dev` signs in against
`https://os.iterate-dev-preview.workers.dev`. What people leave there is erased nightly
(`pnpm preview reset-parent`, in the Preview sweep workflow). No PR deployment depends on it. To
deploy it by hand, from a checkout: `pnpm preview deploy-parents`.

Run preview operations from this directory under Doppler `os/preview`:

```sh
doppler run --project os --config preview -- \
  pnpm preview deploy --pr <number> --apps all
doppler run --project os --config preview -- \
  pnpm preview e2e --pr <number>
doppler run --project os --config preview -- \
  pnpm preview specs --name main
doppler run --project os --config preview -- \
  pnpm preview delete --pr <number>
doppler run --project os --config preview -- \
  pnpm preview sweep --dry-run
doppler run --project os --config preview -- \
  pnpm preview deploy-parents
```

`deploy` deploys this checkout's commit as `pr<number>-<sha7>` (or `<name>-<sha7>` with `--name`).
Use `e2e` (the vitest e2e suite) or `specs` (the Playwright specs) in place of `deploy` to test the
newest deployment of a PR, or without `--pr` of a name (`--name main` is Main OS e2e's). CI does the
same without deploying:

```sh
depot ci dispatch --org 0p91s0lz49 --repo iterate/iterate --workflow preview-os.yml --ref ci-soak/<name> \
  --input pull-request-number=<number> --input action=test
depot ci dispatch --org 0p91s0lz49 --repo iterate/iterate --workflow preview-os.yml --ref ci-soak/<name> \
  --input preview-name=main --input action=e2e
```

`action=test` runs both suites, `e2e` or `specs` one of them. Dispatch from a scratch branch cut
from main ([Run CI without a PR](../../docs/depot-ci.md#run-ci-without-a-pr)), never from main,
whose head would carry the result, and one suite alone never from the PR's branch
([why](../../docs/depot-ci.md#run-the-suites-against-a-deployed-preview)). `delete` removes every
deployment of the PR or name. CI writes each deployment's links into the PR body: per worker, a
`Sign in ↗` that signs the app in as the PR's test person, `pr<N>@preview.iterate.test`, once one of
prd's admins signs in to the deployment through prd (`src/admin-sign-in.ts`) and confirms "Sign in
as someone else" on the consent page (Notes and Docs, which run on the platform's sign-in, open in
`pr<N>` as the admin, whom the seed makes a member), and its Cloudflare dashboard; "New project from
template"
links into the Dash; and the previous commit's section folded while the next deploys
([dev environments](../../docs/dev-environments.md)). For an operational change, verify the
deployment's resulting state and telemetry as well as its checks.
The [engineering invariant](../../docs/engineering-invariants.md) defines the required standard.

## The control plane's database

The control plane — users, identities, organizations, memberships, projects, invitations, custom
hostnames and the OAuth provider's grants — is one D1 per deployment, bound as `DB`: `os-prd-db`,
`os-parent-db` (main on dev), `<deployment>-os-db` for each per-commit deployment, and `os-dev-db`
locally (`src/control-plane/db/`). prd's and main on dev's primaries are in western Europe; a
per-commit deployment's is created near the job that deploys it, which for CI is where its suites
run (`scripts/os/d1.ts`). [sqlfu](https://github.com/mmkal/sqlfu) authors it: the schema is
`definitions.sql`, the migrations `migrations/*.sql`, and every query a named statement in
`queries/*.sql`, typed into `queries/.generated/` (committed); `db/index.ts` says why each write is
one statement or one batch. It is the one truth of organizations, members, invitations and projects:
`session.organizations` and `session.projects` read it as it stands (the Dash reads nothing else),
and the facts a verb lands on an organization's context and a member's account are their activity.

To change the schema, edit `definitions.sql`, write the next migration (`pnpm --dir core/os db:draft`
drafts it), then:

```sh
pnpm --dir core/os db:check     # the migrations replay to definitions.sql
pnpm --dir core/os db:generate  # the typed queries; commit what changes
pnpm --dir core/os db:migrate   # this worktree's local D1 (`pnpm dev` runs it too)
```

Wrangler migrates a deployment's D1 when it deploys, a per-commit deployment's too (created first),
before the code that reads it uploads (`scripts/os/d1.ts`): a migration must keep the running version
working until then. D1 Time Travel restores a database to any minute of the last 30 days.

## Projects and MCP

`session.projects.create()` starts a durable project-creation saga. Each project has a config
repository; a commit to `/repos/config` publishes its `main` (`src/project/publication.ts`). A repo can remember
a git remote as its origin and `pull()` or `push()` it, fast-forward only unless `force`, keeping one
history with the same commits on both ([a config repo on GitHub](docs/project-creation.md#a-config-repo-on-github)). A project
created with no template gets a homepage alone (`src/project/minimal-config.ts`); the presets a
deployment offers are its build's input (`pnpm build --template <github reference>`), and iterate's
own (`configs/`, whose `default` installs the userspace agents and voice apps from npm) come from
its deploy tooling. See [project creation](docs/project-creation.md).

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
[shows runnable examples](../../test/vitest/os/mcp-project-root.e2e.test.ts). An MCP client signs in with OAuth or
presents a personal access token; [credentials](docs/credentials.md) says which bearer works
where, and why the operator bearer is `/api`'s alone.

## Integrations

How a project connects Slack, Google, Cloudflare and GitHub (iterate's apps or its own), uses a
member's own accounts, borrows the deployment's keys, holds a WebSocket through a secret, and logs
in to vendors without OAuth: [integrations](docs/integrations.md).

For a deployment in another Cloudflare account, follow [self-hosting](SELF-HOSTING.md).
