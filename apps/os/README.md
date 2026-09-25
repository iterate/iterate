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

The Preview OS workflow's Deploy preview job deploys the tested commit's platform and all six hosted
clients (Dash, Agents, Notes, Admin, Voice, Kit); then its E2E tests job runs the integration suite
and its Browser specs job the browser specs against them, side by side, each a required check, and
Clean up superseded deletes the PR's older deployments. A PR that changes no preview path deploys
nothing and skips both. The commands to run them from a checkout or from CI are below.

Every tested commit gets a deployment of its own, a set of plain Workers named `<prefix>-<sha7>-<app>`
on the dev/preview account (envs.ts `previewDeployment`): for PR 3144 at `a1b2c3d`,
`https://pr3144-a1b2c3d-os.iterate-dev-preview.workers.dev` for the platform,
`https://pr3144-a1b2c3d-dash.iterate-dev-preview.workers.dev` and so on for the clients, which sign
in against it. The platform has its own Durable Objects, D1, KV, R2 and Artifacts namespace, and
deploys through `scripts/deploy.ts` like prd (`pnpm run deploy --env pr3144-a1b2c3d` works too).
Nothing is redeployed in place and no data survives a push. Closing the PR deletes its deployments;
the nightly sweep removes superseded, stale and half-made ones (`scripts/preview-sweep.ts` for the
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
newest deployment of a PR, or without `--pr` of a name (`--name main` is Main OS e2e's), or the
one PREVIEW_DEPLOYMENT names. CI does the same without deploying:

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
deployment of the PR or name. CI publishes URLs and operation links in the PR body, under a status
line (deploying, deployed, deploy failed, with the CI job) and a line per suite (`E2E tests` and
`Browser specs`: passed or failed, each with its CI job), with one-click `Sign in ↗` links as the
PR's test person, `pr<N>@preview.iterate.test`, and one-click "New project from template" links
into the Dash ([dev environments](../../docs/dev-environments.md), `src/test-link.ts`). For an
operational change, verify the deployment's resulting state and telemetry as well as its checks.
The [engineering invariant](../../docs/engineering-invariants.md) defines the required standard.

## The control plane's database

The control plane — users, identities, organizations, memberships, projects, invitations, custom
hostnames and the OAuth provider's grants — is one D1 per deployment, bound as `DB`: `os-prd-db`,
`os-parent-db` (main on dev), `<deployment>-os-db` for each per-commit deployment, and `os-dev-db`
locally
(`src/control-plane/db/`). [sqlfu](https://github.com/mmkal/sqlfu) authors it: the schema is
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

Wrangler migrates a deployment's D1 when it deploys, a per-commit deployment's too (created first),
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
