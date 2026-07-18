# PostHog

OS and Semaphore initialize PostHog through the shared UI package. The
marketing site has a separate provider. OS also exports its non-ephemeral
production durable-event feed for operational analysis.

## Identity Boundary

The shared provider does not accept PostHog distinct or session IDs from URL
parameters because query parameters are untrusted input. Any future
cross-domain identity handoff needs a separately reviewed, server-issued,
integrity-protected design.

## Key Files

| File                                                       | Purpose                                   |
| ---------------------------------------------------------- | ----------------------------------------- |
| `packages/ui/src/components/posthog.tsx`                   | Shared OS/Semaphore client initialization |
| `packages/ui/src/apps/providers.tsx`                       | Initializes PostHog in shared app shells  |
| `apps/iterate-com/backend/components/posthog-provider.tsx` | PostHog init for marketing site           |
| `apps/os/src/routes/posthog-proxy.$.ts`                    | Worker proxy route for PostHog ingest     |
| `apps/os/src/domains/integrations/posthog.ts`              | Production durable stream event exporter  |
| `packages/shared/src/posthog/`                             | Shared PostHog ingest proxy helper        |

## Durable stream feed

Only `os-prd` exports durable stream events. Preview and local workers produce
synthetic projects at CI scale and must acknowledge the durable PostHog
subscription without sending it to PostHog. Ephemeral events are excluded in
both the subscription and capture paths.

See the
[2026-07-18 stream cost investigation](./posthog-stream-cost-investigation-2026-07-18.md)
for the environment attribution, payload analysis, loop checks, emergency
control, cost model, and monitoring recommendations.

## Verification

1. `apps/os/src/lib/posthog-url-bootstrap.test.ts` proves URL parameters cannot
   influence shared initialization.
2. Browse a few pages and confirm events arrive in the intended PostHog project.
