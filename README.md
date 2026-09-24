# Iterate

The Iterate context platform runs at **https://os.iterate.com**. `apps/os` owns the Worker, OAuth issuer, project contexts, streams, and loaded code.

| Path                     | Purpose                                                         |
| ------------------------ | --------------------------------------------------------------- |
| `apps/os`                | Platform, issuer pages, integration tests, preview tooling      |
| `apps/dash`              | Projects, organizations, sessions, and personal access tokens   |
| `apps/agents`            | Agent conversations and inspection                              |
| `apps/notes`             | Notes client                                                    |
| `apps/voice`             | Voice client                                                    |
| `apps/kit`               | Device installer and firmware using the platform                |
| `apps/spa`               | Static SPA archetype; also hosts the browser extension download |
| `apps/browser-extension` | Chrome side panel that lends a browser to a project             |
| `apps/dummy-petshop`     | Deployed OAuth/API fixture that the OS e2e tests use            |
| `apps/ci-reports`        | Opens CI traces and Playwright reports from Depot artifacts     |
| `packages/iterate`       | `iterate/*` SDK                                                 |
| `packages/cli`           | The `iterate` CLI and the macOS menu bar (`@iterate-com/cli`)   |
| `packages/ui`            | Components used by the apps                                     |
| `packages/shared`        | Shared configuration, events, and test telemetry                |
| `configs`                | Config repository templates copied into new projects            |
| `specs`                  | Browser specs across the apps (`pnpm spec`)                     |
| `scripts`                | Deployment helpers and CI support                               |
| `lint`, `rules`          | Review and lint rules                                           |

```sh
pnpm install
pnpm dev
pnpm typecheck
pnpm test
pnpm spec
```

`pnpm dev` starts the platform locally, attached to the terminal. `pnpm dev start --detach` runs it in the background instead (`pnpm dev status`, `attach`, `kill`, `restart`), on this worktree's last port, else 8788, else a free one. `pnpm getin` opens a browser signed in to it as `test@preview.iterate.test` in project `test`, starting the server and creating the project when missing; `pnpm -s getin --print` prints the link for Playwright and agents. With a local Dash up (`ITERATE_ORIGIN` pointed at the platform, see [apps/dash](apps/dash/README.md)), it lands in the Dash's project page. `pnpm os <script>` runs an `apps/os` script, such as `pnpm os test:watch`. Run a client with `pnpm --dir apps/<name> dev`; its issuer configuration must point to the platform under test. See [platform configuration and development](apps/os/README.md), [self-hosting](apps/os/SELF-HOSTING.md), and [testing](docs/testing.md).

`envs.ts` owns deployment names, URLs, and resource IDs. Doppler supplies secrets; `doppler.yaml` maps directories to projects. Deploy and resource commands live in each app. The Preview OS workflow runs per-PR previews through `pnpm preview`.
