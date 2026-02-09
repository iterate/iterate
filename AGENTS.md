Sacrifice grammar for concision. Don't waste tokens. Skip obvious context.

## TOC

- Quick reference
- Environment variables (Doppler)
- Critical rules
- Trace debugging (Jaeger)
- Frontend react guide
- TypeScript (repo-wide)
- Task system
- Debugging machine errors
- Pointers

## Meta: writing AGENTS.md

- CLAUDE.md must be a symlink to AGENTS.md
- Prefer links to real files/examples; no pasted snippets unless v small and unlikely to change
- Keep short; table of contents + repo-wide rules

## Quick reference

Run before PRs: `pnpm install && pnpm typecheck && pnpm lint && pnpm format && pnpm test`

## Git

- PR descriptions: only add `Testing`/`Validation` when non-standard human/manual steps were done/are needed. Skip trivial stuff (e.g. `pnpm test`).

## Environment variables (Doppler)

We use [Doppler](https://doppler.com) for secrets management. Configs: `dev`, `stg`, `prd`.

```bash
# Run any command with env vars injected
doppler run --config dev -- <command>

# Examples
doppler run --config dev -- pnpm test
doppler run --config dev -- tsx apps/os/sandbox/push-docker-image-to-daytona.ts

# Check available vars
doppler run --config dev -- env | grep SOME_VAR
```

For tests needing credentials (Daytona, Stripe, etc.), wrap with `doppler run`.

## Critical rules

- No `console` in backend — use `apps/os/backend/tag-logger.ts`
- No `useEffect` for data fetching — use `useSuspenseQuery`
- No inline error/success messages — use toast notifications

## Trace debugging (Jaeger)

- Local-docker sandbox exposes Jaeger UI on daemon port `16686` (mapped host port varies)
- OTLP default in sandbox: `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:4318/v1/traces`
- Agent workflow hints:
  - first discover ports from container mapping; do not hardcode host ports
  - check `/api/observability` to confirm OTEL is enabled before debugging traces
  - fetch `services` -> `operations` -> `traces` from Jaeger API; narrow by lookback + service
  - rank spans by duration, then compare parent span vs child spans to find bottleneck stage
  - validate conclusions against process logs (`daemon-backend.log`, `opencode.log`)

## Frontend react guide

Mobile-first is mandatory. Design for 375px, expand to desktop.

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

## Debugging machine errors

When a machine shows `status=error` in the dashboard:

1. Find the container: `docker ps -a --format "table {{.Names}}\t{{.Status}}\t{{.CreatedAt}}"` — most recent is usually the one
2. Check daemon logs: `docker logs <container-name> 2>&1 | tail -100`
3. Common causes:
   - **Readiness probe failed** — the platform sends "1+2=?" via webchat and polls for "3". Check for `500` or OpenCode session errors in logs. Probe code: `apps/os/backend/services/machine-readiness-probe.ts`
   - **Daemon bootstrap failed** — daemon couldn't fetch env/config from control plane. Look for `[bootstrap] Fatal error` in logs
   - **OpenCode not ready** — race between daemon accepting HTTP and OpenCode server starting. Look for `Failed to create OpenCode session`
4. Key log patterns: `webchat/webhook`, `readiness-probe`, `opencode`, `bootstrap`
5. Machine lifecycle code: `apps/os/backend/outbox/consumers.ts` (probe + activation), `apps/os/backend/services/machine-creation.ts`

## Pointers

- Egress proxy & secrets: `docs/egress-proxy-secrets.md`
- Brand & tone: `docs/brand-and-tone-of-voice.md`
- Website (iterate.com): `apps/iterate-com`
- Frontend: `apps/os/app/AGENTS.md`
- Backend: `apps/os/backend/AGENTS.md`
- E2E: `spec/AGENTS.md`
- Vitest patterns: `docs/vitest-patterns.md`
- Architecture: `docs/architecture.md`
- Drizzle migration conflicts: `docs/fixing-drizzle-migration-conflicts.md`
