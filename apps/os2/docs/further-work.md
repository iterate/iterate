# Further Work - os2 Cleanup

This document tracks additional cleanup and improvements identified during code review.

## Completed

### 1. ~~Remove Dead WebSocket Code~~ ✅
- [x] Delete `app/hooks/use-websocket.ts` (150 lines of dead code)
- [x] Remove `useOrganizationWebSocket` import from `app/routes/org/layout.tsx`

### 2. ~~Remove Duplicate Database Helpers~~ ✅
- [x] Deleted `backend/db/helpers.ts` (completely unused)
- [x] Removed unused helper functions from backend router utilities

### 3. ~~Remove Debug Logs in Slack Integration~~ ✅
- [x] Removed debug `console.log` statements from `backend/integrations/slack/slack.ts`
- Note: `console.warn`/`console.error` retained for legitimate warnings/errors

### 4. ~~Improve Type Safety~~ ✅
- [x] Removed `as any` casts in `app/lib/session-query.ts`
- [x] Added proper typing for better-auth session extensions (role, impersonatedBy)

## Medium Priority

### 5. Improve React Import Style (Optional)
Most UI components use `import * as React from "react"` which is the default shadcn pattern.
While these could be changed to named imports, it's a stylistic preference that doesn't affect functionality.

Files using `import * as React`:
- app/components/machine-table.tsx
- app/components/empty-state.tsx
- app/components/ui/button.tsx (uses forwardRef)
- app/components/ui/card.tsx (uses forwardRef)
- app/components/ui/dialog.tsx (uses forwardRef)
- app/components/ui/dropdown-menu.tsx (uses forwardRef)
- app/components/ui/input.tsx (uses forwardRef)
- app/components/ui/input-otp.tsx
- app/components/ui/textarea.tsx (only uses ComponentProps type)
- app/components/ui/table.tsx
- app/components/ui/badge.tsx

## Low Priority

### 6. Consider Consolidating Auth Utilities
- [ ] Review if `backend/auth/auth.ts` and related files can be simplified
