# PostHog

OS and Semaphore use the shared browser integration in
`packages/ui/src/components/posthog.tsx`. OS also sends its complete
non-ephemeral production durable-event feed and reports unhandled backend
exceptions. All traffic goes to the EU PostHog project.

## Browser integration

The shared SDK initialization enables Product Analytics, autocapture, feature
flags, surveys, web analytics, session replay, and browser exception tracking.
Replay masks text, attributes, and inputs; request and response bodies and
headers remain disabled. TanStack Router supplies resolved pageviews and its
global `defaultOnCatch` reports errors handled by route boundaries.

The authenticated user is the PostHog person. OS calls `identify` with the
immutable user ID and resets the SDK on sign-out or a user change. With
`person_profiles: "identified_only"`, anonymous events do not create person
profiles.

OS has two group types:

- `organization`, keyed by immutable organization ID;
- `project`, keyed by immutable project ID.

The browser synchronizes the active organization and route project with the
SDK before capturing the resolved pageview. PostHog then attaches that
persistent group context to subsequent autocapture, replay, exception, and
custom events. A user is not also modelled as a group. Project-operator auth
uses a synthetic organization internally; that authorization-only value is
not sent as an analytics group.

## First-party proxy

Both TanStack Start apps expose `/e/$` as a small same-origin proxy:

- `/e/static/*` and `/e/array/*` go to `eu-assets.i.posthog.com`;
- all other paths go to `eu.i.posthog.com`;
- application cookies are removed before forwarding.

PostHog is configured with `api_host: "/e"` and
`ui_host: "https://eu.posthog.com"`. Keep the `/e` path obscure and stable;
changing it requires updating both the route and SDK configuration.

## Durable stream feed

Only `os-prd` exports durable stream events. Preview and local workers produce
synthetic projects at CI scale and acknowledge the durable subscription
without sending those facts to PostHog. Ephemeral events are excluded in both
the subscription and capture paths.

Every production row is named `stream:append` and contains the complete
committed `StreamEvent` under `stream_event`. The committed stream type is
**not** part of the PostHog event name — it lives on `stream_event_type` (and
inside the raw event) so the catalogue stays one event while queries still
filter and break down by type. The only other custom properties beside the raw
event are `stream_path`, `stream_event_truncated`, and
`stream_event_original_json_bytes`. Nested raw fields remain available in
HogQL; type and path are promoted because they are the common UI filters and
breakdowns. The only payload reduction is deterministic JSON truncation above
100 KiB.

Machine events do not pretend to have a human actor. They use one stable,
namespaced distinct ID per deployment/project and carry
`$groups: { project: projectId }`. The authentic root project birth emits the
project group metadata and labels the synthetic person `project:<slug>` for a
readable activity feed. The exporter does not query the project directory or
derive an organization for machine traffic; project is its complete grouping
boundary.

These events are intentionally identified and grouped. Once Group Analytics is
enabled, PostHog charges identified-event and group processing according to
the organization's aggregate tier placement, not merely the number of unique
profiles. See the
[2026-07-18 cost investigation](./posthog-stream-cost-investigation-2026-07-18.md).

## Exception tracking

Browser exceptions are captured by PostHog's standard JS exception integration
and TanStack Router's global caught-error hook. OS backend boundaries create a
fresh `posthog-node` client per Cloudflare invocation, use `flushAt: 1` and
`flushInterval: 0`, and flush via `waitUntil`. Nested request and server-function
boundaries deduplicate against the same Cloudflare execution context. When a
user or project is already known, the exception carries that person and
project group; capturing telemetry can never replace the original product
error.

The production project's error-tracking project-wide and per-issue ingestion
limits were both unset when audited on 2026-07-18. Configure explicit warning
and billing limits in PostHog before materially expanding exception volume;
limits can permanently drop data, so their values and owner belong in the
operational rollout rather than source code.

## Source maps and credentials

`@posthog/rollup-plugin` runs only for deployed OS builds. It uploads both the
browser and Cloudflare Worker source maps, injects PostHog chunk IDs used for
symbolication, and deletes local map files after upload.

Doppler supplies two different credential classes:

- `APP_CONFIG_POSTHOG` contains the public project ingest key used at runtime;
- `POSTHOG_PERSONAL_API_KEY` and `POSTHOG_PROJECT_ID` are build-only source-map
  credentials passed to Vite by `apps/os/scripts/deploy.ts`.

Never add the personal API key or project ID to Wrangler bindings. Production
and preview use separate PostHog projects, and each deploy uploads maps to the
project selected by that environment's Doppler config.

## Key files

| File                                          | Purpose                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------ |
| `packages/ui/src/components/posthog.tsx`      | Shared browser SDK initialization, identity, groups, pageviews, and exceptions |
| `packages/ui/src/apps/providers.tsx`          | Initializes PostHog in shared app shells                                       |
| `apps/os/src/components/posthog-context.tsx`  | Maps OS auth and resolved routes to browser context                            |
| `apps/os/src/routes/e.$.ts`                   | OS proxy route                                                                 |
| `apps/semaphore/src/routes/e.$.ts`            | Semaphore proxy route                                                          |
| `packages/shared/src/posthog/posthog.ts`      | Streaming EU proxy helper                                                      |
| `apps/os/src/domains/integrations/posthog.ts` | Production durable stream exporter                                             |
| `apps/os/src/observability/posthog.ts`        | Cloudflare backend exception capture                                           |
| `apps/os/vite.config.ts`                      | Frontend and Worker source-map upload                                          |

## Verification

The unit tests cover browser initialization and identity ordering, resolved
route context, proxy routing, complete durable payload preservation, stable
project identity, environment gating, exception delivery, and source-map build
credentials. Before deployment, run the normal repository gate and React
Doctor. A preview acceptance check must additionally confirm that:

1. browser and Worker symbol sets upload to the preview PostHog project;
2. no `.map` files are served publicly after the build;
3. a deliberate browser error and Worker error both resolve to their original
   TypeScript locations;
4. `/e` supports capture, flags, surveys, and session-replay asset requests.
