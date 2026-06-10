# SLACK domain — class-based stream processor migration notes

Migrates the `slack` and `slack-agent` processors from
`packages/shared/src/stream-processors/` onto the class-based `StreamProcessor`
model (see `apps/os/tasks/stream-processor-class-migration-log.md`, D1–D11).
Originals in `packages/shared` are left in place for the orchestrator to delete.

## What moved where

- `apps/os/src/domains/slack/stream-processors/slack/{contract,implementation,slack.test}.ts`
  — `SlackProcessor`, hosted on `SlackIntegrationDurableObject` as
  `host.add("slack", ...)` (name = contract slug).
- `apps/os/src/domains/slack/stream-processors/slack-agent/{contract,implementation,slack-agent.test}.ts`
  — `SlackAgentProcessor`, hosted on `SlackAgentDurableObject` as
  `host.add("slack-agent", ...)`.
- Both DOs gained `host = createStreamProcessorHost(this.ctx)` and a public
  `requestStreamSubscription` (initializes lifecycle from the runtime name
  first, so deps that need `projectId` work on a fresh instance).

## Wire compatibility

- Event types, payload schemas, and emitted idempotency keys are unchanged:
  `slack-route:${channel}:${threadTs}`, `slack/forward-slack-webhook@<offset>`,
  `slack-agent/register-slack-agent-tool-provider@<offset>`,
  `slack-agent/slack-webhook-to-agent-input@<offset>`,
  `slack-agent/slack-bang-command-to-codemode-script@<offset>`,
  `slack-agent/slack-agent-thread-info-function-call-completed@<offset>`.
- Subscription-configured appends switched to callable subscribers (D2) with
  NEW idempotency keys (`:callable` suffix) so they land on streams that
  already carry the legacy built-in subscription:
  - `/integrations/slack`: `slack-subscription:${projectId}:workers-rpc:callable`
    → `durableObjectProcessorSubscriber({ bindingName: "SLACK_INTEGRATION", ... , processorName: "slack" })`
    (binding names verified against `apps/os/alchemy.run.ts`).
  - routed streams (in `routedStreamBootstrapEvents`):
    `slack-agent-subscription:${projectId}:${streamPath}:workers-rpc:callable`
    → `bindingName: "SLACK_AGENT"`, `processorName: "slack-agent"`. The host DO
    name is derived inside the function (`getSlackAgentDurableObjectName`)
    rather than taken from the (legacy, always-empty) input field; the input
    signature is unchanged because the legacy runner still calls it.
  - The codemode and agent-host bootstrap subscriptions in
    `routedStreamBootstrapEvents` were left on the legacy built-in shape — they
    belong to other domains' migrations.

## Decisions

1. **Contracts use streams' `defineProcessorContract`.** `SlackProcessorContract`
   gains `processorDeps: [CoreProcessorContract]` (streams core) so its
   `stream/subscription-configured` emit resolves with the callable-capable
   payload schema instead of the old local literal-`built-in` schema.
   `SlackAgentProcessorContract` keeps depending on the shared
   `AgentProcessorContract`/`CodemodeProcessorContract` (not yet migrated) plus
   the new os-local `SlackProcessorContract`.
2. **standardProcessorBehavior dropped** (D11): `hasRegisteredCurrentVersion`
   left the state schemas, `core/stream-processor-registered` left
   consumes/emits. The host now appends `stream/processor-registered` after
   each handshake. Checkpoint state starts fresh in DO KV, so the state-shape
   change is not a migration concern.
3. **Side-effect mapping** (old `afterAppend` → `processEvent`):
   - Slack Web API sequences run in `blockProcessorWhile`; ordered pairs share
     one closure to keep the legacy "commit append, then add eyes reaction"
     ordering (covered by a test).
   - Pure idempotency-keyed appends (route + forward fan-out, provider
     registration, threadInfo completion) run in `runInBackground` per the
     design-note default for idempotent appends.
   - The DO-level `callSlackApi` dep keeps the legacy error-swallowing wrapper
     (Slack API failures log, never wedge the checkpoint).
4. **`shouldApplySideEffects` / `firstAttachAfterAppend` deleted**: the base
   class `sideEffectsAfterOffset` anchor (set by the host to the
   subscription-configured offset, D5) replaces both. slack-agent's old 60s
   lookback is covered because the bootstrap batch appends the subscription
   before the route/webhook events on a fresh routed stream.
5. **Catch-up polling** (`waitFor*ProcessorCatchUp` / `getRunnerState`) now
   reads the local processor snapshot instead of the retired
   `STREAM_PROCESSOR_RUNNER`. Because delivery is contract-filtered (D9), the
   checkpoint trails the stream head when trailing events are non-consumed, so
   the catch-up target is the max offset of _consumed-type_ events from
   `stream.history`, not the raw max offset. `getRunnerState` keeps the legacy
   `{ processorSlug, snapshot, state, reducedThroughOffset, afterAppendCompletedThroughOffset }`
   shape for callers (`integration-api` ensureReady path).
6. **`@slack/types` dropped** in the migrated implementations (not an apps/os
   dependency; the code only ever did structural record probing).
7. **`slackAgentProcessorRunnerName` / `slackIntegrationProcessorRunnerName`
   deleted** — runner-name derivation has no meaning without the runner DO; no
   external importers existed.

## Out-of-boundary change (required)

- `pnpm-lock.yaml`: the `packages/streams` importer resolved `zod@^4.3.6` to
  4.4.3 while apps/os and packages/shared resolve to 4.3.6. Two zod instances
  make every cross-package `defineProcessorContract` call fail deep
  type-identity checks (`$ZodCheck` invariance). Pinned the streams importer to
  4.3.6 (one line + `pnpm install`); streams typecheck/tests stay green. Every
  other domain migration will need this too.

## Issues / follow-ups for the orchestrator

- **Existing routed Slack threads only get the callable `slack-agent`
  subscription via the route-creation path.** Threads routed before this
  migration take the "known route → forward only" branch, so their streams
  keep only the legacy built-in subscription (dropped by the new core) until
  something re-appends the bootstrap batch. If existing threads must keep
  working without a new route event, the router (or another ensure-path) needs
  to re-append `routedStreamBootstrapEvents` idempotently on forward. Mirrors
  the D2/I3 idempotency-key concern; left unfixed because it changes
  legacy-path behavior beyond this slice's scope.
- `SlackIntegrationDurableObject.afterAppend` / `SlackAgentDurableObject.afterAppend`
  (legacy watcher-shaped entry points) have no callers I could find; kept with
  snapshot-backed return values, but they are candidates for deletion.
- The legacy `StreamProcessorRunner` in apps/os currently fails typecheck on
  this branch (renamed echo/circuit-breaker exports from #1401's class
  migration) — pre-existing, outside the slack boundary.
