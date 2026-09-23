# Iterate

The Iterate context platform runs at **https://os.iterate.com**. `apps/os` owns the Worker, OAuth issuer, project contexts, streams, and loaded code.

| Path               | Purpose                                                       |
| ------------------ | ------------------------------------------------------------- |
| `apps/os`          | Platform, issuer pages, integration tests, preview tooling    |
| `apps/dash`        | Projects, organizations, sessions, and personal access tokens |
| `apps/agents`      | Agent conversations and inspection                            |
| `apps/notes`       | Notes client                                                  |
| `apps/voice`       | Voice client                                                  |
| `apps/kit`         | Device installer and firmware using the platform              |
| `packages/iterate` | `iterate/next/*` SDK                                          |
| `packages/ui`      | Components used by the apps                                   |
| `packages/shared`  | Shared configuration, events, and test telemetry              |
| `scripts`          | Deployment helpers and CI support                             |
| `lint`, `rules`    | Review and lint rules                                         |

```sh
pnpm install
pnpm dev
pnpm typecheck
pnpm test
pnpm spec
```

`pnpm dev` starts the platform locally. Run a client with `pnpm --dir apps/<name> dev`; its issuer configuration must point to the platform under test. See [platform configuration and development](apps/os/README.md), [self-hosting](apps/os/SELF-HOSTING.md), and [testing](docs/testing.md).

`envs.ts` owns deployment names, URLs, and resource IDs. Doppler supplies secrets; `doppler.yaml` maps directories to projects. Deploy and resource commands live in each app. The Preview OS workflow runs per-PR previews through `pnpm preview`.
