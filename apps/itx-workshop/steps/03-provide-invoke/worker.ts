// Step 03 — provide & invoke: capabilities go dynamic.
//
// Stop passing objects as call arguments. Add two verbs: `provide({name,capability})`
// registers a capability under a name; `invoke({name,args})` calls it. The set of
// capabilities is now a dynamic registry, grown at runtime. Here the registry is
// PER-CONNECTION (one Registry per socket) — which is exactly why a second client
// can't see what the first provided (the motivation for Step 04's Durable Object).

import { RpcTarget, newWebSocketRpcSession } from "capnweb";

class Registry extends RpcTarget {
  // A plain object, not a Map — the same table later becomes the StreamProcessor's
  // reduced state (Step 07), which must be plain JSON.
  #caps: Record<string, any> = {};

  provide({ name, capability }: { name: string; capability: any }) {
    // Cap'n Web disposes an argument stub when this call returns; retain it.
    this.#caps[name] = capability.dup?.() ?? capability;
    return `provided ${name}`;
  }

  async invoke({ name, args }: { name: string; args: unknown[] }) {
    const cap = this.#caps[name];
    if (!cap) throw new Error(`no capability "${name}"`);
    return await cap(...args);
  }
}

export function handle(_request: Request): Response {
  const pair = new WebSocketPair();
  const server = pair[0];
  server.accept();
  // A fresh registry per connection — that's the point of this step's limitation.
  newWebSocketRpcSession(server as unknown as WebSocket, new Registry());
  return new Response(null, { status: 101, webSocket: pair[1] });
}
