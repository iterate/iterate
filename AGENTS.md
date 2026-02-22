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

## Working with GitHub

- Commit/push frequently (small, scoped commits)
- Prefer pushing before long local validation so GitHub checks + review agents start early
- After push, keep validating locally and follow up with more commits
- Avoid large unpushed change sets
- PR descriptions: only add `Testing`/`Validation` when non-standard human/manual steps were done/are needed. Skip trivial stuff (e.g. `pnpm test`).

## Environment variables (Doppler)

We use [Doppler](https://doppler.com) for secrets management. Configs: `dev`, `stg`, `prd`.

```bash
# Run any command with env vars injected
doppler run --config dev -- <command>

# Examples
doppler run --config dev -- pnpm test
doppler run --config dev -- pnpm sandbox daytona:push

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
   - **Daemon bootstrap failed** — daemon couldn't report status to control plane. Look for `[bootstrap] Fatal error` in logs
   - **OpenCode not ready** — race between daemon accepting HTTP and OpenCode server starting. Look for `Failed to create OpenCode session`
4. Key log patterns: `webchat/webhook`, `readiness-probe`, `opencode`, `bootstrap`
5. Machine lifecycle code: `apps/os/backend/outbox/consumers.ts` (setup + probe + activation), `apps/os/backend/services/machine-creation.ts`, `apps/os/backend/services/machine-setup.ts`

### Debugging machine lifecycle (dev)

- Query the local dev DB (`machine`, `outbox_event` tables) to find recent machines, check state and event history. The postgres port is docker-mapped — use `docker port` to find it. DB name is `os`.
- For fly machines, `doppler run --config dev -- fly logs -a <external_id> --no-tail` shows daemon/pidnap logs. The `external_id` column on the machine row is the fly app name.
- The `pgmq.q_consumer_job_queue` and `pgmq.a_consumer_job_queue` tables show pending/archived outbox jobs.

### Getting logs from Daytona machines (production)

No `docker logs` for Daytona. Use the Daytona SDK to exec commands in the sandbox:

```bash
# Get daemon logs from a Daytona sandbox (run from apps/os/)
doppler run --config prd -- node -e "
const { Daytona } = require('@daytonaio/sdk');
(async () => {
  const d = new Daytona({ apiKey: process.env.DAYTONA_API_KEY, organizationId: process.env.DAYTONA_ORG_ID });
  const sb = await d.get('<sandbox-name>');  // e.g. 'prd--nustom--ci-c87d181'
  const r = await sb.process.executeCommand('tail -200 /var/log/pidnap/process/daemon-backend.log');
  console.log(r.result);
})();
"
# Other useful log files: opencode.log, env-manager.log (all under /var/log/pidnap/process/)
```

Sandbox name is visible on the machine detail page in the dashboard, or via the Daytona dashboard at app.daytona.io.

### Cloudflare Worker logs (control plane)

The `os` worker handles all oRPC calls from daemons. To debug 500s from the control plane:

- **Dashboard:** Machine detail page has "CF Worker Logs" link in the sidebar, filtered to the project
- **Direct URL:** `https://dash.cloudflare.com/04b3b57291ef2626c6a8daa9d47065a7/workers/services/view/os/production/observability/events`
- **Real-time tail:** `doppler run --config prd -- npx wrangler tail os --format json` (live only, not historical)
- **Telemetry API:** Requires a CF API token with `Workers Scripts:Read` + `Workers Tail:Read` permissions. The `CLOUDFLARE_API_TOKEN` in Doppler may not have POST access to the telemetry events endpoint. For historical queries, use the dashboard query builder or add the needed permissions to the token.

### Querying the production database

Get the prod DB connection string from the `db:studio:prd` script:

```bash
DB_URL=$(doppler secrets --config prd get --plain PLANETSCALE_PROD_POSTGRES_URL)
npx tsx -e "
import postgres from 'postgres';
const sql = postgres('$DB_URL', { prepare: false, ssl: 'require' });
async function main() {
  // your queries here
  await sql.end();
}
main();
"
```

Needs `ssl: 'require'` (PlanetScale). Wrap in `async function main()` — top-level await doesn't work with tsx eval.

### Outbox queue operations

Admin UI: `https://os.iterate.com/admin/outbox` — shows all events, filters by status/event/consumer, has "Process Queue" button.

To archive (soft-delete) stale messages directly:

```sql
SELECT pgmq.archive('consumer_job_queue', msg_id)
FROM pgmq.q_consumer_job_queue
WHERE msg_id IN (...);
```

Queue only processes when triggered via `waitUntil` after an event is enqueued — there is no cron. If messages are stuck, use the admin "Process Queue" button or call `admin.outbox.processQueue` tRPC endpoint.

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
- Sandbox image pipeline (build, tag, push, CI): `sandbox/README.md`
