# PostHog

OS and Semaphore initialize PostHog through the shared UI package. The
marketing site has a separate provider. OS also exports its non-ephemeral
production durable-event feed. OS uses PostHog people plus organization and
project groups as one shared product-analytics model across browser and stream
activity.

## OS identity and groups

The authenticated user is the PostHog person. After authentication, OS calls
`identify` with the immutable user ID and current user properties. It resets the
SDK on sign-out or a user change so one browser cannot leak identity or groups
into the next session. A user is not also modelled as a group.

OS has two group types:

- `organization`, keyed by the immutable organization ID;
- `project`, keyed by the immutable project ID.

The browser attaches the active organization and route project to subsequent
events and also registers `organization_id` and `project_id` as ordinary event
properties. Ordinary properties keep HogQL queries and basic breakdowns simple;
the group keys enable group funnels, cohorts, properties, feature flags, and
experiments. Operator-only synthetic authorization organizations are excluded
because they are not product organizations.

Machine-authored stream facts do not have a human actor. They use one stable,
namespaced PostHog distinct ID per deployment/project instead. Every exported
`stream:append` is linked to its `project` group and, when the project belongs
to one, its `organization` group. The authentic root project birth emits the
group records and project metadata. These rows are intentionally identified and
therefore intentionally incur both identified-event and Group Analytics
processing. A missing project-directory record rejects the delivery instead of
silently emitting an event with incomplete group context; the durable stream
retry/park state preserves that failure for diagnosis.

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
| `apps/os/src/components/posthog-context.tsx`               | Synchronizes OS browser person and groups |
| `apps/os/src/routes/posthog-proxy.$.ts`                    | Worker proxy route for PostHog ingest     |
| `apps/os/src/domains/integrations/posthog.ts`              | Production durable stream event exporter  |
| `packages/shared/src/posthog/`                             | Shared PostHog ingest proxy helper        |

## Durable stream feed

Only `os-prd` exports durable stream events. Preview and local workers produce
synthetic projects at CI scale and must acknowledge the durable PostHog
subscription without sending it to PostHog. Ephemeral events are excluded in
both the subscription and capture paths. Production events retain the complete
committed stream fact, bounded by the documented 100 KiB JSON limit, with
immutable project/organization group keys and ordinary ID properties.

PostHog bills Product Analytics by captured event count. Once Group Analytics
is enabled, all identified events in the PostHog project are processed by that
add-on, not only events containing a group key. Cost forecasts must therefore
use organization-wide tier placement as well as the source's event rate; the
same 40,000 events/day can have materially different marginal cost depending on
whether the free and first-paid bands were already consumed.

See the
[2026-07-18 stream cost investigation](./posthog-stream-cost-investigation-2026-07-18.md)
for the environment attribution, payload analysis, loop checks, emergency
control, cost model, and monitoring recommendations.

## Verification

1. `apps/os/src/lib/posthog-url-bootstrap.test.ts` proves URL parameters cannot
   influence initialization and verifies identify/group/reset ordering.
2. `apps/os/src/components/posthog-context.test.ts` verifies the user,
   organization, project, route, and operator-session model.
3. `apps/os/src/domains/integrations/posthog.test.ts` verifies every production
   stream row's identity and group mapping, durable payload preservation,
   environment gate, retry identity, and group metadata.
4. Browse authenticated organization and project routes and confirm page and
   interaction events resolve to the same groups as `stream:append` events.
