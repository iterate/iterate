---
status: in-progress
size: small
branch: posthog-skip-nonprod
---

# PostHog: skip sending all events from non-production environments

## Status summary

Spec fleshed out, implementation not started. Goal: cut the PostHog bill by
making every PostHog client in the repo a no-op outside production, with one
shared gate so application code stays unaware.

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
- CI test telemetry (`scripts/ci/*` → posthog-events.ts etc.) is a deliberate,
  separate pipeline and stays untouched. If the bill analysis shows it's a big
  contributor, that's a follow-up task.
- We gate in code rather than only flipping `capture`/`sendStreamEvents` in
  non-prd Doppler configs: config-only is invisible, easy to regress, and the
  browser client in semaphore isn't gated by any flag today. The existing
  config flags remain as-is (they still gate prod behavior).
- Feature flags / surveys / toolbar still work in non-prod (SDK still
  initializes); we only drop outgoing capture traffic. Session recording is
  additionally disabled in non-prod since its `$snapshot` events would be
  dropped anyway — no point paying the runtime overhead.

## Checklist

- [ ] `shouldSendPosthogEvents(environment)` in `packages/shared/src/posthog/posthog.ts` + unit test
- [ ] Browser SDK (`packages/ui/src/components/posthog.tsx`): `before_send` hook in
      `buildPosthogInitOptions` that drops every event when
      `!shouldSendPosthogEvents(appStage)`; disable session recording in that case too
- [ ] Semaphore passes an environment identifier (`appStage`) to `AppProviders`
      so its browser client goes through the same gate
- [ ] Server exception capture (`apps/os/src/observability/posthog.ts`):
      early-return in `schedulePosthogException` when the gate says no
- [ ] Durable stream events (`apps/os/src/rpc-targets.ts`
      `PostHogIntegrationRpcTarget`): same gate next to the existing
      `sendStreamEvents` check
- [ ] Tests: gate behavior covered in existing posthog test files
- [ ] `pnpm typecheck && pnpm lint && pnpm knip && pnpm format && pnpm test`

## Alternatives considered

- **Doppler config flip only** (set `capture=false`, `sendStreamEvents=false`
  in non-prd configs): zero code, but silently regressable, doesn't cover
  semaphore's browser client, and leaves nothing in the repo explaining why.
- **PostHog-side downsampling transformation**: still ingests (billing),
  affects prod data quality, needs PostHog-side config nobody can code-review.

## Implementation log

(added as work happens)
