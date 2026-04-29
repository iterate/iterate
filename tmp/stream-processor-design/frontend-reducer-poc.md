# Frontend Reducer Proof Of Concept

Files:

- `frontend-reducer-poc.contract.ts`
- `frontend-reducer-poc.ui.tsx`

## What This Proves

The agents UI can compute frontend-visible state by importing only the processor
contract/reducer module:

```ts
const state = reduceAgentLoopEvents({ events });
```

This gives the future agents UI a clean path to render:

- whether the agent is computing;
- current request id;
- queued message count;
- transcript length / transcript preview;
- whether the current processor version registered itself on the stream.

The contract file typechecks by itself:

```sh
pnpm exec tsc --noEmit --allowImportingTsExtensions --moduleResolution Bundler --module ESNext --target ES2022 --skipLibCheck tmp/stream-processor-design/frontend-reducer-poc.contract.ts
```

## Important Design Constraint

Contract modules must stay frontend-safe.

Good contract module contents:

- Zod event schemas;
- state schema;
- `defineProcessorContract(...)`;
- pure reducer;
- projection helpers such as `reduceAgentLoopEvents(...)`;
- exported inferred state/event types if they are actually useful.

Bad contract module contents:

- Durable Object classes;
- `WorkerEntrypoint`;
- `Ai`, `Fetcher`, `WorkerLoader`, or Cloudflare RPC handles;
- MCP clients;
- dynamic worker loaders;
- implementation factories that call third-party APIs.

## Packaging Implication

The current tmp UI sketch does not typecheck from repo root because it lives
outside an app package, so module resolution cannot find React/TanStack types.
That is fine for the design sketch.

The production split should look more like:

```txt
packages/shared/src/stream-processors/agent-loop/contract.ts
packages/shared/src/stream-processors/agent-loop/processor.ts
packages/shared/src/stream-processors/codemode/contract.ts
packages/shared/src/stream-processors/codemode/processor.ts
```

or, if app-specific for now:

```txt
apps/agents/src/stream-processors/agent-loop/contract.ts
apps/agents/src/stream-processors/agent-loop/processor.ts
apps/agents/src/stream-processors/codemode/contract.ts
apps/agents/src/stream-processors/codemode/processor.ts
```

The UI imports only `contract.ts`. Hosts import both.

## Frontend Projection Shape

The frontend should use the same reducer path as replay hosts:

```ts
export function reduceAgentLoopEvents(args: {
  events: readonly StreamEvent[];
  state?: AgentLoopState;
}) {
  let state = args.state ?? AgentLoopProcessorContract.state.parse(undefined);

  for (const event of args.events) {
    const reduction = runProcessorReduce({
      processor: { contract: AgentLoopProcessorContract },
      event,
      state,
    });
    state = reduction?.state ?? state;
  }

  return state;
}
```

This intentionally does not call:

- `onStart`;
- `afterAppend`;
- `streamApi.append`;
- any backend implementation factory.

## Product Implication For Agents UI

The UI does not need a bespoke "agent status" backend endpoint immediately. It
can read committed stream events and project the status locally.

That said, for large streams we will probably want one of:

- a backend projection endpoint returning reduced state plus
  `reducedThroughOffset`;
- paged replay with a cached frontend state;
- a stream subscription that applies live events after an initial projection.
