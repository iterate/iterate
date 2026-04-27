import { DurableObject } from "cloudflare:workers";

export default {
  fetch() {
    return new Response("callable test worker");
  },
};

export class CallableTestDurableObject extends DurableObject {
  async fetch(request: Request) {
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      return this.handleWebSocketUpgrade();
    }

    return createEchoResponse(request);
  }

  echo(input: unknown) {
    return { target: "durable-object", input };
  }

  join(left: string, right: string) {
    return `${left}:${right}`;
  }

  webSocketMessage() {}

  webSocketClose() {}

  webSocketError() {}

  private handleWebSocketUpgrade() {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    server.addEventListener("error", () => {});
    server.send("connected");
    return new Response(null, { status: 101, webSocket: client });
  }
}

async function createEchoResponse(request: Request) {
  const url = new URL(request.url);
  const body = request.body ? await request.text() : "";
  return Response.json({
    method: request.method,
    path: url.pathname,
    query: url.search,
    body,
    upgrade: request.headers.get("Upgrade"),
  });
}
