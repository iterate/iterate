# PostHog browser setup

OS and Semaphore initialize PostHog through the shared UI package. The
marketing site has a separate provider.

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
| `packages/shared/src/posthog/`                             | Shared PostHog ingest proxy helper        |

## Verification

1. `apps/os/src/lib/posthog-url-bootstrap.test.ts` proves URL parameters cannot
   influence shared initialization.
2. Browse a few pages and confirm events arrive in the intended PostHog project.
