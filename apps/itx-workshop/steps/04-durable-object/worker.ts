// Step 04 — a Durable Object to live in.
//
// Put the registry inside a Durable Object addressed by a constant name, so every
// connection meets the SAME registry — and a LIVE capability client A provided is
// held in the DO so client B (a different socket, a different edge isolate) can
// call it. The WebSocket terminates in the stateless Worker; the DO exposes the
// registry over Workers RPC.
//
// Two things make a live cross-client cap actually survive (both here):
//   - dup() the provided stub at the Worker layer before forwarding to the DO
//     (Cap'n Web disposes the argument when the provide call returns);
//   - ctx.waitUntil keeps the provider's Worker invocation alive for the socket's
//     lifetime, so A's stub is still callable when B invokes it later.

import { RpcTarget, newWebSocketRpcSession } from "capnweb";
import { retain, type RegistryDO } from "./registry-do.ts";

type Env = { REGISTRY: DurableObjectNamespace<RegistryDO> };

// The per-connection handle the Worker serves: it dups the client's stub (so the
// client→Worker import survives) and forwards the verbs to the shared DO.
class WorkerHandle extends RpcTarget {
  #node: DurableObjectStub<RegistryDO>;
  constructor(node: DurableObjectStub<RegistryDO>) {
    super();
    this.#node = node;
  }
  provideCapability(name: string, capability: any) {
    return this.#node.provideCapability(name, retain(capability));
  }
  invoke(name: string, args: unknown[]) {
    return this.#node.invoke(name, args);
  }
  list() {
    return this.#node.list();
  }
}

export function handle(_request: Request, env: Env, ctx: ExecutionContext): Response {
  const node = env.REGISTRY.getByName("step04"); // the ONE shared registry
  const pair = new WebSocketPair();
  const server = pair[0];
  server.accept();
  newWebSocketRpcSession(server as unknown as WebSocket, new WorkerHandle(node));
  // Hold the provider's invocation open for the socket's lifetime.
  ctx.waitUntil(new Promise<void>((resolve) => server.addEventListener("close", () => resolve())));
  return new Response(null, { status: 101, webSocket: pair[1] });
}
