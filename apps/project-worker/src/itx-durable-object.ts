// The ItxDurableObject — the capability host (target-core §4.1). One DO per {projectId, path}, addressed by
// name. Two jobs:
//   1. NATIVE fetch — the ONE method a WS upgrade (101) can flow through (a 101 can't cross an RPC hop). The
//      edge calls it directly; here it accepts a hibernatable socket + echoes (ingress WS / wake attach point).
//   2. The CAPABILITY MODEL — provideCapability (mount at a callPath) + invokeCapability (the single dynamic
//      dispatch: built-in → local mount → fall back). "Reads fall back, writes stay local" (§4.4).
//
// NOT YET (next increments): `live` RPC-stub mounts + the prototype hop (need capnweb), longest-prefix
// navigation, run/load in the DO, the real DurableObjectNameCodec. Solo: the DO name IS the projectId.

import { DurableObject } from "cloudflare:workers";
import { substituteHeaderSecrets } from "./core/egress.ts";
import type { ItxCallPath } from "./core/config.ts";

interface Env {
  ITX_HOST: DurableObjectNamespace<ItxDurableObject>;
  LOADER: WorkerLoader;
  SECRETS_KV?: KVNamespace;
  ITX_KV?: KVNamespace; // backing for itx.kv (project-prefixed — the D8 portability proof point)
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
    if (callPath === "itx.secrets.set") {
      const [name, value] = args as [string, string];
      if (!this.env.SECRETS_KV) throw new Error("no SECRETS_KV bound");
      await this.env.SECRETS_KV.put(`secret:${this.#projectId}:${name}`, String(value));
      return { ok: true }; // write-only from userspace (referenced by placeholder in egress — never read back)
    }

    const mount = this.#mounts.get(callPath);
    if (mount) {
      if (mount.type === "itx-expression") return this.invokeCapability(mount.expression, args); // alias
      return mount.value; // static
    }

    // reads fall back — the SAME method on the fallback, which recurses to the terminal (target-core §4.4)
    return this.env.FALLBACK.invokeCapability(callPath, args);
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
      modules: { "agent.js": source },
      env: { ITX: self }, // the agent sees ONLY its itx (the confinement)
      globalOutbound: self, // plain fetch() → this host's fetch (egress)
    }));
    return worker.getEntrypoint().fetch(request ?? new Request("https://agent.local/"));
  }
}
