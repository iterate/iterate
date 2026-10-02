# Iterate

The Iterate context platform runs at **https://os.iterate.com**. `core/os` owns the Worker, OAuth issuer, project contexts, streams, and loaded code.

`core/` and `packages/` are public: Copybara copies them to [iterate/core](https://github.com/iterate/core) and [iterate/packages](https://github.com/iterate/packages) (`copybara/copy.bara.sky`). `apps/` holds what stays private.

| Path                         | Purpose                                                         |
| ---------------------------- | --------------------------------------------------------------- |
| `core/os`                    | Platform Worker and its issuer pages (sign-in, consent)         |
| `core/lib`                   | `iterate/*` SDK, the agents app and the `iterate` CLI           |
| `core/configs`               | The project templates every build offers                        |
| `configs`                    | iterate's templates that need packages (voice)                  |
| `packages/dash`              | Projects, organizations, sessions, and personal access tokens   |
| `packages/agents-app`        | Agent conversations and inspection                              |
| `packages/notes`             | Notes client                                                    |
| `packages/docs-app`          | Docs client: a project's markdown docs, served like Notes       |
| `packages/voice-app`         | Voice client                                                    |
| `packages/admin`             | Every project and person, and a raw context explorer            |
| `packages/spa`               | Static SPA archetype; also hosts the browser extension download |
| `packages/browser-extension` | Chrome side panel that lends a browser to a project             |
| `packages/voice`             | Voice on the agents app, installed too (`@iterate-com/voice`)   |
| `packages/github-sync`       | Config repo ↔ GitHub, one history (`@iterate-com/github-sync`)  |
| `packages/docs`              | Docs' co-editing processors (`@iterate-com/docs`)               |
| `packages/ai-linter`         | Pull requests against `rules/` (`@iterate-com/ai-linter`)       |
| `packages/petshop-sdk`       | The dummy petshop's SDK, shaped like a vendor's                 |
| `packages/ui`                | Components used by the apps                                     |
| `packages/shared`            | Shared configuration, events, and test telemetry                |
| `apps/dummy-petshop`         | Deployed OAuth/API fixture that the OS e2e tests use            |
| `apps/ci-reports`            | Opens CI traces and Playwright reports from Depot artifacts     |
| `test/playwright`            | Browser specs across the apps (`pnpm spec`)                     |
| `scripts`                    | Deployment helpers and CI support                               |
| `lint`, `rules`              | Review and lint rules                                           |

```sh
pnpm install
pnpm dev
pnpm typecheck
pnpm test
pnpm spec
```

`pnpm dev` starts the platform locally, attached to the terminal. `pnpm dev start --detach` runs it in the background instead (`pnpm dev status`, `attach`, `kill`, `restart`), on this worktree's last port, else 8788, else a free one. `pnpm getin` opens a browser signed in as `test@preview.iterate.test` on project `test`, starting the server and creating the person and project when missing: the local Dash's project page when a Dash wired to this server is up (`APP_CONFIG_URLS__OS` pointed at the platform, see [packages/dash](packages/dash/README.md)), else the platform's `/login`. `pnpm -s getin --print` prints that sign-in URL alone, for Playwright and agents. `pnpm --dir <app> <script>` runs an app's script, such as `pnpm --dir core/os test:watch`, and `pnpm --dir apps/<name> dev` runs a client; its issuer configuration must point to the platform under test. See [platform configuration and development](core/os/README.md), [self-hosting](core/os/SELF-HOSTING.md), and [testing](docs/testing.md).

`envs.ts` owns deployment names, URLs, and resource IDs. Doppler supplies secrets; `doppler.yaml` maps directories to projects. Deploy and resource commands live in each app. The Preview OS workflow runs per-PR previews through `pnpm preview`.
