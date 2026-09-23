# OS

Main product dashboard and project runtime. Read [architecture and source map](README.md) for the area you change.

- The public capability surface is `/api`; its generated contract is `src/itx-api.generated.ts`. Use the existing itx client/hooks rather than adding another product API.
- Auth owns organizations, project IDs and the project directory. Other durable state belongs in Durable Object SQLite.
- Runtime identity uses `prj_…` IDs; slugs are human-readable URLs. Stream paths are project-local.
- Run app commands here. The former `pnpm cli itx` wrapper is retired; the published `iterate` CLI targets OS Next. Wrap operational commands with `doppler run --config <config> --` to target an explicit environment. [Doppler-backed scripts](docs/doppler-backed-scripts.md).

```bash
pnpm test
pnpm typecheck
pnpm e2e                # requires a live target; see test docs
```

[Testing](../../docs/testing.md) · [Frontend](../../docs/frontend-development.md) · [Stream processors](../../docs/writing-stream-processors.md) · [Debugging deployments](docs/debugging-deployed-os-workers.md)
