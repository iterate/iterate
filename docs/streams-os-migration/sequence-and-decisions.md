# OS Streams Migration Sequence And Decisions

This note synthesizes the discovery docs for replacing OS's legacy shared stream implementation with `packages/streams`.

## Source Inventories

- [New packages/streams](./new-packages-streams.md)

## Constraints From The Code

- OS already treats stable Project ID as the stream namespace and stream paths as project-local addresses.
- The user-facing `os.project.streams.*` oRPC surface can likely remain the compatibility boundary for the first migration step.
- The current OS stream facade depends on legacy `@iterate-com/shared/streams` methods: `append`, `appendBatch`, `history`, `stream`, `getState`, initialized stream stubs, and `DO_CATALOG` listing.
- The new `packages/streams` runtime exposes CapnWeb RPC methods: `append`, `appendBatch`, `getEvents`, `subscribe`, `runtimeState`, `reduce`, `kill`, and `reset`.
- Legacy live processor delivery is mostly callable subscriber events that call `afterAppend` on domain Durable Objects.
- New live processor delivery is a stream-owned outbound subscription handshake to a `StreamProcessorRunner`-shaped CapnWeb sink.
- `packages/streams` has no package exports map yet, so broad OS usage should either add exports first or accept temporary source-path imports.
- The new `StreamProcessorRunner` Durable Object is real but currently only maps the `echo-example` processor slug.
- OS processor definitions currently live in `@iterate-com/shared/stream-processors` and are imported by backend runners, frontend reducers, tests, and UI formatting code.
- Secrets and provider connections are currently D1-backed authorities, not stream-backed lifecycles.
- Workspaces are live project-scoped work surfaces/capabilities today, not canonical streams.

## Recommended Migration Shape

## Resolved Decisions

- OS stream processors will run in standalone `StreamProcessorRunner` Durable Objects during this migration.
- Domain Durable Objects remain command and capability owners, but should not own processor checkpoints or be the default live processor hosts.
- Any domain Durable Object that still needs live behavior should interact through explicit capabilities or stream events rather than receiving legacy `afterAppend` subscriber callbacks.
- This is a POC cutover, not a backwards-compatible migration.
- Do not run legacy and new stream Durable Object bindings side by side.
- Cut over the existing stream binding to `packages/streams`, port functionality bit by bit, and use the test suite as the convergence target.
- Existing stream histories do not need preservation.
- OS-specific processor contracts stay in `apps/os` for now.
- Do not move OS domain processors or contracts into `@iterate-com/streams` during this migration.
- Secrets and workspaces stay as existing capabilities/stateful surfaces for the first slice.
- The first implementation slice is: remove old streams from OS, bind `packages/streams`, keep using oRPC, and prove a Project can be created and accessed while preserving current OS behavior.
- Do not temporarily skip existing Project lifecycle stream writes or processor behavior just to get the first proof green; adapt the stream and processor execution mechanism instead.
- Use a small compatibility adapter first if needed so existing OS/shared processor contracts can run inside the new `StreamProcessorRunner` with minimal contract churn.
- Keep broad stream append authority for the POC. Do not mix event-type/path safety policy into the first runtime cutover.
- Use only the new `packages/streams` subscription event schema. Do not translate legacy callable subscription events.

### Phase 0: Prepare The Package Boundary

Add a stable `@iterate-com/streams` export map and decide the canonical names for stream event, path, processor contract, runner, worker client, browser client, and Durable Object exports.

Keep this phase behavior-neutral. The goal is to make OS able to import from `@iterate-com/streams` without binding itself to staging source paths.

### Phase 1: Cut Over Stream Bindings

Replace the legacy shared `StreamDurableObject` binding/export with the `packages/streams` `Stream` Durable Object, and add the required `StreamProcessorRunner` binding.

Do this as a direct cutover of the existing `STREAM` binding, not as `STREAM_V2` plus compatibility code. Expect tests to fail until the adapter and domain slices are ported.

Concretely, the first pass should touch:

- `packages/streams/package.json` and package entrypoints, enough for OS imports.
- `apps/os/package.json`, adding `@iterate-com/streams`.
- `apps/os/src/entry.workerd.ts`, replacing legacy stream exports with `packages/streams` exports.
- `apps/os/alchemy.run.ts`, keeping binding name `STREAM` but pointing it at the new class.
- Durable Object test Wrangler JSONC files that bind `STREAM`.
- `apps/os/src/context.ts` and worker env types.

### Phase 2: Make Project Creation Work With The New Runtime

Make `os.projects.create` work after replacing the legacy stream Durable Object.

Current code facts:

- `ProjectDurableObject.createProject()` writes local Project Durable Object state and D1 projections before touching streams.
- The same command then appends Project lifecycle events and installs legacy stream subscriptions.
- The Project route currently reads project data, project lifecycle state, and the root project stream.

For the first proof, prioritize:

- create a Project through oRPC
- write the Project D1 projection and permission rows
- append the current Project lifecycle stream events through `packages/streams`
- install Project lifecycle subscription using the new `packages/streams` subscription schema
- run the current Project lifecycle processor through `StreamProcessorRunner`
- use a compatibility adapter for the existing Project lifecycle processor contract if direct porting would broaden the first slice
- route to `/projects/$projectSlug`
- load the Project route without the legacy stream implementation

Do not change the intended Project creation semantics for the proof. If current behavior creates lifecycle stream facts, installs subscriptions, builds config worker state, or starts setup work, the cutover should preserve that behavior unless a separate decision explicitly narrows it.

Do not block this slice on Repo creation, Agent setup, codemode, Slack, or raw stream browser parity unless one of those is already part of current Project creation/access behavior.

### Phase 3: Adapt Raw OS Streams API

Implement the OS `StreamsCapability` over `packages/streams` while keeping the existing oRPC contract shape where practical:

- `list`
- `create`
- `append`
- `appendBatch`
- `read`
- `streamEvents`
- `getState`
- `listChildren`

This is the starting product slice. The adapter will need to translate between old NDJSON/history/state semantics and the new CapnWeb/getEvents/runtimeState semantics.

For the first proof, prioritize:

- create or initialize a stream at a project-local path
- append one event
- append a batch
- read persisted events
- stream/read enough events for `ProjectStreamView`
- list initialized streams for the Project Stream Explorer

`listChildren` and full state parity can follow after the raw stream UI can display events.

### Phase 4: Prove The Raw Streams UI

Make `/projects/$projectSlug/streams` and `/projects/$projectSlug/streams/$` work against the new runtime.

The acceptance target for the first slice is intentionally small:

- OS deploys or runs locally with old stream imports removed from the raw streams path.
- `project.streams.create`, `append`, `appendBatch`, `read`, `streamEvents`, and `list` are backed by `packages/streams`.
- The Project Stream Explorer can create/open a stream, append a test event or batch, and render the raw event feed.

Do not block this slice on codemode, agents, repos, Slack, secrets, workspaces, browser OPFS processors, or processor registry work.

### Phase 5: Adapt OS Processor Contracts In Place

Update OS-used processor contracts in `apps/os` so they work with the `packages/streams` processor and runner primitives:

- project lifecycle
- repo lifecycle
- codemode
- agent
- agent chat
- Cloudflare AI
- OpenAI websocket
- JSONata reactor
- Slack integration
- Slack agent
- stream view/frontend processors

Do not move these contracts into `@iterate-com/streams` for now. The stream package should expose generic event, path, contract, processor, runner, client, and Durable Object primitives; OS owns OS domain language.

The remaining design work is whether to adapt the existing richer OS/shared contract lifecycle model in place or standardize OS processors on `packages/streams/src/processor.ts`. The current new runner uses the simpler model.

The first Project creation/access slice may precede this broader cleanup by using a compatibility adapter around the existing Project lifecycle processor contract.

### Phase 6: Build An OS Processor Registry

Generalize the new `StreamProcessorRunner` so OS can resolve processor slugs to implementations and runtime dependencies.

This registry needs to answer:

- which processor slug maps to which implementation
- what runtime dependencies each processor receives
- how Project ID, Event Stream Path, and domain object identity are passed
- how OS capabilities such as project, repos, secrets, codemode session, AI, Slack, OpenAI, workspace, and outbound MCP are constructed

This phase is now mandatory rather than optional: all migrated OS processors are expected to run inside `StreamProcessorRunner`, not inside their owning domain Durable Objects.

### Phase 7: Migrate Domain Processor Hosts

Move domain hosts in risk order:

1. Repo lifecycle: small reducer and explicit stream path.
2. Project lifecycle: core product path, but mostly project provisioning events.
3. Slack agent/integration: exercises cross-stream routing and side effects.
4. Codemode session: highest surface area and provider/function-call behavior.
5. Agent: multi-processor host, child streams, codemode/session/workspace composition, websocket path.

Each migration should keep its oRPC and UI surface stable where possible.

### Phase 8: Browser Stream Viewer

Replace `ProjectStreamView`'s local shared reducer path with `packages/streams` browser processors and OPFS mirror.

This should come after the server API has a stable `packages/streams` route, because the browser runtime expects CapnWeb stream URLs and processor-owned local tables.

### Phase 9: Retire Legacy Shared Streams

Only remove `packages/shared` streams and old mixins after:

- OS no longer imports `@iterate-com/shared/streams`
- OS no longer imports `@iterate-com/shared/stream-processors`
- test Wrangler configs no longer export legacy `StreamDurableObject`
- tests pass against `packages/streams`

## Start Here Checklist

1. Add package exports for the `@iterate-com/streams` primitives OS needs.
2. Add `@iterate-com/streams` to `apps/os`.
3. Replace OS's legacy `StreamDurableObject` export/binding with `packages/streams` `Stream`.
4. Add/bind `StreamProcessorRunner` for OS.
5. Update `StreamsCapability` and Project stream helpers to call the new `StreamRpc`.
6. Update Project lifecycle subscription setup to emit the new subscription event schema.
7. Add a small compatibility adapter if needed so the existing Project lifecycle processor contract runs inside `createProcessorRunner`.
8. Make `os.projects.create` pass and load `/projects/$projectSlug`.
9. Then make `project.streams.*` and the raw Project Stream Explorer pass.
