# OS

`apps/os` is the Iterate platform at https://os.iterate.com. One Cloudflare Worker provides
the OAuth issuer, `/api`, `/mcp`, project ingress, and the Durable Objects that hold project
contexts. First-party clients authenticate through this issuer and use `iterate/next/*`.

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

The Preview OS workflow deploys a platform preview and all five hosted clients (Dash,
Agents, Notes, Voice, Kit); its separate `e2e` job then runs integration and browser checks against
them, only once that deploy succeeded. The commands to run it from a checkout are below.

A platform preview is named `pr<n>-<branch slug>` under the `os-preview` parent Worker. It
has its own Durable Objects, KV, R2, and Artifacts namespace. Closing the PR deletes the
preview and its resources. The nightly sweep also removes stale previews and orphaned resources;
see `scripts/preview-sweep.ts` for the rules. Previews use workers.dev and have no project hosts.

A new Durable Object class needs care. An existing preview cannot gain a class it lacked when it was
created: `wrangler preview` fails with Cloudflare 10061 ("Cannot create binding for class … not
exported by the script"). The deploy then deletes that preview and its resources and creates it
again, once. If the new preview fails the same way, the parent itself lacks the class. Deploy the
parent from main with `pnpm --dir apps/os run deploy --env preview` (`run`, because `pnpm deploy` is
pnpm's own command). A PR that itself adds a class needs the parent deployed from its branch first.

Run preview operations from this directory under the parent Doppler config:

```sh
doppler run --project os --config preview -- \
  pnpm preview deploy --pr <number> --name <branch> --apps all
doppler run --project os --config preview -- \
  pnpm preview e2e --pr <number> --name <branch>
doppler run --project os --config preview -- \
  pnpm preview sweep
```

Use `e2e` in place of `deploy` to test an existing preview. `reset` destroys that preview's state
before redeploying; `delete` removes it. CI publishes URLs and operation links in the PR body,
with one-click `Sign in ↗` links as the PR's test person, `pr<N>@preview.iterate.test`
([dev environments](../../docs/dev-environments.md), `src/test-link.ts`).
For an operational change, verify the preview's resulting state and telemetry as well as its checks.
The [engineering invariant](../../docs/engineering-invariants.md) defines the required standard.

## Projects and MCP

`session.projects.create()` starts a durable project-creation saga. Each project has a config
repository; commits to `/repos/config` publish the pinned `worker.ts` revision. The optional
`configs-next/with-agents` template adds userspace agents. See [project creation](docs/project-creation.md).

A context hosts Durable Object classes as facets (`itx.facets.get(name, { source, className })`, or
a processor's row). A caller reaches a facet by itx expression only through the methods its class
lists in `static publicMethods`: extend `FacetDurableObject` or `StreamProcessorDurableObject` from
`iterate/next/sdk` and add your own (`[...super.publicMethods, "send"]`); the platform's own calls
go around the list (`src/context/facet-public-methods.ts`).

Anything a caller or a facet keeps can hold a context resident and billed after its last call.
[Context residency](docs/residency.md) explains the seven mechanisms that prevent, end or record
that.

The MCP endpoint is `/mcp` on each platform deployment (production also serves
https://mcp.iterate.com). It exposes `run({ project?, script })`, where `script` is an
`async (itx) => …` function. The deployed integration test
[shows runnable examples](e2e/mcp-project-root.e2e.test.ts).

For a deployment in another Cloudflare account, follow [self-hosting](SELF-HOSTING.md).
