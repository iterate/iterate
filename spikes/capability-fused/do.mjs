// SPIKE 4 — the FUSED, hardened capability host ("context") DO, proven in PRODUCTION.
//
// Fuses spike-2 (parent fallthrough) + spike-3 (wake-on-call live mounts) with the red-team
// hardening, and is built to hold a FLEET of live capabilities (e.g. 1000 ESP32 devices),
// each just an RPC target reachable through an optional hibernatable wake socket. The DO
// hibernates while nobody is calling; a call wakes ONLY the targeted device.
//
// Hardening vs the earlier spikes:
//   • Parent is resolved BY NAME per call (native RPC to another context DO) — no retained
//     cross-context stub, so the per-access import/export leak the red-team measured is gone.
//   • Resolution is downward-only: local live cap → local static cap → parent (never upward).
//   • Mutators (/admin/*) are a SEPARATE facet behind a shared secret — off the tenant /call
//     surface (the red-team's unauthenticated-wire-mutator finding).
//   • A durable `incarnation` counter (bumped in the constructor) makes real hibernation/
//     eviction OBSERVABLE: it increases only when the DO is reconstructed.

import { DurableObject } from "cloudflare:workers";
import { newWebSocketRpcSession } from "capnweb";

const IDLE_MS = 300; // tear the live leg down fast so the DO can hibernate
const WAKE_TIMEOUT_MS = 8000;

export class ContextDO extends DurableObject {
  #liveLegs = new Map(); // connectionKey -> RpcStub (a live leg; the only hibernation-blocking pin)
  #pending = new Map(); // connectionKey -> { resolve, reject, timer }
  #idleTimers = new Map(); // connectionKey -> timeout
  #wakeCount = 0;
  #callCount = 0;
  incarnation = 0;

  constructor(ctx, env) {
    super(ctx, env);
    // Bump a durable incarnation counter on every (re)construction — including every
    // wake-from-hibernation. If this grows across an idle gap, the DO was evicted.
    ctx.blockConcurrencyWhile(async () => {
      const n = (await ctx.storage.get("incarnation")) || 0;
      this.incarnation = n + 1;
      await ctx.storage.put("incarnation", this.incarnation);
    });
  }

  get #name() {
    return this.ctx.id.name || "?";
  }

  async fetch(request) {
    const url = new URL(request.url);
    const p = url.pathname;

    // ── the hibernatable doorbell (one per device) ──
    if (p === "/register") {
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server, ["wake"]);
      return new Response(null, { status: 101, webSocket: client });
    }

    // ── the on-demand RPC leg (dialed by a device only when woken) ──
    if (p === "/rpc") {
      const connectionKey = url.searchParams.get("connectionKey");
      const [client, server] = Object.values(new WebSocketPair());
      server.accept();
      this.#liveLegs.set(connectionKey, newWebSocketRpcSession(server));
      const w = this.#pending.get(connectionKey);
      if (w) {
        this.#pending.delete(connectionKey);
        clearTimeout(w.timer);
        w.resolve();
      }
      return new Response(null, { status: 101, webSocket: client });
    }

    // ── TENANT surface: resolve + call only. No mutators here. ──
    if (p === "/call") {
      const cap = url.searchParams.get("cap");
      const arg = url.searchParams.get("arg") ?? "";
      try {
        return Response.json({ ok: true, value: await this.invokeCapability(cap, arg) });
      } catch (e) {
        return Response.json({ ok: false, error: String(e?.message || e) });
      }
    }

    // ── CONTROL surface: mutators, behind a shared secret (auth stand-in). ──
    if (p.startsWith("/admin/")) {
      if (
        (this.env.ADMIN_SECRET ?? "") === "" ||
        url.searchParams.get("secret") !== this.env.ADMIN_SECRET
      ) {
        return Response.json(
          { ok: false, error: "forbidden (mutators are off the tenant surface)" },
          { status: 403 },
        );
      }
      if (p === "/admin/set-parent") {
        await this.ctx.storage.put("parent", url.searchParams.get("name") || "");
        return Response.json({ ok: true });
      }
      if (p === "/admin/provide-static") {
        const statics = (await this.ctx.storage.get("statics")) || {};
        statics[url.searchParams.get("cap")] = url.searchParams.get("value");
        await this.ctx.storage.put("statics", statics);
        return Response.json({ ok: true });
      }
    }

    if (p === "/state") return Response.json(await this.#state());

    // Probe: force-reset the DO to test whether hibernatable sockets survive an abort().
    if (p === "/abort") {
      try {
        this.ctx.abort?.("spike abort probe");
        return Response.json({ ok: true, aborted: true });
      } catch (e) {
        return Response.json({ ok: false, error: String(e?.message || e) });
      }
    }

    return new Response("not found\n", { status: 404 });
  }

  async #state() {
    const wake = this.ctx.getWebSockets("wake");
    const caps = new Set();
    for (const w of wake)
      for (const c of w.deserializeAttachment?.()?.capabilities ?? []) caps.add(c);
    return {
      name: this.#name,
      incarnation: this.incarnation, // grows on every (re)construction — the hibernation tell
      parent: (await this.ctx.storage.get("parent")) || null,
      statics: Object.keys((await this.ctx.storage.get("statics")) || {}),
      wakeSockets: wake.length, // hibernatable doorbells held (the fleet size)
      registeredCaps: caps.size,
      sampleCaps: [...caps].slice(0, 3),
      liveLegs: this.#liveLegs.size, // >0 ⇒ a hibernation-blocking pin is present
      idleTimers: this.#idleTimers.size,
      pending: this.#pending.size,
      dormant: this.#liveLegs.size === 0 && this.#idleTimers.size === 0 && this.#pending.size === 0,
      wakeCount: this.#wakeCount,
      callCount: this.#callCount,
    };
  }

  #wakeSocketFor(cap) {
    for (const ws of this.ctx.getWebSockets("wake")) {
      const att = ws.deserializeAttachment?.();
      if (att?.capabilities?.includes(cap)) return { ws, connectionKey: att.connectionKey };
    }
    return null;
  }

  // Downward-only resolution: local live cap → local static → parent (by name). Never upward.
  async invokeCapability(cap, arg) {
    this.#callCount++;
    const live = this.#wakeSocketFor(cap);
    if (live) return this.#callLive(live, cap, arg);

    const statics = (await this.ctx.storage.get("statics")) || {};
    if (cap in statics) return `static:${statics[cap]}`;

    const parent = (await this.ctx.storage.get("parent")) || "";
    if (parent) {
      // Fall through BY NAME — a fresh native-RPC stub per call, never retained. No leak.
      return this.env.CONTEXT.getByName(parent).invokeCapability(cap, arg);
    }
    throw new Error(`[${this.#name}] no capability "${cap}"`);
  }

  async #callLive({ ws, connectionKey }, cap, arg) {
    if (!this.#liveLegs.has(connectionKey)) {
      this.#wakeCount++;
      const arrived = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (this.#pending.delete(connectionKey)) reject(new Error("wake timed out"));
        }, WAKE_TIMEOUT_MS);
        this.#pending.set(connectionKey, { resolve, reject, timer });
      });
      ws.send(JSON.stringify({ type: "wake", cap })); // outgoing send: billing-free
      await arrived;
    }
    const value = await this.#liveLegs.get(connectionKey).invokeCapability(cap, arg);
    this.#armIdle(connectionKey, ws);
    return value;
  }

  #armIdle(connectionKey, ws) {
    clearTimeout(this.#idleTimers.get(connectionKey));
    this.#idleTimers.set(
      connectionKey,
      setTimeout(() => this.#teardown(connectionKey, ws), IDLE_MS),
    );
  }

  #teardown(connectionKey, ws) {
    this.#idleTimers.delete(connectionKey);
    const leg = this.#liveLegs.get(connectionKey);
    if (!leg) return;
    this.#liveLegs.delete(connectionKey);
    try {
      leg[Symbol.dispose]?.();
    } catch {}
    try {
      ws.send(JSON.stringify({ type: "idle" }));
    } catch {}
  }

  webSocketMessage(ws, message) {
    let msg;
    try {
      msg = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
    } catch {
      return;
    }
    if (msg.type === "register") {
      ws.serializeAttachment({
        v: 1,
        connectionKey: msg.connectionKey,
        socketId: msg.socketId,
        capabilities: msg.capabilities ?? [],
      });
    }
  }

  webSocketClose(ws) {
    const att = ws.deserializeAttachment?.();
    if (!att?.connectionKey) return;
    clearTimeout(this.#idleTimers.get(att.connectionKey));
    this.#idleTimers.delete(att.connectionKey);
    const leg = this.#liveLegs.get(att.connectionKey);
    if (leg) {
      this.#liveLegs.delete(att.connectionKey);
      try {
        leg[Symbol.dispose]?.();
      } catch {}
    }
  }
}

export default {
  async fetch(request, env) {
    const name = new URL(request.url).searchParams.get("ctx") || "project";
    return env.CONTEXT.getByName(name).fetch(request);
  },
};
