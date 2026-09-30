# Iterate

The Iterate context platform runs at **https://os.iterate.com**. `core/os` owns the Worker, OAuth issuer, project contexts, streams, and loaded code.

| Path                     | Purpose                                                         |
| ------------------------ | --------------------------------------------------------------- |
| `core/os`                | Platform Worker and its issuer pages (sign-in, consent)         |
| `core/configs`           | Project templates the platform bakes in                         |
| `apps/dash`              | Projects, organizations, sessions, and personal access tokens   |
| `apps/agents`            | Agent conversations and inspection                              |
| `apps/notes`             | Notes client                                                    |
| `apps/docs`              | Docs client: a project's markdown docs, served like Notes       |
| `apps/voice`             | Voice client                                                    |
| `apps/kit`               | Device installer and firmware using the platform                |
| `apps/admin`             | Every project and person, and a raw context explorer            |
| `apps/spa`               | Static SPA archetype; also hosts the browser extension download |
| `apps/browser-extension` | Chrome side panel that lends a browser to a project             |
| `apps/dummy-petshop`     | Deployed OAuth/API fixture that the OS e2e tests use            |
| `apps/ci-reports`        | Opens CI traces and Playwright reports from Depot artifacts     |
| `packages/iterate`       | `iterate/*` SDK                                                 |
| `packages/cli`           | The `iterate` CLI and the macOS menu bar (`@iterate-com/cli`)   |
| `packages/agents`        | The agents app a project installs (`@iterate-com/agents`)       |
| `packages/voice`         | Voice on the agents app, installed too (`@iterate-com/voice`)   |
| `packages/github-sync`   | Config repo ↔ GitHub, one history (`@iterate-com/github-sync`)  |
| `packages/docs`          | Docs' co-editing processors (`@iterate-com/docs`)               |
| `packages/ai-linter`     | Pull requests against `rules/` (`@iterate-com/ai-linter`)       |
| `packages/petshop-sdk`   | The dummy petshop's SDK, shaped like a vendor's                 |
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

`pnpm dev` starts the platform locally, attached to the terminal. `pnpm dev start --detach` runs it in the background instead (`pnpm dev status`, `attach`, `kill`, `restart`), on this worktree's last port, else 8788, else a free one. `pnpm getin` opens a browser signed in as `test@preview.iterate.test` on project `test`, starting the server and creating the person and project when missing: the local Dash's project page when a Dash wired to this server is up (`APP_CONFIG_URLS__OS` pointed at the platform, see [apps/dash](apps/dash/README.md)), else the platform's `/login`. `pnpm -s getin --print` prints that sign-in URL alone, for Playwright and agents. `pnpm --dir <app> <script>` runs an app's script, such as `pnpm --dir core/os test:watch`, and `pnpm --dir apps/<name> dev` runs a client; its issuer configuration must point to the platform under test. See [platform configuration and development](core/os/README.md), [self-hosting](core/os/SELF-HOSTING.md), and [testing](docs/testing.md).

`envs.ts` owns deployment names, URLs, and resource IDs. Doppler supplies secrets; `doppler.yaml` maps directories to projects. Deploy and resource commands live in each app. The Preview OS workflow runs per-PR previews through `pnpm preview`.
