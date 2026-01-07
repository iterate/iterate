# OS2 Type Slop & Skeleton Assessment

This document compares the low-level infrastructure patterns in `apps/os` and `apps/os2`, focusing on type safety, TRPC usage, TanStack Start integration, and better-auth patterns. The goal is to identify areas where `os2` diverges from the cleaner patterns established in `os`.

## Executive Summary

Overall, `os2` has a reasonably clean skeleton that follows most of the patterns from `os`. However, there are several areas where type slop has crept in or where the patterns diverge unnecessarily. The main issues are:

1. **Manually hardcoded `AuthSession` type** instead of inferring from better-auth
2. **`sessionResult: any` cast** in the worker middleware
3. **Missing `trpc` and `trpcClient` from router context** - uses module-level singletons instead
4. **Missing `localLink` for server-side TRPC** - all calls go through HTTP even on server
5. **`useSession` returns `{ user }` wrapper** instead of direct user
6. **Uses `console.error` instead of logger** in waitUntil wrapper

## Detailed Findings

### 1. AuthSession Type - Manually Hardcoded ❌

**os (good pattern):**

```typescript
// apps/os/backend/auth/auth.ts:129
export type AuthSession = Awaited<ReturnType<Auth["api"]["getSession"]>>;
```

**os2 (type slop):**

```typescript
// apps/os2/backend/auth/auth.ts:86-114
export type AuthSession = {
  user: {
    id: string;
    createdAt: Date;
    updatedAt: Date;
    email: string;
    emailVerified: boolean;
    name: string;
    image?: string | null;
    role?: string | null;
    banned?: boolean | null;
    banReason?: string | null;
    banExpires?: Date | null;
  };
  session: {
    id: string;
    createdAt: Date;
    updatedAt: Date;
    userId: string;
    expiresAt: Date;
    token: string;
    ipAddress?: string | null;
    userAgent?: string | null;
    impersonatedBy?: string | null;
  };
} | null;
```

**Problem:** The `os2` version manually defines the entire session shape. This:

- Is prone to drift from the actual better-auth type
- Requires manual updates when better-auth changes
- Defeats the purpose of TypeScript inference

**Recommendation:** Replace with the inferred type pattern from `os`:

```typescript
export type AuthSession = Awaited<ReturnType<Auth["api"]["getSession"]>>;
```

**Assessment:** 🔴 High priority - this is the single biggest source of potential type drift.

---

### 2. Session Result Cast to `any` in Worker ❌

**os (good pattern):**

```typescript
// apps/os/backend/worker.ts:71
const session = await auth.api.getSession({ headers: c.req.raw.headers });
```

**os2 (type slop):**

```typescript
// apps/os2/backend/worker.ts:47-49
const sessionResult: any = await auth.api.getSession({ headers: c.req.raw.headers });
const session: AuthSession =
  sessionResult && "data" in sessionResult ? sessionResult.data : sessionResult;
```

**Problem:** The `any` cast here indicates uncertainty about what `getSession` returns. This is likely because `os2` is using a different version of better-auth or the types aren't flowing correctly.

**Recommendation:**

1. First, fix the `AuthSession` type to be inferred (see above)
2. Then remove the `any` cast entirely - the session should be typed correctly

**Assessment:** 🔴 High priority - `any` casts defeat TypeScript's purpose.

---

### 3. Router Context Missing TRPC ⚠️

**os (good pattern):**

```typescript
// apps/os/app/router.tsx:13-17
export type TanstackRouterContext = {
  trpc: TRPCOptionsProxy<AppRouter>;
  trpcClient: TRPCClient<AppRouter>;
  queryClient: QueryClient;
};

// apps/os/app/router.tsx:31
context: { queryClient, trpc, trpcClient },
```

**os2 (simplified but less flexible):**

```typescript
// apps/os2/app/router.tsx:7-9
export type TanstackRouterContext = {
  queryClient: QueryClient;
};

// apps/os2/app/router.tsx:28
context: { queryClient },
```

Instead, `os2` uses module-level singletons:

```typescript
// apps/os2/app/lib/trpc.tsx:54-58
export const trpcClient = makeTrpcClient();
export const trpc = createTRPCOptionsProxy<AppRouter>({
  client: trpcClient,
  queryClient: makeQueryClient(),
});
```

**Problem:** The module-level singleton approach:

- Creates a new `queryClient` that's separate from the router's queryClient
- Can lead to cache inconsistencies
- Makes testing harder (can't swap out the client)

**Recommendation:** Add `trpc` and `trpcClient` to the router context, and remove the module-level singleton exports.

**Assessment:** 🟡 Medium priority - works but creates potential cache inconsistency.

---

### 4. Missing `localLink` for Server-Side TRPC ⚠️

**os (good pattern):**

```typescript
// apps/os/app/lib/trpc.ts:27-42
export const makeTrpcClient = createIsomorphicFn()
  .server(() =>
    createTRPCClient<AppRouter>({
      links: [
        localLink({
          router: appRouter,
          createContext: async () => {
            const c = getContext<{ Variables: Variables; Bindings: CloudflareEnv }>();
            return createContext(c);
          },
        }),
      ],
    }),
  )
  .client(() =>
    createTRPCClient<AppRouter>({
      links: [
        loggerLink({ enabled: () => true }),
        httpBatchLink({
          url: `${window.location.origin}/api/trpc`,
          methodOverride: "POST",
        }),
      ],
    }),
  );
```

**os2 (missing server optimization):**

```typescript
// apps/os2/app/lib/trpc.tsx:28-38
export function makeTrpcClient() {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: "/api/trpc",
        transformer: superjson,
        maxURLLength: 2083,
      }),
    ],
  });
}
```

**Problem:** Without `localLink` for server-side, all TRPC calls during SSR will:

- Make HTTP requests to itself
- Add unnecessary latency
- Not share the Hono context (so no access to session, db, etc.)

**Recommendation:** Add `createIsomorphicFn` with `localLink` for server-side like `os` does.

**Assessment:** 🟡 Medium priority - affects SSR performance and correctness.

---

### 5. `useSessionUser` Returns Wrapper Object ⚠️

**os (direct return):**

```typescript
// apps/os/app/hooks/use-session-user.ts
export function useSessionUser() {
  const trpc = useTRPC();
  const userQuery = useQuery(
    trpc.user.me.queryOptions(void 0, {
      staleTime: 1000 * 60 * 10,
    }),
  );
  if (!userQuery.data) throw new Error(`User data not found...`);
  return userQuery.data; // Returns user directly
}
```

**os2 (wrapper object):**

```typescript
// apps/os2/app/hooks/use-session-user.ts
export function useSessionUser() {
  const { data: user } = useSuspenseQuery(trpc.user.me.queryOptions());
  return {
    user,
    isAuthenticated: !!user, // Always true if we reach here with suspense
  };
}
```

**Problem:**

- `isAuthenticated` is always `true` because `useSuspenseQuery` will suspend until data loads
- The wrapper object adds unnecessary destructuring everywhere it's used

**Recommendation:** Either:

1. Return user directly like `os`, or
2. If the wrapper is desired, at least add `staleTime` to avoid refetching on every use

**Assessment:** 🟢 Low priority - stylistic, but the wrapper is misleading.

---

### 6. Uses `console.error` Instead of Logger 🟢

**os (good pattern):**

```typescript
// apps/os/env.ts:42
export function waitUntil(promise: Promise<unknown>): void {
  _waitUntil(promise.catch((error) => logger.error(error)));
}
```

**os2 (uses console):**

```typescript
// apps/os2/env.ts:31
export function waitUntil(promise: Promise<unknown>): void {
  _waitUntil(
    promise.catch((error) => {
      console.error("waitUntil error:", error);
    }),
  );
}
```

**Problem:** Using `console` bypasses the structured logging and PostHog error tracking.

**Recommendation:** Import and use the logger from `tag-logger.ts`.

**Assessment:** 🟢 Low priority - but should be consistent with logging patterns.

---

### 7. Missing `useTRPC` Hook

**os (good pattern):**

```typescript
// apps/os/app/lib/trpc.ts:55
export const { useTRPC, useTRPCClient, TRPCProvider } = createTRPCContext<AppRouter>();
```

Used in components:

```typescript
// apps/os/app/routes/org/settings.tsx:24
const trpc = useTRPC();
const { data: organization } = useQuery(
  trpc.organization.get.queryOptions(...)
);
```

**os2 (uses module-level import):**

```typescript
// apps/os2/app/routes/org/settings.tsx:5
import { trpc, trpcClient } from "../../lib/trpc.tsx";
```

**Problem:** The module-level import doesn't benefit from React context and may not get the same queryClient instance.

**Recommendation:** Use `createTRPCContext` pattern from `os`.

**Assessment:** 🟡 Medium priority - affects testability and potential cache issues.

---

### 8. Better-Auth Module Augmentation is Redundant

**os2 has this file:**

```typescript
// apps/os2/app/lib/better-auth.d.ts
declare module "better-auth/types" {
  interface Session {
    impersonatedBy?: string | null;
  }
  interface User {
    role?: string | null;
    banned?: boolean | null;
    banReason?: string | null;
    banExpires?: Date | null;
  }
}
```

**os does not have this file.**

**Problem:** This module augmentation is needed because `os2` has the hardcoded `AuthSession` type. If `AuthSession` was properly inferred, the types would flow from better-auth's admin plugin automatically.

**Recommendation:** After fixing the `AuthSession` type inference, this file may become unnecessary. Verify and remove if so.

**Assessment:** 🟢 Low priority - symptom of the bigger issue.

---

## Summary Table

| Issue                          | Severity  | Effort | Recommendation                  |
| ------------------------------ | --------- | ------ | ------------------------------- |
| Hardcoded AuthSession type     | 🔴 High   | Low    | Use inferred type               |
| `sessionResult: any` cast      | 🔴 High   | Low    | Remove after fixing AuthSession |
| Missing trpc in router context | 🟡 Medium | Medium | Add to context                  |
| Missing localLink for SSR      | 🟡 Medium | Medium | Add createIsomorphicFn          |
| Missing useTRPC hook           | 🟡 Medium | Low    | Use createTRPCContext           |
| useSessionUser wrapper         | 🟢 Low    | Low    | Return user directly            |
| console.error in waitUntil     | 🟢 Low    | Low    | Use logger                      |
| Redundant module augmentation  | 🟢 Low    | Low    | Remove after fixing types       |

## Recommended Order of Fixes

1. **Fix AuthSession type** - This unblocks several other fixes
2. **Remove the `any` cast** in worker.ts
3. **Add localLink for server-side TRPC** - Important for SSR correctness
4. **Add trpc/trpcClient to router context** - Ensures cache consistency
5. **Use createTRPCContext** for the `useTRPC` hook
6. **Clean up minor issues** (logger, useSessionUser, module augmentation)

## What OS2 Does Well

To be fair, `os2` does many things correctly:

- ✅ TRPC procedures use proper middleware type narrowing
- ✅ Context creation follows the same pattern
- ✅ Error formatting in TRPC is correct
- ✅ Query invalidation pattern is solid
- ✅ Worker setup is largely correct
- ✅ Uses `superjson` transformer consistently
- ✅ Route patterns follow TanStack Start conventions
- ✅ Uses `useSuspenseQuery` appropriately
