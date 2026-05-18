## Repository structure

Important directories:

- `apps/os` - the dashboard for our product. In production, this is served on `os.iterate.com`. In development it is something like `<username>.iterate-dev.com`
- `packages/iterate` - the iterate CLI, which is globally installed `iterate`. Note that the CLI delegates to the local source code when run inside this repo, so you can use the globally-installed binary without worrying about which version is running

## Dev environment

Locally, the dev server is run with `pnpm dev` (starts `apps/auth` and `apps/os`). Sometimes, the user will already be running the dev server. If you need to look at its logs, but can't access them, you should kill the server that's running and run it again yourself with nohup, piping stdout to a log file you can tail. Tell the user when you do this to prevent confusion.

Doppler is used for secrets management. Most commands don't need to worry about doppler, but if secrets or variables stored in doppler are needed, you can run `doppler run -- ./some-script.sh` and the script will automatically receive the correct environment variables. To look at a variable, you can run a command like `doppler run -- env | grep POSTHOG_PUBLIC_KEY`. You don't in general need to use the `--config` option, you can assume the user has set up their doppler config via the CLI already.

## E2E tests

App-level e2e tests live next to each app, for example `apps/os/e2e/`. Run them with that app's `test:e2e*` scripts after setting the required base URL env vars.

## Coding style

When you're writing helpers/utilities/library functions, you have to try to LIMIT complexity and optionality. If you have a function that is only called once then DON'T give it any optional properties. Make the ones that are actually used required, and drop all the others. That makes call sites more explicit. If there are multiple parameters of the same type, use "options-bags" rather than long lists of positional parameters which can be accidentally flipped.

Similarly, avoid "fallback" values which just encourage the proliferation of uncertain system behavior. Instead of accomodating for bizarre system states and adding code complexity to account for it, make the bizarre state impossible to reach in the first place.

Durable Objects should normally live behind tiny dedicated workers and be invoked from app workers through namespace bindings. This keeps app worker startup smaller and makes the Durable Object deployment boundary explicit. Prefer the mixins in `packages/shared/src/durable-object-utils` for new Durable Objects unless there is a clear reason not to.

## Writing React

Avoid useEffect and useState wherever possible. Instead, use `@tanstack/react-query` for any asynchronous work or side-effects. Only use `useSuspenseQuery` sparingly - if you are sure that the _whole component_ is meaningless without the data. If you can use `useQuery` instead, with an isPending/null-check, that's usually better.

Design for columnar 375px for mobile support, implement desktop as a view which happens to fit sidebar(s) + main content at the same time. This way we don't have to design multiple variants.

**Layout:**

- No page titles (h1) — breadcrumbs provide context
- Page containers: `p-4`
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

## Meta: writing AGENTS.md

- Keep it brief, sacrifice grammar for the sake of concision.
- Stick to facts which are likely to remain true, rather than prescriptive recipes ("XYZ can be found in the database" is better than "run this exact query" which might be invalid once the schema changes)

## Quick reference

Run before PRs: `pnpm install && pnpm typecheck && pnpm lint && pnpm format && pnpm test`

## TypeScript (repo-wide)

- Strict TS; infer types where possible
- No `as any` — fix types or ask for help
- File/folder names: kebab-case
- Include file extensions (`.ts` or whatever) for relative imports
- Use `node:` prefix for Node imports
- Prefer named exports
- Acronyms: all caps except `Id` (e.g., `callbackURL`, `userId`)
- Use pnpm for packages
- Use dedent for template strings
- Unit tests: `*.test.ts` next to source
- App e2e tests: `apps/<app>/e2e/**`

## Task system

- Tasks live in `tasks/` as markdown
- Frontmatter keys: state, priority, size, dependsOn
- Working: read task → check deps → clarify if needed → execute
- Recording: create file in `tasks/` → brief description → confirm with user

## Pointers

- Brand & tone: `docs/brand-and-tone-of-voice.md`
- Cloudflare preview + deploy cheat sheet: `docs/cloudflare-preview-and-deploy-cheatsheet.md`
- Website (iterate.com): `apps/iterate-com`
- OS app: `apps/os/AGENTS.md`
- Vitest patterns: `docs/vitest-patterns.md`
- Architecture: `docs/architecture.md`
- OS environments: `docs/os-environments.md`
- Drizzle migration workflow: `.agents/skills/drizzle-migrations/SKILL.md` (MUST follow when making schema changes)
- Drizzle migration conflicts: `docs/fixing-drizzle-migration-conflicts.md`
