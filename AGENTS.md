## Repository structure

Important directories:

- `apps/os` - the dashboard for our product. In production, this is served on `os.iterate.com`. In development, it is something like `<usernmame>.iterate-dev.com`
- `apps/daemon` - the entrypoint for our "agent" which runs on Docker-based sandboxed machines (Fly.io or plain Docker (locally))
- `packages/iterate` - the iterate CLI, which is globally installed `iterate`. Note that the CLI delegates to the local source code when run inside this repo, so you can use the globally-installed binary without worrying about which version is running
- `spec` - our Playwright end to end tests. We call them "specs" rather than "e2e" because we use them to declare how our product is supposed to function.

## Dev environment

Locally, the dev server is run with `pnpm dev`. Sometimes, the user will already be running the dev server. If you need to look at its logs, but can't access them, you should kill the server that's running and run it again yourself with nohup, piping stdout to a log file you can tail. Tell the user when you do this to prevent confusion.

The dev server for the OS in general listens on port 5173, but is accessed via a cloudflare tunnel (`<username>.iterate-dev.com`). If you try to access localhost:5173, you will usually get a redirect response.

The database for development runs via docker compose. To get its port on the host machine, you can run `tsx ./scripts/docker-compose.ts port postgres 5432`.

When making changes to the daemon, or any other services that run in the sandbox, run `pnpm sandbox buildx` to build the sandbox Docker image first. This will automatically set the correct image tag in the user's doppler config. To build for fly.io, it's `pnpm sandbox build`.

Doppler is used for secrets management. Most commands don't need to worry about doppler, but if secrets or variables stored in doppler are needed, you can run `doppler run -- ./some-script.sh` and the script will automatically receive the correct environment variables. To look at a variable, you can run a command like `doppler run -- env | grep POSTHOG_PUBLIC_KEY`. You don't in general need to use the `--config` option, you can assume the user has set up their doppler config via the CLI already.

## Writing specs

Specs and end-to-end test are critical to us. They should be readable, coherent and meaningful. These are arguably more important than the product code, because they represent the decisions we've made about how the product should work. You should use specs and tests to drive your feature work - when building something complex, you can write a test roughly describing how it should work, then iterate on the product until the test passes.

We use playwright, but there are some conventions you need to follow when you're writing them.

We have a custom playwright plugin system that adds additional waiters and logic to locator-based assertions. The most important one is `spinner-waiter`. This enables us to have a very short default wait timeout, and looks for loading UI in the DOM when the timeout passes without the element appearing. What this means:

- Timeouts can stay very short. If neither the target UI nor a loading spinner appears within 1s, the test will fail fast.
- When a test fails for this reason, but it's a legitimately long operation, instead of bumping the timeout, we should update the product code to add a loading spinner. This means the test stays fast and reliable and our product actually improves.
- In general, don't use `expect` for DOM verification assertions. Use `await page.locator(...).waitFor()`. This will intelligently wait for loading UI, but `await expect(...).toBeVisible()` won't
- Loading UI gives a 30s grace period. If it's an extremely long operation, it can be extended by importing `spinnerWaiter`:
- Aim not to look for anything to be hidden/detached. Instead, make positive assertions ("element with XYZ became visible")
- If the only user-visible content to match on is ambiguous, you can add `data-*` attributes to the product code to make matchers more robust. (e.g. `data-label="machine-detail"` or `data-testid="email-input"`)

```ts
await spinnerWaiter.settings.run({ spinnerTimeout: 120_000 }, async () => {
  await page.locator(".foo-bar").waitFor(); // assertions in this scope get 120s of "spinner time" granted
});
```

Don't write if statements, ternaries, or other conditonals in tests. You should usually duplicated code over complex helper functions with conditionals.

You can use the `playwriter-spec` skill to run a spec dynamically when the feature or the spec itself are in flux and not yet validated. Doing this before running via playwright directly can result in a much faster feedback loop, and allow you to adapt the spec/the product as you step through the test.

## Writing React

Avoid useEffect and useState wherever possible. Instead, use `@tanstack/react-query` for any asynchronous work or side-effects.

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

## Meta: writing AGENTS.md

- Keep it brief, sacrifice grammar for the sake of concision.
- Stick to facts which are likely to remain true, rather than prescriptive recipes ("XYZ can be found in the database" is better than "run this exact query which might be invalid once the schema changes")

## Quick reference

Run before PRs: `pnpm install && pnpm typecheck && pnpm lint && pnpm format && pnpm test`

For local Docker machines, refresh the sandbox image + default tag with: `pnpm sandbox buildx`

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
   - **Daemon bootstrap failed** — daemon couldn't report status to control plane. Look for `[bootstrap] Fatal error` in logs
   - **OpenCode not ready** — race between daemon accepting HTTP and OpenCode server starting. Look for `Failed to create OpenCode session`
4. Key log patterns: `webchat/webhook`, `readiness-probe`, `opencode`, `bootstrap`
5. Machine lifecycle code: `apps/os/backend/outbox/consumers.ts` (setup + probe + activation), `apps/os/backend/services/machine-creation.ts`, `apps/os/backend/services/machine-setup.ts`

### Debugging machine lifecycle (dev)

- Query the local dev DB (`machine`, `outbox_event` tables) to find recent machines, check state and event history. The postgres port is docker-mapped — use `docker port` to find it. DB name is `os`.
- For fly machines, `doppler run --config dev -- fly logs -a <external_id> --no-tail` shows daemon/pidnap logs. The `external_id` column on the machine row is the fly app name.
- The `pgmq.q_consumer_job_queue` and `pgmq.a_consumer_job_queue` tables show pending/archived outbox jobs.

### Cloudflare Worker logs (control plane)

The `os` worker handles all oRPC calls from daemons. To debug 500s from the control plane:

- **Dashboard:** Machine detail page has "CF Worker Logs" link in the sidebar, filtered to the project
- **Direct URL:** `https://dash.cloudflare.com/04b3b57291ef2626c6a8daa9d47065a7/workers/services/view/os/production/observability/events`
- **Real-time tail:** `doppler run --config prd -- npx wrangler tail os --format json` (live only, not historical)
- **Telemetry API:** Requires a CF API token with `Workers Scripts:Read` + `Workers Tail:Read` permissions. The `CLOUDFLARE_API_TOKEN` in Doppler may not have POST access to the telemetry events endpoint. For historical queries, use the dashboard query builder or add the needed permissions to the token.

### Querying the production database

Get the prod DB connection string from the `db:studio:prd` script. Run from `apps/os/`:

```bash
doppler run --config prd -- npx tsx -e "
import postgres from 'postgres';
const sql = postgres(process.env.PLANETSCALE_PROD_POSTGRES_URL!, { prepare: false, ssl: 'require' });
async function main() {
  // your queries here
  await sql.end();
}
main();
"
```

Needs `ssl: 'require'` (PlanetScale). Wrap in `async function main()` — top-level await doesn't work with tsx eval.

**Column naming:** The DB uses `snake_case` columns (e.g. `external_id`, `project_id`, `created_at`), not camelCase. Use `SELECT *` first if unsure of column names.

### Looking up machine info (production)

To find the active machine for a project, its Fly app name, and Fly machine ID:

```bash
# 1. Find active machine in DB (from apps/os/)
doppler run --config prd -- npx tsx -e "
import postgres from 'postgres';
const sql = postgres(process.env.PLANETSCALE_PROD_POSTGRES_URL!, { prepare: false, ssl: 'require' });
async function main() {
  const machines = await sql\`SELECT id, name, state, external_id, created_at FROM machine WHERE project_id = '<PROJECT_ID>' ORDER BY created_at DESC LIMIT 5\`;
  console.log(JSON.stringify(machines, null, 2));
  await sql.end();
}
main();
"
# external_id = Fly app name (e.g. prd-iterate-mach-01kj3...)

# 2. Get Fly machine ID
doppler run --config prd -- fly machines list -a <external_id>

# 3. Get logs
doppler run --config prd -- fly logs -a <external_id> --no-tail

# 4. Search logs for specific patterns
doppler run --config prd -- fly logs -a <external_id> --no-tail 2>&1 | grep -i 'slack\|error\|ERR'
```

Key project IDs: Iterate = `prj_01kh7ct9jke49vjq43j4wy3vyw`, team = `T0675PSN873`.

**Fly log limitations:** `fly logs --no-tail` only returns recent logs (last ~30min). Bootstrap/startup logs may not be visible if the machine started hours ago.

### Outbox queue operations

Admin UI: `https://os.iterate.com/admin/outbox` — shows all events, filters by status/event/consumer, has "Process Queue" button.

To archive (soft-delete) stale messages directly:

```sql
SELECT pgmq.archive('consumer_job_queue', msg_id)
FROM pgmq.q_consumer_job_queue
WHERE msg_id IN (...);
```

Queue only processes when triggered via `waitUntil` after an event is enqueued — there is no cron. If messages are stuck, use the admin "Process Queue" button or call `admin.outbox.processQueue` oRPC endpoint.

### Deployment checklist — migrations

**Always run migrations after merging DB schema changes.** The outbox system (`0017_pgmq.sql`, `0018_consumer_job_queue.sql`) was merged without running migrations in prod, causing `reportStatus` to 500 on `INSERT INTO outbox_event` (table didn't exist). This crash-looped every daemon for hours.

```bash
# Run pending migrations against production
PSCALE_DATABASE_URL=$(doppler secrets --config prd get --plain PLANETSCALE_PROD_POSTGRES_URL) pnpm os db:migrate
```

### Known pitfalls

- **Readiness probe pipeline** — machine activation uses a staged event pipeline: `daemon-ready` → `probe-sent` → `probe-succeeded` → `activated`. Each stage is a separate consumer. The `reportStatus` handler emits `machine:daemon-ready` only when daemon reports ready AND `externalId` exists AND `daemonStatus !== "probing"`. If `externalId` is missing (provisioning still running), `machine-creation.ts` emits the deferred `daemon-ready` after provisioning completes. See `apps/os/backend/outbox/consumers.ts` for the full pipeline.
- **oRPC errors were silent** — prior to adding the `onError` interceptor on `RPCHandler` in `worker.ts`, unhandled errors in oRPC handlers were swallowed into generic 500s with no logging. The `cf-ray` response header can be used to correlate daemon-side errors with CF Worker dashboard logs.
- **Queue head-of-line blocking** — `processQueue` reads 2 messages at a time by VT order. A stale probe poll (120s timeout) blocks all messages behind it. Archive stale messages via pgmq to unblock.
- **Pidnap env lifecycle** — pidnap spawns child processes with env vars merged from the config `env`, the global `envFile`, and `process.env`. If a process has `reloadDelay: false`, it never restarts on env file changes, so env vars written after process start are invisible. Use `pidnap process reload <name> -d '<definition-json>' -r true` to force a restart with fresh env. Plain `pidnap process restart` re-applies env defaults too (reload under the hood). The env watcher still tracks file contents even when reload is disabled.

## Pointers

- Egress proxy & secrets: `docs/egress-proxy-secrets.md`
- Brand & tone: `docs/brand-and-tone-of-voice.md`
- Website (iterate.com): `apps/iterate-com`
- Frontend: `apps/os/app/AGENTS.md`
- Backend: `apps/os/backend/AGENTS.md`
- E2E: `spec/AGENTS.md`
- Vitest patterns: `docs/vitest-patterns.md`
- Architecture: `docs/architecture.md`
- Drizzle migration workflow: `.agents/skills/drizzle-migrations/SKILL.md` (MUST follow when making schema changes)
- Drizzle migration conflicts: `docs/fixing-drizzle-migration-conflicts.md`
- Sandbox image pipeline (build, tag, push, CI): `sandbox/README.md`
