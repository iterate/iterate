// A live-capability PROVIDER (simulates a Raspberry Pi / edge device). It holds only the
// cheap hibernatable WAKE SOCKET while idle; it dials the capnweb RPC LEG only when the DO
// rings the doorbell, and drops it again on {type:"idle"}. Reusable by both harnesses.

import { newWebSocketRpcSession, RpcTarget } from "capnweb";

class Invoker extends RpcTarget {
  #impl;
  constructor(impl) {
    super();
    this.#impl = impl;
  }
  invokeCapability(cap, arg) {
    const fn = this.#impl[cap];
    if (!fn) throw new Error(`provider has no capability "${cap}"`);
    return fn(arg);
  }
}

export function startProvider(wsBase, { connectionKey = "pi-1", socketId = "s1", impl } = {}) {
  const capabilities = impl ?? { greet: (arg) => `hello ${arg}` };
  const invoker = new Invoker(capabilities);
  const events = [];
  let rpc = null; // the on-demand RPC leg; null while dormant
  let opened;
  const ready = new Promise((res) => (opened = res));

  const wake = new WebSocket(`${wsBase}/register`);
  wake.addEventListener("open", () => {
    wake.send(
      JSON.stringify({
        type: "register",
        connectionKey,
        socketId,
        capabilities: Object.keys(capabilities),
      }),
    );
    opened();
  });
  wake.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    events.push(msg.type);
    if (msg.type === "wake") {
      // Dial the RPC leg, exposing our invoker as capnweb localMain so the DO can call it.
      rpc = newWebSocketRpcSession(`${wsBase}/rpc?connectionKey=${connectionKey}`, invoker);
    } else if (msg.type === "idle") {
      try {
        rpc?.[Symbol.dispose]?.();
      } catch {}
      rpc = null;
    }
  });

  return {
    ready,
    events,
    get hasRpcLeg() {
      return rpc !== null;
    },
    close() {
      try {
        rpc?.[Symbol.dispose]?.();
      } catch {}
      wake.close();
    },
  };
}
