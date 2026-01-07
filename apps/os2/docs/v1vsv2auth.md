# Authentication: os vs os2

This document contrasts and compares the authentication implementations between `apps/os` (v1) and `apps/os2` (v2). os2 is designed to be a stripped-down, simpler version of os while maintaining the same core patterns that work.

## Package Versions (Aligned)

Both apps use the same versions of critical auth-related packages:

| Package | Version |
|---------|---------|
| `better-auth` | `1.4.3` |
| `@tanstack/react-start` | `^1.139.12` |
| `@tanstack/react-router` | `^1.139.12` |
| `@trpc/client` | `^11.7.2` |
| `@trpc/server` | `^11.7.2` |
| `hono` | `^4.10.7` |
| `drizzle-orm` | `^0.44.7` |

## Architecture Overview

Both apps follow the same fundamental pattern:

```
┌─────────────────────────────────────────────────────────────────┐
│                     Cloudflare Worker                            │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                    Hono Middleware                          │ │
│  │  1. Parse request cookies                                   │ │
│  │  2. Call better-auth's getSession()                         │ │
│  │  3. Set session on context.variables                        │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                              ↓                                   │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │              Tanstack Start Server Entry                    │ │
│  │  Receives context with variables.session                    │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                              ↓                                   │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │              Route beforeLoad (Server Functions)            │ │
│  │  Access session via context.variables.session               │ │
│  └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

## Key Insight: Why Server Functions Matter

The critical pattern that makes auth work in SSR is using **server functions** to check authentication instead of client-side SDK calls.

### The Problem (What os2 Had Before)

```typescript
// ❌ WRONG: This breaks with SSR
export const Route = createFileRoute("/_auth-required.layout")({
  beforeLoad: async ({ context }) => {
    // This makes an HTTP request from the server to /api/auth/get-session
    // But the server doesn't have the user's cookies!
    const session = await authClient.getSession();
    if (!session?.user) throw redirect({ to: "/login" });
  },
});
```

When Tanstack Start runs `beforeLoad` during SSR:
1. The code runs on the Worker
2. `authClient.getSession()` makes a new HTTP request to `/api/auth/get-session`
3. This request doesn't include the user's browser cookies
4. The session check fails, even though the user is logged in

### The Solution (What Both Apps Use Now)

```typescript
// ✅ CORRECT: Use server functions that access Worker context
const assertAuthenticated = authenticatedServerFn.handler(() => {});

export const Route = createFileRoute("/_auth-required.layout")({
  beforeLoad: () => assertAuthenticated(),
});
```

The server function has access to `context.variables.session`, which was populated by the Worker middleware using the **original request's cookies**.

## File-by-File Comparison

### Backend Auth Configuration

#### os: `backend/auth/auth.ts`
- Full-featured with multiple plugins
- Stripe integration (`@better-auth/stripe`)
- Custom integrations plugin for Slack/Google OAuth flows
- Service auth plugin for internal APIs
- Account linking enabled
- User additional fields (`debugMode`, `isBot`)
- Complex OTP generation for test emails

#### os2: `backend/auth/auth.ts`
- Stripped down to essentials
- Only `admin()` and `emailOTP()` plugins
- Simple test OTP handling (emails matching `+.*test@` get `424242`)
- No account linking configuration
- Explicit schema mapping (clearer)
- Manually typed `AuthSession` (avoids better-auth type portability issues)

### Frontend Auth Client

#### os: `app/lib/auth-client.ts`
```typescript
export const authClient = createAuthClient({
  baseURL: import.meta.env.VITE_PUBLIC_URL || "http://localhost:5173",
  plugins: [adminClient(), integrationsClientPlugin(), emailOTPClient()],
  fetchOptions: { throw: true },
});
```

#### os2: `app/lib/auth-client.ts`
```typescript
const getBaseURL = () => {
  if (typeof window !== "undefined") {
    return window.location.origin;
  }
  return import.meta.env.VITE_PUBLIC_URL || "http://localhost:5173";
};

export const authClient = createAuthClient({
  baseURL: getBaseURL(),
  plugins: [emailOTPClient()],
});

export const { signIn, signOut, useSession } = authClient;
```

**Key differences:**
- os2 dynamically computes baseURL (uses `window.location.origin` in browser)
- os2 doesn't set `fetchOptions: { throw: true }` (errors handled differently)
- os2 re-exports common functions for convenience

### Auth Middleware (Identical)

Both apps use the same `auth-middleware.ts`:

```typescript
import { redirect } from "@tanstack/react-router";
import { createMiddleware, createServerFn } from "@tanstack/react-start";
import { getRequestUrl } from "@tanstack/react-start/server";

export const authMiddleware = createMiddleware({ type: "function" }).server(({ context, next }) => {
  const { session } = context.variables;
  const request = getRequestUrl();
  if (!session)
    throw redirect({
      to: "/login",
      search: {
        redirectUrl: request.pathname + request.search,
      },
    });

  return next({
    context: {
      ...context,
      variables: {
        ...context.variables,
        session,
      },
    },
  });
});

export const authenticatedServerFn = createServerFn({ method: "POST" }).middleware([
  authMiddleware,
]);
```

### Worker Session Handling

#### os: `backend/worker.ts`
```typescript
app.use("*", async (c, next) => {
  const db = getDb();
  const auth = getAuth(db);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  c.set("db", db);
  c.set("auth", auth);
  c.set("session", session);
  const trpcCaller = appRouter.createCaller(createContext(c));
  c.set("trpcCaller", trpcCaller);
  return next();
});
```

#### os2: `backend/worker.ts`
```typescript
app.use("*", async (c, next) => {
  const db = getDb();
  const auth = getAuth(db);
  // Note: better-auth API may return { data: session } or session directly
  const sessionResult: any = await auth.api.getSession({ headers: c.req.raw.headers });
  const session: AuthSession =
    sessionResult && "data" in sessionResult ? sessionResult.data : sessionResult;
  c.set("db", db);
  c.set("auth", auth);
  c.set("session", session);
  const trpcCaller = appRouter.createCaller(createContext(c));
  c.set("trpcCaller", trpcCaller);
  return next();
});
```

**Key difference:** os2 handles potential API response format differences.

### Login Page (Nearly Identical)

Both apps use the same pattern:

```typescript
const redirectIfAuthenticated = createServerFn()
  .inputValidator(z.object({ redirectUrl: z.string().catch("/") }))
  .handler(({ context, data }) => {
    if (context.variables.session) throw redirect({ to: data.redirectUrl });
  });

export const Route = createFileRoute("/login")({
  component: LoginPage,
  validateSearch: z.object({
    redirectUrl: z.string().catch("/"),
  }),
  beforeLoad: ({ search }) =>
    redirectIfAuthenticated({ data: { redirectUrl: search.redirectUrl } }),
});
```

### useSessionUser Hook

#### os: Uses tRPC
```typescript
export function useSessionUser() {
  const trpc = useTRPC();
  const userQuery = useQuery(
    trpc.user.me.queryOptions(void 0, {
      staleTime: 1000 * 60 * 10,
    }),
  );
  if (!userQuery.data)
    throw new Error(`User data not found...`);
  return userQuery.data;
}
```

#### os2: Uses tRPC (simplified)
```typescript
export function useSessionUser() {
  const { data: user } = useSuspenseQuery(trpc.user.me.queryOptions());
  return {
    user,
    isAuthenticated: !!user,
  };
}
```

Both fetch user data via tRPC's `user.me` procedure, not via the better-auth client.

## What os2 Omits

| Feature | In os | In os2 | Reason |
|---------|-------|--------|--------|
| Stripe integration | Yes | No | Not needed for MVP |
| Custom integrations plugin | Yes | No | Simplified auth flow |
| Service auth plugin | Yes | No | No internal API auth needed |
| Account linking | Yes | No | Single provider is sufficient |
| User additional fields | Yes | No | Simpler user model |
| Complex test OTP logic | Yes | No | Simple `+test@` pattern works |
| `fetchOptions: { throw: true }` | Yes | No | Different error handling |

## Common Gotchas

### 1. Don't Use authClient.getSession() in beforeLoad

```typescript
// ❌ WRONG
beforeLoad: async () => {
  const session = await authClient.getSession();
}

// ✅ CORRECT
const checkAuth = authenticatedServerFn.handler(() => {});
beforeLoad: () => checkAuth();
```

### 2. Session is on context.variables, not context

```typescript
// ❌ WRONG
handler(({ context }) => {
  const session = context.session;
});

// ✅ CORRECT
handler(({ context }) => {
  const session = context.variables.session;
});
```

### 3. Worker Middleware Must Run Before Tanstack Start

The session must be populated in Hono middleware **before** the request reaches Tanstack Start's server entry:

```typescript
// This runs first - populates c.var.session
app.use("*", async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  c.set("session", session);
  return next();
});

// This runs last - passes session to Tanstack Start
app.all("*", (c) => {
  return tanstackStartServerEntry.fetch(c.req.raw, {
    context: {
      cloudflare: { env: c.env, ctx: c.executionCtx },
      variables: c.var,  // ← session is here
    },
  });
});
```

### 4. tRPC Context Gets Session from Hono Context

```typescript
// backend/trpc/context.ts
export function createContext(c: HonoContext<{ Variables: Variables }>) {
  return {
    db: c.var.db,
    session: c.var.session,
    user: c.var.session?.user || null,
    env: c.env,
  };
}
```

## Testing Auth Locally

Both apps support test emails:
- **os**: Emails like `bob+123456@nustom.com` use `123456` as OTP
- **os2**: Emails matching `+.*test@` (e.g., `foo+test@example.com`) use `424242` as OTP

## Summary

os2 maintains the same core authentication architecture as os:

1. **better-auth** on the backend with cookie-based sessions
2. **Hono middleware** extracts session from request cookies
3. **Tanstack Start server functions** access session via `context.variables`
4. **tRPC protected procedures** use session from context
5. **useSessionUser** fetches user data via tRPC, not the auth client

The main difference is that os2 strips away integration-specific features (Stripe, custom OAuth flows, service auth) while keeping the foundational auth patterns that work correctly with SSR.
