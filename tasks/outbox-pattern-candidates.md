---
state: todo
tags:
  - architecture
  - reliability
  - outbox
---

# Outbox Pattern Candidates

Port the outbox implementation from v2025 branch (`apps/os/backend/outbox/`) and apply it to the following areas. The outbox provides: transactional event publishing, automatic retries, observability via pgmq, and decoupled consumers.

## High Priority

### 1. Stripe Webhook Processing

**File:** `apps/os/backend/integrations/stripe/webhook.ts:39`

Currently processes inline. Should write to outbox then consume:

- `subscription_created` -> createStripeCustomer consumer
- `subscription_updated/deleted/paused/resumed` -> billing state updates
- `invoice.paid` / `invoice.payment_failed` -> billing + PostHog tracking
- `checkout.session.completed` -> activate subscription

**Benefits:** Retry failed Stripe processing, audit trail, decouple signature verification from business logic.

### 2. Slack Webhook Processing

**File:** `apps/os/backend/integrations/slack/slack.ts:392`

Currently returns "ok" immediately and forwards via `waitUntil`. Should:

- Write raw event to outbox
- Consumer handles forwarding to daemon machines
- Separate consumer for interactive callbacks (`slack.ts:504`)

**Benefits:** Retry failed daemon forwards, track which events were delivered.

### 3. Resend/Email Webhook Processing

**File:** `apps/os/backend/integrations/resend/resend.ts:253`

Same pattern as Slack - write to outbox, consumer forwards to daemon.

**Benefits:** Email delivery tracking, retry logic for daemon unavailability.

### 4. Machine Provisioning Side Effects

**File:** `apps/os/backend/trpc/routers/machine.ts:285-396`

When machine is created, several things should happen reliably:

- Daytona sandbox provisioning (already async)
- Initial machine state tracking
- PostHog event capture

**Candidate events:**

- `machine:created` - fire when DB row inserted
- `machine:ready` - when daemon reports ready (`orpc/router.ts:121`)
- `machine:archived` - trigger provider cleanup

### 5. Machine Archival After Promotion

**File:** `apps/os/backend/orpc/router.ts:184-202`

When new machine becomes active, old machines are archived. Currently done via `waitUntil` after transaction. Should be:

- `machine:promoted` event triggers `archiveOldMachines` consumer
- Consumer calls provider.archive for each old machine

**Benefits:** Retry failed archive calls, don't lose track of machines to archive.

## Medium Priority

### 6. OAuth Connection Setup

**Files:**

- `apps/os/backend/integrations/github/github.ts:136-262`
- `apps/os/backend/integrations/slack/slack.ts:245-344`
- `apps/os/backend/integrations/google/google.ts:214-312`

After OAuth callback completes:

- `connection:github:created` -> provision secrets, poke machines
- `connection:slack:created` -> provision secrets, poke machines
- `connection:google:created` -> provision secrets, poke machines

The `pokeRunningMachinesToRefresh` call (`slack.ts:372`, `google.ts:315`) should be a consumer.

### 7. Billing Account + Stripe Customer Creation

**File:** `apps/os/backend/trpc/routers/billing.ts:29-71`

When creating checkout session, may need to create Stripe customer. Should be:

- `billing:checkout:initiated` event
- Consumer creates Stripe customer if needed
- Consumer creates checkout session

**Benefits:** Retry failed Stripe API calls without user re-clicking.

### 8. User Signup Side Effects

**File:** `apps/os/backend/auth/auth.ts:72-107`

After user created:

- `user:created` event
- Consumer: PostHog tracking (`user_signed_up`)
- Consumer: Send welcome email (future)
- Consumer: Create default organization (future)

### 9. Organization Creation

**File:** `apps/os/backend/trpc/routers/organization.ts:40-56`

Could emit `organization:created` for:

- Future: provision default project
- Future: send Slack notification to team
- Future: analytics

## Lower Priority (Consider Later)

### 10. Daytona Webhooks (Future)

**File:** `tasks/daytona-webhooks-ui-updates.md`

When Daytona webhooks are implemented:

- Write to outbox
- Consumer updates machine state
- Consumer broadcasts to Pusher

### 11. PostHog Event Capture

**Files:** `apps/os/backend/lib/posthog.ts:49, 143`

Currently fire-and-forget. Could queue for:

- Batch sending
- Retry on failure
- Audit trail

### 12. OAuth Token Refresh

**File:** `apps/os/backend/services/oauth-refresh.ts`

Token refresh happens inline during egress proxy. Could emit:

- `oauth:token:refreshed` for audit
- `oauth:token:failed` to alert/escalate

## Implementation Notes

### Events from v2025 to Restore

```typescript
export type InternalEventTypes = {
  "testing:poke": { dbtime: string; message: string };
  "estate:build:created": EstateBuilderWorkflowInput & { buildId: string };
  "estate:created": { estateId: string };
};
```

### Consumer Registration Pattern

```typescript
cc.registerConsumer({
  name: "createStripeCustomer",
  on: "estate:created",
  async handler(params) {
    // ... create stripe customer
  },
});
```

### trpc Integration

The v2025 implementation has a trpc plugin that auto-emits events when procedures return `ctx.sendTrpc(tx, output)`. This enables:

```typescript
cc.registerConsumer({
  name: "sendWelcomeEmail",
  on: "trpc:integrations.setupSlackConnectTrial",
  handler: async (params) => {
    // params.payload.input and params.payload.output available
  },
});
```

## Migration Path

1. Port `apps/os/backend/outbox/` from v2025
2. Add migration for `outbox_event` table and pgmq queue
3. Start with Stripe webhook (highest value, clear boundaries)
4. Add machine lifecycle events
5. Migrate OAuth callbacks
6. Consider trpc plugin for automatic procedure events

## Reference

- v2025 branch files:
  - `apps/os/backend/outbox/client.ts`
  - `apps/os/backend/outbox/consumers.ts`
  - `apps/os/backend/outbox/pgmq-lib.ts`
  - `apps/os/backend/outbox/outbox-queuer.ts`
