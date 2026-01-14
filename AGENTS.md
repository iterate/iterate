Sacrifice grammar for concision. Don't waste tokens. Skip obvious context.

## Meta: writing AGENTS.md

- CLAUDE.md must be a symlink to AGENTS.md
- Prefer links to real files/examples; no pasted snippets unless v small and unlikely to change
- Keep short; table of contents + repo-wide rules

## Quick reference

Run before PRs: `pnpm install && pnpm typecheck && pnpm lint && pnpm format && pnpm test`

## Environment variables (Doppler)

We use [Doppler](https://doppler.com) for secrets management. Configs: `dev`, `stg`, `prd`.

```bash
# Run any command with env vars injected
doppler run --config dev -- <command>

# Examples
doppler run --config dev -- pnpm test
doppler run --config dev -- tsx apps/os/sandbox/daytona-snapshot.ts

# Check available vars
doppler run --config dev -- env | grep SOME_VAR
```

For tests needing credentials (Daytona, Stripe, etc.), wrap with `doppler run`.

## Critical rules

- No `console` in backend — use `apps/os/backend/tag-logger.ts`
- No `useEffect` for data fetching — use `useSuspenseQuery`
- No inline error/success messages — use toast notifications

## Frontend react guide

Mobile-first is mandatory. Design for 375px, expand to desktop.

**Layout:**

- No page titles (h1) — breadcrumbs provide context
- Page containers: `p-4 md:p-8`
- Main content max-width: `max-w-md` (phone-width, set in layouts)
- Use `HeaderActions` for action buttons in header
- Use `CenteredLayout` for standalone pages (login, settings)

**Data lists:**

- Use cards, not tables: `space-y-3` with card items
- Card: `flex items-start justify-between gap-4 p-4 border rounded-lg bg-card`
- Content: `min-w-0 flex-1` to enable truncation
- Status: `Circle` icon with fill color, not badges
- Meta: text with `·` separators, not badges

**Components:**

- Prefer `Sheet` over `Dialog` — slides in from side, mobile-friendly
- Use `toast` from sonner, not inline messages
- Use `EmptyState` for empty states
- Use `Field` components for form accessibility

Canonical example: `apps/os/app/routes/org/project/machines.tsx`

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
- Spec tests: `spec/*.spec.ts`

## Task system

- Tasks live in `tasks/` as markdown
- Frontmatter keys: state, priority, size, dependsOn
- Working: read task → check deps → clarify if needed → execute
- Recording: create file in `tasks/` → brief description → confirm with user

## Pointers

- Brand & tone: `docs/brand-and-tone-of-voice.md`
- Website (iterate.com): `apps/iterate-com`
- Frontend: `apps/os/app/AGENTS.md`
- Backend: `apps/os/backend/AGENTS.md`
- E2E: `spec/AGENTS.md`
- Vitest patterns: `docs/vitest-patterns.md`
- Architecture: `docs/architecture.md`
- Drizzle migration conflicts: `docs/fixing-drizzle-migration-conflicts.md`
