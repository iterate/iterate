# OS2 improvement plan (Codex)

Goal: keep `apps/os2` minimal and spec‑aligned while adopting modern TanStack/React patterns and removing unnecessary complexity.

## Decisions & reasoning (consolidated from the four research docs)

### Adopt now
1. **Suspense‑first data fetching**
   - Reason: repo rules require `useSuspenseQuery`; simplifies UI and removes manual loading spinners.
   - Action: convert remaining `useQuery` usages in routes/layouts; add Suspense boundaries and ErrorBoundary at the root.

2. **Router + QueryClient SSR hygiene**
   - Reason: module‑scope QueryClient is unsafe for SSR; Router context enables future loaders and SSR integration.
   - Action: create per‑request QueryClient factory, pass into router context, and enable `setupRouterSsrQueryIntegration`.

3. **Auth guard via `beforeLoad` + redirects**
   - Reason: avoid rendering protected routes before redirect; aligns TanStack Router best practice.
   - Action: move auth checks to `beforeLoad` and replace `<Navigate>` with `throw redirect()` where possible.

4. **tRPC client hardening**
   - Reason: large GETs can exceed URL limits.
   - Action: add `maxURLLength` to `httpBatchLink` and ensure a single QueryClient is used by TRPC options.

5. **CORS correctness**
   - Reason: Hono CORS should not use `*` for methods; Vite CORS should be disabled when Hono handles it.
   - Action: update allowMethods to explicit list; set `server.cors = false` in `apps/os2/vite.config.ts`.

6. **Org creation cleanup**
   - Reason: default “instance” creation conflicts with the spec and user request.
   - Action: remove default instance creation; wrap org + membership inserts in a transaction.

7. **Remove unused/bloated auth integrations**
   - Reason: Slack bot OAuth + service auth are not in spec; simplify and reduce attack surface.
   - Action: remove `service-auth.ts`, integrations plugin, and Slack/Google connection endpoints (login remains via Better‑Auth Google OAuth).

8. **Minimal Slack webhook handler**
   - Reason: spec says skip signature verification and only store events.
   - Action: delete interactive/commands endpoints and signature verification; keep a single `/edge/slack` webhook that stores events and allows unknown team IDs.

9. **Add minimal project‑connection data model**
   - Reason: spec requires a single table for project‑ and user‑scoped connections; used by Slack webhook lookup.
   - Action: add `project_connection`, `project_env_var`, `project_access_token` tables. These reference the existing `instance` table for now (internal naming only).

10. **Test coverage (minimal)**
    - Reason: maintain confidence without bloat.
    - Action: update e2e flows to match new routes + auto‑submit OTP; add one navigation test and keep machine sync test.

### Defer (documented as follow‑ups)
1. **Full rename of `instance` → `project` in schema + API**
   - Reason: requires DB migrations and widespread rename; likely a dedicated migration task. UI already uses “project”.
   - Follow‑up: do a migration pass to rename tables/columns/routers once DB migration plan is approved.

2. **Repo table + Event table restructure**
   - Reason: schema migration needed; not required for current UI skeleton.
   - Follow‑up: update schema to spec once DB migration plan is in place.

3. **Rate limiting + real email delivery**
   - Reason: needs infra decisions (provider, KV/DO strategy).
   - Follow‑up: implement once infra choices are made.

4. **Remove WebSocket DO**
   - Reason: user explicitly requested live invalidation; keep minimal DO for now.
   - Follow‑up: revisit if real‑time invalidation is no longer required.

---

## Execution plan

1. **Router + QueryClient upgrades**
   - Add QueryClient factory and Router context.
   - Add Suspense + ErrorBoundary at root.
   - Convert route queries to `useSuspenseQuery` and simplify loading states.

2. **Auth + redirect flow**
   - Move auth guard to `beforeLoad`.
   - Replace `<Navigate>` with redirects in index/org redirect flows.

3. **Backend cleanup**
   - Remove default instance creation and add org creation transaction.
   - Remove service auth + integrations plugin.
   - Simplify Slack integration to a single webhook (no signature verification; no interactive/commands).
   - Fix CORS config + Zod imports.

4. **Schema additions**
   - Add `project_connection`, `project_env_var`, `project_access_token` tables and relations (backed by `instance` for now).
   - Update Slack webhook lookup to use `project_connection` and allow unknown project IDs.

5. **Tests**
   - Update existing e2e tests to match OTP auto‑submit and new routes.
   - Add one lightweight navigation e2e to cover org/project creation + core pages.

---

## Success criteria
- OS2 uses Suspense‑first fetching with minimal loading boilerplate.
- Auth redirects happen before render.
- CORS and tRPC client configuration match best practice.
- Default “instance” creation removed; orgs route to project creation.
- Slack webhook is minimal and spec‑aligned.
- E2E tests pass with the dev server running.
