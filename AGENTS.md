# Iterate

Cloudflare Workers monorepo. The platform is `apps/os`; production issuer: `https://os.iterate.com`.

- Read scoped `AGENTS.md` files. Follow every `rules/**/*.md` whose `files` globs match what you change, honoring exclusions: they are review rules, and no bot enforces them today.
- Expected outcomes must be modeled; recovery must be bounded and observable. Operational changes require preview, state, and telemetry evidence. [Engineering invariant](docs/engineering-invariants.md).
- `envs.ts` owns deployment configuration; Doppler supplies secrets. Workers are never deleted as part of source cleanup.
- Browser testing uses isolated Playwriter sessions. Personal Chrome requires explicit authorization. [Browser testing](docs/browser-testing.md).
- Do not commit, push, open or merge PRs unless asked. [PR workflow](docs/pull-requests.md).

```sh
pnpm install
pnpm dev                 # local OS platform
pnpm typecheck
pnpm test
pnpm spec                # product browser specs (specs/AGENTS.md)
```

Read when relevant:

- [Repository map](README.md) · [Platform](apps/os/README.md) · [Kit firmware](apps/kit/firmware/AGENTS.md)
- [Dev environments](docs/dev-environments.md): local dev, per-PR previews, and acting as users and operators
- [Testing](docs/testing.md) · [Browser specs](specs/AGENTS.md) · [Vitest patterns](docs/vitest-patterns.md)
- [Depot CI](docs/depot-ci.md): workflows, running CI without a PR, runs, logs, artifacts, and waiting on checks
- TypeScript style: [coding style](docs/coding-style.md) · [conventions](docs/typescript-conventions.md) · [code rules](docs/jonasland-rules.md) · [identifiers](docs/identifiers.md)
- [Frontend development](docs/frontend-development.md) for the client apps (dash, agents, notes, voice)
- [Brand and tone of voice](docs/brand-and-tone-of-voice.md) for user-facing copy
- [Instruction maintenance](docs/writing-agent-docs.md): instructions live in `AGENTS.md` files only
