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
// editor/typecheck story; keep runtime code here dependency-free (only
// `cloudflare:workers` imports) so the embed stays self-contained.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type {
  DynamicWorkerCapability,
  DynamicWorkerRef,
  ItxBinding,
  Project,
  ProjectAuthPolicy,
  StatefulDynamicWorkerRef,
  StreamEvent,
  StreamEventPager,
  StreamPushEventBatch,
} from "./itx-api.generated.ts";
import type { ProcessorStream, ProcessorStreamPager } from "./processors/stream-handle.ts";

// `.ts`-suffixed like every relative import here; tsc's
// rewriteRelativeImportExtensions keeps the declaration emit for the published
// dist/sdk.d.ts, where it must resolve to dist/itx-api.generated.d.ts.
export type * from "./itx-api.generated.ts";

/** The one binding the platform supplies to every dynamic worker: `get()`
 * for capability method calls, `fetch()` for HTTP into sibling workers. */
type IterateEnv = { ITX: ItxBinding };

/**
 * The remote auth target cannot receive an ordinary Request just to inspect
 * its metadata: Workers RPC transfers the body stream even when the target
 * never reads it. Keep the normal partial-fetch contract local instead.
 */
type ProjectAuthMetadata = {
  headers: [string, string][];
  method: string;
  url: string;
};

type RemoteProjectAuth = {
  get(policy: ProjectAuthPolicy): RemoteProjectAuth;
  fetch(request: ProjectAuthMetadata | Request): Promise<Response | null>;
};

function requestMetadata(request: Request): ProjectAuthMetadata {
  const headers: [string, string][] = [];
  request.headers.forEach((value, name) => headers.push([name, value]));
  return {
    headers,
    method: request.method,
    url: request.url,
  };
}

function wrapProjectAuth(remote: RemoteProjectAuth): Project["auth"] {
  return {
    get(policy) {
      return wrapProjectAuth(remote.get(policy));
    },
    async fetch(request) {
      // The callback POST belongs to auth and its body is the token, so auth
      // deliberately consumes it and always answers. Every other path sends
      // metadata only; a null answer therefore leaves the original Request
      // byte-for-byte available to the app.
      return await remote.fetch(
        request.method === "POST" && new URL(request.url).pathname === "/_iterate/auth/callback"
          ? request
          : requestMetadata(request),
      );
    },
  };
}

function wrapProject(itx: Project & Disposable): Project & Disposable {
  let auth: Project["auth"] | undefined;
  return new Proxy(itx, {
    get(target, property) {
      if (property === "auth") {
        auth ??= wrapProjectAuth(
          Reflect.get(target, property, target) as unknown as RemoteProjectAuth,
        );
        return auth;
      }
      if (property === Symbol.dispose) {
        const dispose = Reflect.get(target, property, target) as (() => void) | undefined;
        return dispose === undefined ? undefined : () => Reflect.apply(dispose, target, []);
      }
      // Cap'n Web uses the same callable proxy shape for methods, nested
      // capabilities, and property promises. Preserve that proxy verbatim;
      // wrapping callable values would erase paths such as
      // `itx.processor.snapshot()`.
      return Reflect.get(target, property, target) as unknown;
    },
  });
}

function wrapItxBinding(binding: ItxBinding): ItxBinding {
  return {
    fetch: (request) => binding.fetch(request),
    get: async () => wrapProject(await binding.get()),
  };
}

function wrapIterateEnv<Env extends IterateEnv>(env: Env): Env {
  return { ...env, ITX: wrapItxBinding(env.ITX) };
}

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

/** Dispose an RPC stub, tolerating stubs without a disposer and disposers
 * that throw — cleanup must never mask the value it was cleaning up after. */
function disposeStub(stub: unknown): void {
  try {
    (stub as Partial<Disposable>)[Symbol.dispose]?.();
  } catch {}
}

/** Open a project itx session, use it, dispose it. RPC stubs from
 * `env.ITX.get()` must not outlive the invocation that dialed them, so every
 * operation opens its own session. */
async function withProject<T>(env: IterateEnv, fn: (project: Project) => Promise<T>): Promise<T> {
  const project = await env.ITX.get();
  try {
    return await fn(project);
  } finally {
    disposeStub(project);
  }
}

/**
 * A view of `target` with `overrides` in front and everything else passed
 * through. Proxies (not spreads or Object.create) because DurableObjectState
 * and DurableObjectStorage are host objects: their methods must be invoked
 * with the REAL receiver or workerd throws "Illegal invocation".
 */
function overlay<T extends object>(target: T, overrides: Record<PropertyKey, unknown>): T {
  return new Proxy(target, {
    get(object, prop) {
      // Own keys only: `in` would match Object.prototype inherits
      // (toString, …) and shadow the host object's.
      if (Object.hasOwn(overrides, prop)) return overrides[prop];
      const value = Reflect.get(object, prop, object);
      return typeof value === "function" ? value.bind(object) : value;
    },
  });
}

/**
 * A {@link ProcessorStream} over the project stream at `path`, dialed through
 * the platform ITX binding — the stream handle a worker-hosted stream
 * processor registry needs (`iterate/processors`; see the config-repo
 * template's guestbook for the full hosting shape). RPC stubs from
 * `env.ITX.get()` must not outlive the invocation that dialed them, so every
 * operation opens, uses, and disposes its own session; `readEvents` owns one
 * session for its pager's lifetime (scope it with `using`, like any pager).
 */
export function itxProjectStream(env: IterateEnv, path: string): ProcessorStream {
  const withStream = <T>(fn: (streams: Project["streams"]) => Promise<T>): Promise<T> =>
    withProject(env, (project) => fn(project.streams));
  return {
    append: (...events) => withStream((streams) => streams.get(path).append(...events)),
    getEvent: (args) => withStream((streams) => streams.get(path).getEvent(args)),
    getEvents: (args) => withStream((streams) => streams.get(path).getEvents(args)),
    readEvents: (args): ProcessorStreamPager => {
      let opened: Promise<{ pager: StreamEventPager; project: Disposable }> | undefined;
      let closed = false;
      return {
        next: async () => {
          if (closed) return [];
          opened ??= env.ITX.get().then((project) => ({
            pager: project.streams.get(path).readEvents(args),
            project,
          }));
          const { pager } = await opened;
          return await pager.next();
        },
        [Symbol.dispose]() {
          closed = true;
          void opened
            ?.then(({ pager, project }) => {
              disposeStub(pager);
              disposeStub(project);
            })
            .catch(() => {});
        },
      };
    },
    at: (siblingPath) => itxProjectStream(env, siblingPath),
  };
}

/**
 * Durable alarms for a stateful dynamic worker, presented as the ordinary
 * `DurableObjectState` alarm API.
 *
 * workerd does not implement alarms for facet-hosted Durable Objects — the
 * hosting model for stateful dynamic workers (workerd#6810; a facet
 * `setAlarm` even appears to succeed, then poisons the commit path). So the
 * platform Durable Object that hosts this worker keeps the real alarm on its
 * behalf: the trio here dials `itx.workers.get(ref).setAlarm/getAlarm`
 * through the worker's own ref, and the parent's fire calls this class's
 * `alarm(alarmInfo)` method — retried by the platform if it throws, exactly
 * like a native alarm handler.
 *
 * Everything except the three alarm methods is the worker's own `ctx`,
 * untouched (`storage.kv`, `waitUntil`, WebSocket APIs, …), so code written
 * against the returned state uses only standard Durable Object concepts, and
 * if workerd ships facet alarms this shim disappears without a caller
 * changing. Two honest divergences: the alarm methods ignore the native
 * `options` bag, and alarms armed inside `storage.transaction()` bypass the
 * shim. One more: native `setAlarm` rejects a class with no `alarm()`
 * handler at arm time; this shim cannot check, so a missing handler shows up
 * as a failing, platform-retried fire instead. (Fires are delivered through
 * the worker's `invokeCapability` dispatcher — workerd reserves `alarm` as
 * an RPC method name — and `IterateDurableObject` carries that dispatcher,
 * so extending it is all a class needs.)
 *
 * ```ts
 * export class MyApp extends IterateDurableObject {
 *   // Construct the registry lazily — it needs the project id, which a
 *   // stateful worker learns asynchronously (see the template guestbook's
 *   // #ensureHost for the reference shape).
 *   #registry(projectId: string) {
 *     return createStreamProcessorRegistry(
 *       withStatefulWorkerAlarms(this.ctx, this.env, MY_APP_REF),
 *       { projectId, ... },
 *     );
 *   }
 *   async alarm(alarmInfo?: AlarmInvocationInfo) {
 *     await this.#ensureRegistry().handleAlarm(alarmInfo);
 *   }
 * }
 * ```
 */
export function withStatefulWorkerAlarms(
  ctx: DurableObjectState,
  env: IterateEnv,
  ref: StatefulDynamicWorkerRef,
): DurableObjectState {
  const withWorker = <T>(fn: (worker: DynamicWorkerCapability) => Promise<T>): Promise<T> =>
    withProject(env, (project) => fn(project.workers.get(ref)));
  return overlay(ctx, {
    storage: overlay(ctx.storage, {
      setAlarm: (scheduledTime: number | Date) =>
        withWorker((worker) =>
          worker.setAlarm(
            typeof scheduledTime === "number" ? scheduledTime : scheduledTime.getTime(),
          ),
        ),
      deleteAlarm: () => withWorker((worker) => worker.setAlarm(null)),
      getAlarm: () => withWorker((worker) => worker.getAlarm()),
    }),
  });
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
> extends WorkerEntrypoint<Env> {
  constructor(ctx: ConstructorParameters<typeof WorkerEntrypoint<Env>>[0], env: Env) {
    super(ctx, env);
    this.env = wrapIterateEnv(env);
  }

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
export class IterateDurableObject<Env extends IterateEnv = IterateEnv> extends DurableObject<Env> {
  constructor(ctx: ConstructorParameters<typeof DurableObject<Env>>[0], env: Env) {
    super(ctx, env);
    this.env = wrapIterateEnv(env);
  }

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
