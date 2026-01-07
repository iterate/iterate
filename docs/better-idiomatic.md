# Better Idiomatic Setup Guide for `apps/os2`

This report compares the current `apps/os2` setup against the latest idiomatic patterns recommended by Better Auth, TanStack Start, oRPC, and Cloudflare Workers documentation.

**Documentation Sources:**

- [Better Auth + TanStack Start Integration](https://www.better-auth.com/docs/integrations/tanstack)
- [oRPC + Better Auth Integration](https://orpc.dev/docs/integrations/better-auth)
- [TanStack Start + Cloudflare Workers](https://developers.cloudflare.com/workers/framework-guides/web-apps/tanstack-start/)
- [TanStack Start Cloudflare Example](https://github.com/tanstack/router/tree/main/examples/react/start-basic-cloudflare)

---

## Executive Summary

The current `apps/os2` setup works but diverges significantly from the idiomatic patterns. Key issues:

| Area                  | Current                      | Recommended                                      | Priority  |
| --------------------- | ---------------------------- | ------------------------------------------------ | --------- |
| Server Architecture   | Hono wrapping TanStack Start | Native TanStack Start with file-based API routes | 🔴 High   |
| Auth Handler Mount    | Hono route (`/api/auth/*`)   | TanStack Start file route (`/api/auth/$.ts`)     | 🟡 Medium |
| Auth Protection       | React Query + `beforeLoad`   | TanStack Start middleware                        | 🟡 Medium |
| oRPC Context          | Hono context passthrough     | Direct headers from Request                      | 🟢 Low    |
| Cloudflare Deployment | Alchemy                      | Standard `@cloudflare/vite-plugin`               | 🟢 Low    |

---

## 1. Better Auth + TanStack Start Integration

### Current Setup ❌

The auth handler is mounted via Hono in `backend/worker.ts`:

```typescript
// Current: backend/worker.ts
app.all("/api/auth/*", (c) => c.var.auth.handler(c.req.raw));
```

Auth protection is done client-side using React Query in route `beforeLoad`:

```typescript
// Current: app/routes/auth-required.layout.tsx
beforeLoad: async ({ context }) => {
  const session = await context.queryClient.ensureQueryData(sessionQueryOptions());
  if (!session?.user) {
    throw redirect({ to: "/login" });
  }
  return { session };
};
```

### Recommended Setup ✅

**Step 1: Create a TanStack Start file-based API route for auth**

Create `app/routes/api/auth/$.ts`:

```typescript
import { createFileRoute } from "@tanstack/react-router";
import { getAuth } from "../../../../backend/auth/auth.ts";
import { getDb } from "../../../../backend/db/client.ts";

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: ({ request }) => {
        const db = getDb();
        const auth = getAuth(db);
        return auth.handler(request);
      },
      POST: ({ request }) => {
        const db = getDb();
        const auth = getAuth(db);
        return auth.handler(request);
      },
    },
  },
});
```

**Step 2: Create TanStack Start middleware for protected routes**

Create `app/lib/auth-middleware.ts`:

```typescript
import { redirect } from "@tanstack/react-router";
import { createMiddleware } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { getAuth } from "../../backend/auth/auth.ts";
import { getDb } from "../../backend/db/client.ts";

export const authMiddleware = createMiddleware().server(async ({ next }) => {
  const headers = getRequestHeaders();
  const db = getDb();
  const auth = getAuth(db);
  const session = await auth.api.getSession({ headers });

  if (!session) {
    throw redirect({ to: "/login" });
  }

  return await next({
    context: {
      session,
      user: session.user,
    },
  });
});
```

**Step 3: Apply middleware to protected routes**

Update `app/routes/auth-required.layout.tsx`:

```typescript
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { authMiddleware } from "../lib/auth-middleware.ts";

export const Route = createFileRoute("/_auth-required.layout")({
  component: AuthRequiredLayout,
  server: {
    middleware: [authMiddleware],
  },
});

function AuthRequiredLayout() {
  return <Outlet />;
}
```

### Better Auth Config ✅ (Already Correct)

The current Better Auth setup correctly uses `tanstackStartCookies()`:

```typescript
// backend/auth/auth.ts - KEEP THIS
plugins: [
  admin(),
  emailOTP({ ... }),
  tanstackStartCookies(), // ✅ Correct - must be last
]
```

---

## 2. oRPC + Better Auth Integration

### Current Setup ❌

Context is created from Hono context:

```typescript
// Current: backend/orpc/context.ts
export function createContext(
  c: HonoContext<{ Bindings: CloudflareEnv; Variables: Variables }>,
): Context {
  return {
    env: c.env,
    db: c.var.db,
    session: c.var.session,
    user: c.var.session?.user ?? null,
  };
}
```

Auth middleware validates session from pre-populated Hono context:

```typescript
// Current: backend/orpc/orpc.ts
export const protectedProcedure = o.use(({ context, next }) => {
  if (!context.session || !context.user) {
    throw new ORPCError("UNAUTHORIZED");
  }
  // ...
});
```

### Recommended Setup ✅

**Step 1: Define base context with headers**

Update `backend/orpc/context.ts`:

```typescript
import { os } from "@orpc/server";
import type { CloudflareEnv } from "../../env.ts";
import type { DB } from "../db/client.ts";

export type BaseContext = {
  headers: Headers;
  env: CloudflareEnv;
  db: DB;
};

export const base = os.$context<BaseContext>();
```

**Step 2: Create dedicated auth middleware**

Update `backend/orpc/orpc.ts`:

```typescript
import { os, ORPCError } from "@orpc/server";
import { getAuth } from "../auth/auth.ts";
import { base } from "./context.ts";

export { ORPCError };

// Public procedures have base context
export const publicProcedure = base;

// Auth middleware fetches session from Better Auth
export const authMiddleware = base.middleware(async ({ context, next }) => {
  const auth = getAuth(context.db);
  const sessionData = await auth.api.getSession({
    headers: context.headers,
  });

  if (!sessionData?.session || !sessionData?.user) {
    throw new ORPCError("UNAUTHORIZED");
  }

  return next({
    context: {
      session: sessionData.session,
      user: sessionData.user,
    },
  });
});

// Protected procedures require authentication
export const protectedProcedure = base.use(authMiddleware);

// ... rest of procedures (orgProtectedProcedure, etc.)
```

**Step 3: Update RPC handler context creation**

When mounting the oRPC handler, pass headers directly:

```typescript
// If using TanStack Start handlers:
app.all("/api/orpc/*", async (c) => {
  const { response } = await orpcHandler.handle(c.req.raw, {
    prefix: "/api/orpc",
    context: {
      headers: c.req.raw.headers,
      env: c.env,
      db: c.var.db,
    },
  });
  return response ?? new Response("Not found", { status: 404 });
});
```

---

## 3. Cloudflare Workers + TanStack Start Deployment

### Current Setup (Alchemy)

The current setup uses Alchemy for deployment, which abstracts away the standard Cloudflare tooling. This works but is non-standard.

```typescript
// Current: alchemy.run.ts
const worker = await TanStackStart("os2", {
  bindings: { ... },
  wrangler: {
    main: "./backend/worker.ts",
  },
  // ...
});
```

### Recommended Setup (Standard Cloudflare)

If you want to adopt the idiomatic Cloudflare approach:

**Step 1: Add wrangler.jsonc to project root**

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "os2",
  "compatibility_date": "2025-11-28",
  "compatibility_flags": ["nodejs_compat"],
  "main": "@tanstack/react-start/server-entry",
  "observability": {
    "enabled": true,
  },
}
```

**Step 2: Update vite.config.ts**

```typescript
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { devtools } from "@tanstack/devtools-vite";

export default defineConfig({
  plugins: [
    devtools(),
    tailwindcss(),
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tanstackStart({
      srcDirectory: "./app",
      router: {
        addExtensions: true,
        virtualRouteConfig: "./app/routes.ts",
      },
    }),
    viteReact(),
  ],
});
```

**Step 3: Update package.json scripts**

```json
{
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "deploy": "npm run build && wrangler deploy",
    "cf-typegen": "wrangler types"
  }
}
```

**Step 4: Access bindings via cloudflare:workers**

```typescript
import { env } from "cloudflare:workers";

// Use env.DATABASE_URL, env.BETTER_AUTH_SECRET, etc.
```

### Decision: Keep Alchemy or Switch?

| Factor                 | Alchemy                           | Standard Cloudflare |
| ---------------------- | --------------------------------- | ------------------- |
| Database provisioning  | ✅ Automated PlanetScale branches | ❌ Manual setup     |
| Durable Objects        | ✅ Declarative bindings           | ✅ wrangler.jsonc   |
| Environment management | ✅ Stage-based with Doppler       | ⚠️ Manual env files |
| Learning curve         | ⚠️ Custom patterns                | ✅ Standard docs    |
| Community examples     | ❌ Limited                        | ✅ Extensive        |

**Recommendation:** Keep Alchemy for its PlanetScale integration and environment management, but adopt the standard patterns where possible (especially auth middleware).

---

## 4. Minimal Better Auth Setup

The current setup is already fairly minimal but can be simplified. Here's the absolute minimal configuration:

```typescript
// backend/auth/auth.ts - Minimal version
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import type { DB } from "../db/client.ts";
import * as schema from "../db/schema.ts";
import { env } from "../../env.ts";

export const getAuth = (db: DB) =>
  betterAuth({
    baseURL: env.VITE_PUBLIC_URL,
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
      },
    }),
    plugins: [tanstackStartCookies()],
  });
```

Add providers/plugins as needed. The `tanstackStartCookies()` plugin is essential for TanStack Start integration.

---

## 5. Migration Path

### Phase 1: Auth Middleware (Recommended)

1. Create `app/routes/api/auth/$.ts` file route
2. Create `app/lib/auth-middleware.ts`
3. Update protected routes to use server middleware
4. Remove auth handling from Hono middleware
5. Test auth flows

### Phase 2: oRPC Context (Optional)

1. Update `backend/orpc/context.ts` to use headers-based context
2. Update auth middleware to fetch session from Better Auth
3. Update handler context creation
4. Test all oRPC procedures

### Phase 3: Standard Cloudflare (Optional)

1. Add `wrangler.jsonc` to project root
2. Update `vite.config.ts` with cloudflare plugin
3. Update environment variable access
4. Test local development and deployment
5. Consider keeping Alchemy for database management only

---

## 6. Key Differences Summary

### Session Handling

| Aspect                 | Current                       | Idiomatic                             |
| ---------------------- | ----------------------------- | ------------------------------------- |
| Session fetch location | Hono middleware (server-wide) | TanStack Start middleware (per-route) |
| Session storage        | Passed via Hono context       | Fetched from headers in middleware    |
| Route protection       | Client-side `beforeLoad`      | Server-side middleware                |
| oRPC auth              | Pre-populated context         | Middleware fetches from headers       |

### Architecture

| Aspect           | Current                  | Idiomatic                            |
| ---------------- | ------------------------ | ------------------------------------ |
| Server entry     | Hono worker              | `@tanstack/react-start/server-entry` |
| API routes       | Hono routes              | TanStack Start file routes           |
| Auth handler     | `app.all("/api/auth/*")` | `Route.server.handlers`              |
| Protected routes | Layout + client check    | Server middleware                    |

---

## 7. Package Version Compatibility

### Verified Compatible Versions (as of January 2026)

The following package versions in `apps/os2/package.json` have been verified to work together:

| Package                            | Version      | Status        | Notes                                                                    |
| ---------------------------------- | ------------ | ------------- | ------------------------------------------------------------------------ |
| `@tanstack/react-start`            | 1.145.7      | ✅ Compatible | Supports `createMiddleware()`, file-based API routes, Cloudflare Workers |
| `@tanstack/react-router`           | 1.145.7      | ✅ Compatible | Must match react-start version                                           |
| `@tanstack/react-router-ssr-query` | 1.145.7      | ✅ Compatible | Must match react-start version                                           |
| `@tanstack/react-query`            | 5.90.11      | ✅ Compatible | Works with react-query-devtools 5.91.1                                   |
| `better-auth`                      | 1.4.10       | ✅ Compatible | Includes `tanstackStartCookies()` plugin                                 |
| `@orpc/server`                     | 1.13.2       | ✅ Compatible | Supports `os.$context<T>()` pattern                                      |
| `@orpc/client`                     | 1.13.2       | ✅ Compatible | Must match server version                                                |
| `@orpc/tanstack-query`             | 1.13.2       | ✅ Compatible | Must match server version                                                |
| `@cloudflare/vite-plugin`          | 1.17.1       | ✅ Compatible | Updated from 1.15.3                                                      |
| `wrangler`                         | 4.54.0       | ✅ Compatible | Updated from 4.51.0                                                      |
| `@cloudflare/workers-types`        | 4.20260103.0 | ✅ Compatible | Updated to match wrangler                                                |
| `react` / `react-dom`              | 19.2.0       | ✅ Compatible | React 19 supported                                                       |

### Minimum Version Requirements

Based on documentation:

- **TanStack Start 1.138.0+** required for static prerendering with Cloudflare Workers
- **Better Auth** - `tanstackStartCookies()` plugin available since early 1.x versions
- **oRPC 1.x** - stable API for `os.$context<T>()` pattern

### Completed Updates (January 2026)

The following packages were updated to their latest compatible versions:

- `@cloudflare/vite-plugin`: 1.15.3 → 1.17.1
- `wrangler`: 4.51.0 → 4.54.0
- `@cloudflare/workers-types`: 4.20251128.0 → 4.20260103.0

### Optional Minor Updates

```bash
# Optional: Update minor versions of React Query
pnpm update @tanstack/react-query @tanstack/react-query-devtools
```

### Version Alignment Rules

1. **TanStack packages** (`react-router`, `react-start`, `react-router-ssr-query`, `virtual-file-routes`) should all be on the same minor version
2. **oRPC packages** (`@orpc/server`, `@orpc/client`, `@orpc/tanstack-query`) should all be on the same version
3. **React Query** devtools should be within one minor version of the main package

---

## 8. Trade-offs

### Keep Current Architecture If:

- The app is stable and working
- Team is familiar with Hono patterns
- PlanetScale branch automation is valuable
- Migration cost outweighs benefits

### Migrate to Idiomatic If:

- Building new features that need auth middleware
- Want better alignment with documentation
- Easier onboarding for new developers
- Plan to contribute back to community

---

## References

- [TanStack Start Middleware Docs](https://tanstack.com/start/latest/docs/framework/react/guide/middleware)
- [Better Auth TanStack Start Example](https://github.com/better-auth/better-auth/tree/main/examples/tanstack-start-example)
- [oRPC Documentation](https://orpc.dev/docs/getting-started)
- [Cloudflare Vite Plugin](https://developers.cloudflare.com/workers/vite-plugin/)
