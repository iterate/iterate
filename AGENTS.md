# Iterate

Cloudflare Workers monorepo. Main product: `apps/os`.

- Read the scoped `AGENTS.md` for the area you change and the `rules/**/*.md` whose `files` globs match, honoring exclusions. These are the canonical review rules.
- Expected outcomes must be modeled; recovery must be bounded and observable. Operational changes require preview, state and telemetry evidence, with no unexplained errors. [Full engineering invariant](docs/engineering-invariants.md).
- `envs.ts` owns deployment configuration; Doppler supplies secrets. `dev` / `dev_<you>` are fully local. Workers are never deleted.
- Browser testing uses isolated Playwriter sessions, one per task; actual personal Chrome requires explicit authorization. [Browser testing](docs/browser-testing.md).
- Do not commit, push, open or merge PRs unless asked. When opening a PR, complete required checks and address every review thread. [PR workflow](docs/pull-requests.md).

## Working here

```bash
pnpm install
pnpm dev                 # local OS, random port
pnpm auth:mint           # dev/preview test identity
```

- [Local environments and lifecycle](docs/dev-environments.md)
- [Testing and required evidence](docs/testing.md)
- [Deployments and Doppler](docs/devops-cloudflare-doppler.md)
- [OS instructions](apps/os/AGENTS.md) · [Auth instructions](apps/auth/AGENTS.md) · [Kit firmware](apps/kit/firmware/AGENTS.md)
- [Frontend](docs/frontend-development.md) · [Design system](docs/design-system.md)
- [Browser specs](specs/AGENTS.md) · [Stream processors](docs/writing-stream-processors.md)
- [Repository map and documentation](README.md)

`AGENTS.md` is canonical; `CLAUDE.md` links to it. Keep local facts here and longer explanations in linked docs. [Instruction and skill maintenance](docs/writing-agent-docs.md).
