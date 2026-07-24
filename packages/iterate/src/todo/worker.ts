import {
  LiveState,
  LiveStateRpcTarget,
  RpcTarget,
  newWorkersWebSocketRpcResponse,
  type LiveStateRpc,
} from "../sdk/capnweb/index.ts";
import { IterateDurableObject } from "../sdk.ts";
import { createDurableObjectClient, defineConfig, sql } from "sqlfu";
import todoClientSource from "iterate:todo-client-source";

export type Todo = {
  createdAt: string;
  done: boolean;
  id: string;
  title: string;
};

type TodoListState = { todos: Todo[] };

/** One packaged Durable Object owns the page, API, persistence, and live value. */
export class TodoApp extends IterateDurableObject {
  static db = defineConfig({
    definitions: sql`
      create table todos (
        id text primary key,
        title text not null,
        done integer not null default 0,
        created_at text not null
      );
    `,
    migrations: [
      {
        name: "20260718000001_create_todos",
        content: sql`
          create table if not exists todos (
            id text primary key,
            title text not null,
            done integer not null default 0,
            created_at text not null
          );
        `,
      },
    ],
    queries: {
      list: sql.many<{
        result: { created_at: string; done: number; id: string; title: string };
      }>`
        select id, title, done, created_at from todos order by created_at asc, id asc
      `,
      insert: sql.run<{ parameters: { createdAt: string; id: string; title: string } }>`
        insert into todos (id, title, done, created_at) values (:id, :title, 0, :createdAt)
      `,
      setDone: sql.run<{ parameters: { done: number; id: string } }>`
        update todos set done = :done where id = :id
      `,
      remove: sql.run<{ parameters: { id: string } }>`
        delete from todos where id = :id
      `,
    },
  });

  readonly #db: ReturnType<typeof TodoApp.db<ReturnType<typeof createDurableObjectClient>>>;
  readonly #live: LiveState<TodoListState>;

  constructor(...args: ConstructorParameters<typeof IterateDurableObject>) {
    super(...args);
    this.#db = TodoApp.db(createDurableObjectClient({ sql: this.ctx.storage.sql }));
    this.#db.migrate();
    this.#live = new LiveState<TodoListState>({ todos: this.#load() });
  }

  #load(): Todo[] {
    return this.#db.list().map((row) => ({
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
    this.#db.insert({
      createdAt: new Date().toISOString(),
      id: crypto.randomUUID(),
      title: trimmed,
    });
    this.#refresh();
  }

  setDone(id: string, done: boolean): void {
    this.#db.setDone({ done: done ? 1 : 0, id });
    this.#refresh();
  }

  remove(id: string): void {
    this.#db.remove({ id });
    this.#refresh();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api") {
      return newWorkersWebSocketRpcResponse(request, new TodoApi(this, this.#live));
    }
    if (request.method === "GET" && url.pathname === "/apps/todo/client.js") {
      return new Response(todoClientSource, {
        headers: {
          "content-type": "application/javascript; charset=utf-8",
          "x-content-type-options": "nosniff",
        },
      });
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

export class TodoApi extends RpcTarget {
  readonly #app: TodoApp;
  readonly #liveState: LiveStateRpcTarget<TodoListState>;

  constructor(app: TodoApp, live: LiveState<TodoListState>) {
    super();
    this.#app = app;
    this.#liveState = new LiveStateRpcTarget(live);
  }

  get liveState(): LiveStateRpc<TodoListState> {
    return this.#liveState;
  }

  async add(title: string): Promise<void> {
    this.#app.add(title);
  }

  async setDone(id: string, done: boolean): Promise<void> {
    this.#app.setDone(id, done);
  }

  async remove(id: string): Promise<void> {
    this.#app.remove(id);
  }
}
