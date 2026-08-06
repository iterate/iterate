// The ItxDurableObject — the capability host (target-core §4.1). One DO per {projectId, path} (a faux-URL
// name), the single host for a context:
//   • NATIVE fetch — the ONE method a WS upgrade (101) can flow through. `/register` → a hibernatable WAKE
//     socket (no pin); `/connect` → a capnweb provider RPC leg; `/facet?path=` → a STATEFUL worker's facet
//     fetch (WS/streaming into a hosted DO); a WS upgrade → ingress (acceptWebSocket); a non-WS request →
//     EGRESS (secret-sub → fallback). `/state` → observability.
//   • invokeCapability — the single dispatch: built-ins (whoami/kv/secrets/streams/repo/provideCapability/
//     configure) → live provider mounts → WAKE-ON-CALL (page a hibernatable device) → local mounts
//     (alias/static/code/stateful) → fall back to the PARENT PATH, then the SHELL. "Reads fall back, writes
//     stay local."
//   • provideCapability — mount at a callPath. Two dynamic-worker kinds (mirroring apps/os): `code` = a
//     STATELESS repo fn; `stateful` = a repo `DurableObject` class run by the dedicated StatefulWorkerDurableObject
//     runner (a separate DO the host forwards to by name). load — run confined code IN this context
//     (env.ITX = self-stub). itx.configure — run the repo's config worker. itx.repo — the project's file store.
//
// Wake-on-call (spike-4): a live RPC leg is the ONLY thing that pins the DO; wake sockets are hibernatable, so
// 1000 registered devices cost ~nothing while idle. The fallback is a real second worker (the control plane).

import { DurableObject } from "cloudflare:workers";
import { newWorkersRpcResponse, RpcTarget } from "capnweb";
import { substituteHeaderSecrets } from "./core/egress.ts";
import { ITX_SURFACE_MODULE, CODE_CAP_RUNNER } from "./core/agent-runtime.ts";
import {
  evaluateItxExpression,
  expressionCallPath,
  itxRoot,
  type ItxExpression,
} from "./core/itx-expression.ts";
import { parseName, stringifyName, parentPath } from "./core/names.ts";
import type { StreamDurableObject, StreamEventInput } from "./stream-durable-object.ts";
import type { StatefulWorkerDurableObject } from "./stateful-worker-durable-object.ts";
import type { ItxCallPath } from "./core/config.ts";

/** A capnweb stub to a provider-supplied capability. `.dup()` retains it past a call; `onRpcBroken` fires when
 *  the provider's socket drops; other keys are its (remote) methods, which resolve back on the provider. */
type LiveStub = {
  dup(): LiveStub;
  onRpcBroken?(cb: (e: unknown) => void): void;
  [method: string]: unknown;
};

// `Symbol.dispose` isn't in the current lib target; reference it defensively to free a capnweb stub.
const DISPOSE: symbol | undefined = (Symbol as { dispose?: symbol }).dispose;
function disposeStub(stub: LiveStub): void {
  const fn = DISPOSE ? (stub as Record<symbol, unknown>)[DISPOSE] : undefined;
  if (typeof fn === "function") (fn as () => void).call(stub);
}

// Wake-on-call timings (spike-4). Kept short so the RPC leg is torn down fast and the DO can hibernate; the
// wake sockets themselves are hibernatable and never pin.
const IDLE_MS = 2000; // tear the on-demand RPC leg down this long after the last call
const WAKE_TIMEOUT_MS = 8000; // give a paged device this long to dial its RPC leg back

/** The control surface a capability PROVIDER (device / browser / worker) gets when it connects over capnweb
 *  (target-core §4.1, "live" mounts / D7). It can mount LIVE capabilities at a callPath; invocations of them
 *  travel back over the same socket to the provider. */
class ProviderControl extends RpcTarget {
  #mount: (path: string, stub: LiveStub) => void;
  constructor(mount: (path: string, stub: LiveStub) => void) {
    super();
    this.#mount = mount;
  }
  provideCapability(path: string, capability: LiveStub): { ok: true } {
    this.#mount(path, capability.dup()); // dup: the param is disposed when this call returns; keep ours
    return { ok: true };
  }
}

interface Env {
  ITX_HOST: DurableObjectNamespace<ItxDurableObject>;
  LOADER: WorkerLoader;
  SECRETS_KV?: KVNamespace;
  ITX_KV?: KVNamespace; // backing for itx.kv (project-prefixed — the D8 portability proof point)
  STREAM_DO?: DurableObjectNamespace<StreamDurableObject>; // backing for itx.streams (project-prefixed)
  STATEFUL_WORKER: DurableObjectNamespace<StatefulWorkerDurableObject>; // dedicated runner for stateful caps
  // The fallback (target-core §4.4 / D30). Solo: a self service-binding to DummyControlPlane. A DO can't mint
  // ctx.exports loopbacks, so it reaches the fallback via a binding rather than the worker's ctx.exports.
  // It IS a whole shell: `fetch` (egress → terminal) + `invokeCapability` (capability fallthrough).
  FALLBACK: Fetcher & { invokeCapability(callPath: string, args?: unknown[]): Promise<unknown> };
}

/** djb2 — a stable content hash so the loader cache key changes when the source changes. */
function hashSource(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// The v1 "file reader" behind `itx.files.read` — NO repo/KV, it just PROVIDES a hello module (Jonas: since
// we're not bundling, delete the source KV and provide a hello). Later this becomes a real repo read at a ref,
// behind the SAME `itx.files` capability + the SAME source expression — the loader never changes.
const HELLO_FILES: Record<string, string> = {
  "/hello.js": `export default (itx, name) => "hello " + (name ?? "world");`,
  "/counter.js": `import { DurableObject } from "cloudflare:workers";
export class Counter extends DurableObject {
  async increment(by) { const n = ((await this.ctx.storage.get("n")) ?? 0) + by; await this.ctx.storage.put("n", n); return n; }
  async value() { return (await this.ctx.storage.get("n")) ?? 0; }
  async whoAmI() { return await this.env.ITX.invokeCapability("itx.whoami", []); }
}`,
  // A fetch-serving dynamic worker: an HTTP page AND a WebSocket upgrade (101). The stand-in for "a device
  // presents a website with WebSocket functionality" — here served by in-mesh loaded code, reached by fetch.
  "/site.js": `export default {
  async fetch(request) {
    if ((request.headers.get("Upgrade") || "").toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      pair[1].accept();
      pair[1].addEventListener("message", (e) => pair[1].send("site-echo:" + e.data));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response("<!doctype html><title>dynamic site</title><h1>hello from a dynamic web capability</h1>", { headers: { "content-type": "text/html" } });
  }
};`,
};

// A mount (target-core §4.1). `itx-expression` = an ALIAS to another callPath. `static` = a plain value.
// The two DYNAMIC-WORKER kinds mirror apps/os's `DynamicWorkerRef` — and their SOURCE is an itx EXPRESSION
// (data), resolved to a `{ name: source }` modules map by evaluating it against this host. The loader is
// repo-agnostic: it knows only "evaluate an expression to get modules" (v1 reader = `itx.files.read`, below).
//   • `code` = STATELESS — modules whose entry `cap.js` default-exports `(itx, ...args) => result`.
//   • `stateful` = a `DurableObject` class (`className`), run by the dedicated `StatefulWorkerDurableObject`
//     runner (a separate DO, one per stateful capability, hosting the class as a facet with its own SQLite).
//   • `web` = FETCH-SHAPED — modules whose entry `cap.js` default-exports `{ fetch(request, env) }`. Reached by
//     the FETCH LANE (`#fetchCapability`), so a WebSocket **upgrade (101) passes through** to it natively — the
//     thing apps/os could not do (a provided capability there is reachable only by RPC replay, and a 101 can't
//     serialize across an RPC hop). `code`/`stateful` are RPC-shaped; `web` (and `stateful`'s facet fetch) are
//     fetch-shaped.
// (`live` RPC-stub mounts are the capnweb path, above.)
type Mount =
  | { type: "itx-expression"; expression: ItxCallPath }
  | { type: "static"; value: unknown }
  | { type: "code"; source: ItxExpression }
  | { type: "stateful"; source: ItxExpression; className: string }
  | { type: "web"; source: ItxExpression };

export type ProvideCapabilityInput = { path: ItxCallPath } & Mount;

export class ItxDurableObject extends DurableObject<Env> {
  #mounts = new Map<string, Mount>(); // callPath -> mount (mirrors DO storage; the event-sourced fold is later)
  // Wake-on-call state (spike-4). All IN-MEMORY: a live RPC leg is the only thing that pins the DO; the wake
  // sockets are hibernatable and survive eviction, so 1000 registered devices cost ~nothing while idle.
  #liveMounts = new Map<string, { stub: LiveStub; connectionKey: string }>(); // callPath -> connected provider
  #liveByConn = new Map<string, Set<string>>(); // connectionKey -> callPaths it currently provides
  #pending = new Map<
    string,
    { resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  #idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  incarnation = 0; // durable, bumped on every (re)construction — grows across an idle gap ⇒ the DO hibernated

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const stored = (await ctx.storage.get<Record<string, Mount>>("mounts")) ?? {};
      this.#mounts = new Map(Object.entries(stored));
      const n = (await ctx.storage.get<number>("incarnation")) ?? 0;
      this.incarnation = n + 1;
      await ctx.storage.put("incarnation", this.incarnation);
    });
  }

  /** The context this DO is — parsed from its (unforgeable) faux-URL name `{projectId}.iterate{path}`. */
  get #name(): { projectId: string; path: string } {
    return parseName(this.ctx.id.name ?? "?");
  }
  get #projectId(): string {
    return this.#name.projectId;
  }

  // ── native fetch (target-core §4.1, §6.0). Two callers, disambiguated by the Upgrade header:
  //    • WS upgrade → INGRESS: accept a hibernatable socket (a client connecting in).
  //    • non-WS     → EGRESS: a loaded agent reaching OUT via its globalOutbound self-stub → substitute the
  //      project's own secrets, then delegate to the fallback (→ terminal). This is `itx.egress.fetch`.
  //    (WS EGRESS from a DO-loaded agent is ambiguous with WS ingress here — deferred; agents egress over HTTP
  //     today. A marker will disambiguate when needed.) ──
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // ── THE FETCH LANE (target-core §6.0 / D33). A request carrying `x-itx-cap` (a capability address, as a
    // serialized ItxExpression or a bare callPath) is routed to a FETCH-SHAPED capability by NATIVE `.fetch()`
    // hops — so a WebSocket upgrade (101) passes straight through. This is the sibling of `invokeCapability`
    // (RPC): a 101 can't cross an RPC hop, but it rides a fetch. Checked FIRST so a cap WS never hits the
    // ingress-echo path below. ──
    const capHeader = request.headers.get("x-itx-cap");
    if (capHeader) {
      const callPath = capHeader.startsWith("[")
        ? expressionCallPath(JSON.parse(capHeader) as ItxExpression)
        : capHeader;
      return this.#fetchCapability(callPath, request);
    }

    // A device REGISTERS a hibernatable wake socket declaring the capabilities it can provide. This socket does
    // NOT pin the DO (it survives hibernation) — 1000 of these cost ~nothing. It only carries pages (DO→device).
    if (url.pathname === "/register") {
      const connectionKey = url.searchParams.get("connectionKey") ?? crypto.randomUUID();
      const caps = (url.searchParams.get("caps") ?? "").split(",").filter(Boolean);
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], ["wake"]); // hibernatable
      pair[1].serializeAttachment({ connectionKey, caps }); // survives hibernation
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    // The on-demand RPC leg: a device dials this (usually after a wake page) and re-provides its capability
    // over capnweb. This IS a live pin — torn down after IDLE_MS so the DO can hibernate again.
    if (url.pathname === "/connect") {
      const connectionKey = url.searchParams.get("connectionKey") ?? crypto.randomUUID();
      return newWorkersRpcResponse(
        request,
        new ProviderControl((p, s) => this.#mountLive(connectionKey, p, s)),
      );
    }

    // The STATEFUL worker fetch lane: forward to the mount's runner DO (→ the facet's own `fetch`) — the ONLY
    // lane that can carry a WS upgrade (a 101 can't cross an RPC method). `?path=<callPath>` names the mount;
    // module + class ride in headers.
    if (url.pathname === "/facet") {
      const callPath = url.searchParams.get("path") ?? "";
      const mount = this.#mounts.get(callPath);
      if (!mount || mount.type !== "stateful")
        return new Response(`no stateful mount at "${callPath}"\n`, { status: 404 });
      const headers = new Headers(request.headers);
      headers.set("x-itx-source", JSON.stringify(mount.source));
      headers.set("x-itx-class", mount.className);
      const fwd = new Request(request.url, {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      });
      return this.#statefulRunner(callPath).fetch(fwd);
    }

    // Observability: incarnation (the hibernation tell) + how much is pinning right now.
    if (url.pathname === "/state") {
      return Response.json({
        incarnation: this.incarnation,
        wakeSockets: this.ctx.getWebSockets("wake").length,
        liveMounts: this.#liveMounts.size,
        idleTimers: this.#idleTimers.size,
        dormant:
          this.#liveMounts.size === 0 && this.#idleTimers.size === 0 && this.#pending.size === 0,
      });
    }

    if ((request.headers.get("Upgrade") ?? "").toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], ["echo"]); // hibernatable ingress echo
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    const sub = await substituteHeaderSecrets(request, "project", (name) =>
      this.env.SECRETS_KV ? this.env.SECRETS_KV.get(`secret:${this.#projectId}:${name}`) : null,
    );
    return this.env.FALLBACK.fetch(sub);
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    // Only the ingress-echo socket echoes; a wake socket receives pages and sends nothing back that we act on.
    if (this.ctx.getTags(ws).includes("echo")) {
      const text = typeof message === "string" ? message : new TextDecoder().decode(message);
      ws.send(`echo:${text}`);
    }
  }
  webSocketClose(ws: WebSocket): void {
    const att = ws.deserializeAttachment() as { connectionKey?: string } | null;
    if (att?.connectionKey) this.#dropConn(att.connectionKey); // a device's wake socket dropped → clean up
  }
  webSocketError(): void {
    /* keep the DO from crashing on a transport error */
  }

  // ── the capability model ──

  /** Mount a capability at a callPath on THIS scope (writes stay LOCAL — target-core §4.4). Durable now; the
   *  event-sourced `capability-provided`-on-a-stream fold is a later increment. */
  async provideCapability(input: ProvideCapabilityInput): Promise<{ ok: true }> {
    const { path, ...mount } = input;
    this.#mounts.set(path, mount as Mount);
    await this.ctx.storage.put("mounts", Object.fromEntries(this.#mounts));
    return { ok: true };
  }

  /** THE single dynamic dispatch (target-core §4.1). Built-in (resolved in-place) → local mount (an
   *  itx-expression re-enters as an alias) → else fall back to the enclosing shell's invokeCapability. */
  async invokeCapability(callPath: string, args: unknown[] = []): Promise<unknown> {
    // built-ins resolve in-place, no fallback (target-core §4.0). Backing is project-prefixed by the DO's own
    // (unforgeable) projectId — so byte-identical project code is isolated in a shared namespace (D8).
    if (callPath === "itx.whoami") return { projectId: this.#projectId };
    if (callPath.startsWith("itx.kv.")) return this.#kv(callPath.slice("itx.kv.".length), args);
    if (callPath === "itx.streams.append") {
      const [path, event] = args as [string, StreamEventInput];
      return this.#stream(path).append(event);
    }
    if (callPath === "itx.streams.read") {
      const [path, after] = args as [string, number?];
      return this.#stream(path).read(after ?? 0);
    }
    // The project's REPO (a file store) + registering/configuring dynamic capabilities in terms of it.
    if (callPath.startsWith("itx.repo."))
      return this.#repo(callPath.slice("itx.repo.".length), args);
    if (callPath === "itx.provideCapability") {
      await this.provideCapability(args[0] as ProvideCapabilityInput);
      return { ok: true };
    }
    // The v1 "file reader": evaluate a source expression's terminal call. Returns a `{ name: source }` modules
    // map. No repo/KV yet — a hardcoded hello (later: a repo snapshot at a ref, same capability + expression).
    if (callPath === "itx.files.read") {
      const [path] = args as [string];
      const content = HELLO_FILES[path];
      if (content == null) throw new Error(`itx.files: no file "${path}"`);
      return { "cap.js": content };
    }
    if (callPath === "itx.configure") return this.#configure(); // run the repo's config worker
    if (callPath === "itx.secrets.set") {
      const [name, value] = args as [string, string];
      if (!this.env.SECRETS_KV) throw new Error("no SECRETS_KV bound");
      await this.env.SECRETS_KV.put(`secret:${this.#projectId}:${name}`, String(value));
      return { ok: true }; // write-only from userspace (referenced by placeholder in egress — never read back)
    }

    // LIVE mounts (a provider with an OPEN RPC leg): dispatch, refresh the idle timer (target-core §4.1 / D7).
    let live = this.#liveMountFor(callPath);
    if (live) return this.#dispatchLive(live, args);
    // WAKE-ON-CALL (spike-4): a registered device declares this cap but has no live leg → page its hibernatable
    // wake socket, wait for it to dial its RPC leg back and re-provide, then dispatch. The DO was hibernating.
    if (await this.#wake(callPath)) {
      live = this.#liveMountFor(callPath);
      if (live) return this.#dispatchLive(live, args);
    }

    const mount = this.#mounts.get(callPath);
    if (mount) {
      if (mount.type === "itx-expression") return this.invokeCapability(mount.expression, args); // alias
      if (mount.type === "code") return this.#runCode(mount.source, args); // stateless worker (from a source expr)
      if (mount.type === "static") return mount.value;
      // stateful with no method (a bare mount-path call) is not invocable — fall through to fallback.
    }
    // STATEFUL worker (RPC lane): a `DurableObject` class hosted as a facet. Longest dotted-prefix match — the
    // remaining segment names the facet method (like a live mount / apps/os replayPath, at clean-room weight).
    const sf = this.#statefulMountFor(callPath);
    if (sf) return this.#dispatchStateful(sf.callPath, sf.mount, sf.method, args);

    // reads fall back (target-core §4.4 / D21): a deep path falls back to its PARENT PATH (another context DO,
    // so it inherits everything provided above it); the ROOT falls back to the enclosing SHELL. Both recurse
    // until the capability resolves or the terminal shell throws.
    const parent = parentPath(this.#name.path);
    if (parent === null) return this.env.FALLBACK.invokeCapability(callPath, args); // root → shell
    const parentName = stringifyName({ projectId: this.#projectId, path: parent });
    return this.env.ITX_HOST.getByName(parentName).invokeCapability(callPath, args); // → parent path
  }

  /** Longest dotted-prefix live mount; the remaining segment(s) name the provider method to call. */
  #liveMountFor(
    callPath: string,
  ): { stub: LiveStub; method: string; connectionKey: string } | null {
    const parts = callPath.split(".");
    for (let i = parts.length - 1; i >= 2; i--) {
      const hit = this.#liveMounts.get(parts.slice(0, i).join("."));
      if (hit)
        return {
          stub: hit.stub,
          method: parts.slice(i).join("."),
          connectionKey: hit.connectionKey,
        };
    }
    return null;
  }

  #dispatchLive(
    live: { stub: LiveStub; method: string; connectionKey: string },
    args: unknown[],
  ): unknown {
    this.#armIdle(live.connectionKey);
    return (live.stub[live.method] as (...a: unknown[]) => unknown)(...args);
  }

  /** A device connected its RPC leg and provided a capability. Record it, resolve any pending wake, arm idle. */
  #mountLive(connectionKey: string, path: string, stub: LiveStub): void {
    this.#liveMounts.set(path, { stub, connectionKey });
    let paths = this.#liveByConn.get(connectionKey);
    if (!paths) this.#liveByConn.set(connectionKey, (paths = new Set()));
    paths.add(path);
    stub.onRpcBroken?.(() => this.#dropConn(connectionKey)); // leg dropped → forget its mounts
    const p = this.#pending.get(connectionKey);
    if (p) {
      this.#pending.delete(connectionKey);
      clearTimeout(p.timer);
      p.resolve();
    }
    this.#armIdle(connectionKey);
  }

  /** Page the hibernatable wake socket that declares `callPath`, then wait for its RPC leg to arrive. */
  async #wake(callPath: string): Promise<boolean> {
    const target = this.#wakeSocketFor(callPath);
    if (!target) return false;
    const { ws, connectionKey } = target;
    const arrived = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#pending.delete(connectionKey))
          reject(new Error(`wake timed out for ${connectionKey}`));
      }, WAKE_TIMEOUT_MS);
      this.#pending.set(connectionKey, { resolve, reject, timer });
    });
    ws.send(JSON.stringify({ type: "wake", cap: callPath }));
    await arrived;
    return true;
  }

  /** The wake socket whose declared caps cover `callPath` (a declared cap is a dotted prefix of it). */
  #wakeSocketFor(callPath: string): { ws: WebSocket; connectionKey: string } | null {
    for (const ws of this.ctx.getWebSockets("wake")) {
      const att = ws.deserializeAttachment() as { connectionKey: string; caps: string[] } | null;
      if (att && att.caps.some((c) => callPath === c || callPath.startsWith(`${c}.`)))
        return { ws, connectionKey: att.connectionKey };
    }
    return null;
  }

  #armIdle(connectionKey: string): void {
    const prev = this.#idleTimers.get(connectionKey);
    if (prev !== undefined) clearTimeout(prev);
    this.#idleTimers.set(
      connectionKey,
      setTimeout(() => this.#teardown(connectionKey), IDLE_MS),
    );
  }

  /** Idle: tell the device to close its RPC leg (freeing the pin) and forget its live mounts. The device keeps
   *  its hibernatable wake socket, so the DO can hibernate and still be paged later. */
  #teardown(connectionKey: string): void {
    this.#idleTimers.delete(connectionKey);
    for (const ws of this.ctx.getWebSockets("wake")) {
      const att = ws.deserializeAttachment() as { connectionKey: string } | null;
      if (att?.connectionKey === connectionKey) {
        try {
          ws.send(JSON.stringify({ type: "idle" }));
        } catch {
          /* socket gone */
        }
      }
    }
    this.#dropConn(connectionKey);
  }

  #dropConn(connectionKey: string): void {
    const prev = this.#idleTimers.get(connectionKey);
    if (prev !== undefined) clearTimeout(prev);
    this.#idleTimers.delete(connectionKey);
    for (const path of this.#liveByConn.get(connectionKey) ?? []) {
      const hit = this.#liveMounts.get(path);
      if (hit) disposeStub(hit.stub);
      this.#liveMounts.delete(path);
    }
    this.#liveByConn.delete(connectionKey);
  }

  /** itx.kv — a project-prefixed view of env.ITX_KV. `${projectId}:` prefix makes byte-identical project code
   *  isolated in a shared namespace, and swappable for a BYO KV by config (D8 / target-core §4.5). */
  async #kv(op: string, args: unknown[]): Promise<unknown> {
    if (!this.env.ITX_KV) throw new Error("no ITX_KV bound");
    const kv = this.env.ITX_KV;
    const prefix = `${this.#projectId}:`;
    const key = (k: unknown) => prefix + String(k);
    switch (op) {
      case "get":
        return kv.get(key(args[0]));
      case "put":
        await kv.put(key(args[0]), String(args[1]));
        return { ok: true };
      case "delete":
        await kv.delete(key(args[0]));
        return { ok: true };
      case "list": {
        const r = await kv.list({ prefix: key(args[0] ?? "") });
        return { keys: r.keys.map((k) => k.name.slice(prefix.length)) };
      }
      default:
        throw new Error(`itx.kv: no op "${op}"`);
    }
  }

  /** itx.streams — a project-prefixed view of the StreamDurableObject namespace. Name `${projectId}:${path}`
   *  so a project can only ever name its OWN streams (constructive isolation, like itx.kv). */
  #stream(path: string) {
    if (!this.env.STREAM_DO) throw new Error("no STREAM_DO bound");
    return this.env.STREAM_DO.getByName(`${this.#projectId}:${path}`);
  }

  /** itx.repo — the project's file store (where the config worker + capability code live). Really lightweight:
   *  a `${projectId}:repo:` view over env.ITX_KV (a real content-addressed RepoDurableObject can slot in behind
   *  this same API later). */
  async #repo(op: string, args: unknown[]): Promise<unknown> {
    if (!this.env.ITX_KV) throw new Error("no ITX_KV bound");
    const kv = this.env.ITX_KV;
    const prefix = `${this.#projectId}:repo:`;
    switch (op) {
      case "get":
        return kv.get(prefix + String(args[0]));
      case "put":
        await kv.put(prefix + String(args[0]), String(args[1]));
        return { ok: true };
      case "list": {
        const r = await kv.list({ prefix });
        return { files: r.keys.map((k) => k.name.slice(prefix.length)) };
      }
      default:
        throw new Error(`itx.repo: no op "${op}"`);
    }
  }

  /** Evaluate a source EXPRESSION against THIS host's itx into a `{ name: source }` modules map. The loader is
   *  repo-agnostic — it only knows "evaluate an itx expression to get modules" (v1 → `itx.files.read`). */
  async #loadModules(source: ItxExpression): Promise<Record<string, string>> {
    const root = itxRoot((p, a) => this.invokeCapability(p, a));
    return (await evaluateItxExpression(root, source)) as Record<string, string>;
  }

  /** Run a stateless dynamic worker: resolve its modules from the source expression, load the entry `cap.js`'s
   *  `(itx, ...args) => result` default export confined (env.ITX = a self-stub), and return the result. */
  async #runCode(source: ItxExpression, args: unknown[]): Promise<unknown> {
    const modules = await this.#loadModules(source);
    const self = this.env.ITX_HOST.getByName(this.ctx.id.name ?? "?");
    const worker = this.env.LOADER.get(
      `code:${this.ctx.id.name}:${hashSource(JSON.stringify(modules))}`,
      () => ({
        compatibilityDate: "2026-07-01",
        mainModule: "run.js",
        modules: { "run.js": CODE_CAP_RUNNER, "itx.js": ITX_SURFACE_MODULE, ...modules },
        env: { ITX: self },
        globalOutbound: self,
      }),
    );
    const resp = await worker
      .getEntrypoint()
      .fetch(new Request("https://code.local/", { method: "POST", body: JSON.stringify(args) }));
    return ((await resp.json()) as { result: unknown }).result;
  }

  /** THE FETCH LANE dispatch: resolve a fetch-shaped capability and forward the request NATIVELY, so a 101
   *  upgrade passes through. `web` → a loaded fetch worker; `stateful` → the runner's facet fetch; an alias
   *  re-resolves; a live capnweb provider needs a frame bridge (a 101 can't cross capnweb) — deferred; a deep
   *  path falls back to its PARENT PATH (a native DO→DO fetch, so the 101 still survives). */
  async #fetchCapability(callPath: string, request: Request): Promise<Response> {
    const mount = this.#mounts.get(callPath);
    if (mount) {
      if (mount.type === "itx-expression") return this.#fetchCapability(mount.expression, request); // alias
      if (mount.type === "web") return this.#fetchWeb(mount.source, request);
      if (mount.type === "stateful") {
        const headers = new Headers(request.headers);
        headers.set("x-itx-source", JSON.stringify(mount.source));
        headers.set("x-itx-class", mount.className);
        return this.#statefulRunner(callPath).fetch(new Request(request, { headers }));
      }
      return new Response(`capability "${callPath}" (${mount.type}) is not fetch-shaped\n`, {
        status: 400,
      });
    }
    // A live capnweb provider: a 101 can't cross capnweb, so a WS to a device needs a frame bridge (deferred).
    if (this.#liveMountFor(callPath))
      return new Response(
        `fetch to a live provider "${callPath}" needs a frame bridge (deferred)\n`,
        {
          status: 501,
        },
      );
    // Fall back to the PARENT PATH — a native DO→DO fetch, so the 101 survives the hop (reads fall back).
    const parent = parentPath(this.#name.path);
    if (parent === null)
      return new Response(`no fetch capability "${callPath}"\n`, { status: 404 });
    const headers = new Headers(request.headers);
    headers.set("x-itx-cap", callPath);
    return this.env.ITX_HOST.getByName(
      stringifyName({ projectId: this.#projectId, path: parent }),
    ).fetch(new Request(request, { headers }));
  }

  /** Load a `web` capability's modules and forward the request to its fetch entrypoint (env.ITX + globalOutbound
   *  = a self-stub, like every dynamic worker). The entrypoint's `fetch` can `accept()` a WebSocket and return a
   *  101, which flows straight back out through this native binding call. */
  async #fetchWeb(source: ItxExpression, request: Request): Promise<Response> {
    const modules = await this.#loadModules(source);
    const self = this.env.ITX_HOST.getByName(this.ctx.id.name ?? "?");
    const worker = this.env.LOADER.get(
      `web:${this.ctx.id.name}:${hashSource(JSON.stringify(modules))}`,
      () => ({
        compatibilityDate: "2026-07-01",
        mainModule: "cap.js",
        modules: { "itx.js": ITX_SURFACE_MODULE, ...modules },
        env: { ITX: self },
        globalOutbound: self,
      }),
    );
    return worker.getEntrypoint().fetch(request);
  }

  /** Longest dotted-prefix STATEFUL mount; the remaining segment(s) name the facet method to call. */
  #statefulMountFor(
    callPath: string,
  ): { callPath: string; mount: Extract<Mount, { type: "stateful" }>; method: string } | null {
    const parts = callPath.split(".");
    for (let i = parts.length - 1; i >= 2; i--) {
      const p = parts.slice(0, i).join(".");
      const m = this.#mounts.get(p);
      if (m && m.type === "stateful")
        return { callPath: p, mount: m, method: parts.slice(i).join(".") };
    }
    return null;
  }

  /** The dedicated runner DO for a stateful capability in THIS context. One instance per (context, callPath). */
  #statefulRunner(callPath: string) {
    return this.env.STATEFUL_WORKER.getByName(
      `${this.#projectId}::${this.#name.path}::${callPath}`,
    );
  }

  /** The RPC lane for a stateful worker: FORWARD to the runner DO, which owns the facet and calls the method
   *  NATIVELY (mirrors apps/os). The runner awaits the facet method, so a plain value returns — no facet stub
   *  crosses back to this host. */
  async #dispatchStateful(
    callPath: string,
    mount: Extract<Mount, { type: "stateful" }>,
    method: string,
    args: unknown[],
  ): Promise<unknown> {
    return this.#statefulRunner(callPath).invokeCapability({
      source: mount.source,
      className: mount.className,
      method,
      args,
    });
  }

  /** Run the project's config worker: load `/worker.js` from the repo and execute it in THIS context. It
   *  typically registers the project's dynamic capabilities (itx.provideCapability) in terms of the repo. */
  async #configure(): Promise<unknown> {
    const source = (await this.#repo("get", ["/worker.js"])) as string | null;
    if (source == null) throw new Error("itx.repo: no /worker.js (config worker)");
    return (await (await this.load(source)).json()) as unknown;
  }

  /** Execute code IN this context (target-core §4.1 mode 2 / D23). Loads `source` as a confined dynamic
   *  worker whose ONLY binding is env.ITX = globalOutbound = a self-stub to THIS host — so the agent's
   *  `itx.*` calls and its plain `fetch()` both resolve against its own capability host. The agent calling
   *  back into this DO while we await it is intra-DO re-entrancy (allowed: the input gate is open during the
   *  await). Returns the agent's Response. */
  async load(source: string, request?: Request): Promise<Response> {
    const self = this.env.ITX_HOST.getByName(this.ctx.id.name ?? "?"); // a stub to THIS host
    const worker = this.env.LOADER.get(`load:${this.ctx.id.name}:${hashSource(source)}`, () => ({
      compatibilityDate: "2026-07-01",
      mainModule: "agent.js",
      // `itx.js` gives the agent the ergonomic `itx.a.b(args)` surface over the raw host stub (§4.2).
      modules: { "agent.js": source, "itx.js": ITX_SURFACE_MODULE },
      env: { ITX: self }, // the agent sees ONLY its itx (the confinement)
      globalOutbound: self, // plain fetch() → this host's fetch (egress)
    }));
    return worker.getEntrypoint().fetch(request ?? new Request("https://agent.local/"));
  }
}
