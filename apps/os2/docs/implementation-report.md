# os2 Implementation Report

## Overview

os2 is a simplified version of the main `apps/os` application, built as a clean-room implementation using modern frameworks. It provides organization/project/machine management without the AI agent runtime complexity.

## Architecture

```
┌─────────────────────────────────────────────────┐
│           Frontend (app/)                       │
│  TanStack Router → React Components → oRPC     │
└─────────────────────────────────────────────────┘
                    ↓↑ HTTP /api/orpc
┌─────────────────────────────────────────────────┐
│     Backend (Cloudflare Worker)                 │
│  Hono → oRPC Handlers → Drizzle ORM → Postgres │
└─────────────────────────────────────────────────┘
```

**Key Technologies:**
- **Frontend:** React 19, TanStack Router/Query, oRPC client, shadcn/ui
- **Backend:** Hono, oRPC server, Drizzle ORM, Better Auth
- **Infrastructure:** Cloudflare Workers, Durable Objects, Postgres/Neon

## LOC Comparison: os2 vs os

| Metric | os2 | os | Ratio |
|--------|-----|-----|-------|
| **Total LOC** | ~8,000 | ~71,000 | 11% |
| **Frontend** | 5,100 | 22,300 | 23% |
| **Backend** | 2,600 | 45,400 | 6% |
| **Files** | 95 | 287 | 33% |
| **UI Components** | 23 | 56 | 41% |

**Why os2 is smaller:**
- No AI agent runtime (~30,000 LOC in os)
- No MCP integration
- No Stripe billing
- Fewer integrations
- Simplified data model

## os2 LOC Breakdown

| Directory | LOC | Files | Purpose |
|-----------|-----|-------|---------|
| app/routes/ | 2,200 | 23 | Page components |
| app/components/ | 2,600 | 23 | UI + feature components |
| app/lib/ | 300 | 5 | oRPC client, auth, utilities |
| backend/orpc/ | 1,300 | 11 | API routers |
| backend/db/ | 350 | 2 | Schema + client |
| backend/auth/ | 180 | 1 | Better Auth config |
| backend/integrations/ | 400 | 2 | Slack |
| backend/utils/ | 200 | 3 | Helpers |
| e2e/ | 250 | 4 | Playwright tests |

## Key Decisions

### 1. oRPC instead of tRPC
- **Decision:** Migrated from tRPC to oRPC
- **Rationale:** oRPC has better TanStack Query integration, simpler API
- **Status:** Complete, working well

### 2. Better Auth instead of custom auth
- **Decision:** Use Better Auth with email OTP + Google OAuth
- **Rationale:** Handles sessions, accounts, CSRF protection out of box
- **Trade-off:** Less control over auth flow, but much less code

### 3. Hono for HTTP layer
- **Decision:** Use Hono instead of raw Workers fetch
- **Rationale:** Middleware support, cleaner routing, CORS handling
- **Works well with:** oRPC handler integration

### 4. TanStack Start (partial)
- **Decision:** Use TanStack Router + Query with Start for SSR
- **Rationale:** Modern React Router with file-based routes
- **Caveat:** Not fully leveraging SSR optimization (see issues below)

### 5. Durable Objects for cache invalidation
- **Decision:** Use DO for WebSocket-based query invalidation
- **Rationale:** Real-time updates when data changes
- **Status:** Implemented but may be over-engineered

## Questionable Decisions

### 1. Not using oRPC middleware properly
The codebase defines `orgProtectedProcedure` and `projectProtectedProcedure` but most routers ignore them and re-implement lookup logic manually. This adds ~200+ lines of duplication.

**Should be:**
```typescript
// Router uses middleware
export const machineRouter = {
  list: projectProtectedProcedure.handler(({ context }) => {
    // context.project already available from middleware
  })
}
```

**Currently:**
```typescript
// Router does lookup manually
export const machineRouter = {
  list: protectedProcedure.input(ProjectInput).handler(({ input, context }) => {
    const project = await projectLookup(context, input); // Duplicated everywhere
  })
}
```

### 2. `as { data: Type }` type assertions everywhere
Almost every `useSuspenseQuery` call uses type assertions instead of proper inference:
```typescript
// Current (unsafe)
const { data: machines } = useSuspenseQuery(orpc.machine.list.queryOptions({...})) as { data: Machine[] };

// Should be (oRPC should infer this)
const { data: machines } = useSuspenseQuery(orpc.machine.list.queryOptions({...}));
```

### 3. Inline type definitions in route files
Types like `Organization`, `Project`, `Machine` are redefined in each route file instead of being shared or inferred from the API.

### 4. Durable Object for query invalidation
May be over-engineered. TanStack Query's built-in refetch on window focus + manual invalidation might suffice for this app's scale.

### 5. Unused database tables
- `project_repo` - Schema exists, loaded in queries, but no router
- `project_connection` - Schema exists for OAuth, no management UI
- `event` table - Only used internally by Slack integration

## Non-Idiomatic Patterns

### 1. useState + setTimeout for copy feedback
```typescript
// Current (memory leak risk)
const handleCopy = () => {
  setCopied(true);
  setTimeout(() => setCopied(false), 2000);
};

// Better: use a custom hook with cleanup
```

### 2. window.confirm for destructive actions
Uses browser's native confirm dialog instead of shadcn Dialog component for consistency.

### 3. Missing SSR optimization
The oRPC client always makes HTTP requests, even during SSR. The TanStack Start docs recommend using `createRouterClient` on server to avoid round-trips.

### 4. Form submission patterns vary
Some forms use `react-hook-form`, others use raw `useState`. Should standardize.

### 5. Error handling repetition
Every mutation has the same try/catch/toast pattern. Should create a wrapper:
```typescript
const mutation = useMutation({
  ...orpc.machine.delete.mutationOptions(),
  onError: (err) => toast.error(err.message),
});
```

## Code Reduction Opportunities

### High Impact (~300 LOC)

1. **Extract shared lookup functions**
   - `projectLookup` duplicated 3x (120+ lines)
   - `orgLookup` duplicated 2x (60+ lines)
   - `checkAdmin` duplicated 2x (20+ lines)

2. **Use middleware properly**
   - Remove manual lookups from routers
   - Let `projectProtectedProcedure` inject `context.project`

3. **Create shared types file**
   - Extract `Organization`, `Project`, `Machine`, `Member` types
   - Import from API or shared location

### Medium Impact (~150 LOC)

4. **Create mutation wrapper hook**
   ```typescript
   function useApiMutation<T>(options: MutationOptions<T>) {
     return useMutation({
       ...options,
       onError: (err) => toast.error(err.message),
     });
   }
   ```

5. **Consolidate query key patterns**
   - Create helper for common invalidation patterns

6. **Remove unused features**
   - Delete stub admin impersonation if not implementing
   - Remove unused schema relations if not needed

### Low Impact (~50 LOC)

7. **Replace window.confirm**
   - Use AlertDialog from shadcn

8. **Standardize form patterns**
   - Pick one approach (react-hook-form or controlled)

## Summary

**os2 is well-structured but has significant duplication.** The ~8,000 LOC could likely be reduced to ~6,500-7,000 with the changes above. The architecture is sound - oRPC + TanStack Query + Drizzle is a solid stack.

**Priority fixes:**
1. Extract duplicated lookup functions → immediate ~200 LOC savings
2. Use oRPC middleware properly → cleaner code, fewer bugs
3. Fix type assertions → better type safety

The comparison to `os` (71k LOC) shows os2 achieved its goal of being a simpler app, but there's still room to be even leaner.
