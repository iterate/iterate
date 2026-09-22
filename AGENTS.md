# Iterate

Cloudflare Workers monorepo. The platform is `apps/os-next`; production issuer: `https://os.iterate2.com`.

- Read scoped `AGENTS.md` files and matching `rules/**/*.md`, honoring exclusions.
- Expected outcomes must be modeled; recovery must be bounded and observable. Operational changes require preview, state, and telemetry evidence. [Engineering invariant](docs/engineering-invariants.md).
- `envs.ts` owns deployment configuration; Doppler supplies secrets. Workers are never deleted as part of source cleanup.
- Browser testing uses isolated Playwriter sessions. Personal Chrome requires explicit authorization. [Browser testing](docs/browser-testing.md).
- Do not commit, push, open or merge PRs unless asked. [PR workflow](docs/pull-requests.md).

```sh
pnpm install
pnpm dev                 # local os-next platform
pnpm typecheck
pnpm test
pnpm spec                # platform browser specs
```

[Repository map](README.md) · [Platform](apps/os-next/README.md) · [Testing](docs/testing.md) · [Kit firmware](apps/kit/firmware/AGENTS.md)

`AGENTS.md` is canonical; `CLAUDE.md` links to it. [Instruction maintenance](docs/writing-agent-docs.md).
