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
pnpm e2e
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
cutover: `https://os.iterate.com/.auth/identity/callback` for Google and
`https://os.iterate.com/.auth/identity/cloudflare/callback` for Cloudflare. The production Doppler
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
with one-click `Sign in ↗` links as the PR's test person, `pr<N>@preview.iterate.test`, and
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
repository; commits to `/repos/config` publish the pinned `worker.ts` revision. The optional
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

For a deployment in another Cloudflare account, follow [self-hosting](SELF-HOSTING.md).
