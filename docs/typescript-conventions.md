# TypeScript conventions

Repo-wide rules:

- Strict TS; infer types where possible
- No `as any` — fix types or ask for help
- File/folder names: kebab-case
- Include file extensions (`.ts`, etc.) for relative imports
- Use `node:` prefix for Node imports
- Prefer named exports
- Identifier naming (no all-caps acronyms, greppable names): [identifiers](identifiers.md)
- Event types: the full `events.iterate.com/…` literal where used, never a constant: [coding style](coding-style.md#event-types)
- Use pnpm for packages
- Use dedent for template strings
- Unit tests: `*.test.ts` next to source
- App e2e tests: `apps/<app>/e2e/**`

## Scripts are trpc-cli programs

A script (`scripts/**`, `apps/*/scripts/**`) exports plain functions whose last parameter is an options object; [trpc-cli](https://github.com/mmkal/trpc-cli)'s module mode turns each export into a command (camelCase → `--kebab-case` flags, leading string parameters → positionals, JSDoc → help text; `export default` is the command run without a name). The file ends with `if (isMainModule(import.meta.url)) void createCli({ ...import.meta, name: "<name>" }).run();` (`isMainModule` from `@iterate-com/shared/dev/is-main-module`), never hand-parses `process.argv` or `node:util` `parseArgs`, and throws to fail: `run()` exits 0 after a command returns, so a `process.exitCode` set inside it is lost. Examples: `scripts/ci/prd-post-deploy-check.ts`, `apps/dummy-petshop/scripts/deploy.ts`.

Exceptions run with plain `node` before `pnpm install` or in a sparse checkout, so they cannot import trpc-cli: `scripts/ci/merges-with-main.ts`, `scripts/ci/preview-paths.ts`, `scripts/ci/preview-tested-commit.ts`, `scripts/depot-ci/dependencies.mjs`, `apps/kit/scripts/firmware-release.ts` (the ESP-IDF image). `apps/os/scripts/dev.ts` also stays hand-parsed: it forwards unknown args to vite and outlives its command, and `run()` would exit it.
