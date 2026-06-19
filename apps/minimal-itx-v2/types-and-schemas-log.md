# Types And Schemas Log

This log explains the simplifications made in `types-and-schemas.ts` and what
would change if the implementation imports these types directly.

## Simplifications Made

- Put the capability tree first. `Project` is the project-scoped ITX surface,
  `AgentItx` is `Project` with a current-agent shortcut, and `RootItx` is the
  small administrative entrypoint.
- Dropped the public `RpcTarget` suffixes. The raw synchronous implementation
  interfaces are named after what callers see: `Stream`, `Streams`, `Repo`,
  `Repos`, `Agent`, `Agents`, and `ProjectWorker`.
- Declared stable object-capability surfaces as `interface`s. Algebraic,
  recursive, and schema-derived names stay as `type` aliases.
- Kept public method signatures synchronous. Server-side classes can implement
  the same interfaces directly, while `RpcStub<Project>` makes client calls
  awaitable and deep-stubifies nested properties.
- Made capability mounting receiver-scoped. `Project` and `Agent` both extend
  `ItxCapabilityHost`; `project.provideCapability(...)` mounts on the project,
  while `agent.provideCapability(...)` mounts on that agent.
- Moved `runScript()` onto `ItxCapabilityHost`. A project host runs scripts
  with project ITX; an agent host runs scripts with agent ITX.
- Kept `AgentItx` simple. It extends `Project` and adds only `agent`, the
  current-agent shortcut. It does not have an extra `project` branch because
  the root `AgentItx` object is already the project surface.
- Removed `streamPath` from `Stream.append()` and `Stream.appendBatch()`.
  Streams are addressed once with `itx.streams.get(path)`.
- Reduced the stream model to one generic uncommitted event schema
  (`StreamEventInput`) and one committed event schema (`StreamEvent`). No
  processor-owned domain event unions were added.
- Kept Zod narrow. Zod appears only for generic stream events and data
  structures the ITX processor contract should import (`DynamicWorkerRef` and
  its nested `DynamicWorkerSource`, plus `CapabilityRecord`). Ordinary live RPC
  argument objects are plain TypeScript.
- Made stream event `payload`, `metadata`, and script results JSON-shaped. This
  matches durable fact storage and avoids `unknown` in values returned across
  RPC boundaries.
- Kept `Json` finite at the TypeScript level while validating with `z.json()`
  at runtime. Cloudflare's Workers RPC types recursively prove return values
  are serializable; an unbounded recursive JSON alias makes generated Durable
  Object stubs hit TypeScript's recursion limit.
- Made provided capabilities an explicit union:
  `{ type: "live"; target: unknown }` for functions, stubs, concrete targets,
  and other live references, or `{ type: "dynamic-worker"; workerRef:
DynamicWorkerRef }` for durable JSON-backed providers. The `unknown` is
  quarantined inside the live branch and is never part of stream event data.
- Replaced the extra `CapabilityAddress` alias with `DynamicWorkerRef`.
  Dynamic capability records now carry an explicit `type`: live records are
  `{ type: "live", path }`, while durable records are
  `{ type: "dynamic-worker", path, workerRef }`.
- Normalized durable worker refs to `{ source, cacheKey?, target }`. The source
  says where code comes from (`inline` or `repo`), and the target says what to
  call from that source (`worker-entrypoint` or `durable-object`).
- Inlined single-use RPC argument and return shapes instead of naming them
  separately. The remaining exported names are the capability hosts, generic
  stream event schemas, and processor-contract support structures.
- Tightened create methods to the actual data they need and made them return
  both the committed event and the created handle. `Repo.create()` and
  `Agent.create()` take no input; collection create methods take only
  `{ path }`. Returning the handle lets Cap'n Web clients pipeline calls such
  as `itx.agents.create({ path }).agent.sendMessage(...)`.
- Kept auth/principal near the host objects, because the public door determines
  which ITX tree a caller can enter.

## Implementation Implications

- `src/itx/processor-contract.ts` can eventually import `DynamicWorkerSource`,
  `DynamicWorkerRef`, and `CapabilityRecord` from this file, replacing local
  dynamic capability state aliases.
- `src/itx/processor.ts` can branch on `capability.type`: retain
  `capability.target` only for `"live"` capabilities, and persist
  `capability.workerRef` only for `"dynamic-worker"` capabilities.
- `src/domains/dynamic-workers/dynamic-worker-ref.ts` can either re-export
  `DynamicWorkerRef` from this file or disappear after callers move over.
  Keeping one source would avoid drift between dynamic capability docs and persisted
  processor state.
- The runtime stream append parser currently accepts `unknown` payloads through
  the shared stream-event schema. Adopting this file directly would tighten
  generic stream payloads and metadata to JSON. That is the right public
  contract for durable facts, but existing tests or callers that append
  non-JSON values would need to change.
- The runtime currently accepts `event.offset` as an append precondition before
  it assigns the committed offset. This public model omits that shortcut so
  `StreamEventInput` stays the uncommitted fact shape and `StreamEvent` is the
  only schema with `offset`.
- The public ITX, stream, repo, agent, and worker interfaces are synchronous.
  The current implementation types in `src/itx-types.ts` include `Promise`
  unions because server methods often perform async work. If runtime classes
  directly `implements` these public types, they should either return the
  synchronous values at the public seam or use a small internal adapter type
  instead of widening the public contract.
- The inline `runScript()` result uses `Json` because it is returned across the
  public RPC boundary and journaled through the script completion event. The
  current implementation still has `unknown` in `src/itx-types.ts` and the ITX
  processor contract; adopting this public file means validating or normalizing
  script return values to JSON before exposing them.
- `AgentItx` is documented as an internal host obtained by agent-path code via
  `env.ITX.get()`. The public WebSocket route remains project-hosted; the
  `agent` property is a shortcut for the current agent object.
- Cap'n Web docs and local type definitions were checked for the RPC-facing
  assumptions used here: `RpcStub<T>` deep-stubifies methods and properties,
  `newWebSocketRpcSession<T>()` accepts a string URL, functions and target
  objects can be live references, and `Response` is pass-by-value.
- The runtime's fourth ITX operation is the Cap'n Web fallback dispatch hook
  used to invoke mounted dynamic capability paths. It remains a transport hook,
  not a named public method in this contract; callers type mounted capabilities
  with intersections such as `Project & { echo: Echo }`.
- Cloudflare Workers docs were checked for the platform assumptions: Workers
  RPC exposes public methods on `WorkerEntrypoint`, and Durable Object public
  methods are callable through typed stubs.
- Added a proof-only copied stream Durable Object and processor contract:
  `types-and-schemas.stream-proof.ts` proves local stream implementation and
  processor event narrowing; `types-and-schemas.wrangler-proof.worker.ts` plus
  `types-and-schemas.wrangler-proof.d.ts` prove Wrangler-generated
  `DurableObjectNamespace` stubs keep `append()` and `appendBatch()` callable,
  awaitable, and not `unknown` or `never`.

## Review Notes

- Round 1 adversarial review found that the first draft overused Zod, invented
  a custom fetch response shape, exposed runtime address machinery too early,
  and did not align public names with the runtime shape.
- Round 2 focused on naming and Zod boundaries. That moved root/auth context
  closer to the host types, removed duplicate dynamic capability names, and
  kept processor-owned event payload schemas out of this file.
- Round 3 found that durable capability refs still allowed arbitrary props and
  extra object fields. The schemas and expect-type tests now lock those refs to
  JSON-shaped strict objects.
- The latest pass removed the extra address alias, removed `streamPath`, made
  `Project` the project ITX surface, deleted the old project alias, made
  `AgentItx` add only `agent`, and tightened create inputs to the actual fields
  they need.
- The interface/type pass made stable RPC surfaces `interface`s and proved that
  create methods return `{ createdThing, event }`-style results so Cap'n Web
  stubs can pipeline through the returned handle.
- The current pass names the receiver mixin `ItxCapabilityHost`, names the live
  capability slot `target`, and treats the file as a future public contract
  rather than a runtime-compatibility snapshot.
- The revised file keeps the narrative shape but separates three categories:
  host/capability surfaces, generic stream schemas, and processor-contract
  support structures.
- The remaining intentional inconsistency is that some support structures have
  Zod schemas while most RPC inputs do not. This matches the current processor
  contract system: schemas belong where reduced state or stream facts need
  runtime validation.
