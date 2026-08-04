// The ItxDurableObject — the capability host (target-core §4.1). One DO per {projectId, path}, addressed by
// name. It is the single host for a context:
//   • NATIVE fetch — the ONE method a WS upgrade (101) can flow through. `/connect` → a capnweb provider
//     session; a WS upgrade → ingress (acceptWebSocket); a non-WS request → EGRESS (secret-sub → fallback).
//   • invokeCapability — the single dispatch: built-ins (whoami/kv/secrets) → live provider mounts → local
//     static/alias mounts → fall back to the enclosing shell. "Reads fall back, writes stay local" (§4.4).
//   • provideCapability — mount at a callPath. load — run confined code IN this context (env.ITX = self-stub).
//
// NOT YET: wake-on-call for live mounts (hibernation, spikes 3-4); streams built-in; the real
// DurableObjectNameCodec + parent-path fallthrough. Solo: the DO name IS the projectId.

import { DurableObject } from "cloudflare:workers";
import { newWorkersRpcResponse, RpcTarget } from "capnweb";
import { substituteHeaderSecrets } from "./core/egress.ts";
import { ITX_SURFACE_MODULE } from "./core/agent-runtime.ts";
import type { StreamDurableObject, StreamEventInput } from "./stream-durable-object.ts";
import type { ItxCallPath } from "./core/config.ts";

/** A capnweb stub to a provider-supplied capability. `.dup()` retains it past a call; other keys are its
 *  (remote) methods, which return promises that resolve back on the provider. */
type LiveStub = { dup(): LiveStub; [method: string]: (...a: unknown[]) => unknown };

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

// A mount (target-core §4.1). `itx-expression` = an ALIAS to another callPath. `static` = a plain value (a
// test affordance). `live` RPC-stub mounts land with capnweb.
type Mount =
  | { type: "itx-expression"; expression: ItxCallPath }
  | { type: "static"; value: unknown };

export type ProvideCapabilityInput = { path: ItxCallPath } & Mount;

export class ItxDurableObject extends DurableObject<Env> {
  #mounts = new Map<string, Mount>(); // callPath -> mount (mirrors DO storage; the event-sourced fold is later)
  #liveMounts = new Map<string, LiveStub>(); // callPath -> a connected provider's stub (IN-MEMORY; a live pin,
  //                                             lost on eviction — wake-on-call reconnection is a later increment)

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const stored = (await ctx.storage.get<Record<string, Mount>>("mounts")) ?? {};
      this.#mounts = new Map(Object.entries(stored));
    });
  }

  /** Solo: the DO name IS the projectId (root path "/"). Real {projectId,path} name codec is a later increment. */
  get #projectId(): string {
    return this.ctx.id.name ?? "?";
  }

  // ── native fetch (target-core §4.1, §6.0). Two callers, disambiguated by the Upgrade header:
  //    • WS upgrade → INGRESS: accept a hibernatable socket (a client connecting in).
  //    • non-WS     → EGRESS: a loaded agent reaching OUT via its globalOutbound self-stub → substitute the
  //      project's own secrets, then delegate to the fallback (→ terminal). This is `itx.egress.fetch`.
  //    (WS EGRESS from a DO-loaded agent is ambiguous with WS ingress here — deferred; agents egress over HTTP
  //     today. A marker will disambiguate when needed.) ──
  async fetch(request: Request): Promise<Response> {
    // A capability PROVIDER connecting over capnweb: serve the ProviderControl surface. The session pins the
    // DO awake while the provider is connected; its live mounts dispatch back over this socket.
    if (new URL(request.url).pathname === "/connect") {
      return newWorkersRpcResponse(
        request,
        new ProviderControl((p, s) => this.#liveMounts.set(p, s)),
      );
    }
    if ((request.headers.get("Upgrade") ?? "").toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]); // hibernatable — survives eviction (spikes 3-4)
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    const sub = await substituteHeaderSecrets(request, "project", (name) =>
      this.env.SECRETS_KV ? this.env.SECRETS_KV.get(`secret:${this.#projectId}:${name}`) : null,
    );
    return this.env.FALLBACK.fetch(sub);
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const text = typeof message === "string" ? message : new TextDecoder().decode(message);
    ws.send(`echo:${text}`);
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
    if (callPath === "itx.secrets.set") {
      const [name, value] = args as [string, string];
      if (!this.env.SECRETS_KV) throw new Error("no SECRETS_KV bound");
      await this.env.SECRETS_KV.put(`secret:${this.#projectId}:${name}`, String(value));
      return { ok: true }; // write-only from userspace (referenced by placeholder in egress — never read back)
    }

    // LIVE mounts (a connected provider): longest-prefix match; the remaining segment is the method to call
    // ON the provider — the call travels back over its capnweb socket (target-core §4.1 "live" / D7).
    const live = this.#liveMountFor(callPath);
    if (live) return live.stub[live.method](...args);

    const mount = this.#mounts.get(callPath);
    if (mount) {
      if (mount.type === "itx-expression") return this.invokeCapability(mount.expression, args); // alias
      return mount.value; // static
    }

    // reads fall back — the SAME method on the fallback, which recurses to the terminal (target-core §4.4)
    return this.env.FALLBACK.invokeCapability(callPath, args);
  }

  /** Longest dotted-prefix live mount; the remaining segment(s) name the provider method to call. */
  #liveMountFor(callPath: string): { stub: LiveStub; method: string } | null {
    const parts = callPath.split(".");
    for (let i = parts.length - 1; i >= 2; i--) {
      const stub = this.#liveMounts.get(parts.slice(0, i).join("."));
      if (stub) return { stub, method: parts.slice(i).join(".") };
    }
    return null;
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
