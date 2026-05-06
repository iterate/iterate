import { createIterateDurableObjectBase } from "@iterate-com/shared/durable-object-utils/iterate-durable-object";
import {
  buildCounterExplorerLinks,
  buildCounterPublicPath,
  COUNTER_DURABLE_OBJECT_CLASS_NAME,
  type CounterInitParams,
  type CounterState,
} from "~/lib/counter-durable-objects.ts";

type CounterStateMessage = CounterState & {
  type: "counter-state";
};

type CounterStateRow = {
  count: number;
  updated_at: string | null;
};

type ExampleCounterEnv = {
  DB: D1Database;
  EXAMPLE_COUNTER: DurableObjectNamespace<ExampleCounter>;
};

const counterKey = "counter";

const ExampleCounterBase = createIterateDurableObjectBase<
  CounterInitParams,
  Pick<ExampleCounterEnv, "DB">
>({
  className: COUNTER_DURABLE_OBJECT_CLASS_NAME,
  getDatabase: (env) => env.DB,
  indexes: {
    scope: (params) => params.scope,
    variant: (params) => params.variant,
  },
});

export class ExampleCounter extends ExampleCounterBase<ExampleCounterEnv> {
  constructor(ctx: DurableObjectState, env: ExampleCounterEnv) {
    super(ctx, env);

    const sql = this.getDurableObjectSql();
    sql.exec(`CREATE TABLE IF NOT EXISTS counter_state (
      id TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      updated_at TEXT
    )`);
    sql.exec(`CREATE TABLE IF NOT EXISTS counter_events (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      count INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )`);
  }

  async fetch(request: Request) {
    const url = new URL(request.url);

    if (url.pathname === "/websocket") {
      return await this.handleWebSocket(request);
    }

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/state")) {
      return await this.handleJson(() => this.readState());
    }

    if (request.method === "POST" && url.pathname === "/increment") {
      return await this.handleJson(() => this.increment());
    }

    if (request.method === "POST" && url.pathname === "/reset") {
      return await this.handleJson(() => this.reset());
    }

    const fallbackResponse = await super.fetch?.(request);
    return fallbackResponse ?? new Response("Not found", { status: 404 });
  }

  private async handleJson(read: () => Promise<CounterState>) {
    try {
      return Response.json(await read());
    } catch (error) {
      if (error instanceof Error && error.name === "NotInitializedError") {
        return Response.json(
          { error: "counter_not_initialized", message: error.message },
          { status: 409 },
        );
      }

      throw error;
    }
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
    const initParams = await this.ensureStarted();
    const row = this.readCounterStateRow();
    const publicPath = buildCounterPublicPath(initParams.name);

    return {
      ...initParams,
      count: row?.count ?? 0,
      updatedAt: row?.updated_at ?? null,
      publicPath,
      explorerLinks: buildCounterExplorerLinks(publicPath),
    };
  }

  private readCounterStateRow() {
    return this.getDurableObjectSql()
      .exec<CounterStateRow>(
        `SELECT count, updated_at
         FROM counter_state
         WHERE id = ?
         LIMIT 1`,
        counterKey,
      )
      .toArray()[0];
  }

  private async increment() {
    const current = await this.readState();
    const next = {
      ...current,
      count: current.count + 1,
      updatedAt: new Date().toISOString(),
    };

    this.writeCounterState(next, "increment");
    this.broadcastState(next);
    return next;
  }

  private async reset() {
    const current = await this.readState();
    const next = {
      ...current,
      count: 0,
      updatedAt: new Date().toISOString(),
    };

    this.writeCounterState(next, "reset");
    this.broadcastState(next);
    return next;
  }

  private writeCounterState(state: CounterState, action: "increment" | "reset") {
    this.transactionSync(() => {
      const sql = this.getDurableObjectSql();
      sql.exec(
        `INSERT INTO counter_state (id, count, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           count = excluded.count,
           updated_at = excluded.updated_at`,
        counterKey,
        state.count,
        state.updatedAt,
      );
      sql.exec(
        `INSERT INTO counter_events (id, action, count, created_at)
         VALUES (?, ?, ?, ?)`,
        crypto.randomUUID(),
        action,
        state.count,
        state.updatedAt,
      );
    });
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
      ...state,
    };

    return JSON.stringify(message);
  }
}

export default {
  fetch() {
    return Response.json({ ok: true });
  },
} satisfies ExportedHandler<ExampleCounterEnv>;
