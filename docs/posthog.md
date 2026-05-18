# PostHog Analytics Setup

Cross-domain tracking between iterate.com (marketing) and the OS product app (`apps/os2`).

## Architecture

```
iterate.com (anonymous)          os.iterate.com / os2.iterate.com (identified)
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

Different origins do not share cookies. Marketing passes PostHog IDs on signup links:

1. **iterate.com** — `apps/iterate-com/backend/routes/index.tsx` appends `ph_distinct_id` and `ph_session_id` on outbound product links.
2. **OS app** — client init reads those params and bootstraps PostHog before `identify(userId)` on signup.

## Key Files

| File                                                       | Purpose                               |
| ---------------------------------------------------------- | ------------------------------------- |
| `apps/iterate-com/backend/routes/index.tsx`                | Adds PostHog IDs to signup URLs       |
| `apps/iterate-com/backend/components/posthog-provider.tsx` | PostHog init for marketing site       |
| `apps/os2/src/routes/posthog-proxy.$.ts`                   | Worker proxy route for PostHog ingest |
| `packages/shared/src/posthog/`                             | Shared proxy + sourcemap helpers      |

Search `apps/os2` for PostHog client init and identity hooks when wiring new UI surfaces.

## Environment Variables

Configured in Doppler for `os2` and `iterate-com`:

- `POSTHOG_PUBLIC_KEY` — server-side project API key
- `VITE_POSTHOG_PUBLIC_KEY` — client key (often aliased from `POSTHOG_PUBLIC_KEY`)
- `VITE_APP_STAGE` — included as `$environment` on events (`dev_*`, `preview_N`, `prd`)

## Verification

1. Click signup on iterate.com → URL contains `ph_distinct_id`
2. Sign up in OS → person in PostHog includes marketing pageviews
3. Exercise billing flows → confirm subscription/payment events if enabled for the environment
