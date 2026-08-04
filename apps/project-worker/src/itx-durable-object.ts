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
import type { ItxCallPath } from "./core/config.ts";

interface Env {
  ITX_HOST: DurableObjectNamespace<ItxDurableObject>;
  // The fallback (target-core §4.4 / D30). Solo: a self service-binding to DummyControlPlane. A DO can't mint
  // ctx.exports loopbacks, so it reaches the fallback via a binding rather than the worker's ctx.exports.
  FALLBACK: { invokeCapability(callPath: string, args?: unknown[]): Promise<unknown> };
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

  // ── native fetch: ingress + WS upgrade (target-core §4.1, §6.0) ──
  async fetch(request: Request): Promise<Response> {
    if ((request.headers.get("Upgrade") ?? "").toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]); // hibernatable — survives eviction (spikes 3-4)
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response(`itx-do ${this.#projectId} ok\n`, {
      headers: { "content-type": "text/plain" },
    });
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
    // built-ins resolve in-place, no fallback (target-core §4.0)
    if (callPath === "itx.whoami") return { projectId: this.#projectId };

    const mount = this.#mounts.get(callPath);
    if (mount) {
      if (mount.type === "itx-expression") return this.invokeCapability(mount.expression, args); // alias
      return mount.value; // static
    }

    // reads fall back — the SAME method on the fallback, which recurses to the terminal (target-core §4.4)
    return this.env.FALLBACK.invokeCapability(callPath, args);
  }
}
