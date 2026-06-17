// server.ts — the Cloudflare Worker that hosts itx.
//
// One Worker, Project/Agent Durable Objects host their own embedded itx
// processors, and each context still has one durable event log. The public
// surface is:
//
//   /api/itx                         -> admin-only platform root
//   /api/itx/<projectId>             -> project context
//   project.agents.get("/agents/x")  -> agent ITX surface
//
// There is no global/`__global__` context: a project is its own ITX root, and
// cross-project / platform reach lives ONLY behind the admin root.
//
// A NAKED Cap'n Web stub drives every context: `itx.provideCapability({…})` and
// `itx.slack.chat.postMessage(msg)` are both just pipelined property paths that
// end in a call. The trick is entirely server-side: `pathInvokerToProxy`
// (below) collapses every terminal call into one `invokeCapability({ path, args })`.
// The context, not the proxy, decides
// whether that path is a reserved ITX control name or a user capability.

import { DurableObject, env as workerEnv, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { newWorkersRpcResponse } from "capnweb";
import {
  createStreamProcessorHost,
  type RequestStreamSubscriptionArgs,
} from "@iterate-com/os/src/domains/streams/engine/workers/stream-processor-host.ts";
import { durableObjectProcessorSubscriber } from "@iterate-com/os/src/domains/streams/engine/shared/callable-subscriber.ts";
import { ItxContract } from "./contract.ts";
import { ItxProcessor, replayPath, type ItxContext, type ProvideArgs } from "./itx.ts";
import { RootItx } from "./root-itx.ts";
import { authenticate, authorizeProjectAccess } from "./auth.ts";
import {
  formatDurableObjectName,
  parseDurableObjectName,
  PLATFORM_PROJECT_ID,
  type DurableObjectNameParts,
} from "./durable-object-names.ts";

// The real durable event log from apps/os — re-exported so wrangler hosts it as
// a Durable Object. A context's capability table is the fold of one of these.
export { Stream } from "@iterate-com/os/src/domains/streams/engine/workers/durable-objects/stream.ts";

export class ItxBindingEntrypoint extends WorkerEntrypoint<
  Env,
  { projectId: string; path: string }
> {
  async get(): Promise<ItxContext> {
    const node = contextNode(this.env, this.ctx.props);
    return itxHandleForNode(node);
  }
}

// ---------------------------------------------------------------------------
// The server-side path proxy — the load-bearing trick.
// ---------------------------------------------------------------------------
//
// Capabilities are registered at RUNTIME and change over a context's life, so
// the served main object cannot be a class with fixed methods. It must answer
// names it has never heard of and collapse an accumulated dotted path into one
// `invokeCapability`. The processor decides whether that path is an ITX control
// call (`describe`, `provideCapability`, ...) or a user capability. Three
// non-obvious requirements, each a real debugging round (and the reason an
// earlier draft wrongly concluded this "doesn't work"):
//
//   1. The target must be FUNCTION-typed (a Proxy over `function(){}`), NOT a
//      Proxy over an RpcTarget. Cap'n Web classifies an rpc-target by prototype
//      and forbids fabricated "instance properties"; a function-typed target is
//      traversed via Object.hasOwn, where fabricated own properties are allowed.
//   2. `getOwnPropertyDescriptor` is load-bearing, not just `get`. Server-side
//      Cap'n Web does Object.hasOwn(value, segment) BEFORE reading value[segment];
//      without the descriptor trap every segment reads as absent and the path
//      dies at ".chat of undefined".
//   3. `has` must answer for non-reserved names too.
//
// The inverse adapter is `PathInvoker`: it takes a normal object and exposes the
// one path invocation method by replaying `{ path, args }` onto that object.
// The host DOs use `new PathInvoker(this)` as their base built-in at `path: []`.

// Names Cap'n Web (or the JS runtime) probes that must never be treated as path
// segments or verbs — they would derail the proxy or trigger thenable detection.
const RESERVED = new Set([
  "then",
  "__proto__",
  "constructor",
  "prototype",
  "apply",
  "call",
  "bind",
  "dup",
  "onRpcBroken",
]);

type PathInvocation = { path: string[]; args?: unknown[] };
type PathInvokable = { invokeCapability(args: PathInvocation): unknown };

const ITX_HOST_INTERNAL_PATHS = new Set([
  "describe",
  "itx",
  "invokeCapability",
  "provideCapability",
  "requestStreamSubscription",
  "revokeCapability",
  "runScript",
]);

class PathInvoker implements PathInvokable {
  #target: unknown;
  #exclude: ReadonlySet<string>;

  constructor(target: unknown, options: { exclude?: ReadonlySet<string> } = {}) {
    this.#target = target;
    this.#exclude = options.exclude ?? new Set();
  }

  invokeCapability({ path, args = [] }: PathInvocation) {
    if (path[0] && this.#exclude.has(path[0])) {
      throw new Error(`path "${path[0]}" is not part of this public capability surface`);
    }
    return replayPath(this.#target, path, args);
  }
}

function pathInvokerToProxy(target: PathInvokable, path: string[] = []): any {
  const valueFor = (key: string) => pathInvokerToProxy(target, [...path, key]);
  return new Proxy(function () {}, {
    get(t, key) {
      if (typeof key === "symbol") return Reflect.get(t, key);
      if (RESERVED.has(key as string)) return undefined; // includes "then": never thenable
      return valueFor(key);
    },
    getOwnPropertyDescriptor(t, key) {
      if (typeof key === "symbol" || RESERVED.has(key as string))
        return Reflect.getOwnPropertyDescriptor(t, key);
      return { configurable: true, enumerable: true, writable: false, value: valueFor(key) };
    },
    has(t, key) {
      return typeof key === "symbol" ? key in t : !RESERVED.has(key as string);
    },
    apply(_t, _s, args) {
      // Every terminal call becomes one path invocation. The target, not this
      // proxy, owns the meaning of root paths like ["describe"].
      return target.invokeCapability({ path, args: args as unknown[] });
    },
  });
}

interface Env {
  PROJECT: DurableObjectNamespace<ProjectDurableObject>;
  AGENT: DurableObjectNamespace<AgentDurableObject>;
  REPO: DurableObjectNamespace<RepoDurableObject>;
  STREAM: DurableObjectNamespace<any>;
  // Worker Loader: build + run dynamic workers/facets and codemode scripts at
  // runtime.
  LOADER: {
    get(
      id: string,
      getCode: () => {
        compatibilityDate: string;
        compatibilityFlags: string[];
        env?: Record<string, unknown>;
        mainModule: string;
        modules: Record<string, string>;
      },
    ): {
      getEntrypoint(name?: string, options?: { props?: Record<string, unknown> }): any;
      getDurableObjectClass?(name?: string): any;
    };
  };
}

type ItxHostNode = {
  describe(): Promise<unknown>;
  invokeCapability(args: { path: string[]; args?: unknown[] }): Promise<unknown>;
  provideCapability(args: ProvideArgs): Promise<unknown>;
  readonly itx: ItxContext;
  revokeCapability(args: { path: string[] }): Promise<unknown>;
  runScript(args: { code: string }): Promise<unknown>;
};

function itxHandleForNode(node: ItxHostNode): ItxContext {
  return pathInvokerToProxy({
    invokeCapability: ({ path, args = [] }: { path: string[]; args?: unknown[] }) => {
      if (path[0] === "runScript") {
        if (path.length !== 1) throw new Error('reserved ITX control path "runScript"');
        return node.runScript(args[0] as { code: string });
      }
      return node.invokeCapability({ path, args });
    },
  }) as ItxContext;
}

function contextNode(env: Env, parts: { projectId: string; path: string }): ItxHostNode {
  if (parts.path === "/") {
    return env.PROJECT.getByName(formatDurableObjectName(parts)) as unknown as ItxHostNode;
  }
  if (parts.path.startsWith("/agents/")) {
    return env.AGENT.getByName(formatDurableObjectName(parts)) as unknown as ItxHostNode;
  }
  throw new Error(
    `no ITX host for path "${parts.path}" (only "/" and "/agents/..." are host-owned contexts)`,
  );
}

// Content-addressed cache key for a loaded isolate: same source → same isolate.
function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

const PROJECT_REPO_PATH = "/repos/project";

// A context's durable event log lives at `/itx` (project root) or `/itx/agents/…`
// (agent) within the SAME projectId — the same `{projectId}:{path}` scheme as
// every other Durable Object (durable-object-names.ts).
function itxLogName(contextName: string): string {
  const context = parseDurableObjectName(contextName);
  return formatDurableObjectName({
    projectId: context.projectId,
    path: context.path === "/" ? "/itx" : `/itx${context.path}`,
  });
}

type DynamicWorkerSource =
  | {
      type: "inline";
      mainModule: string;
      modules: Record<string, string>;
      compatibilityDate?: string;
    }
  | {
      type: "repo";
      repo: string;
      commit: string | "latest";
      path: string;
      compatibilityDate?: string;
    };

type ResolvedWorkerSource = {
  cacheKey: string;
  compatibilityDate?: string;
  mainModule: string;
  modules: Record<string, string>;
};

function localPathProxy(target: unknown | Promise<unknown>, path: string[] = []): any {
  return new Proxy(function () {}, {
    get(_t, key) {
      if (typeof key === "symbol") return undefined;
      if (RESERVED.has(key as string)) return undefined;
      return localPathProxy(target, [...path, key as string]);
    },
    apply: async (_t, _s, args) => await replayPath(await target, path, args),
  });
}

// ---------------------------------------------------------------------------
// The itx context host — one Durable Object hosting the real StreamProcessor.
//
// The capability table is the FOLD of a durable event log: provide appends an
// event, the fold projects it, replaying the log rebuilds it. The processor's
// checkpoint is a disposable cache in this DO's storage; the live stubs are an
// in-memory field inside the processor; the log itself is the real `Stream`
// Durable Object, resolved by coordinate.
// ---------------------------------------------------------------------------
abstract class ItxHostDurableObject extends DurableObject<Env> {
  host = createStreamProcessorHost(this.ctx);
  #subscriptionConfigured = false;
  #dynamicDurableObjectVersions = new Map<string, string>();
  #itx = this.host.add(
    ItxContract.slug,
    (deps) =>
      new ItxProcessor({
        ...deps,
        iterateContext: { stream: this.#log() },
        resolveAddress: (address) => this.#resolveAddress(address),
        builtinCapabilities: [
          {
            path: [],
            capability: new PathInvoker(this, { exclude: ITX_HOST_INTERNAL_PATHS }),
            instructions: "the host Durable Object's public capability surface",
          },
        ],
      }),
  );

  protected nameParts(): DurableObjectNameParts | null {
    const name = this.ctx.id.name;
    return name ? parseDurableObjectName(name) : null;
  }

  // An itx context Durable Object is always summoned by name (getByName), so its
  // coordinate is always present. Fail loudly rather than invent a fallback.
  #requireName(): string {
    const name = this.ctx.id.name;
    if (!name) throw new Error("itx context Durable Object must be addressed by name");
    return name;
  }

  #requireNameParts(): DurableObjectNameParts {
    return parseDurableObjectName(this.#requireName());
  }

  protected requireProjectId(): string {
    const projectId = this.nameParts()?.projectId;
    if (!projectId) throw new Error("ITX host Durable Object must be project-scoped");
    return projectId;
  }

  // Capability address → callable stub.
  #resolveAddress(address: any): any {
    if (address?.type === "dynamic-worker") {
      const loaded = this.#loadDynamicWorker(address.source);
      const entrypoint = loaded.then((worker) =>
        worker.getEntrypoint(address.entrypoint, { props: address.props ?? {} }),
      );
      entrypoint.catch(() => {});
      return localPathProxy(entrypoint);
    }
    if (address?.type === "dynamic-durable-object") {
      const facetName = `dynamic-durable-object:${hashString(
        JSON.stringify({
          className: address.className,
          mountPath: address.mountPath,
        }),
      )}`;
      return localPathProxy(this.#dynamicDurableObjectFacet(facetName, address));
    }
    throw new Error(`address is not resolvable: ${JSON.stringify(address)}`);
  }

  async #resolveWorkerSource(source: DynamicWorkerSource): Promise<ResolvedWorkerSource> {
    if (source.type === "inline") {
      return {
        cacheKey: hashString(JSON.stringify(source)),
        compatibilityDate: source.compatibilityDate,
        mainModule: source.mainModule,
        modules: source.modules,
      };
    }
    const repo = this.env.REPO.getByName(
      formatDurableObjectName({
        projectId: this.requireProjectId(),
        path: PROJECT_REPO_PATH,
      }),
    );
    const resolved = await repo.getWorkerSource({ path: source.path });
    return {
      cacheKey: hashString(JSON.stringify({ source, resolved })),
      compatibilityDate: source.compatibilityDate ?? resolved.compatibilityDate,
      mainModule: resolved.mainModule,
      modules: resolved.modules,
    };
  }

  #loadResolvedDynamicWorker(resolved: ResolvedWorkerSource) {
    return this.env.LOADER.get(`dynamic-worker:${resolved.cacheKey}`, () => ({
      compatibilityDate: resolved.compatibilityDate ?? "2026-05-01",
      compatibilityFlags: ["nodejs_compat"],
      env: {
        ITX: ((this.ctx as any).exports as any).ItxBindingEntrypoint({
          props: this.#requireNameParts(),
        }),
      },
      mainModule: resolved.mainModule,
      modules: resolved.modules,
    }));
  }

  async #loadDynamicWorker(source: DynamicWorkerSource) {
    const resolved = await this.#resolveWorkerSource(source);
    return this.#loadResolvedDynamicWorker(resolved);
  }

  async #dynamicDurableObjectFacet(facetName: string, address: any) {
    const resolved = await this.#resolveWorkerSource(address.source);
    const version = JSON.stringify({ cacheKey: resolved.cacheKey, className: address.className });
    const versionKey = `itx:dynamic-do-facet-version:${facetName}`;
    const previous =
      this.#dynamicDurableObjectVersions.get(facetName) ??
      ((await this.ctx.storage.get(versionKey)) as string | undefined);

    // Cloudflare facets deliberately split durable identity from loaded code:
    // the facet NAME owns the SQLite database, while abort(name) stops the
    // current class without deleting that database. So the name excludes source
    // (storage survives repo/source upgrades), and the source hash is tracked as
    // supervisor metadata. When it changes, abort first; the next get() starts
    // the same named facet with the new class and the old storage.
    if (previous && previous !== version) {
      (this.ctx as any).facets.abort(
        facetName,
        `dynamic Durable Object source changed for ${facetName}`,
      );
    }
    this.#dynamicDurableObjectVersions.set(facetName, version);
    // This marker is supervisor metadata, not user data. We need it durably so a
    // freshly-started host DO can tell whether an already-running facet is on
    // the source/class version it is about to serve. But once the in-memory
    // map has seen the current version, writing the same marker on every method
    // call is pure hot-path storage churn. Persist only the first observation for
    // this isolate or an actual version change.
    if (previous !== version) {
      await this.ctx.storage.put(versionKey, version);
    }

    return (this.ctx as any).facets.get(facetName, async () => {
      const worker = this.#loadResolvedDynamicWorker(resolved);
      const klass = worker.getDurableObjectClass?.(address.className);
      if (!klass) {
        throw new Error(`Dynamic worker did not export DurableObject ${address.className}.`);
      }
      return { class: klass };
    });
  }

  // This context's durable event log is its OWN stream, named by coordinate — a
  // context IS its stream coordinate. Re-resolve the stub per call so it stays
  // valid across the log's lifecycle.
  #coordinate(): string {
    return itxLogName(this.#requireName());
  }
  #log() {
    // `as any` on the stream stub avoids a deep StreamProcessor-generic
    // instantiation tsc flags as "excessively deep" through the DO stub type.
    const stream = (): any => (this.env.STREAM as any).getByName(this.#coordinate());
    return {
      append: (args: any) => stream().append(args),
      appendBatch: (args: any) => stream().appendBatch(args),
    };
  }

  // Configure the stream → processor subscription ONCE (idempotent): point the
  // stream at THIS DO's requestStreamSubscription. The Stream DO then calls us and
  // pumps every appended batch into the processor — automatic delivery, including
  // events written by anyone else, not just this context's own provides.
  #ensureSubscriptionConfigured(): void {
    if (this.#subscriptionConfigured) return;
    this.#subscriptionConfigured = true;
    const name = this.#requireName();
    const bindingName = this.#requireNameParts().path === "/" ? "PROJECT" : "AGENT";
    const event: any = {
      type: "events.iterate.com/stream/subscription-configured",
      idempotencyKey: `itx-host-subscription:${bindingName}:${name}`,
      payload: {
        subscriptionKey: `itx:${name}`,
        subscriber: durableObjectProcessorSubscriber({
          bindingName,
          durableObjectName: name,
          processorName: ItxContract.slug,
        }),
      },
    };
    this.ctx.waitUntil(this.#log().append({ event }));
  }

  // The hosted processor. Lazily wires the subscription on first reach.
  get itx(): ItxContext {
    this.#ensureSubscriptionConfigured();
    return itxHandleForNode(this);
  }

  provideCapability(args: ProvideArgs) {
    this.#ensureSubscriptionConfigured();
    return this.#itx.provideCapability(args);
  }

  invokeCapability(args: { path: string[]; args?: unknown[] }) {
    this.#ensureSubscriptionConfigured();
    return this.#itx.invokeCapability(args);
  }

  revokeCapability(args: { path: string[] }) {
    this.#ensureSubscriptionConfigured();
    return this.#itx.revokeCapability(args);
  }

  describe() {
    this.#ensureSubscriptionConfigured();
    return this.#itx.describe();
  }

  // The Stream DO calls this to start delivering batches to the host's processor.
  requestStreamSubscription(args: RequestStreamSubscriptionArgs): Promise<void> {
    this.#ensureSubscriptionConfigured();
    return this.host.requestStreamSubscription(args);
  }

  // Codemode: a capability can be a whole PROGRAM. The code is an
  // `async (itx) => …` function; we LOAD it as a worker through the Worker
  // Loader, hand it an itx handle so it can invoke/provide against THIS context,
  // and bracket the run with durable request/completed records. Everything the
  // script does between them is invisible to the log; the two events are the
  // audit record that a run happened.
  async runScript({ code }: { code: string }): Promise<unknown> {
    this.#ensureSubscriptionConfigured();
    const executionId = crypto.randomUUID();
    const log = this.#log();
    const appendCompleted = async (payload: Record<string, unknown>) => {
      const completed = await log.append({
        event: {
          type: "events.iterate.com/itx/script-execution-completed",
          payload: { executionId, ...payload },
        },
      } as any);
      await this.#itx.waitUntilEvent({ offset: (completed as any).offset });
    };
    const requested = await log.append({
      event: {
        type: "events.iterate.com/itx/script-execution-requested",
        payload: { executionId, code },
      },
    } as any);
    await this.#itx.waitUntilEvent({ offset: (requested as any).offset });
    const source = `
      import { WorkerEntrypoint } from "cloudflare:workers";
      const program = ${code};
      export class ScriptEntrypoint extends WorkerEntrypoint {
        async run(itx) { return await program(itx); }
      }
    `;
    const loaded = this.env.LOADER.get(`script:${hashString(code)}`, () => ({
      compatibilityDate: "2026-05-01",
      compatibilityFlags: ["nodejs_compat"],
      mainModule: "main.js",
      modules: { "main.js": source },
    }));
    // The itx handle the script receives is the same shape as a WebSocket
    // handle: arbitrary dotted calls all collapse to invokeCapability. If this
    // were a plain `{ invokeCapability }` object, `itx.whoami()` would work in
    // Node and browser but fail in codemode, which is exactly the runtime drift
    // ITX is meant to avoid.
    const itxHandle = itxHandleForNode(this);
    try {
      const result = await loaded.getEntrypoint("ScriptEntrypoint").run(itxHandle);
      await appendCompleted({ result });
      return { executionId, result };
    } catch (error: any) {
      await appendCompleted({ error: error?.message ?? String(error) });
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// The domain objects. A context's identity is a project id + a path, and at each
// coordinate sits a real domain Durable Object: the project root is a `Project`,
// an agent under it is an `Agent`. Each owns its resources AND defines the
// public capability surface a context scoped to it is born with. The ITX host
// mounts each DO itself as the base built-in at `path: []`, so adding a built-in
// is just adding a public method/getter here.
// ---------------------------------------------------------------------------

// The Project DO. Owns the project's capability surface.
export class ProjectDurableObject extends ItxHostDurableObject {
  async egress(
    url: string,
    init?: RequestInit,
  ): Promise<{ status: number; body: string; viaProject: string }> {
    const response = await globalThis.fetch(url, init);
    return {
      status: response.status,
      body: await response.text(),
      viaProject: this.ctx.id.name
        ? (parseDurableObjectName(this.ctx.id.name).projectId ?? "?")
        : "?",
    };
  }

  get repo() {
    return new RepoRpcTarget({
      path: PROJECT_REPO_PATH,
      projectId: this.requireProjectId(),
    });
  }

  get agents() {
    return new AgentsRpcTarget({ projectId: this.requireProjectId() });
  }
}

// The Agent DO. Lives UNDER a project (coordinate "<id>/agents/<name>"). Owns its
// identity and exposes explicit project reach through its public surface.
export class AgentDurableObject extends ItxHostDurableObject {
  get project() {
    const project = this.env.PROJECT.getByName(
      formatDurableObjectName({ projectId: this.requireProjectId(), path: "/" }),
    ) as unknown as ItxHostNode;
    return itxHandleForNode(project);
  }

  whoami(): string {
    const parts = this.nameParts();
    return parts ? `agent ${parts.projectId}:${parts.path}` : "agent ?";
  }

  sendMessage(input: { message: string; channel?: string }) {
    return { agent: this.whoami(), ...input };
  }
}

export class RepoDurableObject extends DurableObject<Env> {
  getWorkerSource({ path }: { path: string }): ResolvedWorkerSource {
    if (path !== "counter.js") {
      throw new Error(`fake repo only contains counter.js, not ${path}`);
    }
    const source = `
      import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

      export class CounterEntrypoint extends WorkerEntrypoint {
        add(a, b) { return a + b; }
      }

      export class CounterDurableObject extends DurableObject {
        async increment() {
          const n = ((await this.ctx.storage.get("n")) ?? 0) + 1;
          await this.ctx.storage.put("n", n);
          return n;
        }
        async current() {
          return (await this.ctx.storage.get("n")) ?? 0;
        }
      }
    `;
    return {
      cacheKey: hashString(source),
      mainModule: "counter.js",
      modules: { "counter.js": source },
    };
  }
}

class RepoRpcTarget extends RpcTarget {
  #path: string;
  #projectId: string;

  constructor(input: { path: string; projectId: string }) {
    super();
    this.#path = input.path;
    this.#projectId = input.projectId;
  }

  #repo() {
    return (workerEnv as unknown as Env).REPO.getByName(
      formatDurableObjectName({ projectId: this.#projectId, path: this.#path }),
    );
  }

  getWorkerSource(args: { path: string }) {
    return this.#repo().getWorkerSource(args);
  }
}

class AgentsRpcTarget extends RpcTarget {
  #projectId: string;

  constructor(input: { projectId: string }) {
    super();
    this.#projectId = input.projectId;
  }

  get(agentPathInput: string) {
    const path = normalizeAgentPath(agentPathInput);
    const agent = (workerEnv as unknown as Env).AGENT.getByName(
      formatDurableObjectName({ projectId: this.#projectId, path }),
    ) as unknown as ItxHostNode;
    return agent.itx;
  }
}

function normalizeAgentPath(path: string): string {
  if (!path.startsWith("/agents/")) {
    throw new Error(`agent path must start with "/agents/", got "${path}"`);
  }
  return path;
}

// ---------------------------------------------------------------------------
// The Worker entrypoint.
// ---------------------------------------------------------------------------

async function readScriptCode(request: Request): Promise<string> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = (await request.json()) as { code?: unknown };
    if (typeof body.code !== "string")
      throw new Error('JSON body must contain string field "code".');
    return body.code;
  }
  return await request.text();
}

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    const pathProjectMatch = url.pathname.match(/^\/api\/itx\/([^/]+)$/);
    const projectId = decodeURIComponent(pathProjectMatch?.[1] ?? "");

    if (!projectId && url.pathname === "/api/itx") {
      const principal = authenticate(request);
      if (!principal) return new Response("missing or invalid token", { status: 401 });
      if (principal.access !== "all")
        return new Response("root ITX is admin-only in the reference implementation", {
          status: 403,
        });
      if (request.method !== "GET") return new Response("method not allowed", { status: 405 });
      return newWorkersRpcResponse(request, pathInvokerToProxy(new RootItx(env)));
    }

    if (!projectId) {
      return new Response("minimal-itx: connect to /api/itx/<projectId> or /api/itx for admins", {
        status: 404,
      });
    }

    const path = "/";

    // `__null__` is the platform plane, not a connectable context — its streams
    // live behind the admin root, never as a project context.
    if (projectId === PLATFORM_PROJECT_ID) {
      return new Response(`"${PLATFORM_PROJECT_ID}" is not a connectable context; use /api/itx`, {
        status: 404,
      });
    }

    // THE authority decision: may this principal reach this project? Everything
    // past this door is confined by construction — host surfaces name only this
    // project, agents reach their project through an explicit host-owned member,
    // and user provides cannot name another project's Durable Object. No further
    // authority checks anywhere.
    const auth = authorizeProjectAccess(request, projectId);
    if (!auth.ok) return new Response(auth.message, { status: auth.status });

    const node = contextNode(env, { projectId, path });

    if (request.method === "POST") {
      try {
        const code = await readScriptCode(request);
        const run = (await node.runScript({ code })) as Record<string, unknown>;
        return json({
          context: formatDurableObjectName({ projectId, path }),
          ...run,
          describe: await node.describe(),
        });
      } catch (error: any) {
        return json({ error: error?.message ?? String(error) }, { status: 400 });
      }
    }
    if (request.method !== "GET") return new Response("method not allowed", { status: 405 });

    // The WebSocket surface is one operation: invokeCapability, forwarded into
    // the selected context. No catalog scoping to do — there is no global catalog
    // on a project's ITX surface.
    return newWorkersRpcResponse(request, itxHandleForNode(node));
  },
};
