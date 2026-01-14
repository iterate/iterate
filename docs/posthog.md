# PostHog Analytics Setup

This document describes the PostHog analytics implementation for user journey tracking across iterate.com (marketing) and os2.iterate.com (product).

## Architecture

```
iterate.com (anonymous)          os2.iterate.com (identified)
┌─────────────────────┐         ┌─────────────────────────────┐
│ User visits         │         │ User signs up               │
│ marketing page      │         │                             │
│                     │   URL   │ PostHog bootstraps with     │
│ PostHog assigns     │ ──────► │ distinct_id from URL        │
│ distinct_id: abc123 │ params  │                             │
│                     │         │ identify(userId) merges     │
│ Tracks: $pageview   │         │ abc123 → userId             │
└─────────────────────┘         └─────────────────────────────┘
```

## Cross-Domain Tracking

Since iterate.com and os2.iterate.com are different origins, cookies aren't shared. We use URL parameters to link sessions:

1. **iterate.com** (`apps/iterate-com/backend/routes/index.tsx`):
   - When user clicks "Add to Slack", we append `ph_distinct_id` and `ph_session_id` params

2. **os2.iterate.com** (`apps/os/app/routes/root.tsx`):
   - On init, PostHog reads URL params and bootstraps with the cross-domain IDs
   - When user signs up, `identify(userId)` merges anonymous events to the user

## Events Tracked

### Frontend Events

- `$pageview` - Automatic on route changes
- `$pageleave` - Automatic on page leave

### Backend Events (Auth)

- `user_signed_up` - When a new user is created (via better-auth hook)

### Backend Events (Stripe Webhooks)

- `subscription_started` - When subscription is created
- `invoice_paid` - When payment succeeds
- `payment_failed` - When payment fails

All backend events include:

- `distinctId`: First org member's userId
- `groups`: `{ organization: organizationId }`

## Stripe Integration

### Data Warehouse Sync

PostHog can sync Stripe data for revenue analytics. Configure in PostHog Dashboard:

1. Data Pipeline → Sources → Add Stripe
2. Create restricted API key with read permissions
3. Enable Revenue Analytics

### Customer Linking

Stripe customers are linked to PostHog persons via:

- **Email match**: Customer email matches person email
- **Metadata**: `createdByUserId` stored in Stripe customer metadata

## Key Files

| File                                                       | Purpose                                  |
| ---------------------------------------------------------- | ---------------------------------------- |
| `apps/iterate-com/backend/routes/index.tsx`                | Adds PostHog IDs to signup URLs          |
| `apps/iterate-com/backend/components/posthog-provider.tsx` | PostHog init for marketing site          |
| `apps/os/app/routes/root.tsx`                              | PostHog init with cross-domain bootstrap |
| `apps/os/app/hooks/use-posthog-identity.tsx`               | User identification logic                |
| `apps/os/backend/auth/auth.ts`                             | User signup event tracking               |
| `apps/os/backend/integrations/stripe/webhook.ts`           | Billing event tracking                   |
| `apps/os/backend/lib/posthog.ts`                           | Server-side event capture                |
| `apps/os/backend/trpc/routers/billing.ts`                  | Stripe customer creation with metadata   |

## Verification

1. **Cross-domain tracking**: Click signup on iterate.com → URL should contain `ph_distinct_id`
2. **Identity merge**: Sign up → Check PostHog person has marketing pageviews
3. **Billing events**: Subscribe → Check `subscription_started` event in PostHog
4. **Payment failure**: Simulate failed payment → Check `payment_failed` event

## Environment Variables

### iterate-com

- `POSTHOG_PUBLIC_KEY` - PostHog public key (injected at build time)

### os (apps/os)

- `VITE_POSTHOG_PUBLIC_KEY` - Frontend public key
- `VITE_POSTHOG_PROXY_URI` - Proxy endpoint (defaults to `/ingest`)
- `POSTHOG_KEY` - Backend API key for server-side events
