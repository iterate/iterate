# PostHog Analytics Setup

Cross-domain tracking between iterate.com (marketing) and the OS product app (`apps/os`).

## Architecture

```
iterate.com (anonymous)          os.iterate.com / os.iterate.com (identified)
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

Different origins do not share cookies. The reading side exists in shared code: `setupPosthog` in `packages/ui/src/components/posthog.tsx` bootstraps PostHog from `ph_distinct_id` / `ph_session_id` URL query params when `bootstrapFromUrl` is enabled (the default in `packages/ui/src/apps/providers.tsx`). Nothing currently appends those params to outbound links — a sender would need to add them for cross-domain identity to merge.

## Key Files

| File                                                       | Purpose                                                  |
| ---------------------------------------------------------- | -------------------------------------------------------- |
| `packages/ui/src/components/posthog.tsx`                   | Shared client init; bootstraps from `ph_*` URL params    |
| `packages/ui/src/apps/providers.tsx`                       | Wires `setupPosthog` + `PostHogProvider` into app shells |
| `apps/iterate-com/backend/components/posthog-provider.tsx` | PostHog init for marketing site                          |
| `apps/os/src/routes/posthog-proxy.$.ts`                    | Worker proxy route for PostHog ingest                    |
| `packages/shared/src/posthog/`                             | Shared proxy + sourcemap helpers                         |

Search `apps/os` for PostHog client init and identity hooks when wiring new UI surfaces.

## Environment Variables

Configured in Doppler for `os` and `iterate-com`:

- `POSTHOG_PUBLIC_KEY` — server-side project API key
- `VITE_POSTHOG_PUBLIC_KEY` — client key (often aliased from `POSTHOG_PUBLIC_KEY`)
- `VITE_APP_STAGE` — included as `$environment` on events (`dev_*`, `preview_N`, `prd`)

## Verification

1. Open an app with `?ph_distinct_id=<id>` appended → PostHog bootstraps with that distinct id
2. Browse a few pages → events arrive in PostHog under that distinct id with the expected `$environment`
3. Exercise billing flows → confirm subscription/payment events if enabled for the environment
