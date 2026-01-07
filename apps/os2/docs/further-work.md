# Further Work - os2 Cleanup

This document tracks additional cleanup and improvements identified during code review.

## High Priority

### 1. Remove Dead WebSocket Code
- [ ] Delete `app/hooks/use-websocket.ts` (150 lines of dead code)
- [ ] Remove `useOrganizationWebSocket` import from `app/routes/org/layout.tsx`

The WebSocket Durable Object was removed but the client-side hook and its usage remain.

### 2. Remove Duplicate Database Helpers
- [ ] Review `backend/db/helpers.ts` for duplicates with trpc.ts middleware
- [ ] Remove or consolidate duplicate functions

The helpers file contains functions that may duplicate functionality in the tRPC middleware.

### 3. Fix Logging in Slack Integration
- [ ] Replace `console.warn`/`console.log` with `logger` in `backend/integrations/slack/slack.ts`

Lines with console usage: 27, 55, 75, 89, 131, 159

## Medium Priority

### 4. Remove Unnecessary React Imports
- [ ] Remove `import * as React from "react"` from files that don't need it

Files identified:
- app/components/project-selector.tsx
- app/components/ui/button.tsx
- app/components/ui/card.tsx
- app/components/ui/dialog.tsx
- app/components/ui/dropdown-menu.tsx
- app/components/ui/input.tsx
- app/components/ui/label.tsx
- app/components/ui/select.tsx
- app/components/ui/sidebar.tsx
- app/components/ui/tabs.tsx
- app/components/ui/textarea.tsx

### 5. Improve Type Safety
- [ ] Remove `as any` casts in `app/lib/session-query.ts`
- [ ] Add proper typing for better-auth session responses

## Low Priority

### 6. Review Unused Exports
- [ ] Audit helper functions in `backend/trpc/trpc.ts` for unused exports
- [ ] Remove any dead code

### 7. Consider Consolidating Auth Utilities
- [ ] Review if `backend/auth/auth.ts` and related files can be simplified
