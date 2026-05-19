---
state: todo
priority: high
size: large
dependsOn: []
---

# Make stream callable subscriber delivery independent

Slack agent reactions regressed from roughly 1-2 seconds to roughly 15-20
seconds on cold Slack threads because callable subscribers on a stream were
effectively serialized behind whichever subscriber the Stream Durable Object
picked first.

The desired behavior is: every subscriber should deliver events as quickly as it
can, independently from other subscribers, while preserving event order within a
single subscriber.

## Findings

Slack routed streams are bootstrapped with at least two callable subscribers:

1. `slack-agent:<projectId>:<streamPath>`
2. `agent:<projectId>:<streamPath>`

`slack-agent` owns lightweight Slack side effects, including adding the `eyes`
reaction and forwarding bang commands into codemode. The generic `agent`
subscriber owns heavier agent startup, including workspace setup, repo state,
codemode session wiring, provider registration, LLM setup, and websocket
subscriptions.

The stream runtime kept a callable delivery queue per subscriber, but the
delivery selector sorted subscriber slugs alphabetically and selected one
subscriber delivery per alarm. Since `agent:...` sorts before `slack-agent:...`,
new Slack thread handling often ran heavy generic agent startup before the
lightweight Slack side effects.

Production evidence from 2026-05-19:

- Slow stream: `/agents/slack/c08r1smtzgd/ts-1779192365-251829`
- Human Slack message timestamp: `2026-05-19T12:06:05.251829Z`
- Routed stream webhook event appended: `2026-05-19T12:06:11.280Z`
- LLM provider setup observed: `2026-05-19T12:06:12.763Z`
- LLM request requested: `2026-05-19T12:06:26.566Z`
- First Slack output: `2026-05-19T12:06:30.381Z`
- Slack post completed: `2026-05-19T12:06:32.157Z`
- `eyes` reaction event timestamp: `2026-05-19T12:06:25.009800Z`
- OS received the reaction webhook back from Slack: `2026-05-19T12:06:27.713Z`

Cloudflare traces matched this shape. A routed stream alarm spent about 7.8s in
`AgentDurableObject.afterAppend` while the Slack-specific subscriber was still
waiting for its turn.

## Suspicious Changes

- `8e21410f2` - "Add OS2 integrations and Slack stream-agent routing"
  - Introduced Slack routed streams and callable subscriber routing.
  - The callable subscriber delivery selector sorted subscriber slugs, which put
    `agent:` before `slack-agent:`.

- `b42281cf1` - "Add OS2 repos and prepared agent workspaces"
  - Made generic agent startup heavier by awaiting prepared workspace setup.
  - This is not wrong by itself, but it made the delivery-ordering bug much more
    visible.

- `74d4f834a` - lowered agent debounce from 1000ms to 200ms.
  - This is unlikely to be the cause of `eyes` latency and should usually
    improve response latency.

## Current Implementation Direction

The intended fix is independent callable subscriber delivery:

- At most one active delivery per subscriber slug.
- Different subscriber slugs may deliver concurrently.
- Each subscriber removes only its own delivered offset.
- A fast subscriber schedules its next delivery turn without waiting for slow
  subscribers to finish.

The current implementation work adds:

- `packages/shared/src/streams/callable-subscriber-delivery.ts`
  - Selects one queued offset for every currently inactive subscriber.
  - Leaves active subscribers alone.

- `packages/shared/src/streams/callable-subscriber-delivery.test.ts`
  - Covers one queued event per inactive subscriber.
  - Covers a fast `slack-agent` subscriber continuing while `agent` is active.
  - Covers skipping active subscribers.

- `packages/shared/src/streams/stream-durable-object.ts`
  - Starts one fire-and-forget delivery per inactive subscriber.
  - Tracks active subscriber slugs in memory.
  - On completion, removes only that subscriber's offset and reschedules if more
    queue work remains.

This is the right high-level shape, but it exposed real reentrancy and startup
ordering assumptions elsewhere in `apps/os`.

## Reentrancy Issues Already Found

Independent subscriber delivery made `agent` and `slack-agent` startup overlap.
That surfaced these hazards:

- Prepared repo creation could race and fail with
  `repo already exists: <project>--iterate-config`.
- Stream processor registration could race and fail with
  `Stream processor "agent-chat" is already registered`.
- `slack-agent` could emit a codemode script request before generic `agent`
  startup had created the codemode session and registered providers.
- `CodemodeSessionDurableObject` could receive provider/script events before an
  explicit initialize call and throw `Durable Object has not been initialized`.

Patches currently in flight address part of this:

- Repo creation is serialized per Repo Durable Object instance and recovers if
  the artifact repo already exists.
- Stream processor registration is idempotent for the same slug/version.
- Slack routed stream bootstrap now includes codemode session startup events and
  baseline providers.
- Codemode session methods can initialize themselves from their runtime Durable
  Object name when needed.

## Real Slack Bot-Message Probe

After the subscriber delivery and bootstrap fixes, the focused prod e2e passed,
but a real Slack probe still did not wake the agent:

- Probe message: `<@U08NQR1GCRE> codex latency probe ...`
- Sender: another Slack bot user, `U0964BNAYEM` / `B0964BNAJEM`
- Routed stream: `/agents/slack/c08r1smtzgd/ts-1779197713-901949`

The integration stream routed the event correctly, and the routed stream
bootstrapped `slack-agent`, codemode, and the generic agent. However, no
`agent/input-added` event appeared for the message. The `slack-agent` processor
was still filtering any Slack event with a `bot_id` or `bot_profile`, which
meant messages from other bots could not wake Iterate.

The desired policy is narrower:

- Ignore actions performed by our own Iterate bot user.
- Do not ignore messages from other bots.
- Other bots may wake Iterate just like human users.

The implemented patch removes the broad `isBotMessage` filter and keeps only the
`isBotAction(slackEvent, state.botUserId)` guard.

Production verification after the patch:

- Probe message timestamp: `1779198240.251909`
- OS received the Slack message webhook: `2026-05-19T13:44:06.530Z`
- Routed stream configured: `2026-05-19T13:44:06.903Z`
- Routed stream initialized: `2026-05-19T13:44:07.972Z`
- `slack-agent` registered: `2026-05-19T13:44:10.802Z`
- `agent/input-added` for the other bot message: `2026-05-19T13:44:11.208Z`
- `eyes` reaction webhook received back from Slack: `2026-05-19T13:44:13.979Z`
- LLM request requested: `2026-05-19T13:44:17.738Z`
- Slack reply posted: `2026-05-19T13:44:25.297Z`
- The reply text reported `23727ms since 2026-05-19T13:44:00.032Z`.

This confirms the bot-message filter bug is fixed, but the overall live reply
latency is still much higher than the old 1-2 second target.

## Current State After 2026-05-19 Revert

The product design is now explicit:

- Provider registrations remain separate stream events.
- Each provider registration is transcribed into its own `agent/input-added`
  event.
- A separate generic Agent Durable Object still owns the agent loop.
- A separate Slack Agent Durable Object still owns Slack-specific routing and
  Slack side effects.
- Performance work must make this event volume cheap; it must not collapse
  provider registrations into one synthetic input.

A short-lived provider-summary experiment violated that design by marking
codemode provider registration events as pre-rendered and appending one synthetic
agent input summarising providers. That caused the bot to respond to the
provider summary rather than the Slack user message. The experiment was reverted:

- Removed `skipProviderRegistrationInput` handling from the agent processor.
- Removed the synthetic Slack provider-summary input.
- Removed the test that asserted provider-registration rendering could be
  skipped.

Validation after the revert:

- `pnpm --dir packages/shared exec vitest run src/stream-processors/agent/implementation.test.ts src/streams/callable-subscriber-delivery.test.ts src/streams/external-subscriber.test.ts src/stream-processors/slack-agent/slack-agent.test.ts`
  passed: 37 tests.
- `pnpm --filter @iterate-com/shared typecheck` passed.
- `pnpm --dir apps/os typecheck` passed.
- Production deploy to `prd` completed.
- Focused production Slack e2e passed:
  `routes Slack webhooks into slack-agent streams and executes bang command replies`.

The latest good latency improvement is on the ingress reaction path, not the
full reply path. Moving `reactions.add` into the Slack webhook ingress and
batching the integration subscription plus webhook append removed the
`SlackIntegration.ensureReady()` wait from the hot path. In the best observed
probe, Slack's reaction event timestamp was about 1.08s after the original
message timestamp.

The remaining full-reply latency is still too high. The correct next target is
processor throughput and startup cost under many events:

- Generic agent startup still begins several seconds after routed stream
  bootstrap on cold Slack threads.
- Provider registration events generate multiple agent-input events, which is
  correct, but the agent processor should catch up quickly.
- The agent processor currently performs one append/reduce cycle per rendered
  model-visible event. That is the likely place to investigate batching,
  catch-up efficiency, and trace-level timings without changing event semantics.

## 2026-05-19 Root Cause Update: Event Volume Amplification

The best current explanation is not that provider registrations are the wrong
semantic unit. The problem is that the stream runtime made each event too
expensive:

- Callable subscriber delivery could recurse through the same request chain.
  A subscriber handled event N, appended event N+1, and the Stream Durable
  Object immediately kicked off more callable delivery before returning. With
  codemode and agent processors appending follow-up events, this produced
  Cloudflare `Subrequest depth limit exceeded` errors.
- The stream queues every callable subscriber for many events even if that
  subscriber will later no-op after checking its filter or consumed event set.
- The callable delivery queue is stored as arrays in one KV value. Each enqueue
  and removal copies arrays and rewrites the queue, so many bootstrap/provider
  events amplify queue churn.
- The generic Agent Durable Object startup still does expensive pre-catch-up
  work, including prepared workspace setup, codemode session setup, full stream
  reads, processor catch-up, and another full stream read before the LLM handoff.

The patch deployed after this finding makes callable subscriber delivery
strictly outbox/alarm-driven: append requests enqueue callable work and ensure
an alarm, while the alarm starts deliveries. Different subscriber slugs can
still run independently, and each subscriber remains ordered, but event cascades
now cross a request boundary instead of recursively growing one Worker call
chain.

Verification immediately after that deployment:

- Focused shared tests passed: 37 tests.
- `pnpm --filter @iterate-com/shared typecheck` passed.
- `pnpm --dir apps/os typecheck` passed.
- Focused prod e2e passed:
  - `uses OpenAI for unconfigured agent chats by default`
  - `routes Slack webhooks into slack-agent streams and executes bang command replies`
- Full prod agent e2e passed: `apps/os/e2e/vitest/agents.e2e.test.ts`
  passed all 9 tests in about 173s.

The next high-value performance fix is subscriber filtering at enqueue time:
only queue subscribers whose `jsonataFilter` or explicit consumed-event filter
matches the event. This should reduce the number of queued callable deliveries
without changing event semantics.

That filter is now implemented for new subscription events:

- `ExternalSubscriber` accepts an optional `eventTypes` list.
- Stream callable delivery uses `eventTypes` before queueing a subscriber for an
  event, so subscribers are not woken for event types their processor contract
  does not consume.
- Slack routed stream bootstrap now records contract-derived filters for
  `slack-agent`, `codemode-session`, and `agent`.
- Slack integration ingress records a contract-derived filter for the
  integration-level Slack router subscription.
- Focused shared tests passed after this change: 38 tests.
- `pnpm --filter @iterate-com/shared typecheck` passed.
- `pnpm --dir apps/os typecheck` passed.
- Production deploy to `prd` completed.
- Full prod agent e2e passed after deploy: all 9 tests in about 175s.

This is still a mitigation, not the rigorous end state. Existing streams whose
subscription events were already appended will keep their old subscriber
payloads because those events are idempotent. New Slack routed streams should
benefit immediately after deploy.

The latest real Slack probe after the strict alarm/outbox deployment still had
poor end-to-end latency:

- Probe marker: `2026-05-19T14:32:41.418Z`
- Slack message event timestamp: `1779201161.662109`
- OS integration stream created the message webhook event at
  `2026-05-19T14:32:57.348Z`
- Slack `eyes` reaction event timestamp: `1779201177.017500`
- Bot reply webhook event was created at `2026-05-19T14:33:21.206Z`

That probe suggests a large chunk of latency happened before OS appended the
message webhook event, so the remaining performance work needs trace-level
separation between Slack delivery/ingress delay and OS stream processing delay.

## 2026-05-19 Latest Latency Update

Further production probes narrowed the regression:

- The `eyes` reaction path is now fast. Ingress starts `reactions.add` from the
  Slack webhook handler without awaiting SlackAgent startup, and Slack's own
  reaction event timestamp was about 0.8-1.1s after the original Slack message
  in the good probes.
- The full reply path was still slow because the LLM request was being pushed
  behind setup and provider transcription work.
- A duplicate awaited `reactions.add` in SlackAgent was removed. Ingress already
  owns the fast reaction, so SlackAgent should not block `agent/input-added` on
  a second reaction call.
- Slack generic Agent startup now warms workspace setup in the background for
  `/agents/slack/...` streams. Non-Slack agents still await workspace/codemode
  setup as before.
- OpenAI-backed agents now get `agent/llm-config-updated` with the intended
  `debounceMs: 200`. Previously only the OpenAI provider config was appended,
  so the generic Agent processor scheduled with its schema default of 1000ms.
- Slack routed-stream bootstrap now includes the default agent setup events
  before the first forwarded Slack webhook, so the first Slack input sees the
  correct model, system prompt, and debounce config.

An experiment to kick off callable delivery immediately after the durable queue
write was reverted. Full prod e2e showed it could reintroduce Cloudflare
`Subrequest depth limit exceeded` during codemode provider bootstrap. The safer
state for this PR keeps strict alarm/outbox-driven callable delivery and treats
faster non-recursive wakeup as follow-up work.

Measured prod probe after routed-bootstrap/debounce fixes:

- Probe marker: `2026-05-19T15:07:08.034Z 8ac7841b`
- Slack message timestamp: `1779203228.236919`
- OS integration stream created the message webhook event at
  `2026-05-19T15:07:12.240Z` (~4.0s after Slack timestamp).
- Routed stream bootstrap and forwarded webhook were appended at
  `2026-05-19T15:07:14.945Z` (~2.7s after integration event creation).
- First Slack webhook `agent/input-added` was appended at
  `2026-05-19T15:07:17.057Z`.
- The Agent drained provider registration inputs until
  `2026-05-19T15:07:19.333Z`.
- `agent/llm-request-scheduled` was appended at `2026-05-19T15:07:19.378Z`
  with `debounceMs: 200` and `model: gpt-5.5`.
- `agent/llm-request-requested` followed at `2026-05-19T15:07:19.693Z`.
- OpenAI completed in about 3.9s.
- Slack `chat.postMessage` completed in about 1.5s.
- Slack reply timestamp was `1779203245.654419`, about 17.4s after the original
  message timestamp.

Follow-up probe after batching Agent processor derived appends for provider
registration inputs:

- Probe marker: `2026-05-19T15:21:13.638Z b1535350`
- Slack message timestamp: `1779204073.823699`
- OS integration stream created the message webhook event at
  `2026-05-19T15:21:16.624Z` (~2.8s after Slack timestamp).
- Routed stream bootstrap and forwarded webhook were appended at
  `2026-05-19T15:21:19.393Z` (~2.8s after integration event creation).
- First Slack webhook `agent/input-added` was appended at
  `2026-05-19T15:21:21.266Z`.
- Provider registration inputs drained from `2026-05-19T15:21:21.617Z` through
  `2026-05-19T15:21:22.306Z`.
- `agent/llm-request-scheduled` was appended at `2026-05-19T15:21:22.350Z`
  with `debounceMs: 200` and `model: gpt-5.5`.
- `agent/llm-request-requested` followed at `2026-05-19T15:21:23.978Z`.
- OpenAI completed in about 4.7s.
- Slack `chat.postMessage` completed in about 1.1s.
- Slack reply timestamp was `1779204090.131099`, about 16.3s after the original
  message timestamp.

The provider append batching reduced the one-by-one append shape in the Agent
processor, but the probe still shows the end-to-end path is dominated by
Slack-to-ingress variance, integration-to-routed bootstrap, cold provider input
drain, the alarm/debounce wakeup path, OpenAI time, and Slack post time.

Follow-up probes after batching callable queue writes, draining all queued
offsets for a subscriber in one alarm turn, and directly waking the Slack
integration DO from Slack ingress:

- Probe marker: `2026-05-19T15:33:53.632Z c2d9ed85`
  - Slack message timestamp: `1779204833.810399`
  - OS integration stream created the message webhook event at
    `2026-05-19T15:33:55.955Z` (~2.1s after Slack timestamp).
  - Routed stream bootstrap and forwarded webhook were appended at
    `2026-05-19T15:33:57.761Z` (~1.8s after integration event creation).
  - First Slack webhook `agent/input-added` was appended at
    `2026-05-19T15:33:59.565Z`.
  - Provider registration inputs drained through `2026-05-19T15:34:00.160Z`.
  - `agent/llm-request-scheduled` was appended at `2026-05-19T15:34:00.253Z`;
    `agent/llm-request-requested` followed at `2026-05-19T15:34:00.555Z`.
  - OpenAI completed in about 4.6s.
  - Slack `chat.postMessage` completed in about 1.9s.
  - Slack reply timestamp was `1779204847.421199`, about 13.6s after the
    original message timestamp.
- Probe marker: `2026-05-19T15:37:09.815Z dc461a34`
  - Slack message timestamp: `1779205029.994629`
  - OS integration stream created the message webhook event at
    `2026-05-19T15:37:14.071Z` (~4.1s after Slack timestamp).
  - Routed stream bootstrap and forwarded webhook were appended at
    `2026-05-19T15:37:16.643Z` (~2.6s after integration event creation).
  - First Slack webhook `agent/input-added` was appended at
    `2026-05-19T15:37:18.221Z`.
  - Provider registration inputs drained through `2026-05-19T15:37:19.634Z`.
  - `agent/llm-request-scheduled` was appended at `2026-05-19T15:37:19.704Z`;
    `agent/llm-request-requested` followed at `2026-05-19T15:37:20.857Z`.
  - OpenAI completed in about 4.0s.
  - Slack `chat.postMessage` completed in about 1.6s.
  - Slack reply timestamp was `1779205046.870599`, about 16.9s after the
    original message timestamp.

The latest code does improve the middle of the path: provider input transcription
is no longer obviously one alarm per original provider event, and one probe had
schedule-to-request around 300ms. The hard remaining gaps are still before or
around route creation: Slack delivery to OS can vary by several seconds, and
integration-to-routed remains 1.8-2.6s in these probes.

The latest split means the request-start bug is mostly fixed: schedule-to-request
is now often hundreds of milliseconds instead of seconds, though it still varies.
The largest remaining controllable costs are the integration-to-routed wake path
and cold routed-stream bootstrap/provider-input drain before scheduling. That
work still preserves the desired design, but it is too expensive:

- Provider registrations remain separate stream events.
- Each provider registration still becomes a separate `agent/input-added`.
- The generic Agent processor currently appends those rendered inputs one by one
  and waits for them to drain before the first LLM request is scheduled. The
  current PR batches part of that append path, but the remaining cold-start
  workflow is still too expensive.

The next rigorous fix should keep those event semantics but make the bootstrap
drain cheaper. Promising directions:

- Precompute the provider-registration render inputs as part of routed-stream
  bootstrap, while preserving one input per provider and the existing event
  shapes.
- Reduce alarm/debounce wakeup latency without reintroducing recursive
  Cloudflare subrequest-depth failures.
- Add trace spans around stream append, callable queue enqueue/kickoff,
  subscriber delivery, Agent provider rendering, debounce firing, request
  history read, OpenAI call, and Slack post.
- Measure Cloudflare trace timings for Slack webhook ingress separately from
  Slack's own event delivery, because recent probes still show 3-4s before OS
  even creates the first integration-stream webhook event.

## Fixed E2E Bootstrap Failure

The focused prod e2e failure after introducing independent delivery was a
codemode provider bootstrap race.

The test was:

```bash
cd apps/os
doppler run --project os --config prd -- \
  sh -lc 'OS_BASE_URL="$APP_CONFIG_BASE_URL" OS_ADMIN_API_SECRET="$APP_CONFIG_ADMIN_API_SECRET" pnpm exec vitest run --config ./e2e/vitest.config.ts ./e2e/vitest/agents.e2e.test.ts -t "routes Slack webhooks"'
```

Observed failure:

- The test posts a Slack follow-up bang command using `!debug`.
- `slack-agent` emits a `codemode/script-execution-requested` event for a script
  that calls `ctx.debug()`.
- Codemode executes before the generic Agent Durable Object has registered the
  `debug` provider.
- The script completes with:

```text
No codemode provider registered for debug.
```

Then generic agent startup registers `debug` and other agent-specific providers
afterward.

The fix shares provider construction with `AgentDurableObject` and bootstraps
the same baseline codemode providers when the Slack routed stream is configured.
That makes Slack-routed streams able to execute bang commands before generic
agent startup completes.

## Rigorous Fix Plan

1. Make Slack routed codemode bootstrap complete.
   - Identify every provider Slack bang commands can call before generic agent
     startup finishes.
   - At minimum, bootstrap the `debug` provider because the e2e uses
     `ctx.debug()`.
   - Prefer sharing provider construction with `AgentDurableObject` rather than
     duplicating provider literals in Slack integration code.
   - Keep Slack-specific exclusions, such as avoiding the generic `agent-chat`
     provider where Slack streams should not use it.

2. Define the subscriber delivery contract explicitly.
   - A subscriber receives events in offset order for its own slug.
   - Different subscribers are independent and can run concurrently.
   - A slow or failing subscriber must not block another subscriber's queue.
   - Delivery state transitions must be observable and retry behavior must be
     intentional.

3. Move active delivery state out of process memory or make the in-memory model
   formally safe.
   - Current active subscriber tracking is in memory.
   - That may be acceptable if pending delivery promises keep the Durable Object
     instance alive, but it should be proven or hardened.
   - A more durable design would persist per-subscriber leases/cursors so a DO
     restart cannot accidentally duplicate or lose delivery progress.

4. Audit subscriber startup for idempotency and reentrancy.
   - `AgentDurableObject.afterAppend`
   - workspace and repo setup
   - codemode session startup
   - stream processor registration
   - provider registration
   - Slack routed stream bootstrap

5. Avoid recursive request and alarm blowups.
   - Do not bulk-drain large subscriber backlogs in one alarm.
   - Process one offset per subscriber turn, or use a very small bounded batch
     only after subrequest-depth behavior is understood.
   - Reschedule from the stream delivery path with clear limits.

6. Add observability for subscriber lag.
   - Log or trace subscriber slug, offset, queue wait, delivery duration,
     completion status, and reschedule decisions.
   - For Slack, track:
     - Slack webhook received -> routed stream append
     - routed stream append -> `slack-agent` input append
     - routed stream append -> Slack `reactions.add` request/completion
     - Slack post request -> Slack post completion

7. Reduce remaining live latency.
   - The bot-message fix made the real path functional again, but the 2026-05-19
     prod probe still took roughly 24s end-to-end.
   - Preserve separate provider events and separate agent inputs while doing
     this.
   - Split the latency budget by source:
     - Slack post -> OS webhook append
     - OS webhook append -> routed stream append
     - routed stream append -> `slack-agent` input append
     - `agent/input-added` -> LLM request requested
     - LLM request requested -> first output
     - output -> Slack post completion
   - The latest probe showed large chunks before OS received the webhook and
     before the LLM request was requested. Those need separate investigation
     from subscriber independence.

8. Gate the rollout with e2e and a live Slack probe.
   - Run focused shared tests.
   - Run `apps/os` unit/integration tests that cover project ingress, codemode
     session behavior, and Slack stream routing.
   - Run the full `apps/os/e2e/vitest/agents.e2e.test.ts` suite against preview
     or prod, depending on environment availability.
   - Inspect target streams for `events.iterate.com/core/error-occurred`.

## Acceptance Criteria

- `slack-agent` side effects are not delayed by generic `agent` startup.
- A slow `agent` subscriber cannot block a fast `slack-agent` subscriber.
- Each subscriber still sees its own events in offset order.
- Slack routed bang commands can run before generic agent startup finishes.
- Messages from other Slack bots can wake Iterate.
- Messages/actions from Iterate's own bot do not recursively wake Iterate.
- No `core/error-occurred` events are appended during normal Slack route e2e.
- Focused shared tests and `apps/os/e2e/vitest/agents.e2e.test.ts` pass.

## Verification Commands

Focused shared checks:

```bash
pnpm --dir packages/shared exec vitest run src/streams/callable-subscriber-delivery.test.ts src/streams/external-subscriber.test.ts
pnpm --filter @iterate-com/shared typecheck
pnpm --filter @iterate-com/shared test:durable-object-utils:unit
```

Focused `apps/os` checks:

```bash
pnpm --dir apps/os typecheck
pnpm --dir apps/os test
pnpm --dir apps/os test:project-ingress
pnpm --dir apps/os test:codemode-session
```

Focused prod Slack e2e:

```bash
cd apps/os
doppler run --project os --config prd -- \
  sh -lc 'OS_BASE_URL="$APP_CONFIG_BASE_URL" OS_ADMIN_API_SECRET="$APP_CONFIG_ADMIN_API_SECRET" pnpm exec vitest run --config ./e2e/vitest.config.ts ./e2e/vitest/agents.e2e.test.ts -t "routes Slack webhooks"'
```

Full targeted prod agent e2e:

```bash
cd apps/os
doppler run --project os --config prd -- \
  sh -lc 'OS_BASE_URL="$APP_CONFIG_BASE_URL" OS_ADMIN_API_SECRET="$APP_CONFIG_ADMIN_API_SECRET" pnpm exec vitest run --config ./e2e/vitest.config.ts ./e2e/vitest/agents.e2e.test.ts'
```
