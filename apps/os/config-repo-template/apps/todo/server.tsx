import { RpcTarget, newWorkersWebSocketRpcResponse } from "@iterate-com/capnweb";
import { LiveState, LiveStateRpcTarget, type LiveStateRpc } from "iterate/live-state";
import { IterateDurableObject } from "iterate/sdk";

export type Todo = {
  createdAt: string;
  done: boolean;
  id: string;
  title: string;
};

type TodoListState = { todos: Todo[] };

type TodoApi = {
  liveState: LiveStateRpc<TodoListState>;
  add(title: string): Promise<void>;
  setDone(id: string, done: boolean): Promise<void>;
  remove(id: string): Promise<void>;
};

/** One createApp Durable Object owns the page, API, persistence, and live value. */
export class TodoApp extends IterateDurableObject {
  readonly #live: LiveState<TodoListState>;

  constructor(...args: ConstructorParameters<typeof IterateDurableObject>) {
    super(...args);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS todos (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        done INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      )
    `);
    this.#live = new LiveState<TodoListState>({ todos: this.#load() });
  }

  #load(): Todo[] {
    return this.ctx.storage.sql
      .exec<{ created_at: string; done: number; id: string; title: string }>(
        "SELECT id, title, done, created_at FROM todos ORDER BY created_at, id",
      )
      .toArray()
      .map((row) => ({
        createdAt: row.created_at,
        done: row.done !== 0,
        id: row.id,
        title: row.title,
      }));
  }

  #refresh(): void {
    this.#live.setState({ todos: this.#load() });
  }

  add(title: string): void {
    const trimmed = title.trim().slice(0, 200);
    if (trimmed.length === 0) return;
    this.ctx.storage.sql.exec(
      "INSERT INTO todos (id, title, done, created_at) VALUES (?, ?, 0, ?)",
      crypto.randomUUID(),
      trimmed,
      new Date().toISOString(),
    );
    this.#refresh();
  }

  setDone(id: string, done: boolean): void {
    this.ctx.storage.sql.exec("UPDATE todos SET done = ? WHERE id = ?", done ? 1 : 0, id);
    this.#refresh();
  }

  remove(id: string): void {
    this.ctx.storage.sql.exec("DELETE FROM todos WHERE id = ?", id);
    this.#refresh();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api") {
      return newWorkersWebSocketRpcResponse(request, new PublicTodoApi(this, this.#live));
    }
    if (request.method !== "GET" || url.pathname !== "/") {
      return new Response("not found", { status: 404 });
    }
    return new Response(
      `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Todo</title>
    <style>
      :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
      body { margin: 0; padding: 2rem; }
      main { margin: 0 auto; max-width: 38rem; }
      form, li { display: flex; gap: .75rem; margin-block: .75rem; }
      input[type="text"] { flex: 1; padding: .6rem; }
      button { padding: .45rem .75rem; }
      .done { text-decoration: line-through; opacity: .65; }
      [role="alert"] { color: #c33; }
    </style>
  </head>
  <body>
    <main id="root"><p>Loading…</p></main>
    <script type="module" src="/apps/todo/client.js"></script>
  </body>
</html>`,
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "x-content-type-options": "nosniff",
        },
      },
    );
  }
}

class PublicTodoApi extends RpcTarget implements TodoApi {
  readonly #liveState: LiveStateRpcTarget<TodoListState>;

  constructor(
    private readonly app: TodoApp,
    live: LiveState<TodoListState>,
  ) {
    super();
    this.#liveState = new LiveStateRpcTarget(live);
  }

  get liveState(): LiveStateRpc<TodoListState> {
    return this.#liveState;
  }

  async add(title: string): Promise<void> {
    this.app.add(title);
  }

  async setDone(id: string, done: boolean): Promise<void> {
    this.app.setDone(id, done);
  }

  async remove(id: string): Promise<void> {
    this.app.remove(id);
  }
}
