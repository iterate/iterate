---
status: implemented
size: small
branch: posthog-skip-nonprod
---

# PostHog: skip sending all events from non-production environments

## Status summary

Implemented, all checks green, PR open (draft):
https://github.com/iterate/iterate/pull/2494. Two pieces:

1. Every app PostHog client (browser, server exceptions, durable stream
   events) gates on one shared `shouldSendPosthogEvents(environment)`
   predicate — non-prod deployments no-op at egress.
2. CI telemetry PostHog delivery downsampled to ZERO: `sendPostHogEvents` in
   `scripts/ci/posthog-events.ts` drops everything (artifacts still written).
   CI test events were 70%+ of all ingestion (~13M/month at the July run
   rate); the `CI_TELEMETRY_POSTHOG_ENABLED` escape hatch is gone.

Remaining: review.

## Motivation

Our PostHog bill is too high. Preview slots, local dev, and shared dev all
send real events (pageviews, session recordings, exceptions, durable stream
events) to the same PostHog project as production. None of that non-prod
traffic is worth its ingestion cost. Downsampling
(https://posthog.com/docs/cdp/transformations/downsampling-plugin) was
considered but is server-side, more involved, and still ingests; client-side
"don't send" is free and simpler.

## Design

One shared predicate, applied at each client's egress point (`before_send`
for the browser SDK), so no feature code changes:

- `packages/shared/src/posthog/posthog.ts` gains
  `shouldSendPosthogEvents(environment: string | undefined): boolean` —
  true only for production deployments. The environment string is the worker
  name (`os-prd`, `semaphore-prd`, `os-preview-3`, undefined for local dev).
  Production = `prd` or `*-prd`.
- Every client already tags events with `$environment` derived from the same
  worker name, so the gate input already exists at each site.

### Assumptions (made while fleshing out, AFK-style)

- "Non-production" = anything whose worker name isn't `*-prd`: preview slots,
  local dev (`pnpm dev`), `dev_<you>`, CI e2e runs against previews. Semaphore
  prd counts as production (it's a real deployed surface; its traffic is tiny).
- ~~CI test telemetry (`scripts/ci/*` → posthog-events.ts etc.) is a
  deliberate, separate pipeline and stays untouched.~~ _Superseded: the bill
  analysis (PostHog HogQL, 30 days) showed CI telemetry was 71% of all
  ingestion — Misha asked for it to be downsampled to zero in this PR._
- We gate in code rather than only flipping `capture`/`sendStreamEvents` in
  non-prd Doppler configs: config-only is invisible, easy to regress, and the
  browser client in semaphore isn't gated by any flag today. The existing
  config flags remain as-is (they still gate prod behavior).
- Feature flags / surveys / toolbar still work in non-prod (SDK still
  initializes); we only drop outgoing capture traffic. Session recording is
  additionally disabled in non-prod since its `$snapshot` events would be
  dropped anyway — no point paying the runtime overhead.

## Checklist

- [x] `shouldSendPosthogEvents(environment)` in `packages/shared/src/posthog/posthog.ts` + unit test
      _`prd` or `*-prd` only; tested in posthog.test.ts alongside the proxy tests_
- [x] Browser SDK (`packages/ui/src/components/posthog.tsx`): `before_send` hook in
      `buildPosthogInitOptions` that drops every event when
      `!shouldSendPosthogEvents(appStage)`; disable session recording in that case too
      _both in `buildPosthogInitOptions`; SDK still initializes so flags/toolbar work_
- [x] Semaphore passes an environment identifier (`appStage`) to `AppProviders`
      so its browser client goes through the same gate
      _new `workerName` publicValue in semaphore config, emitted as
      `APP_CONFIG_WORKER_NAME` by generate-wrangler-config, passed in `__root.tsx`_
- [x] Server exception capture (`apps/os/src/observability/posthog.ts`):
      early-return in `schedulePosthogException` when the gate says no
- [x] ~~Durable stream events (`apps/os/src/rpc-targets.ts`)~~ gate placed inside
      `capturePosthogStreamEventBatch` (`apps/os/src/domains/integrations/posthog.ts`)
      instead — it already receives `workerName` and is directly testable;
      rpc-targets untouched
- [x] Tests: gate behavior covered in existing posthog test files
      _shared predicate, os observability (preview + undefined worker), stream
      batch no-egress, browser init options in posthog-url-bootstrap.test.ts_
- [x] `pnpm typecheck && pnpm lint && pnpm knip && pnpm format && pnpm test`
      _all green locally 2026-08-13_

## Alternatives considered

- **Doppler config flip only** (set `capture=false`, `sendStreamEvents=false`
  in non-prd configs): zero code, but silently regressable, doesn't cover
  semaphore's browser client, and leaves nothing in the repo explaining why.
- **PostHog-side downsampling transformation**: still ingests (billing),
  affects prod data quality, needs PostHog-side config nobody can code-review.

## Bill analysis (2026-08-13, via PostHog HogQL)

30-day org totals: prd project 16.9M events, stg 3.2M, dev 0.19M, ~20.3M
total. prd breakdown: 71% CI test telemetry, 29% prod stream:append, 0.03%
browser/product. stg's 3.2M was a one-off July 15–18 burst of preview stream
events (2.67M on July 17 alone) — the exact accident the code gate prevents.
Current steady state: non-prod ~11 events/day, CI telemetry bursting only
from branches that re-enable it (441k on Aug 10–11 from
`fix/posthog-ci-delivery-fence`).

Note: PR #2446 (Jonas, Aug 6) deliberately removed an earlier worker-name
gate from `capturePosthogStreamEventBatch` in favor of config flags only.
This PR re-adds a worker-name gate — deliberately, because the July burst
shows config flags alone regress silently.

## Implementation log

- 2026-08-13 (later): CI telemetry downsampled to zero at the
  `sendPostHogEvents` chokepoint — batching/retry/credential code deleted
  (recoverable from git history), `CI_TELEMETRY_POSTHOG_ENABLED` checks
  removed from both callers so the code can't suggest an env var re-enables
  delivery. Artifact writing and CI-storage upload untouched.
- 2026-08-13: one shared predicate + four egress gates, ~40 lines of product
  code. Notable deviation from the spec: the stream-event gate lives in
  `capturePosthogStreamEventBatch` rather than the rpc-target, because the
  function already takes `workerName` and its test file could cover the gate
  directly. The os "defaults" browser test
  (`apps/os/src/lib/posthog-url-bootstrap.test.ts`) now inits with
  `appStage: "os-prd"` since the no-stage default is deliberately fail-closed.
