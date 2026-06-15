// Step 01 — a method call over a socket.
//
// itx is, at the bottom, a Cap'n Web session over a WebSocket. The client gets a
// typed stub; calling a method on the stub runs the method here, on the server,
// and the return value comes back. That's the whole primitive — everything later
// makes this bidirectional, dynamic, shared, durable, and nameable.

import { RpcTarget, newWebSocketRpcSession } from "capnweb";

class Server extends RpcTarget {
  whoami() {
    return "the itx server";
  }
  greet(person: string) {
    return `hello, ${person}`;
  }
}

// The Worker answers the WebSocket upgrade and hands Cap'n Web the target. From
// here the client drives it as `using itx = newWebSocketRpcSession<Server>(url)`.
export function handle(_request: Request): Response {
  const pair = new WebSocketPair();
  const server = pair[0];
  server.accept();
  newWebSocketRpcSession(server as unknown as WebSocket, new Server());
  return new Response(null, { status: 101, webSocket: pair[1] });
}
