# Minimal ITX v4 Re-Enablement Plan

## Goal

Re-enable the small ITX capability host surface in `apps/minimal-itx-v4` while staying faithful to the v4 design direction:

- Keep `apps/minimal-itx-v4/types.ts` as the public contract.
- Keep `apps/minimal-itx-v4/src/rpc-targets.ts` as the public RPC adapter layer.
- Keep `ProjectDurableObject` and future `AgentDurableObject` as the hosts of their own ITX processors.
- Do not introduce a separate `ItxDurableObject`.

The immediate test target is the commented `provideCapability` / dotted invocation / `revoke` block in `apps/minimal-itx-v4/itx.e2e.test.ts`.

## Constraints

- Use `DurableObjectNameCodec` from `src/domains/durable-object-names.ts` for all DO names.
- The project ITX host is the `PROJECT` Durable Object named with `{ projectId, path: "/" }`.
- A future agent ITX host should be the `AGENT` Durable Object named with `{ projectId, path: agentPath }`.
- `ProjectRpcTarget` should delegate ITX host methods to the project DO's ITX processor, not embed processor state itself.
- The implementation should stay small and close to v3, but preserve v4's `project/create-requested` flow.

## Proposed Shape

### 1. Host ITX Inside `ProjectDurableObject`

Restore the existing commented ITX wiring in `src/domains/projects/project-durable-object.ts`:

- create a stream stub for the project root stream;
- create a `DynamicWorkersRpcTarget`;
- register `ItxProcessor` on the existing `createStreamProcessorHost`;
- expose `itxProcessor`;
- implement `runScript`, `provideCapability`, and `revokeCapability` by delegating to that processor.

This mirrors v3, but keeps the v4 project DO file as the host.

### 2. Subscribe ITX From `ProjectProcessor`

In `src/domains/projects/project-processor.ts`, when handling `events.iterate.com/project/create-requested`, append an ITX subscription configuration to the root stream before appending `events.iterate.com/project/created`.

The subscriber should point at the same project DO:

```ts
durableObjectProcessorSubscriber({
  bindingName: "PROJECT",
  durableObjectName: DurableObjectNameCodec.stringify({
    projectId: this.deps.projectId,
    path: "/",
  }),
  processorName: ItxContract.slug,
});
```

Use a deterministic subscription key. Do not add an idempotency key for this subscription; the subscription key already makes reconfiguration idempotent.

```ts
subscriptionKey: ItxContract.slug;
```

### 3. Add ITX Host Delegation To `ProjectRpcTarget`

In `src/rpc-targets.ts`, add a small base class similar to v3:

- imports `fallbackCall` from `capnweb`;
- has an abstract `itxProcessor(): ItxProcessorRpc`;
- implements `runScript`;
- implements `provideCapability`;
- implements `revokeCapability`;
- implements `[fallbackCall](path, args)` by calling `invokeCapability`.

`ProjectRpcTarget` should extend that base and resolve its processor with:

```ts
env.PROJECT.getByName(
  DurableObjectNameCodec.stringify({
    projectId: this.props.projectId,
    path: "/",
  }),
).itxProcessor;
```

The base class should reject built-in root collisions before providing a capability, so paths like `["streams"]` cannot shadow `project.streams`.

### 4. Keep Dynamic Dotted Invocation Runtime-Only

Do not change `types.ts` to enumerate arbitrary provided capabilities. The test can keep using `@ts-expect-error` for:

```ts
project.someMethodInTestRunner.getSecret(...)
```

At runtime, Cap'n Web's fallback call should route unknown dotted paths to `ItxProcessor.invokeCapability`.

### 5. Re-Enable The E2E Block

Uncomment the live-capability test block in `itx.e2e.test.ts`.

Expected behavior:

- first session calls `project.provideCapability(...)`;
- first session can invoke `project.someMethodInTestRunner.getSecret(getSecret)`;
- a second authenticated session gets the same project and can invoke the same live capability;
- `revoke()` removes it;
- both sessions then reject with `no capability "someMethodInTestRunner.getSecret"`.

## Why This Is The Simple Faithful Version

This keeps the v4 boundary intact:

- `rpc-targets.ts` remains a public adapter and auth gate;
- `ProjectDurableObject` remains the project-local durable host;
- `ItxProcessor` remains the stateful stream processor;
- project creation remains event-driven through `project/create-requested`;
- no generic context host is introduced yet.

It borrows only the minimal v3 mechanism needed for the test: domain DO hosts the ITX processor, and RPC fallback turns dotted calls into `invokeCapability`.
