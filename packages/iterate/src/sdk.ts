// `iterate/sdk` — what an iterate project repo imports from.
//
// The platform's public capability types (Project, Stream, StreamEvent,
// ItxBinding, …) are generated from the platform's RpcTargets into
// ./itx-api.generated.ts (regenerate from apps/os: `pnpm generate:itx-api`)
// and re-exported here. Hand-written helpers for project code accumulate in
// this file.
//
// Dynamic workers install and bundle this published package from their normal
// package.json dependency. Preview deployments rewrite that dependency to the
// exact pkg.pr.new artifact produced by the pull request.
import { DurableObject, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import type {
  DynamicWorkerCapability,
  DynamicWorkerRef,
  ItxBinding,
  Project,
  ProjectAuthActor,
  ProjectAuthCredentials,
  ProjectAuthPolicy,
  StatefulDynamicWorkerRef,
  StreamEvent,
  StreamEventPager,
  StreamPushEventBatch,
} from "./itx-api.generated.ts";
import type { ProcessorStream, ProcessorStreamPager } from "./processors/stream-handle.ts";
import { dispatchProjectApps, type IterateProjectApp } from "./project-apps.ts";
import type {
  ProcessorSnapshot,
  StreamSubscriberWakeRequest,
  StreamSubscriberWakeResponse,
} from "./processors/rpc-types.ts";
import {
  createStreamProcessorRegistry,
  type RegisterableProcessor,
  type RegisteredProcessorReads,
  type StreamProcessorRegistry,
} from "./processors/cloudflare.ts";

// `.ts`-suffixed like every relative import here; tsc's
// rewriteRelativeImportExtensions keeps the declaration emit for the published
// dist/sdk.d.ts, where it must resolve to dist/itx-api.generated.d.ts.
export type * from "./itx-api.generated.ts";

/**
 * What the platform supplies to every dynamic worker: the `ITX` binding
 * (`get()` for capability method calls, `fetch()` for HTTP into sibling
 * workers) and `ITERATE_WORKER_VERSION` — the worker's own content-addressed
 * build identity, changing exactly when its source does. Pass the latter as
 * the `version` of a hosted processor registry: a version change is what
 * resets a crash-looping keepalive's backoff budget, so a broken-then-fixed
 * worker recovers on its next build instead of waiting out the backoff.
 */
type IterateEnv = { ITX: ItxBinding; ITERATE_WORKER_VERSION: string };

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
  authenticate(
    request: ProjectAuthMetadata,
    credentials: ProjectAuthCredentials,
  ): Promise<ProjectAuthActor>;
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
    async authenticate(request, credentials) {
      return await remote.authenticate(requestMetadata(request), credentials);
    },
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

/** Where the platform-delivered self ref lives in this worker's own storage
 * (see {@link IterateDurableObject.__stashSelfRef}). */
const SELF_REF_STORAGE_KEY = "iterate:self-ref";

/**
 * Durable alarms for a stateful dynamic worker, presented as the ordinary
 * `DurableObjectState` alarm API — what `IterateDurableObject` installs as
 * `this.ctx`, so alarms on stateful workers just work.
 *
 * workerd does not implement alarms for facet-hosted Durable Objects — the
 * hosting model for stateful dynamic workers (workerd#6810; a facet
 * `setAlarm` even appears to succeed, then poisons the commit path). So the
 * platform Durable Object that hosts this worker keeps the real alarm on its
 * behalf: the trio here dials `itx.workers.get(ref).setAlarm/getAlarm` on the
 * worker's own ref — delivered by the host before any other traffic and
 * stashed durably ({@link IterateDurableObject.__stashSelfRef}) — and the
 * host's fire calls this class's `alarm(alarmInfo)` method, retried by the
 * platform if it throws, exactly like a native alarm handler.
 *
 * Everything except the three alarm methods is the worker's own `ctx`,
 * untouched (`storage.kv`, `waitUntil`, WebSocket APIs, …), so code written
 * against this state uses only standard Durable Object concepts, and if
 * workerd ships facet alarms the shim disappears without a caller changing.
 * Honest divergences: the alarm methods ignore the native `options` bag,
 * alarms armed inside `storage.transaction()` bypass the shim, and a class
 * with no `alarm()` handler fails at fire time (native `setAlarm` rejects at
 * arm time; the shim cannot check).
 */
function selfAlarmState<State extends DurableObjectState>(ctx: State, env: IterateEnv): State {
  const withSelf = <T>(fn: (worker: DynamicWorkerCapability) => Promise<T>): Promise<T> => {
    const ref = ctx.storage.kv.get<StatefulDynamicWorkerRef>(SELF_REF_STORAGE_KEY);
    if (ref === undefined) {
      // Unreachable after any platform contact — every call, fetch, and
      // alarm fire delivers the ref first. Constructor bodies run before
      // that first contact, hence the carve-out in the error.
      throw new Error(
        "this worker's own ref has not been delivered yet — alarms are unavailable in the " +
          "constructor; arm from a handler instead",
      );
    }
    return withProject(env, (project) => fn(project.workers.get(ref)));
  };
  return overlay(ctx, {
    storage: overlay(ctx.storage, {
      setAlarm: (scheduledTime: number | Date) =>
        withSelf((worker) =>
          worker.setAlarm(
            typeof scheduledTime === "number" ? scheduledTime : scheduledTime.getTime(),
          ),
        ),
      deleteAlarm: () => withSelf((worker) => worker.setAlarm(null)),
      getAlarm: () => withSelf((worker) => worker.getAlarm()),
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
  /** Declarative project apps receive every committed event in registration order. */
  protected apps: IterateProjectApp<Env>[] = [];

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
  protected async processEvent(event: StreamEvent): Promise<void> {
    await dispatchProjectApps(this.apps, event, this.env);
  }

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
 * across requests and WebSockets can be served from `fetch`. Durable alarms
 * work natively — `this.ctx.storage.setAlarm(...)` plus an `alarm()` method
 * on the class — even though this object is hosted as a workerd facet with
 * no alarms of its own; see {@link selfAlarmState} for the mechanism.
 */
export class IterateDurableObject<Env extends IterateEnv = IterateEnv> extends DurableObject<Env> {
  constructor(ctx: ConstructorParameters<typeof DurableObject<Env>>[0], env: Env) {
    super(ctx, env);
    this.env = wrapIterateEnv(env);
    // Read back through the property so the overlay carries the exact ctx
    // type the base class declares in every typecheck context.
    this.ctx = selfAlarmState(this.ctx, this.env);
  }

  /**
   * Platform bootstrap door: the Durable Object hosting this worker delivers
   * the worker's OWN ref here before any other traffic in its incarnation —
   * a facet has no channel to learn its identity by itself, and the ref is
   * what the alarm shim dials (`itx.workers.get(ref)` resolves back to the
   * hosting DO). Stashed durably, so a warm facet under a fresh host needs
   * no re-delivery to keep working.
   */
  __stashSelfRef(ref: StatefulDynamicWorkerRef): void {
    this.ctx.storage.kv.put(SELF_REF_STORAGE_KEY, ref);
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
// =============================================================================
// Durable Object stream-processor hosting.
// =============================================================================

const HOST_PROJECT_ID_KEY = "iterate:processor-host:project-id";
const HOST_STREAM_PATH_KEY = "iterate:processor-host:stream-path";

type WakeRegistryLookup = (
  projectId: string,
  path: string,
) => Pick<StreamProcessorRegistry<object>, "wakeStreamSubscriber">;

/** The wake door the stream spine dials. It crosses Workers RPC as a property
 * read before its method is called, so it must be a real RpcTarget. */
class ProcessorWakeSubscriber extends RpcTarget {
  readonly #registryFor: WakeRegistryLookup;

  constructor(registryFor: WakeRegistryLookup) {
    super();
    this.#registryFor = registryFor;
  }

  async wakeStreamSubscriber(
    request: StreamSubscriberWakeRequest,
  ): Promise<StreamSubscriberWakeResponse> {
    if (request.stream.projectId === null) {
      throw new Error("stream-processor hosts subscribe on project streams only");
    }
    // The registry fences mismatched coordinates itself, so a host with a
    // fixed home stream rejects a stray wake instead of adopting its path.
    return await this.#registryFor(
      request.stream.projectId,
      request.stream.path,
    ).wakeStreamSubscriber(request);
  }
}

export type ProcessorHost<State extends object> = {
  /** The lazily built registry. Outside a wake request the coordinates come
   * from the durable cache, the static `path`, or one project dial. */
  registry(): Promise<StreamProcessorRegistry<State>>;
  /** One consistent read of the hosted processor's committed fold. */
  snapshot(): Promise<ProcessorSnapshot<State>>;
  /** Assign to a `processor` getter — the wake door the stream spine dials. */
  readonly wakeSubscriber: ProcessorWakeSubscriber;
  /** Route the Durable Object's `alarm()` here. Nothing cached means no
   * registry ever armed one, so a stray fire is a no-op. */
  handleAlarm(alarmInfo?: AlarmInvocationInfo): Promise<void>;
};

/**
 * Host one stream processor in a Durable Object: the registry ceremony, the
 * RPC-safe wake door, the alarm multiplex, and the durable coordinate cache
 * in one place, so an app class is only its processor plus its own verbs.
 *
 * With `path` the host serves one fixed home stream (the guestbook shape).
 * Without it the host learns its stream from the first wake request and
 * caches the coordinates durably (the review-bot shape: one Durable Object
 * per dynamic stream, keyed by the ref that names it). One host per Durable
 * Object — the cache keys assume it.
 */
export function createProcessorHost<State extends object = Record<string, unknown>>(args: {
  ctx: DurableObjectState;
  env: IterateEnv;
  path?: string;
  /** Post-eviction keepalive recovery, for processors that owe registered work. */
  recovery?: boolean;
  createProcessor(deps: {
    path: string;
    projectId: string;
    stream: ProcessorStream;
  }): RegisterableProcessor;
}): ProcessorHost<State> {
  let built:
    | { reads: RegisteredProcessorReads<State>; registry: StreamProcessorRegistry<State> }
    | undefined;

  const ensure = (projectId: string, path: string) => {
    if (built === undefined) {
      args.ctx.storage.kv.put(HOST_PROJECT_ID_KEY, projectId);
      args.ctx.storage.kv.put(HOST_STREAM_PATH_KEY, path);
      const stream = itxProjectStream(args.env, path);
      const registry = createStreamProcessorRegistry<State>(args.ctx, {
        path,
        projectId,
        stream,
        version: args.env.ITERATE_WORKER_VERSION,
      });
      const processor = registry.register(
        args.createProcessor({ path, projectId, stream }),
        args.recovery === undefined ? undefined : { recovery: args.recovery },
      );
      built = {
        // `RegisterableProcessor` erases the contract, so `reads` comes back
        // `<unknown>`; the caller's `State` is the same assertion it already
        // makes for the registry generic above.
        reads: registry.reads(processor) as RegisteredProcessorReads<State>,
        registry,
      };
    }
    return built;
  };

  const buildOutsideWake = async () => {
    if (built !== undefined) return built;
    const path = args.path ?? args.ctx.storage.kv.get<string>(HOST_STREAM_PATH_KEY);
    if (path === undefined) {
      throw new Error("this processor host learns its stream from the first wake request");
    }
    const projectId =
      args.ctx.storage.kv.get<string>(HOST_PROJECT_ID_KEY) ??
      (await withProject(args.env, async (project) => await project.projectId));
    return ensure(projectId, path);
  };

  return {
    registry: async () => (await buildOutsideWake()).registry,
    snapshot: async () => await (await buildOutsideWake()).reads.snapshot(),
    wakeSubscriber: new ProcessorWakeSubscriber(
      (projectId, path) => ensure(projectId, args.path ?? path).registry,
    ),
    async handleAlarm(alarmInfo?: AlarmInvocationInfo) {
      const projectId = args.ctx.storage.kv.get<string>(HOST_PROJECT_ID_KEY);
      const path = args.path ?? args.ctx.storage.kv.get<string>(HOST_STREAM_PATH_KEY);
      if (projectId === undefined || path === undefined) return;
      await ensure(projectId, path).registry.handleAlarm(alarmInfo);
    },
  };
}
