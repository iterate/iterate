Sacrifice grammar for concision. Don't waste tokens. Skip obvious context.

## Meta: writing AGENTS.md

- CLAUDE.md must be a symlink to AGENTS.md
- Prefer links to real files/examples; no pasted snippets unless v small and unlikely to change
- Keep short; table of contents + repo-wide rules

## Quick reference

Run before PRs: `pnpm install && pnpm typecheck && pnpm lint && pnpm format && pnpm test`

## Critical rules

- No `console` in backend — use `apps/os2/backend/tag-logger.ts`
- No `useEffect` for data fetching — use `useSuspenseQuery`
- No inline error/success messages — use toast notifications

## TypeScript (repo-wide)

- Strict TS; infer types where possible
- No `as any` — fix types or ask for help
- No `import { z } from "zod"` — use `"zod/v4"`
- File/folder names: kebab-case
- Include `.ts`/`.js` in relative imports (not package imports)
- Use `node:` prefix for Node imports
- Prefer named exports
- Acronyms: all caps except `Id` (e.g., `callbackURL`, `userId`)
- Use pnpm
- Use remeda for utilities, dedent for template strings
- Unit tests: `*.test.ts` next to source
- E2E tests: `e2e/*.e2e.ts`

## Task system

- Tasks live in `tasks/` as markdown
- Frontmatter keys: state, priority, size, dependsOn
- Working: read task → check deps → clarify if needed → execute
- Recording: create file in `tasks/` → brief description → confirm with user

## Pointers

- Brand & tone: `docs/brand-and-tone-of-voice.md`
- Website (iterate.com): `apps/iterate-com`
- Frontend: `apps/os2/app/AGENTS.md`
- Backend: `apps/os2/backend/AGENTS.md`
- E2E: `e2e/AGENTS.md`
- Design system: `docs/design-system.md`
- Vitest patterns: `docs/vitest-patterns.md`
