// SPIKE 3 — the wake-on-CALL live-capability mechanism (generalizes PR #2386's stream
// wake socket from wake-on-append to wake-on-call).
//
// Two channels, per the #2386 design:
//   • WAKE SOCKET (the doorbell): a hibernatable WebSocket the provider holds to the DO
//     (`ctx.acceptWebSocket`, tag "wake"). Costs ~nothing while the DO hibernates. Carries
//     only fire-and-forget JSON control frames. The provider registers its capability here.
//   • RPC LEG (the phone call): an ON-DEMAND capnweb session the provider dials only when
//     woken. It is a live stub — which BLOCKS hibernation — so it is torn down after an idle
//     window, leaving only the hibernatable wake socket. (Grounding: a live RpcTarget stub
//     into/out of a DO blocks hibernation; a plain socket + attachment does not.)
//
// Flow: consumer calls invokeCapability(cap,arg) → if no live leg, send {type:"wake"} on the
// doorbell → provider dials /rpc with its invoker as capnweb localMain → DO forwards the call
// → arm idle timer → on idle, dispose the leg + send {type:"idle"} → dormant (hibernatable).
//
// NOTE: the spike uses setTimeout for the idle window for brevity; setTimeout itself blocks
// hibernation, so production would use a DO alarm (as #2386 reuses the stream idle alarm).
// The teardown clears the timer, so the *dormant* state has neither a timer nor a live stub.

import { DurableObject } from "cloudflare:workers";
import { newWebSocketRpcSession } from "capnweb";

const IDLE_MS = 400;
const WAKE_TIMEOUT_MS = 5000;

export class CapabilityWakeDO extends DurableObject {
  // In-memory, valid only while awake. Torn down before hibernation; rebuilt from the
  // hibernation-surviving wake sockets (getWebSockets + deserializeAttachment) on wake.
  #liveLegs = new Map(); // connectionKey -> RpcStub (the provider's invoker; a hibernation-blocking pin)
  #pending = new Map(); // connectionKey -> { resolve, reject } waiter for the RPC leg to arrive
  #idleTimers = new Map(); // connectionKey -> timeout
  #wakeCount = 0;
  #callCount = 0;

  async fetch(request) {
    const url = new URL(request.url);

    // The hibernatable doorbell. Registration arrives as the first WS message.
    if (url.pathname === "/register") {
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server, ["wake"]);
      return new Response(null, { status: 101, webSocket: client });
    }

    // The on-demand RPC leg. The provider passes its invoker as capnweb localMain; we get a
    // stub for it via the returned remote-main and hold it until idle teardown.
    if (url.pathname === "/rpc") {
      const connectionKey = url.searchParams.get("connectionKey");
      const [client, server] = Object.values(new WebSocketPair());
      server.accept(); // NORMAL accept — a pinning session, deliberately not hibernatable
      const providerInvoker = newWebSocketRpcSession(server); // remote main = the provider's invoker
      this.#liveLegs.set(connectionKey, providerInvoker);
      const waiter = this.#pending.get(connectionKey);
      if (waiter) {
        this.#pending.delete(connectionKey);
        waiter.resolve();
      }
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/call") {
      const cap = url.searchParams.get("cap");
      const arg = url.searchParams.get("arg");
      try {
        const value = await this.invokeCapability(cap, arg);
        return Response.json({ ok: true, value });
      } catch (e) {
        return Response.json({ ok: false, error: String(e?.message || e) });
      }
    }

    if (url.pathname === "/state") {
      return Response.json(this.#state());
    }

    return new Response("not found\n", { status: 404 });
  }

  #state() {
    const wake = this.ctx.getWebSockets("wake");
    return {
      wakeSockets: wake.length,
      registered: wake.map((w) => w.deserializeAttachment?.()?.capabilities ?? []).flat(),
      liveLegs: this.#liveLegs.size, // >0 means a hibernation-blocking pin is present
      pending: this.#pending.size,
      idleTimers: this.#idleTimers.size,
      dormant: this.#liveLegs.size === 0 && this.#idleTimers.size === 0, // hibernation-eligible
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

  async invokeCapability(cap, arg) {
    this.#callCount++;
    const found = this.#wakeSocketFor(cap);
    if (!found) throw new Error(`no provider registered for "${cap}"`);
    const { ws, connectionKey } = found;

    if (!this.#liveLegs.has(connectionKey)) {
      // WAKE: ring the doorbell, then await the provider dialing the RPC leg.
      this.#wakeCount++;
      const arrived = new Promise((resolve, reject) => {
        this.#pending.set(connectionKey, { resolve, reject });
        setTimeout(() => {
          if (this.#pending.delete(connectionKey)) reject(new Error("wake timed out"));
        }, WAKE_TIMEOUT_MS);
      });
      ws.send(JSON.stringify({ type: "wake", cap })); // outgoing send: billing-free
      await arrived;
    }

    const invoker = this.#liveLegs.get(connectionKey);
    const value = await invoker.invokeCapability(cap, arg); // forwarded over the live leg
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

  // Sever the pinning RPC leg so only the hibernatable wake socket remains.
  #teardown(connectionKey, ws) {
    this.#idleTimers.delete(connectionKey);
    const invoker = this.#liveLegs.get(connectionKey);
    if (!invoker) return;
    this.#liveLegs.delete(connectionKey);
    try {
      invoker[Symbol.dispose]?.(); // disposing the main stub closes the /rpc connection
    } catch {}
    try {
      ws.send(JSON.stringify({ type: "idle" })); // tell the provider it can drop its side
    } catch {}
  }

  // Hibernatable handlers.
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
    if (att?.connectionKey) {
      clearTimeout(this.#idleTimers.get(att.connectionKey));
      this.#idleTimers.delete(att.connectionKey);
      const invoker = this.#liveLegs.get(att.connectionKey);
      if (invoker) {
        this.#liveLegs.delete(att.connectionKey);
        try {
          invoker[Symbol.dispose]?.();
        } catch {}
      }
    }
  }
}

// Thin stateless router: forward everything (incl. WS upgrades) to the one context DO.
// The 101 upgrade must go through the DO stub's real fetch() — it cannot cross an RPC method.
export default {
  async fetch(request, env) {
    return env.CAP_DO.getByName("ctx").fetch(request);
  },
};
