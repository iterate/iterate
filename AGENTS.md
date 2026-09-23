# Iterate

Cloudflare Workers monorepo. The platform is `apps/os`; production issuer: `https://os.iterate.com`.

- Read scoped `AGENTS.md` files and matching `rules/**/*.md`, honoring exclusions.
- Expected outcomes must be modeled; recovery must be bounded and observable. Operational changes require preview, state, and telemetry evidence. [Engineering invariant](docs/engineering-invariants.md).
- `envs.ts` owns deployment configuration; Doppler supplies secrets. Workers are never deleted as part of source cleanup.
- Browser testing uses isolated Playwriter sessions. Personal Chrome requires explicit authorization. [Browser testing](docs/browser-testing.md).
- Do not commit, push, open or merge PRs unless asked. [PR workflow](docs/pull-requests.md).

```sh
pnpm install
pnpm dev                 # local OS platform
pnpm typecheck
pnpm test
pnpm spec                # platform browser specs
```

Read when relevant:

- [Repository map](README.md) · [Platform](apps/os/README.md) · [Kit firmware](apps/kit/firmware/AGENTS.md)
- [Testing](docs/testing.md) · [Vitest patterns](docs/vitest-patterns.md)
- TypeScript style: [coding style](docs/coding-style.md) · [conventions](docs/typescript-conventions.md) · [code rules](docs/jonasland-rules.md) · [identifiers](docs/identifiers.md)
- [Frontend development](docs/frontend-development.md) for the client apps (dash, agents, notes, voice)
- [Brand and tone of voice](docs/brand-and-tone-of-voice.md) for user-facing copy
- [Instruction maintenance](docs/writing-agent-docs.md): instructions live in `AGENTS.md` files only
