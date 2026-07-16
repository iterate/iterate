// `iterate/sdk` — what an iterate project repo imports from.
//
// The platform's public capability types (Project, Stream, StreamEvent,
// ItxBinding, …) are generated from the platform's RpcTargets into
// ./itx-api.generated.ts (regenerate from apps/os: `pnpm generate:itx-api`)
// and re-exported here. Hand-written helpers for project code accumulate in
// this file.
//
// Runtime exports here reach dynamic workers WITHOUT an npm install: the
// platform embeds this module (compiled to plain JS) as the `iterate/sdk`
// virtual module in every dynamic worker build — see apps/os
// iterate-sdk-virtual-module.generated.ts. The published package is still the
// editor/typecheck story. The embed is bundled, so the stream-processor
// runtime and its zod/capnweb dependencies are available in project workers
// without a project-level npm install.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type {
  DynamicWorkerRef,
  ItxBinding,
  StreamEvent,
  StreamPushEventBatch,
} from "./itx-api.generated";

// Extensionless on purpose: this specifier lands verbatim in the published
// dist/sdk.d.ts, where it must resolve to dist/itx-api.generated.d.ts.
export type * from "./itx-api.generated";

// A project-defined processor uses the same contract, runtime, and Durable
// Object host as the platform's built-in processors. The `.js` specifiers land
// verbatim in the published declarations and resolve to emitted files; the
// virtual `iterate/sdk` module bundles their runtime implementations.
export * from "./processor-contracts.js";
export * from "./stream-processor.js";
export * from "./stream-processor-host.js";
export {
  StreamEvent as StreamEventSchema,
  StreamEventInput as StreamEventInputSchema,
  StreamListItem as StreamListItemSchema,
} from "./stream-events.js";
export { z } from "zod";

/** The one binding the platform supplies to every dynamic worker: `get()`
 * for capability method calls, `fetch()` for HTTP into sibling workers. */
type IterateEnv = { ITX: ItxBinding };

// Plain Node test runners expose the `cloudflare:workers` module shim without
// its runtime base classes. Falling back to inert bases keeps contracts and
// pure processor code importable there; a deployed worker always receives
// the real workerd classes and therefore never takes this lane.
const DurableObjectBase = DurableObject ?? class {};
const WorkerEntrypointBase = WorkerEntrypoint ?? class {};

/**
 * Forward a request to one of the project's dynamic workers (an "app") —
 * pages, APIs, streaming bodies, and WebSocket upgrades all ride through.
 *
 * Why this is a real `env.ITX.fetch` hop with the ref in a header, and not a
 * method call on the app: workerd only performs protocol work — WebSocket 101
 * upgrades, streaming response bodies — through genuine `fetch` handler hops
 * between workers. Calling `fetch` (or anything else) on an app handle from
 * `project.workers.get(ref)` is ordinary RPC: arguments and results are
 * serialized copies, so a Response carrying a socket cannot cross it (workerd
 * throws a DataCloneError). And because a fetch hop's only side channel for
 * "which worker do I mean" is the request itself, the target ref rides the
 * x-iterate-worker-dispatch header (JSON `{ ref, buildBudgetMs? }` — the same
 * ref shape `project.workers.get` takes). Method calls on apps still go
 * through `project.workers.get(ref)` RPC dispatch; HTTP never does.
 *
 * A cold build past `buildBudgetMs` (default 15s) answers a 503 building page
 * that refreshes itself, marked with x-iterate-worker-building — intercept
 * that response here to render your own.
 */
async function fetchDynamicWorker(
  env: IterateEnv,
  req: Request,
  ref: DynamicWorkerRef,
  opts?: { buildBudgetMs?: number },
): Promise<Response> {
  const headers = new Headers(req.headers);
  headers.set(
    "x-iterate-worker-dispatch",
    JSON.stringify({ buildBudgetMs: opts?.buildBudgetMs ?? 15_000, ref }),
  );
  return await env.ITX.fetch(new Request(req, { headers }));
}

/**
 * Walk a dotted capability path over the worker instance and invoke the final
 * segment. The platform dispatches `itx.worker.<path>` calls as ONE flattened
 * `invokeCapability({ path, args })`, and this walks it in userland: nothing
 * ever crosses RPC except the final method's arguments and result, so a
 * getter on the worker class can hand back a whole vendor SDK (installed from
 * package.json) — or any nested surface — in a single round trip.
 */
async function invokeCapability(
  receiver: unknown,
  { args = [], path }: { args?: unknown[]; path: string[] },
): Promise<unknown> {
  for (const segment of path.slice(0, -1)) {
    receiver = await Reflect.get(Object(receiver), segment);
  }
  const method = path.at(-1)!;
  const handler = Reflect.get(Object(receiver), method);
  if (typeof handler !== "function") {
    throw new Error(`"${path.join(".")}" is not a method on this worker`);
  }
  return await Reflect.apply(handler, receiver, args);
}

/**
 * Base class for stateless dynamic workers — the project worker (a repo's
 * default export) and stateless apps. A WorkerEntrypoint whose env carries
 * the platform's itx binding, plus the platform ceremony every worker needs
 * but shouldn't have to hand-roll:
 *
 * - `processEventBatch` / `processEvent`: the platform delivers every
 *   committed DURABLE event on every stream in the project as checkpointed
 *   per-stream batches — in per-stream order, at-least-once. Events appended
 *   with `ephemeral: true` (LLM streaming chunks and other transient
 *   signals) never arrive here — they ride live `subscribe()` connections
 *   only; react to the durable fact that supersedes them (e.g.
 *   an assistant-role `agents/context-added` item). The base unpacks batches
 *   into one `processEvent(event)` call per event; override `processEvent` to react
 *   (one `if` per reaction, keyed on event.path + event.type). Throwing (or a worker that fails to build) leaves that
 *   stream's checkpoint in place and the whole batch is redelivered later,
 *   so return normally to advance past events you don't care about — and
 *   anything a reaction appends should carry an idempotency key.
 * - `invokeCapability`: the flattened `itx.worker.<path>` dispatcher — add a
 *   getter or method to your class and it becomes a capability surface.
 * - `fetchDynamicWorker`: forward HTTP (WebSockets included) to another of
 *   the project's dynamic workers.
 */
export class IterateWorkerEntrypoint<
  Env extends IterateEnv = IterateEnv,
> extends WorkerEntrypointBase<Env> {
  /** See `fetchDynamicWorker` at module level: a real fetch hop into a
   * sibling dynamic worker — the only lane that can carry WebSocket upgrades
   * and streaming bodies (RPC serializes; sockets can't cross it). */
  protected async fetchDynamicWorker(
    req: Request,
    ref: DynamicWorkerRef,
    opts?: { buildBudgetMs?: number },
  ): Promise<Response> {
    return await fetchDynamicWorker(this.env, req, ref, opts);
  }

  /** Platform entry point for event delivery (see the class docstring for
   * the delivery contract). Override `processEvent`, not this, unless you
   * need whole-batch atomicity. */
  async processEventBatch(batch: StreamPushEventBatch): Promise<void> {
    for (const event of batch.events) await this.processEvent(event);
  }

  /** Called once per delivered event, in per-stream order, at-least-once.
   * Override to react; the default ignores everything. */
  protected async processEvent(_event: StreamEvent): Promise<void> {}

  /** Platform entry point for flattened `itx.worker.<path>` capability
   * calls (see the class docstring). */
  async invokeCapability(input: { args?: unknown[]; path: string[] }): Promise<unknown> {
    return await invokeCapability(this, input);
  }
}

/**
 * Base class for stateful dynamic workers (apps hosted as Durable Objects
 * under a `durableWorkerKey`). Same platform surface as
 * `IterateWorkerEntrypoint` — see its docstring for the event-delivery and
 * capability-dispatch contracts — on a DurableObject, so state survives
 * across requests and WebSockets can be served from `fetch`.
 */
export class IterateDurableObject<
  Env extends IterateEnv = IterateEnv,
> extends DurableObjectBase<Env> {
  /** A real fetch hop into a sibling dynamic worker — see
   * `IterateWorkerEntrypoint.fetchDynamicWorker`. */
  protected async fetchDynamicWorker(
    req: Request,
    ref: DynamicWorkerRef,
    opts?: { buildBudgetMs?: number },
  ): Promise<Response> {
    return await fetchDynamicWorker(this.env, req, ref, opts);
  }

  /** Platform entry point for event delivery — see
   * `IterateWorkerEntrypoint.processEventBatch`. */
  async processEventBatch(batch: StreamPushEventBatch): Promise<void> {
    for (const event of batch.events) await this.processEvent(event);
  }

  /** Called once per delivered event — see
   * `IterateWorkerEntrypoint.processEvent`. */
  protected async processEvent(_event: StreamEvent): Promise<void> {}

  /** Platform entry point for flattened `itx.worker.<path>` capability
   * calls — see `IterateWorkerEntrypoint.invokeCapability`. */
  async invokeCapability(input: { args?: unknown[]; path: string[] }): Promise<unknown> {
    return await invokeCapability(this, input);
  }
}
