# TypeScript conventions

Repo-wide rules:

- Strict TS; infer types where possible
- No `as any` — fix types or ask for help
- File/folder names: kebab-case
- Include file extensions (`.ts`, etc.) for relative imports
- Use `node:` prefix for Node imports
- Prefer named exports
- Acronyms: all caps except `Id` (e.g. `callbackURL`, `userId`)
- Use pnpm for packages
- Use dedent for template strings
- Unit tests: `*.test.ts` next to source
- App e2e tests: `apps/<app>/e2e/**`
