// server.ts — the Cloudflare Worker that hosts itx.
//
// One Worker, one itx Durable Object per context coordinate, one durable event
// log per context. The whole surface is a single connect route:
//
//   /api/itx?projectId=<id>&path=/                 -> a project context
//   /api/itx?projectId=<id>&path=/agents/<name>    -> an agent context
//   /api/itx?projectId=&path=/                     -> the stateless platform root
//
// A NAKED Cap'n Web stub drives every context: `itx.provideCapability({…})` and
// `itx.slack.chat.postMessage(msg)` are both just pipelined property paths that
// end in a call. The trick is entirely server-side:
// `pathProxyToInvokeCapability` (below) collapses every terminal call into one
// `invokeCapability({ path, args })`. The context, not the proxy, decides
// whether that path is a reserved ITX control name or a user capability.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { newWorkersRpcResponse } from "capnweb";
import {
  createStreamProcessorHost,
  type RequestStreamSubscriptionArgs,
} from "@iterate-com/os/src/domains/streams/engine/workers/stream-processor-host.ts";
import { durableObjectProcessorSubscriber } from "@iterate-com/os/src/domains/streams/engine/shared/callable-subscriber.ts";
import { ItxContract } from "./contract.ts";
import { ItxProcessor, replayPath, type ItxContext, type ProvideArgs } from "./itx.ts";
import { GlobalItx } from "./global-itx.ts";
import { authenticate, authorizeProjectAccess } from "./auth.ts";

// The real durable event log from apps/os — re-exported so wrangler hosts it as
// a Durable Object. A context's capability table is the fold of one of these.
export { Stream } from "@iterate-com/os/src/domains/streams/engine/workers/durable-objects/stream.ts";

export class ItxBindingEntrypoint extends WorkerEntrypoint<Env, { context: string }> {
  async get(): Promise<ItxContext> {
    const node = this.env.ITX.getByName(this.ctx.props.context);
    return pathProxyToInvokeCapability({
      invokeCapability: (args: { path: string[]; args?: unknown[] }) =>
        (node as any).invokeCapability(args),
    }) as ItxContext;
  }
}

export class ItxEntrypoint extends WorkerEntrypoint<Env, { projectId: string; path: string }> {
  invokeCapability(args: { path: string[]; args?: unknown[] }) {
    const context = contextFromProjectPath(this.ctx.props.projectId, this.ctx.props.path);
    if (context === "__global__") {
      return new GlobalItx({ access: "all" }).invokeCapability(args);
    }
    return this.env.ITX.getByName(context).invokeCapability(args);
  }

  describe() {
    return this.invokeCapability({ path: ["describe"], args: [] });
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
//      without the descriptor trap every segment reads as absent and the chain
//      dies at ".chat of undefined".
//   3. `has` must answer for non-reserved names too.

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

function pathProxyToInvokeCapability(
  target: { invokeCapability(args: { path: string[]; args?: unknown[] }): unknown },
  path: string[] = [],
): any {
  const valueFor = (key: string) => pathProxyToInvokeCapability(target, [...path, key]);
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
  ITX: DurableObjectNamespace<ItxDurableObject>;
  PROJECT: DurableObjectNamespace<ProjectDurableObject>;
  AGENT: DurableObjectNamespace<AgentDurableObject>;
  REPO: DurableObjectNamespace<RepoDurableObject>;
  STREAM: DurableObjectNamespace<any>;
  // Worker Loader: build + run a worker from a sturdy address (dial) or a script
  // (codemode) at runtime.
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

// Content-addressed cache key for a loaded isolate: same source → same isolate.
function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

const NULL_DURABLE_OBJECT_PROJECT_ID = "__null__";
const PROJECT_REPO_PATH = "/repos/project";

type DurableObjectNameParts = { projectId: string | null; path: string };

function normalizeDurableObjectProjectId(projectId: string | null): string | null {
  return projectId === NULL_DURABLE_OBJECT_PROJECT_ID ? null : projectId;
}

function normalizeDurableObjectPath(path: string): string {
  return path === "" ? "/" : path.startsWith("/") ? path : `/${path}`;
}

// Keep the reference app's internal DO names in the same shape as apps/os:
// object-form `{ projectId, path }` at call sites, encoded only at the Worker
// binding edge. `__global__` is still stateless, so it never gets an ITX DO name.
function formatDurableObjectName(input: DurableObjectNameParts): string {
  const projectId =
    normalizeDurableObjectProjectId(input.projectId) ?? NULL_DURABLE_OBJECT_PROJECT_ID;
  if (projectId.includes(":")) {
    throw new Error(`Durable Object projectId must not contain ":", got ${projectId}.`);
  }
  return `${projectId}:${normalizeDurableObjectPath(input.path)}`;
}

function parseDurableObjectName(name: string): DurableObjectNameParts {
  const colon = name.indexOf(":");
  if (colon <= 0 || name[colon + 1] !== "/") {
    throw new Error(`Durable Object name must be "{projectId}:{path}", got ${name}.`);
  }
  return {
    projectId: normalizeDurableObjectProjectId(name.slice(0, colon)),
    path: normalizeDurableObjectPath(name.slice(colon + 1)),
  };
}

function itxLogName(contextName: string | undefined): string {
  if (!contextName) return formatDurableObjectName({ projectId: null, path: "/itx" });
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
// Durable Object, dialed by coordinate.
// ---------------------------------------------------------------------------
export class ItxDurableObject extends DurableObject<Env> {
  // The processor is HOSTED (not just newed) so the stream can deliver batches to
  // it: createStreamProcessorHost wires checkpoint storage + keep-alive, and on
  // subscription handshake pumps every appended batch into the processor's ingest.
  host = createStreamProcessorHost(this.ctx);
  #itx = this.host.add(
    ItxContract.slug,
    (deps) =>
      new ItxProcessor({
        ...deps,
        iterateContext: { stream: this.#log() },
        dial: (address) => this.#dial(address),
        builtinCapabilities: this.#contextBuiltinCapabilities(), // from the domain object
      }),
  );
  #subscriptionConfigured = false;
  #dynamicDurableObjectVersions = new Map<string, string>();

  #nameParts(): DurableObjectNameParts | null {
    const name = this.ctx.id.name;
    return name ? parseDurableObjectName(name) : null;
  }

  // A context is born with built-in capabilities defined by the DOMAIN object it
  // is scoped to. The project context gets `itxParent` + Project DO built-ins; an
  // agent context gets `itxParent` + Agent DO built-ins. The host decides WHICH
  // coordinate maps to WHICH domain object; the domain object defines WHAT it
  // offers.
  #contextBuiltinCapabilities(): ProvideArgs[] {
    const parts = this.#nameParts();
    const projectId = parts?.projectId;
    if (!parts || !projectId) return [];
    if (parts.path === "/") {
      return ProjectDurableObject.builtinCapabilities(projectId);
    }
    if (parts.path.startsWith("/agents/")) {
      return AgentDurableObject.builtinCapabilities({ projectId, path: parts.path });
    }
    return [];
  }

  // Capability address → callable stub.
  #dial(address: any): any {
    if (address?.type === "worker-entrypoint") {
      const entrypoint = ((this.ctx as any).exports as any)[address.entrypoint]({
        props: address.props ?? {},
      });
      // `ItxEntrypoint` is a path-call surface: it exposes
      // invokeCapability({ path, args }), not a literal method for every
      // inherited capability. Wrap that shape with the same server-side proxy the
      // WebSocket edge uses, so a sturdy itxParent address can answer
      // `itx.itxParent.fetch(...)` and implicit miss fallback identically.
      if (typeof entrypoint.invokeCapability === "function") {
        return pathProxyToInvokeCapability({
          invokeCapability: (args: { path: string[]; args?: unknown[] }) =>
            entrypoint.invokeCapability(args),
        });
      }
      return localPathProxy(entrypoint);
    }
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
    if (address?.type === "durable-object") {
      const namespace = this.#durableObjectNamespace(address.namespace);
      return localPathProxy(namespace.getByName(address.name), address.path ?? []);
    }
    throw new Error(`address is not dialable: ${JSON.stringify(address)}`);
  }

  #durableObjectNamespace(namespace: string): { getByName(name: string): unknown } {
    const namespaces: Record<string, { getByName(name: string): unknown }> = {
      agent: this.env.AGENT,
      itx: this.env.ITX,
      project: this.env.PROJECT,
      repo: this.env.REPO,
    };
    const binding = namespaces[namespace];
    if (!binding) throw new Error(`unknown trusted Durable Object namespace "${namespace}"`);
    return binding;
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
    const repo = this.env.REPO.getByName(source.repo);
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
          props: {
            context: this.ctx.id.name ?? formatDurableObjectName({ projectId: null, path: "/itx" }),
          },
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
    // freshly-started ItxDurableObject can tell whether an already-running facet
    // is on the source/class version it is about to serve. But once the in-memory
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
    return itxLogName(this.ctx.id.name);
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
  // stream at THIS DO's requestStreamSubscription. The Stream DO then dials us and
  // pumps every appended batch into the processor — automatic delivery, including
  // events written by anyone else, not just this context's own provides.
  #ensureSubscriptionConfigured(): void {
    if (this.#subscriptionConfigured) return;
    this.#subscriptionConfigured = true;
    const name = this.ctx.id.name ?? formatDurableObjectName({ projectId: null, path: "/itx" });
    const event: any = {
      type: "events.iterate.com/stream/subscription-configured",
      idempotencyKey: `itx-subscription:${name}`,
      payload: {
        subscriptionKey: `itx:${name}`,
        subscriber: durableObjectProcessorSubscriber({
          bindingName: "ITX",
          durableObjectName: name,
          processorName: ItxContract.slug,
        }),
      },
    };
    this.ctx.waitUntil(this.#log().append({ event }));
  }

  // The hosted processor. Lazily wires the subscription on first reach.
  get itx(): ItxProcessor {
    this.#ensureSubscriptionConfigured();
    return this.#itx;
  }

  provideCapability(args: ProvideArgs) {
    return this.itx.provideCapability(args);
  }

  invokeCapability(args: { path: string[]; args?: unknown[] }) {
    return this.itx.invokeCapability(args);
  }

  revokeCapability(args: { path: string[] }) {
    return this.itx.revokeCapability(args);
  }

  describe() {
    return this.itx.describe();
  }

  // The Stream DO dials this to start delivering batches to the host's processor.
  requestStreamSubscription(args: RequestStreamSubscriptionArgs): Promise<void> {
    this.#ensureSubscriptionConfigured();
    return this.host.requestStreamSubscription(args);
  }

  // Codemode: a capability can be a whole PROGRAM. The code is an
  // `async (itx) => …` function; we LOAD it as a worker (the Worker Loader, like
  // dial), hand it an itx handle so it can invoke/provide against THIS context,
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
    const itxHandle = pathProxyToInvokeCapability(this.#itx);
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
// built-in capabilities a context scoped to it is born with — the production
// shape in miniature (apps/os has Project and Agent DOs; the itx context
// attaches to them by coordinate, and parentage is a reserved built-in).
// ---------------------------------------------------------------------------

// The Project DO. Owns the project's egress AND defines a project context's
// built-ins. `egress` does the outbound fetch (named `egress`, not `fetch`,
// because a DO's `fetch` is its HTTP entrypoint).
export class ProjectDurableObject extends DurableObject<Env> {
  async egress(
    url: string,
    init?: RequestInit,
  ): Promise<{ status: number; body: string; viaProject: string }> {
    const response = await fetch(url, init);
    return {
      status: response.status,
      body: await response.text(),
      viaProject: this.ctx.id.name
        ? (parseDurableObjectName(this.ctx.id.name).projectId ?? "?")
        : "?",
    };
  }

  // The capabilities a context scoped to THIS project is born with — same shape
  // as a provideCapability call. A built-in is a capability pre-provided in code.
  static builtinCapabilities(projectId: string): ProvideArgs[] {
    return [
      {
        path: ["itxParent"],
        capability: {
          type: "worker-entrypoint",
          entrypoint: "ItxEntrypoint",
          props: { projectId: "", path: "/" },
        },
        instructions: "the stateless __global__ parent context",
      },
      {
        path: ["fetch"],
        capability: {
          type: "durable-object",
          namespace: "project",
          name: formatDurableObjectName({ projectId, path: "/" }),
          path: ["egress"],
        },
        instructions: "the project's HTTP egress",
      },
      {
        path: ["repo"],
        capability: {
          type: "durable-object",
          namespace: "repo",
          name: formatDurableObjectName({ projectId, path: PROJECT_REPO_PATH }),
        },
        instructions: "the project's fake repo: getWorkerSource({ path: 'counter.js' })",
      },
    ];
  }
}

// The Agent DO. Lives UNDER a project (coordinate "<id>/agents/<name>"). Owns its
// identity and defines its own built-ins (whoami). An agent context is born with
// these AND a reserved `itxParent` built-in pointing at its project, so an agent can
// call its own `whoami` AND the project's inherited `fetch`.
export class AgentDurableObject extends DurableObject<Env> {
  whoami(): string {
    const parts = this.ctx.id.name ? parseDurableObjectName(this.ctx.id.name) : null;
    return parts ? `agent ${parts.projectId}:${parts.path}` : "agent ?";
  }

  static builtinCapabilities(parts: { projectId: string; path: string }): ProvideArgs[] {
    return [
      {
        path: ["itxParent"],
        capability: {
          type: "worker-entrypoint",
          entrypoint: "ItxEntrypoint",
          props: { projectId: parts.projectId, path: "/" },
        },
        instructions: "the parent project context",
      },
      {
        path: ["whoami"],
        capability: {
          type: "durable-object",
          namespace: "agent",
          name: formatDurableObjectName(parts),
          path: ["whoami"],
        },
        instructions: "the agent's own identity",
      },
    ];
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

// ---------------------------------------------------------------------------
// The Worker entrypoint.
// ---------------------------------------------------------------------------

function contextFromProjectPath(projectId: string, path: string): string {
  if (projectId === "") return "__global__";
  return formatDurableObjectName({ projectId, path });
}

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
    if (url.pathname !== "/api/itx") {
      return new Response(
        "minimal-itx: connect to /api/itx?projectId=<id>&path=/ or POST code to run a script",
        { status: 404 },
      );
    }

    const projectId = url.searchParams.get("projectId") ?? "";
    const path = url.searchParams.get("path") ?? "/";
    const context = contextFromProjectPath(projectId, path);

    // The __global__ root: not project-scoped, so authenticate the principal only
    // and serve the STATELESS __global__ context, scoped to the projects it may reach.
    // No DO and no stream — the context is constructed per connection.
    if (context === "__global__") {
      const principal = authenticate(request);
      if (!principal) return new Response("missing or invalid token", { status: 401 });
      if (request.method !== "GET") {
        return json(
          { error: "__global__ is stateless and does not support script execution" },
          { status: 400 },
        );
      }
      return newWorkersRpcResponse(
        request,
        pathProxyToInvokeCapability(new GlobalItx({ access: principal.projects })),
      );
    }

    // A project or agent context. Authorize the principal for the project, then
    // serve the DO-backed context at that coordinate. The DO also exposes
    // codemode (runScript) directly.
    const auth = authorizeProjectAccess(request, projectId);
    if (!auth.ok) return new Response(auth.message, { status: auth.status });

    const node = env.ITX.getByName(context);
    if (request.method === "POST") {
      try {
        const code = await readScriptCode(request);
        const run = (await node.runScript({ code })) as Record<string, unknown>;
        return json({
          context,
          ...run,
          describe: await node.describe(),
        });
      } catch (error: any) {
        return json({ error: error?.message ?? String(error) }, { status: 400 });
      }
    }
    if (request.method !== "GET") return new Response("method not allowed", { status: 405 });
    // The WebSocket surface is intentionally one operation: invokeCapability.
    // That keeps root control-name dispatch in the context, not in the Cap'n Web
    // proxy. The only edge policy here is principal-scoping inherited global
    // catalog reads. `projects.*`, `itxParent.projects.*`, and
    // `itxParent.itxParent.projects.*` are the same global catalog from an external
    // caller's point of view, so strip leading `itxParent` segments before applying
    // the existing catalog scope. Internal itxParent entrypoints still run wider,
    // which is tracked as a later hardening task.
    return newWorkersRpcResponse(
      request,
      pathProxyToInvokeCapability({
        invokeCapability: (args: { path: string[]; args?: unknown[] }) => {
          const globalCatalogPath = args.path.slice();
          while (globalCatalogPath[0] === "itxParent") globalCatalogPath.shift();
          if (globalCatalogPath[0] === "projects") {
            return new GlobalItx({ access: auth.projects }).invokeCapability({
              ...args,
              path: globalCatalogPath,
            });
          }
          return node.invokeCapability(args);
        },
      }),
    );
  },
};
