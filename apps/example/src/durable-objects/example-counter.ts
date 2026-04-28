import { DurableObject } from "cloudflare:workers";

type CounterState = {
  count: number;
  updatedAt: string | null;
};

type CounterStateMessage = CounterState & {
  type: "counter-state";
};

type ExampleCounterEnv = {
  EXAMPLE_COUNTER: DurableObjectNamespace<ExampleCounter>;
};

const counterKey = "counter";

export class ExampleCounter extends DurableObject<ExampleCounterEnv> {
  async fetch(request: Request) {
    const url = new URL(request.url);

    if (url.pathname === "/api/durable-counter/websocket") {
      return this.handleWebSocket(request);
    }

    if (request.method === "GET" && url.pathname === "/api/durable-counter") {
      return Response.json(await this.readState());
    }

    if (request.method === "POST" && url.pathname === "/api/durable-counter/increment") {
      return Response.json(await this.increment());
    }

    if (request.method === "POST" && url.pathname === "/api/durable-counter/reset") {
      return Response.json(await this.reset());
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }

  private async handleWebSocket(request: Request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);
    server.send(this.createStateMessage(await this.readState()));

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (message === "ping") {
      ws.send("pong");
      return;
    }

    ws.send(this.createStateMessage(await this.readState()));
  }

  private async readState(): Promise<CounterState> {
    return (
      (await this.ctx.storage.get<CounterState>(counterKey)) ?? {
        count: 0,
        updatedAt: null,
      }
    );
  }

  private async increment() {
    const current = await this.readState();
    const next = {
      count: current.count + 1,
      updatedAt: new Date().toISOString(),
    };

    await this.ctx.storage.put(counterKey, next);
    this.broadcastState(next);
    return next;
  }

  private async reset() {
    const next = {
      count: 0,
      updatedAt: new Date().toISOString(),
    };

    await this.ctx.storage.put(counterKey, next);
    this.broadcastState(next);
    return next;
  }

  private broadcastState(state: CounterState) {
    const message = this.createStateMessage(state);

    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(message);
      } catch {
        ws.close();
      }
    }
  }

  private createStateMessage(state: CounterState) {
    const message: CounterStateMessage = {
      type: "counter-state",
      count: state.count,
      updatedAt: state.updatedAt,
    };

    return JSON.stringify(message);
  }
}

export default {
  fetch() {
    return Response.json({ ok: true });
  },
} satisfies ExportedHandler<ExampleCounterEnv>;
