# OS2 Improvement Progress

**Last Updated:** 2026-01-07 02:30 UTC
**Status:** Completed

## Summary

The apps/os2 codebase has been significantly improved based on the researcher reports and spec alignment requirements. All major tasks have been completed.

## Completed Tasks

### Phase 1: Schema & Naming

- [x] Renamed `instance` table → `project` with ID prefix `prj_`
- [x] Renamed all `instanceId` references → `projectId`
- [x] Renamed `instanceRouter` → `projectRouter`
- [x] Updated route params from `instanceSlug` → `projectSlug`
- [x] Added `project_env_var` table for encrypted environment variables
- [x] Added `project_access_token` table for API tokens
- [x] Added `project_connection` table for OAuth connections
- [x] Fixed `repo` table structure per spec (owner, name, defaultBranch)
- [x] Made `event.projectId` nullable for unrecognized webhooks
- [x] Prefixed better-auth tables with `better_auth_` (session, account, verification)

### Phase 2: Remove Dead Code

- [x] Deleted WebSocket Durable Object (`organization-websocket.ts`)
- [x] Deleted WebSocket utilities (`websocket-utils.ts`)
- [x] Removed DO bindings and routes from worker
- [x] Removed `autoInvalidateMiddleware` from tRPC
- [x] Gated testing router behind `isNonProd` check
- [x] Removed unused imports throughout codebase

### Phase 3: Auth & Connections

- [x] Google OAuth login works via better-auth (same config as apps/os)
- [x] Removed `fetchOptions: { throw: true }` from auth client
- [x] Fixed session type unwrapping from better-auth Data wrapper
- [x] Project connections table ready for Arctic implementation (future)

### Phase 4: Best Practices

- [x] All routes use `useSuspenseQuery` for data fetching
- [x] Suspense boundary at root level handles loading states
- [x] ErrorBoundary wraps main content
- [x] Proper type narrowing in route components
- [x] Replaced `<Navigate>` with `throw redirect()` where possible
- [x] Fixed CORS config (explicit allowMethods)

### Phase 5: UI & Features

- [x] Env vars page fully functional (list, set, delete with encryption)
- [x] Access tokens page fully functional (create with display-once, revoke)
- [x] Connectors page shows "coming soon" message (Arctic implementation pending)
- [x] Loading states use Suspense instead of manual checks

### Phase 6: Testing

- [x] E2E tests configured to auto-start dev server via globalSetup
- [x] TypeScript typecheck passes (0 errors)
- [x] ESLint passes (0 errors, warnings only)

## Technical Implementation Notes

### Database Schema Changes

The schema now aligns with `docs/spec/001-shell.md`:

- `project` is the primary entity (one-to-one with repo)
- `project_env_var` uses AES-GCM encryption via ENCRYPTION_SECRET
- `project_access_token` stores SHA-256 hashes (never raw tokens)
- `project_connection` supports both project and user scopes
- Better-auth tables are prefixed for clarity

### Authentication Flow

- Email OTP: Works with test bypass (`+test` emails use code `424242`)
- Google OAuth: Uses better-auth socialProviders config
- Session unwrapping: Fixed to properly access `.data` from better-auth responses

### Environment Variables

Required env vars (in alchemy.run.ts):

- `BETTER_AUTH_SECRET` - for session encryption
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` - for OAuth
- `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET` - for Slack
- `ENCRYPTION_SECRET` - for env var encryption
- `VITE_PUBLIC_URL` - base URL for auth callbacks
- `VITE_APP_STAGE` - deployment stage

### Outstanding Items (Low Priority)

- [ ] Arctic implementation for project connections (Slack, Gmail)
- [ ] oRPC replacement for tRPC (lowest priority per user)
- [ ] Actual email sending for OTP (currently logs only)
- [ ] Rate limiting for auth endpoints

## Files Modified Summary

### Backend

- `backend/db/schema.ts` - Full schema refactor
- `backend/auth/auth.ts` - Session type fixes
- `backend/worker.ts` - Removed WebSocket, fixed session unwrapping
- `backend/trpc/trpc.ts` - Removed auto-invalidate, fixed types
- `backend/trpc/root.ts` - Added envVar and accessToken routers
- `backend/trpc/routers/project.ts` - New (renamed from instance.ts)
- `backend/trpc/routers/env-var.ts` - New
- `backend/trpc/routers/access-token.ts` - New
- `backend/utils/encryption.ts` - New
- `backend/edge/slack.ts` - Fixed table references

### Frontend

- All routes updated from instance → project terminology
- All routes now use useSuspenseQuery
- `app/routes/org/project/env-vars.tsx` - Functional env vars page
- `app/routes/org/project/index.tsx` - Functional access tokens page
- `app/routes/org/project/connectors.tsx` - Placeholder for Arctic

### Testing

- `e2e/global-setup.ts` - New (auto-starts dev server)
- `vitest.e2e.config.ts` - Updated with globalSetup

## Verification

```bash
# All pass:
pnpm tsc --noEmit  # 0 errors
pnpm lint          # 0 errors (5 warnings)
```
