---
state: open
priority: high
size: large
dependsOn:
  - agents-processor-composition-requirements
  - testing-processors
---

# Post Stream Processor PR Cleanup Handover

This is the handover note for the work to continue after the stream processor PR is merged and deployed.

The goal is not to preserve the exact shape of this PR. The goal is to use the PR as the first working cut, then continue coalescing it toward a small, well documented stream processor model with clean runners, clear processor contracts, and much less legacy/backwards-compatibility code.

## Current State To Assume

- The new processor abstraction lives independently from `events-contract` for now.
- New-style processor contracts and implementations live in `packages/shared/src/stream-processors`.
- Agent, Codemode, Webchat, Scheduling, Jsonata Transformer, and Dynamic Worker processors should be treated as shared standalone processors.
- `apps/events` should keep only stream core concerns plus the external subscriber and circuit breaker processors.
- The old `IterateAgent` path has been replaced by separate Agent, Codemode, and Webchat `StreamProcessorRunner` Durable Objects.
- The runners are intentionally not production-perfect. They prove the model and should stay simple while the abstraction settles.
- Backwards compatibility with old deployed processors, old event type pages, old SDK shapes, and old workshop cruft is not required after this PR is deployed.

Useful context lives in:

- `tasks/agents-processor-composition-requirements.md`
- `tasks/testing-processors.md`
- `packages/shared/src/stream-processors/`
- `apps/agents/src/durable-objects/*stream-processor-runner*.ts`
- `apps/events/src/durable-objects/stream.ts`

## First Checks After Merge And Deploy

Before starting a big cleanup branch, verify that the merged work actually deployed and behaves in the real environment.

1. Check the deployed `apps/events` service accepts the new core subscription event types, especially `events.iterate.com/core/subscription-configured`.
2. Run the agents mocked-internet e2e without forcing a local `EVENTS_BASE_URL`. During the PR this only passed against local events because production events had not yet deployed the new core event shape.
3. Run the local agents smoke flow against deployed events and confirm Webchat -> Agent -> Codemode still appends the expected stream events.
4. Confirm the processor docs pages are served from the deployed events app and no old static event pages remain visible.
5. Check CI on a clean follow-up PR, not only this PR. Re-check anything that was broken, skipped, or noisy here:
   - preview deployments
   - preview e2e tests
   - sandbox-related jobs
   - any old `ai-engineer-workshop` or old events SDK workflow references
   - HAR/mocked-internet agents tests
   - root `typecheck`, `lint`, `format`, and package tests

Preview deployment failures were allowed on this PR while the branch was in flux. They should not be normalized as permanent failures. Use a new clean PR to prove which failures are real after merge/deploy.

## Cleanup Direction

Keep the codebase boring and explicit. Be wary of over-abstraction.

- Prefer one clear file over a pile of single-use modules.
- Avoid compatibility layers for old event names, old agents routes, old workshop code, or old SDK exports.
- Keep TUI-related code.
- Avoid exported event type constants as the main authoring API. Prefer visible event type strings in contracts, with TypeScript checking that they are valid.
- Keep processor contracts importable from frontend code. Runtime implementations may depend on Cloudflare bindings or third-party APIs and must not leak into frontend imports.
- Keep processor implementations dependency-injected. Cloudflare bindings, code executors, AI bindings, fetchers, MCP clients, and similar runtime objects should be passed in, not imported globally.

## Stream.ts Target

The long-term target for `apps/events/src/durable-objects/stream.ts` is a single clear, well commented Durable Object file around 400-500 LOC if possible.

It should read like the core stream service:

- append
- read
- subscribe
- maintain append-only offsets
- run the tiny amount of privileged built-in logic that truly belongs inside the stream Durable Object

Do not split it into many tiny modules unless that module is a genuine processor or reusable Durable Object utility. The user specifically wants this file to feel simple, direct, and carefully documented.

Core stream behavior should remain in `apps/events`:

- external subscriber processor
- circuit breaker processor
- subscription plumbing
- append validation and offset assignment

Move or keep moved as shared new-style processors:

- scheduling
- Jsonata transformer
- dynamic worker manager
- agent
- codemode
- webchat

After deployment, review `stream.ts` again and remove anything that exists only because old deployed processors might still be around.

## Durable Object Utilities

Revisit the Durable Object runner implementation after the first deployed proof.

- The descriptive term should be `StreamProcessorRunner`.
- Avoid vague extra vocabulary like host, runtime, slot, mount, or adapter unless there is a concrete distinction.
- The Durable Object mixin should initially support one processor. If multiple processors need to run together, compose processors in stream-processor land and pass one composed processor to the mixin.
- Check whether `withStreamProcessorRunner` should use more existing mixins from `packages/shared/src/durable-object-utils`.
- In particular, inspect and use where appropriate:
  - D1 tracking
  - SQL explorer
  - KV explorer
  - real keepalive behavior for long-running promises

Do not add task tracking, retry machinery, or checkpoint complexity unless a concrete failing runner example proves the need.

## Processor Composition

Composition should stay a processor abstraction, not a Durable Object runner abstraction.

The likely next helper is a small `combineProcessors(...)` / `combineProcessorFactories(...)` shape that:

- keeps child reduced state slices separate
- unions `processorDeps`, `consumes`, and `emits`
- runs each child reducer over its own slice
- runs each child `afterAppend` over its own slice
- remains testable without Durable Objects

Do not let this become a hidden same-turn ordering guarantee. Ordinary processors must still behave as if they could sit behind a network connection with arbitrary lag.

## Processor Docs Pages

The old event type pages can be deleted entirely.

The replacement docs should be generated only from new-style processor contracts:

- `events.iterate.com/:processorSlug`
- `events.iterate.com/:processorSlug/:eventSlug`

The processor overview should show:

- description
- version
- processor dependencies
- owned events
- consumed events
- emitted events
- links to processor dependency pages
- links to event detail pages

Do not list old event types just to preserve the old catalog. Start from the new contracts in `packages/shared/src/stream-processors` plus any new-style core contract in `apps/events`.

## Testing Work

Keep tightening test coverage around the abstraction rather than only around the current concrete runners.

- Add expect-type tests for authored contracts, event string validation, emitted append inputs, consumed event narrowing, and object-shaped state.
- Add runtime tests for contract validation so dynamically assembled contracts fail clearly.
- Keep e2e tests readable and meaningful. They are product specs, not only regression tests.
- The HAR-backed mocked-internet agents test should pass again after deploy without local-only environment hacks.
- It is fine to keep dynamic worker and Jsonata e2e tests skipped temporarily if the contracts and unit tests cover the extracted processor behavior.

Commands that passed during the PR and are good starting checks:

```bash
pnpm typecheck
pnpm test:stream-processors
cd apps/events && pnpm test
cd apps/agents && pnpm test:unit
cd apps/agents && EVENTS_BASE_URL=http://localhost:5173 pnpm test:e2e:mocked-internet
```

After deploy, also run the agents e2e without `EVENTS_BASE_URL=http://localhost:5173`.

## Processor Authoring Docs

Keep iterating the concise "how to write a processor" documentation.

It should explain:

- contract modules are frontend-safe and contain schemas, metadata, state schema, optional `initialState`, and optional pure reducer
- implementation modules may depend on runtime deps and must not be imported by frontend code
- `consumes` means every event the reducer or `afterAppend` may inspect
- `emits` means every event the processor is allowed to append
- exactly-once patterns need both reduced state and an idempotency key
- derived events should use an idempotency key derived from the source event and processor identity
- registration/self-description is a standard processor behavior owned by the core processor contract
- processors should append normal stream events for their own docs/registration, not rely only on out-of-band metadata

## Known Follow-Up Ideas

- Add a debug info requested/provided event pair for well-behaved processors.
- Add a cleaner helper for common exactly-once append patterns.
- Add processor composition helpers after the single-processor runner is simpler.
- Consider an `MCPConnection` Durable Object as a separate tool-provider processor/service.
- Revisit class-backed processor authoring later only if object/factory processors become awkward in real code.
- Revisit whether the frontend projection API should live in shared processor helpers once the agents UI starts showing reduced agent state.

## Final Reminder

After this PR is merged and deployed, the next cleanup should be ruthless about deleting dead compatibility code and conservative about adding new abstractions.

The target is a codebase where:

- `stream.ts` is simple enough to audit in one sitting
- processors are ordinary importable contracts plus dependency-injected implementations
- runners are thin Durable Object or pull-subscription shells
- tests prove the abstraction without needing production Cloudflare state
- deployed docs come directly from processor contracts
