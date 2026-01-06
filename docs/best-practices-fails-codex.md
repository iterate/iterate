# OS2 best-practice audit (Codex)

Date: January 6, 2026

## Scope
Reviewed the major technologies used in `apps/os2` and compared current usage against the latest official guidance:

- TanStack Start / TanStack Router
- TanStack Query (React Query)
- tRPC (client + server)
- Hono (CORS middleware + Vite integration)
- Drizzle ORM
- Better Auth (email OTP)

## Sources (official docs)
- TanStack Router external data loading: https://tanstack.com/router/latest/docs/framework/react/guide/external-data-loading
- TanStack Router + TanStack Query integration (SSR): https://tanstack.com/router/latest/docs/framework/react/guide/external-data-loading#tanstack-query-integration
- TanStack Query SSR guide: https://tanstack.com/query/latest/docs/framework/react/guides/ssr
- Hono CORS middleware: https://hono.dev/docs/middleware/builtin/cors
- Drizzle ORM transactions: https://orm.drizzle.team/docs/transactions
- Better Auth email OTP plugin: https://www.better-auth.com/docs/plugins/email-otp

## Best-practice mismatches found

### 1) SSR QueryClient is created at module scope (shared across requests)
**Best practice:** TanStack Query SSR docs explicitly warn against creating a QueryClient at module scope in SSR; create a fresh QueryClient per request (or per request lifecycle) to avoid shared cache/state across users.

**Where:** `apps/os2/app/routes/root.tsx:8` creates a module-level QueryClient.

**Why it matters:** In SSR, a shared QueryClient can leak cached data between users and requests, and can lead to hydration mismatches or incorrect cache state.

**Suggested fix:** Create the QueryClient per request (or per render) and wire it through TanStack Router SSR integration (`setupRouterSsrQueryIntegration`) so the query cache is request-scoped.

---

### 2) TanStack Router data loading best practices not applied (no loaders + no SSR Query integration)
**Best practice:** TanStack Router recommends using route `loader`/`beforeLoad` for external data loading to avoid waterfalls, enable preloading, and ensure SSR-ready data. It also provides a dedicated TanStack Query SSR integration to handle server/client dehydration.

**Where:**
- Routes use `useQuery(...)` inside components without any `loader`/`beforeLoad` (examples: `apps/os2/app/routes/user/settings.tsx`, `apps/os2/app/routes/org/team.tsx`, `apps/os2/app/routes/org/project/index.tsx`).
- `@tanstack/react-router-ssr-query` is a dependency but not used anywhere in `apps/os2`.

**Why it matters:** Without loaders and the SSR Query integration, data loading is more likely to happen on the client only, leading to waterfalls and losing the benefits of SSR/preloading.

**Suggested fix:** Move data fetching to route loaders and use the SSR Query integration to prefetch and dehydrate query data.

---

### 3) Hono CORS + Vite integration: Vite CORS not disabled
**Best practice:** Hono docs note that Vite's built-in CORS should be disabled when using Hono's CORS middleware to avoid conflicts.

**Where:** `apps/os2/vite.config.ts` does not set `server.cors: false`, but `apps/os2/backend/worker.ts` uses Hono's `cors(...)` middleware.

**Why it matters:** Conflicting CORS handling can result in unexpected headers or request failures.

**Suggested fix:** Set `server: { cors: false }` in `apps/os2/vite.config.ts` when relying on Hono CORS.

---

### 4) Hono CORS allowMethods uses "*" (non-standard)
**Best practice:** Hono docs show `allowMethods` as a list of explicit HTTP methods; `Access-Control-Allow-Methods` does not accept `*` in standard CORS.

**Where:** `apps/os2/backend/worker.ts:37` sets `allowMethods: ["*"]`.

**Why it matters:** Browsers may ignore or reject the CORS response when `Access-Control-Allow-Methods` is `*`.

**Suggested fix:** Replace with an explicit list (e.g. `["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]`) or omit to use Hono defaults.

---

### 5) Multi-step DB writes not wrapped in transactions
**Best practice:** Drizzle recommends using transactions when multiple statements must succeed or fail together.

**Where:**
- `apps/os2/backend/trpc/routers/organization.ts:22-52` performs three dependent inserts (organization, membership, default instance) without a transaction.
- `apps/os2/backend/trpc/routers/instance.ts:73-86` checks count then deletes outside a transaction (race window can violate "last instance" constraint).

**Why it matters:** Partial writes can leave inconsistent state if any step fails or if concurrent requests race.

**Suggested fix:** Wrap related statements in `db.transaction(...)` and, where needed, enforce constraints in a single transactional query.

---

### 6) Better Auth email OTP sending does not follow serverless guidance
**Best practice:** Better Auth docs recommend not awaiting email sending and using `waitUntil` on serverless platforms for OTP delivery.

**Where:** `apps/os2/backend/auth/auth.ts:37-43` logs and returns without using `waitUntil` (and the real email send is still TODO).

**Why it matters:** When real email sending is added, awaiting the send can add latency or cause request timeouts; not using `waitUntil` also conflicts with recommended serverless patterns.

**Suggested fix:** When implementing email delivery, dispatch via `waitUntil` (from `apps/os2/env.ts`) and avoid awaiting the send.
