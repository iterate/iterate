// A live-capability PROVIDER (simulates a Raspberry Pi / ESP32 device). Holds only the cheap
// hibernatable WAKE SOCKET while idle; dials the capnweb RPC LEG only when woken; auto-reconnects
// its doorbell if it drops (as a real always-on device would). Reusable by every harness.

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

export function startProvider(
  wsBase,
  { connectionKey = "pi-1", socketId = "s1", ctx = "project", impl, reconnect = true } = {},
) {
  const capabilities = impl ?? { greet: (arg) => `hello ${arg}` };
  const invoker = new Invoker(capabilities);
  const registerMsg = JSON.stringify({
    type: "register",
    connectionKey,
    socketId,
    capabilities: Object.keys(capabilities),
  });
  const q = `ctx=${encodeURIComponent(ctx)}`;
  const events = [];
  let rpc = null; // the on-demand RPC leg; null while dormant
  let wake = null;
  let closedByUser = false;
  let connects = 0;
  let opened;
  const ready = new Promise((res) => (opened = res));

  function connect() {
    connects++;
    wake = new WebSocket(`${wsBase}/register?${q}`);
    wake.addEventListener("open", () => {
      wake.send(registerMsg);
      opened();
    });
    wake.addEventListener("error", () => opened());
    wake.addEventListener("close", () => {
      if (!closedByUser && reconnect) setTimeout(connect, 300 + Math.floor(Math.random() * 700)); // re-dial the doorbell
    });
    wake.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      events.push(msg.type);
      if (msg.type === "wake") {
        rpc = newWebSocketRpcSession(
          `${wsBase}/rpc?${q}&connectionKey=${encodeURIComponent(connectionKey)}`,
          invoker,
        );
      } else if (msg.type === "idle") {
        try {
          rpc?.[Symbol.dispose]?.();
        } catch {}
        rpc = null;
      }
    });
  }
  connect();

  return {
    ready,
    events,
    get reconnects() {
      return Math.max(0, connects - 1); // dials beyond the first = churn
    },
    get hasRpcLeg() {
      return rpc !== null;
    },
    close() {
      closedByUser = true;
      try {
        rpc?.[Symbol.dispose]?.();
      } catch {}
      try {
        wake?.close(1000, "client done"); // GRACEFUL: normal-closure handshake, avoids client-side 1006
      } catch {}
    },
  };
}
