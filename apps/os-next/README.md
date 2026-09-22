# OS Next

`apps/os-next` is the Iterate platform at https://os.iterate2.com. One Cloudflare Worker provides
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
pnpm --dir apps/os-next build
pnpm --dir apps/os-next typecheck
pnpm --dir apps/os-next test
pnpm --dir apps/os-next e2e
pnpm --dir apps/os-next spec
```

The build generates `wrangler.jsonc`, the self-host configuration, and generated source used by
the Worker. `WORKER_BASE_URL` selects a deployed target for integration tests; browser tests use
`DEMO_BASE_URL`. See [testing](../../docs/testing.md) for the suite boundary and required evidence.

## Configuration and deployment

`envs.ts` owns managed deployment names, URLs, and resource IDs. Doppler supplies secrets. Build
before deploying so the generated Wrangler configuration matches the selected environment:

```sh
pnpm --dir apps/os-next build
pnpm --dir apps/os-next deploy -- --env <environment>
```

The Preview OS-Next workflow deploys a platform preview and all four hosted clients (Dash,
Agents, Notes, Voice), then runs integration and browser checks. To run it from a checkout:

```sh
doppler run --project project-worker --config preview -- \
  pnpm preview deploy --pr <number> --name <branch> --apps all
```

Use `e2e` in place of `deploy` to test an existing preview. `reset` destroys that preview's state
before redeploying; `delete` removes it. CI publishes URLs and operation links in the PR body.
For an operational change, verify the preview's resulting state and telemetry as well as its checks.
The [engineering invariant](../../docs/engineering-invariants.md) defines the required standard.

## Projects and MCP

`session.projects.create()` starts a durable project-creation saga. Each project has a config
repository; commits to `/repos/config` publish the pinned `worker.ts` revision. The optional
`configs-next/with-agents` template adds userspace agents. See [project creation](docs/project-creation.md).

The MCP endpoint is `/mcp` on each platform deployment (production also serves
https://mcp.iterate2.com). It exposes `run({ project?, script })`, where `script` is an
`async (itx) => …` function. The deployed integration test
[shows runnable examples](e2e/mcp-project-root.e2e.test.ts).

For a deployment in another Cloudflare account, follow [self-hosting](SELF-HOSTING.md).
