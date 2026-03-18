import type { Hooks } from "crossws";
import { defineHooks } from "crossws";

export function createPingPongHooks(): Partial<Hooks> {
  return defineHooks({
    message(peer, _message) {
      setTimeout(() => {
        peer.send(JSON.stringify({ type: "pong", ts: Date.now() }));
      }, 1000);
    },
  });
}
