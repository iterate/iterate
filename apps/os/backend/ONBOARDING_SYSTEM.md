# Onboarding System Documentation

## Overview

The onboarding system tracks both automated system tasks (Stripe, agent warmup) and user-required steps (connect integrations, setup repo, confirm org name) using a normalized Postgres event-sourcing approach.

## Database Schema

### `estate_onboarding` Table

High-level onboarding state per estate:

- `state`: Overall status (pending → in_progress → completed | error)
- `retryCount`: Number of retry attempts
- `lastError`: Last error message
- Timestamps for tracking progress

### `estate_onboarding_event` Table

Individual onboarding events (both system and user):

- `eventType`: The specific step (stripe_customer, onboarding_agent, connect_slack, etc.)
- `category`: "system" or "user"
- `status`: pending | in_progress | completed | error | skipped
- `metadata`: Flexible JSONB for step-specific data
- Timestamps for tracking

**Key Indexes:**

- `(onboardingId, eventType)`: Unique - one row per step per onboarding
- `(onboardingId, category, status)`: Efficiently query pending user steps
- `(category, status)`: Global queries across all estates

## Event Types

### System Events (Automated)

1. **stripe_customer**: Create Stripe customer and subscription
2. **onboarding_agent**: Warm up onboarding agent durable object

### User Steps (Manual, Blocking)

1. **confirm_org_name**: Confirm organization name
2. **connect_slack**: Connect Slack workspace
3. **connect_github**: Connect GitHub account
4. **setup_repo**: Connect GitHub repository

## File Structure

### Core Files

- `apps/os/backend/db/schema.ts`: Table definitions
- `apps/os/backend/org-utils.ts`: Creates org/estate and initializes onboarding
- `apps/os/backend/onboarding-processor.ts`: Processes system events
- `apps/os/backend/onboarding-user-steps.ts`: Helper functions for user steps
- `apps/os/backend/onboarding-cron.ts`: Retry logic for failed onboardings
- `apps/os/backend/redirect-logic.ts`: Central routing logic

### Routes

- `apps/os/app/routes/redirect.tsx`: Root redirect with onboarding orchestration
- `apps/os/app/routes/org/estate/onboarding.tsx`: Blocking onboarding page

### OAuth Callbacks

- `apps/os/backend/auth/integrations.ts`: Slack OAuth callback
- `apps/os/backend/integrations/github/router.ts`: GitHub OAuth callback

## Flow

### 1. User Signup (OAuth)

```
User clicks "Continue with Slack/Google"
  ↓
OAuth callback (integrations.ts):
  - Upsert user
  - Call createUserOrganizationAndEstate
    → Creates org, estate, membership
    → Inserts onboarding record (pending)
    → Inserts 6 event rows (2 system, 4 user, all pending)
  - Link OAuth account
  - Set session cookie
  ↓
Background: processOnboarding() starts via waitUntil
```

### 2. Root Redirect (`/`)

```
User lands on /
  ↓
determineUserRedirect(user):
  - Get/create org and estate
  - Check for pending user steps
  - Return redirect URL
  ↓
If pending user steps exist:
  → Redirect to /{org}/{estate}/onboarding
Otherwise:
  → Redirect to /{org}/{estate} (dashboard)
  ↓
Background: processOnboarding() runs via waitUntil
```

### 3. System Onboarding (Background)

Runs automatically via `waitUntil` and cron retries:

```
processOnboarding(onboardingId):
  ↓
For each system event (stripe_customer, onboarding_agent):
  - Check if already completed (query event row)
  - If pending: process and update event row
  ↓
Mark onboarding state as completed
```

**Cron Retry (every 5 minutes):**

- Finds pending/failed onboardings
- Retries up to 5 times
- Updates retry count and error state

### 4. User Onboarding Steps

User sees blocking page at `/{org}/{estate}/onboarding`:

1. **Confirm org name**: Form to update organization name
   - Updates org name if changed
   - Marks `confirm_org_name` as completed

2. **Connect Slack**: OAuth flow
   - Uses `authClient.integrations.link.slackBot()`
   - OAuth callback auto-marks `connect_slack` as completed

3. **Connect GitHub**: OAuth flow
   - Uses `trpc.integrations.startGithubAppInstallFlow()`
   - OAuth callback auto-marks `connect_github` as completed

4. **Setup repo**: (To be implemented)
   - UI to select/connect repository
   - Marks `setup_repo` as completed

After all steps complete, user is redirected to dashboard.

## Auto-Completion

### Slack Connection

In `apps/os/backend/auth/integrations.ts` (Slack callback):

```typescript
waitUntil(
  updateUserStep(db, estateId, "connect_slack", "completed").catch(...)
);
```

### GitHub Connection

In `apps/os/backend/integrations/github/router.ts` (GitHub callback):

```typescript
waitUntil(
  updateUserStep(db, estateId, "connect_github", "completed").catch(...)
);
```

## tRPC Endpoints

### Estate Router

```typescript
// Query pending user steps
estate.getPendingUserOnboardingSteps({ estateId });

// Get full onboarding status
estate.getOnboardingStatus({ estateId });

// Mark step as complete
estate.completeUserOnboardingStep({
  estateId,
  step: "connect_slack",
  metadata: {},
});

// Skip a step
estate.skipUserOnboardingStep({
  estateId,
  step: "setup_repo",
});

// Get onboarding agent data (for existing UI)
estate.getOnboardingAgentData();
```

## Benefits

1. **Normalized data**: Event rows instead of JSONB arrays
2. **Efficient queries**: Proper indexes for filtering by category/status
3. **Flexible metadata**: Per-event metadata storage
4. **Auto-completion**: OAuth flows automatically mark steps complete
5. **Blocking UX**: Users can't use product until onboarding complete
6. **Non-blocking backend**: System onboarding happens asynchronously
7. **Automatic retries**: Failed system onboarding retries via cron
8. **Single source of truth**: Central redirect logic handles all routing

## Testing

### Check onboarding status

```sql
-- Get all onboarding records
SELECT * FROM estate_onboarding ORDER BY created_at DESC;

-- Get events for a specific estate
SELECT eo.state, eoe.*
FROM estate_onboarding eo
JOIN estate_onboarding_event eoe ON eo.id = eoe.onboarding_id
WHERE eo.estate_id = 'est_xxx'
ORDER BY eoe.created_at;

-- Find pending user steps
SELECT * FROM estate_onboarding_event
WHERE category = 'user' AND status = 'pending';
```

### Manual testing

1. Sign up via Slack OAuth
2. Should land at `/{org}/{estate}/onboarding`
3. Complete each step sequentially
4. After all steps, redirected to dashboard

## Migration

Run `pnpm db:migrate` to apply migration `0022_freezing_cerise.sql`

This creates both `estate_onboarding` and `estate_onboarding_event` tables with proper indexes and foreign keys.

