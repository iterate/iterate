import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { newWorkersRpcResponse } from "capnweb";
import { z } from "zod";
import {
  address,
  expectedFailure,
  Fault,
  httpError,
  methodPath,
  Read,
  Source,
  Target,
  type NativeResult,
} from "./model.ts";
import { Stream } from "./stream.ts";
import { Egress } from "./egress.ts";
import { Repositories } from "./repositories.ts";
import { Builder, BuildInput } from "./build.ts";
import type Bundler from "./bundler.ts";
import { Processors } from "./processors.ts";
import { LendingDirectory, lend, type ClientCapability, type LendingInvoker } from "./lending.ts";
import { loadSource, loadWorker, LoadedWorker, callTarget } from "./runtime.ts";
import { handleMcp } from "./mcp.ts";
import { EventRecord, type EventInput } from "./signatures.ts";
import { cleanFetchRequest, routeFetch, Terminal, type CoreExports } from "./routing.ts";
import { withLogin, type AuthEnv } from "./auth.ts";
import { resolveProjectHost, type IngressEnv } from "./ingress.ts";
import {
  HandleTarget,
  ScopeTarget,
  ContextInspection,
  EventPage,
  type LentCapability,
  type MountDescriptor,
  type ReadEventsOptions,
  type StreamCallback,
  type SubscribeOptions,
  type WorkerInput,
} from "./types.ts";
export { FetchNext, FetchDestination } from "./routing.ts";

export interface Env extends AuthEnv, IngressEnv {
  CONTEXT: DurableObjectNamespace<Context>;
  LOADER: WorkerLoader;
  VERSION: { id: string };
  ASSETS: Fetcher;
  BUNDLER: Service<Bundler>;
  EGRESS_KEY?: string;
  EXPERIMENT_ADMIN_TOKEN?: string;
}
const Call = z.strictObject({
  method: z.array(z.string()).min(1).max(24),
  args: z.array(z.unknown()).max(64),
});
const AppendBatch = z.array(z.unknown()).min(1).max(128);
function requireControlPlane(request: Request, token: string | undefined) {
  if (!token) throw new Fault("CONTROL_AUTH", "Control plane is not configured", 503);
  const credential = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const expected = new TextEncoder().encode(token);
  const actual = new TextEncoder().encode(credential);
  let difference = expected.byteLength ^ actual.byteLength;
  for (let index = 0; index < Math.max(expected.byteLength, actual.byteLength); index++) {
    difference |= (expected[index] ?? 0) ^ (actual[index] ?? 0);
  }
  if (difference) throw new Fault("CONTROL_AUTH", "Control plane authentication failed", 401);
}

function isClientCapability(value: unknown): value is ClientCapability {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { dup?: unknown }).dup === "function"
  );
}

class Handle extends HandleTarget {
  readonly #close: () => void;

  constructor(close: () => void) {
    super();
    this.#close = close;
  }
  [Symbol.dispose]() {
    this.#close();
  }
}

/** A real RpcTarget at the stateless edge: returned capabilities keep native RPC pipelining. */
export class Scope extends ScopeTarget {
  #handles = new Set<HandleTarget>();
  #location: ReturnType<typeof address>;
  readonly #env: Env;
  readonly #ctx: ExecutionContext;

  constructor(env: Env, project: string, path: string, ctx: ExecutionContext) {
    super();
    this.#env = env;
    this.#location = address(project, path);
    this.#ctx = ctx;
  }
  override cd(path: string) {
    const next = address(this.#location.project, path, this.#location.path);
    return new Scope(this.#env, next.project, next.path, this.#ctx);
  }
  get #host() {
    return this.#env.CONTEXT.getByName(this.#location.name);
  }
  override invoke(path: readonly string[], ...args: unknown[]): Promise<unknown> {
    return this.#host.invoke([...path], args);
  }
  override load(code: WorkerInput, exportName?: string) {
    return this.#host.loadWorker(code, exportName);
  }
  override get build() {
    return new Builder(async (input) => {
      // BuildResult is inert data: release the nested native RPC pipeline after it settles.
      // Disposing a general capability-bearing result here would revoke its authority.
      using result = this.#host.build(input);
      return await result;
    });
  }
  override append(input: EventInput | readonly EventInput[]): Promise<readonly EventRecord[]> {
    return this.invoke(["append"], input).then((records) => z.array(EventRecord).parse(records));
  }
  override readEvents(options: ReadEventsOptions = {}): Promise<EventPage> {
    return this.invoke(["readEvents"], options).then((page) => EventPage.parse(page));
  }
  override inspect(): Promise<ContextInspection> {
    return this.invoke(["inspect"]).then((inspection) => ContextInspection.parse(inspection));
  }
  override async provide(match: string, target: MountDescriptor | LentCapability) {
    const parsed = Target.safeParse(target);
    let release: Disposable | undefined;
    let installed: MountDescriptor;
    if (parsed.success) installed = parsed.data;
    else {
      // Cap'n Web hands live arguments over as stubs; lend owns the retained duplicate.
      if (!isClientCapability(target))
        throw new Fault("TARGET", "Expected a source target or live RPC capability");
      const relay = await lend(this.#host, target, (p) => this.#ctx.waitUntil(p));
      release = relay;
      installed = { kind: "client", key: relay.key };
    }
    try {
      await this.append({
        id: crypto.randomUUID(),
        type: "itx.set",
        data: { key: `mount/${match}`, value: installed },
      });
    } catch (error) {
      release?.[Symbol.dispose]();
      throw error;
    }
    const handle = new Handle(() => {
      if (!this.#handles.delete(handle)) return;
      if (release) release[Symbol.dispose]();
    });
    this.#handles.add(handle);
    return handle;
  }
  override async subscribe(callback: StreamCallback, options: SubscribeOptions = {}) {
    const url = new URL("https://stream.internal/");
    url.searchParams.set("afterOffset", String(options.afterOffset ?? 0));
    const response = await this.#host.fetch(
      new Request(url, { headers: { Upgrade: "websocket", "x-core-stream": "1" } }),
    );
    if (!response.webSocket) throw new Fault("SUBSCRIBE", "Stream upgrade did not return a socket");
    const socket = response.webSocket;
    socket.accept();
    const retained = callback as typeof callback &
      Disposable & { dup(): typeof callback & Disposable };
    const target = retained.dup();
    let closed = false;
    let callbackTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (code?: number, reason?: string) => {
      if (closed) return;
      closed = true;
      if (callbackTimer !== undefined) clearTimeout(callbackTimer);
      target[Symbol.dispose]();
      if (code !== undefined) socket.close(code, reason);
    };
    socket.addEventListener("message", (event) => {
      if (closed) return;
      if (callbackTimer !== undefined) {
        console.error("subscription received a page while its previous callback was active");
        finish(1011, "callback overlap");
        return;
      }
      let page: EventPage;
      try {
        page = EventPage.parse(JSON.parse(String(event.data)));
      } catch (error) {
        console.error("subscription received an invalid stream page", error);
        finish(1011, "invalid stream page");
        return;
      }
      const deadline = new Promise<never>((_, reject) => {
        callbackTimer = setTimeout(
          () =>
            reject(
              new Fault("SUBSCRIBE_TIMEOUT", "Subscription callback exceeded 20 seconds", 504),
            ),
          20_000,
        );
      });
      this.#ctx.waitUntil(
        Promise.race([Promise.resolve().then(() => target(page)), deadline])
          .then(() => {
            if (!closed) socket.send(JSON.stringify({ afterOffset: page.throughOffset }));
          })
          .catch((error) => {
            if (!closed) {
              console.error("subscription callback failed", error);
              finish(1011, "callback failed");
            }
          })
          .finally(() => {
            if (callbackTimer !== undefined) clearTimeout(callbackTimer);
            callbackTimer = undefined;
          }),
      );
    });
    const handle = new Handle(() => {
      if (this.#handles.delete(handle)) {
        finish(1000, "subscription disposed");
      }
    });
    this.#handles.add(handle);
    socket.addEventListener("close", () => handle[Symbol.dispose](), { once: true });
    return handle;
  }
  override fetch(request: Request) {
    return routeFetch(request, this.#env, this.#ctx, this.#location);
  }
  [Symbol.dispose]() {
    for (const handle of [...this.#handles]) handle[Symbol.dispose]();
  }
}

/** The loader receives this scoped capability, never a namespace or raw platform binding. */
export class Host extends WorkerEntrypoint<Env, { project: string; path: string }> {
  get() {
    return new Scope(this.env, this.ctx.props.project, this.ctx.props.path, this.ctx);
  }
  override fetch(request: Request) {
    return routeFetch(request, this.env, this.ctx, this.ctx.props);
  }
}

export class Context extends DurableObject<Env> {
  #stream?: Stream;
  #egress?: Egress;
  #repos?: Repositories;
  #processors?: Processors;
  #processorRun?: Promise<void>;
  #processorReschedule = false;
  #pendingBytes = 0;
  #active = 0;
  readonly #location: ReturnType<typeof address>;
  readonly #lending: LendingDirectory;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    if (!ctx.id.name) throw new Fault("ADDRESS", "Contexts must be addressed by canonical name");
    const slash = ctx.id.name.indexOf("/");
    this.#location = address(ctx.id.name.slice(0, slash), ctx.id.name.slice(slash));
    this.#lending = new LendingDirectory(ctx, (key) => this.detached(key));
  }
  get stream() {
    return (this.#stream ??= new Stream(this.ctx, this.#location.name));
  }
  get repos() {
    return (this.#repos ??= new Repositories(this.stream.sql));
  }
  get egress() {
    return (this.#egress ??= new Egress(
      this.ctx,
      this.#location.name,
      this.env.EGRESS_KEY,
      (input) => this.stream.platformAppend(input),
      async () => {
        this.stream.publish();
        await this.#scheduleProcessors();
      },
    ));
  }
  get processors() {
    return (this.#processors ??= new Processors(this.ctx, this.stream, (source) =>
      this.load(source),
    ));
  }
  async #armAlarm(processorWake = this.#processorRun ? null : this.processors.nextWake()) {
    const lendingWake = !this.#active && this.#lending.state().borrowed ? Date.now() + 5000 : null;
    const wake = Math.min(
      processorWake ?? Infinity,
      lendingWake ?? Infinity,
      this.stream.expireAcknowledgements() ?? Infinity,
    );
    if (!Number.isFinite(wake)) return;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || wake < current) await this.ctx.storage.setAlarm(wake);
  }
  #runProcessors() {
    if (this.#processorRun) return this.#processorRun;
    const run = this.processors
      .run()
      .catch((error) => console.error("processor scheduler failed", error))
      .finally(async () => {
        try {
          // Nested appends see the previous retry deadline. Only this finishing run may re-arm it.
          await this.#armAlarm(this.processors.nextWake());
        } finally {
          this.#processorRun = undefined;
          if (this.#processorReschedule) {
            this.#processorReschedule = false;
            this.#runProcessors();
          }
        }
      });
    this.#processorRun = run;
    this.ctx.waitUntil(run);
    return run;
  }
  async #scheduleProcessors() {
    // Preserve appends arriving while the current run awaits its final alarm write.
    if (this.#processorRun) this.#processorReschedule = true;
    await this.#armAlarm();
    this.#runProcessors();
  }
  detached(key: string) {
    this.stream.commit(
      [
        {
          input: { id: crypto.randomUUID(), type: "itx.system.detached", data: { key } },
          signerKeyIds: [],
          apply: () => {
            for (const setting of this.stream.settings()) {
              if (!setting.key.startsWith("mount/")) continue;
              const target = Target.nullable().parse(setting.value);
              if (target?.kind === "client" && target.key === key)
                this.stream.sql.exec("DELETE FROM settings WHERE key = ?", setting.key);
            }
          },
        },
      ],
      true,
    );
    this.stream.publish();
    this.ctx.waitUntil(this.#scheduleProcessors());
  }
  lend(input: { key: string; invoker: LendingInvoker }) {
    this.#lending.lend(input);
  }
  async append(value: unknown) {
    const values = AppendBatch.parse(Array.isArray(value) ? value : [value]);
    const bytes = new TextEncoder().encode(JSON.stringify(values)).byteLength;
    if (bytes > 524288 || this.#pendingBytes + bytes > 8388608)
      throw new Fault("APPEND_LIMIT", "Append memory budget exceeded", 413);
    this.#pendingBytes += bytes;
    try {
      const prepared = await Promise.all(
        values.map((input) =>
          this.stream.prepare(input, async (event) => {
            const egressApply = this.egress.prepare(event);
            const repoApply = await this.repos.prepare(event);
            if (!repoApply && !egressApply) return undefined;
            return (record) => {
              repoApply?.(record.offset);
              egressApply?.(record);
            };
          }),
        ),
      );
      if (this.ctx.getWebSockets("stream").some((socket) => socket.readyState === WebSocket.OPEN))
        await scheduler.wait(0);
      const records = this.stream.commit(prepared);
      this.stream.publish();
      await this.#scheduleProcessors();
      return records;
    } finally {
      this.#pendingBytes -= bytes;
    }
  }
  readEvents(options: ReadEventsOptions = {}): EventPage {
    return this.stream.readEvents(options);
  }
  inspect(): ContextInspection {
    return {
      context: this.#location,
      head: this.stream.head,
      settings: this.stream.settings(),
      lending: this.#lending.state(),
      processors: this.processors.state(),
    };
  }
  async putSecret(value: unknown): Promise<NativeResult<unknown>> {
    try {
      return { result: await this.egress.putSecret(value) };
    } catch (error) {
      return { error: expectedFailure(error) };
    }
  }
  #loader() {
    // ctx.exports is this module's native export table; workers-types cannot infer it without generated types.
    const exports = this.ctx.exports as unknown as CoreExports;
    return {
      env: this.env,
      owner: `${this.#location.name}:itx`,
      host: exports.Host({ props: this.#location }),
    };
  }
  load(source: Source) {
    return loadSource(source, {
      ...this.#loader(),
      filesForRepo: (repo, revision) => this.repos.read(repo, revision).files,
    });
  }
  readRepo(repo: string, revision: string): NativeResult<ReturnType<Repositories["read"]>> {
    try {
      return { result: this.repos.read(repo, revision) };
    } catch (error) {
      return { error: expectedFailure(error) };
    }
  }
  readFetchPolicy(): NativeResult<{
    target: Extract<Target, { kind: "worker" }>;
    policyOffset: number;
  }> {
    try {
      const policy = this.stream.setting("mount/fetch");
      if (!policy) throw new Fault("FETCH_POLICY_UNCONFIGURED", "Install a fetch policy", 404);
      const target = Target.parse(policy);
      if (target.kind !== "worker")
        throw new Fault("FETCH_TARGET", "Fetch policy must be a worker");
      // No await: the descriptor and its authority revision are one state snapshot.
      return { result: { target, policyOffset: this.fetchPolicyOffset() } };
    } catch (error) {
      return { error: expectedFailure(error) };
    }
  }
  fetchPolicyOffset() {
    return (
      this.stream.sql
        .exec<{ offset: number }>("SELECT offset FROM settings WHERE key = 'mount/fetch'")
        .toArray()[0]?.offset ?? 0
    );
  }
  loadWorker(code: unknown, exportName?: string) {
    return new LoadedWorker(loadWorker(code, this.#loader()), exportName);
  }
  build(value: BuildInput) {
    const input = BuildInput.parse(value);
    return this.env.BUNDLER.build({
      files: this.repos.read(input.source.repo, input.source.revision).files,
      options: input.options,
    });
  }
  async invoke(path: string[], args: unknown[], depth = 0): Promise<unknown> {
    methodPath(path);
    if (depth > 16) throw new Fault("ROUTE_LOOP", "Capability routing exceeded 16 hops", 508);
    this.#active++;
    try {
      const physical = path[0] === "builtins";
      if (physical) path = path.slice(1);
      if (!physical) {
        for (let length = path.length; length > 0; length--) {
          const value = this.stream.setting(`mount/${path.slice(0, length).join(".")}`);
          if (!value) continue;
          const target = Target.parse(value);
          const rest = path.slice(length);
          if (target.kind === "client") return await this.#lending.invoke(target.key, rest, args);
          if (target.kind === "context") {
            const next = address(this.#location.project, target.path, this.#location.path);
            return await this.env.CONTEXT.getByName(next.name).invoke(
              [...target.member, ...rest],
              args,
              depth + 1,
            );
          }
          const loaded = await this.load(target.source);
          return await callTarget(loaded.getEntrypoint(target.exportName), rest, args);
        }
      }
      switch (path.join(".")) {
        case "append":
          return await this.append(args[0]);
        case "readEvents":
          return this.readEvents(Read.parse(args[0]));
        case "inspect":
          return this.inspect();
        case "repos.list":
          return this.repos.list();
        case "repos.head":
          return this.repos.head(z.string().parse(args[0])) ?? null;
        case "repos.read":
          return this.repos.read(z.string().parse(args[0]), z.string().optional().parse(args[1]));
        case "workers.get":
          return new LoadedWorker(
            await this.load(Source.parse(args[0])),
            z.string().optional().parse(args[1]),
          );
        default:
          throw new Fault("NO_METHOD", `No capability provides ${path.join(".")}`, 404);
      }
    } finally {
      this.#active--;
      if (!this.#active) await this.#armAlarm();
    }
  }
  async request(method: string[], args: unknown[]) {
    try {
      return { result: await this.invoke(method, args) };
    } catch (error) {
      if (error instanceof Fault || error instanceof z.ZodError)
        return { error: expectedFailure(error) };
      console.error("context request failed", error);
      return {
        error: {
          code: "INTERNAL",
          message: "Context request failed; inspect worker logs",
          status: 500,
        },
      };
    }
  }
  override async fetch(request: Request): Promise<Response> {
    try {
      return await this.#routeFetch(request);
    } catch (error) {
      const failure = expectedFailure(error);
      return Response.json({ error: failure }, { status: failure.status });
    }
  }
  async #routeFetch(request: Request): Promise<Response> {
    const pager = this.#lending.attach(request);
    if (pager) return pager;
    if (request.headers.get("x-core-stream")) {
      const response = this.stream.subscribe(request);
      await this.#armAlarm();
      return response;
    }
    const clean = cleanFetchRequest(request);
    const terminal = request.headers.get("x-core-terminal");
    if (terminal) {
      const { policyOffset, approval } = Terminal.parse(JSON.parse(terminal));
      const assertCurrent = () => {
        if (policyOffset !== this.fetchPolicyOffset())
          throw new Fault("FETCH_POLICY_CHANGED", "Fetch policy was replaced", 409);
      };
      assertCurrent();
      return this.egress.terminal(clean, approval, policyOffset, assertCurrent);
    }
    throw new Fault("PRIVATE_FETCH", "Context fetch requires a platform protocol", 400);
  }
  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    if (this.ctx.getTags(socket).includes("stream")) {
      try {
        this.stream.acknowledge(socket, message);
        await this.#armAlarm();
      } catch (error) {
        if (
          !(error instanceof Fault || error instanceof z.ZodError || error instanceof SyntaxError)
        )
          throw error;
        socket.close(1008, "Invalid stream acknowledgement");
      }
    } else this.#lending.webSocketMessage(socket, message);
  }
  override webSocketClose(socket: WebSocket) {
    // Complete client-initiated stream closes explicitly.
    if (this.ctx.getTags(socket).includes("stream")) socket.close();
    else this.#lending.webSocketClose(socket);
  }
  override async alarm() {
    this.stream.expireAcknowledgements();
    if (!this.#active) this.#lending.releaseIdle();
    await this.#runProcessors();
  }
}

const dashboard = withLogin({
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/version")
        return Response.json({ name: "project-core", version: env.VERSION.id });
      const project = url.searchParams.get("project");
      if (url.pathname === "/secrets") {
        if (request.method !== "POST")
          return new Response("POST required", { status: 405, headers: { Allow: "POST" } });
        requireControlPlane(request, env.EXPERIMENT_ADMIN_TOKEN);
      }
      if (["/secrets", "/api", "/rpc", "/events", "/mcp"].includes(url.pathname)) {
        if (!project) throw new Fault("PROJECT", "Specify a project");
        const location = address(project, url.searchParams.get("path") ?? "/");
        const context = env.CONTEXT.getByName(location.name);
        if (url.pathname === "/secrets") {
          const result = await context.putSecret(await request.json());
          return Response.json(result, { status: result.error?.status ?? 200 });
        }
        if (url.pathname === "/rpc")
          return newWorkersRpcResponse(
            request,
            new Scope(env, location.project, location.path, ctx),
          );
        if (url.pathname === "/events") {
          if (
            request.method !== "GET" ||
            request.headers.get("Upgrade")?.toLowerCase() !== "websocket"
          )
            throw new Fault("UPGRADE", "Use a WebSocket stream connection", 426);
          return await context.fetch(
            new Request(url, { headers: { Upgrade: "websocket", "x-core-stream": "1" } }),
          );
        }
        if (request.method !== "POST")
          return new Response("POST required", { status: 405, headers: { Allow: "POST" } });
        if (url.pathname === "/mcp")
          return await handleMcp(request, (method, args) => context.request(method, args));
        const call = Call.parse(await request.json());
        const result = await context.request(call.method, call.args);
        return Response.json(result, { status: result.error?.status ?? 200 });
      }
      const match = /^\/p\/([^/]+)(\/.*)?$/.exec(url.pathname);
      if (match) {
        const location = address(match[1]!);
        url.hostname = `${location.project}.iterate`;
        url.port = "";
        url.pathname = match[2] ?? "/";
        return await routeFetch(new Request(url, request), env, ctx, location);
      }
      return env.ASSETS.fetch(request);
    } catch (error) {
      if (error instanceof Fault) return httpError(error);
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        return httpError({ code: "VALIDATION", message: error.message, status: 400 });
      console.error("front door failed", error);
      return httpError({
        code: "INTERNAL",
        message: "Request failed; inspect worker logs",
        status: 500,
      });
    }
  },
});

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const project = resolveProjectHost(new URL(request.url), env);
    if (project) return routeFetch(request, env, ctx, { project: project.projectId, path: "/" });
    return dashboard.fetch(request, env, ctx);
  },
};
