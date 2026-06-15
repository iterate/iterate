// Step 02 — the server calls the client.
//
// The cool thing about Cap'n Web: stubs pass as arguments in EITHER direction.
// So the client can hand the server a live object and the SERVER calls methods on
// it, back across the same socket. Here the client passes a `laptop` capability;
// the server calls `laptop.compute(...)` — code running on the client, invoked
// from the server. Fully self-contained: no registry, no DO yet.

import { RpcTarget, newWebSocketRpcSession } from "capnweb";

class RegisterServer extends RpcTarget {
  // `laptop` is a stub pointing back at the client; calling it runs THERE.
  async register(laptop: { compute: (a: number, b: number) => Promise<number> }) {
    const answer = await laptop.compute(6, 7);
    return `the laptop computed: ${answer}`;
  }
}

export function handle(_request: Request): Response {
  const pair = new WebSocketPair();
  const server = pair[0];
  server.accept();
  newWebSocketRpcSession(server as unknown as WebSocket, new RegisterServer());
  return new Response(null, { status: 101, webSocket: pair[1] });
}
