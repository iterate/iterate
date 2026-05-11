import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { dispatchCallable } from "./runtime.ts";

export default {
  async fetch(
    request: Request,
    env: Record<string, unknown>,
    ctx: { exports?: Record<string, unknown> },
  ) {
    const url = new URL(request.url);
    if (url.pathname === "/dispatch") {
      const input = (await request.json()) as { callable: unknown; payload: unknown };
      const value = await dispatchCallable({
        callable: input.callable,
        payload: input.payload,
        ctx: { env, exports: ctx.exports },
      });
      return Response.json({ value });
    }

    return new Response("callable test worker");
  },
};

export class CallableLoopbackService extends WorkerEntrypoint<
  Record<string, unknown>,
  { tenantId?: string }
> {
  async fetch(request: Request) {
    const response = await createEchoResponse(request);
    const value = (await response.json()) as Record<string, unknown>;
    return Response.json({
      target: "loopback-service",
      props: this.ctx.props,
      ...value,
    });
  }

  echo(input: unknown) {
    return { target: "loopback-service", props: this.ctx.props, input };
  }
}

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
    server.close(1000, "test complete");
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
