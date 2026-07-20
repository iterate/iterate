import { RpcTarget, newWorkersWebSocketRpcResponse } from "@iterate-com/capnweb";
import { LiveState, LiveStateRpcTarget, type LiveStateRpc } from "iterate/live-state";
import { IterateDurableObject, type ProjectAuthCredentials } from "iterate/sdk";
import { createDurableObjectClient, defineConfig, sql } from "sqlfu";
import type { Todo, TodoListState } from "./lib/state.ts";

// The small, stateful half of the todo app. It has its own worker entry so
// a cold /api WebSocket loads only the Durable Object and its data/runtime
// dependencies, never the unrelated React page bundle.
export class TanstackTodos extends IterateDurableObject {
  static db = defineConfig({
    // The desired schema now (`sqlfu draft` diffs new migrations against it).
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
      list: sql.many<{ result: { id: string; title: string; done: number; created_at: string } }>`
        select id, title, done, created_at from todos order by created_at asc, id asc
      `,
      insert: sql.run<{ parameters: { id: string; title: string; createdAt: string } }>`
        insert into todos (id, title, done, created_at) values (:id, :title, 0, :createdAt)
      `,
      setDone: sql.run<{ parameters: { id: string; done: number } }>`
        update todos set done = :done where id = :id
      `,
      rename: sql.run<{ parameters: { id: string; title: string } }>`
        update todos set title = :title where id = :id
      `,
      remove: sql.run<{ parameters: { id: string } }>`
        delete from todos where id = :id
      `,
    },
  });

  // {sql} without transactionSync: initialization is await-free and Durable
  // Object SQLite commits one event-loop task atomically, so the single
  // migration cannot persist half-applied.
  readonly #db = TanstackTodos.db(createDurableObjectClient({ sql: this.ctx.storage.sql }));
  readonly #live: LiveState<TodoListState>;

  constructor(...args: ConstructorParameters<typeof IterateDurableObject>) {
    super(...args);
    this.#db.migrate();
    this.#live = new LiveState<TodoListState>({ todos: this.#load() });
  }

  #load(): Todo[] {
    return this.#db.list().map((row) => ({
      id: row.id,
      title: row.title,
      done: row.done !== 0,
      createdAt: row.created_at,
    }));
  }

  #refresh(): void {
    this.#live.setState({ todos: this.#load() });
  }

  addTodo(title: string): string | undefined {
    const trimmed = title.trim().slice(0, 500);
    if (trimmed.length === 0) return;
    const id = crypto.randomUUID();
    this.#db.insert({
      id,
      title: trimmed,
      createdAt: new Date().toISOString(),
    });
    this.#refresh();
    return id;
  }

  setTodoDone(id: string, done: boolean): void {
    this.#db.setDone({ id, done: done ? 1 : 0 });
    this.#refresh();
  }

  renameTodo(id: string, title: string): void {
    const trimmed = title.trim().slice(0, 500);
    if (trimmed.length === 0) return;
    this.#db.rename({ id, title: trimmed });
    this.#refresh();
  }

  removeTodo(id: string): void {
    this.#db.remove({ id });
    this.#refresh();
  }

  liveStateTarget(): LiveStateRpcTarget<TodoListState> {
    return new LiveStateRpcTarget(this.#live);
  }

  /** The Cap'n Web door: every /api WebSocket upgrade terminates here. */
  async fetch(request: Request): Promise<Response> {
    return newWorkersWebSocketRpcResponse(request, new PublicTodoApi(this, request));
  }
}

// The unauthenticated Cap'n Web root: exactly the internal app's pattern —
// the browser exchanges this app's exact-origin cookie in-band and gets an
// attenuated session capability, never the project itx.
class PublicTodoApi extends RpcTarget {
  constructor(
    private readonly app: TanstackTodos,
    private readonly request: Request,
  ) {
    super();
  }

  async authenticate(credentials: ProjectAuthCredentials): Promise<TodoSession> {
    using itx = await this.app.env.ITX.get();
    await itx.auth.get({ policy: "project-member" }).authenticate(this.request, credentials);
    return new TodoSession(this.app);
  }
}

// The authority an authenticated browser holds: the live list (read-only by
// construction) and four verbs. Every mutation refreshes the one LiveState,
// so every open tab repaints from the pushed patch — that IS the multiplayer.
class TodoSession extends RpcTarget {
  constructor(private readonly app: TanstackTodos) {
    super();
  }

  get liveState(): LiveStateRpc<TodoListState> {
    return this.app.liveStateTarget();
  }

  async add(title: string): Promise<string | undefined> {
    return this.app.addTodo(title);
  }

  async setDone(id: string, done: boolean): Promise<void> {
    this.app.setTodoDone(id, done);
  }

  async rename(id: string, title: string): Promise<void> {
    this.app.renameTodo(id, title);
  }

  async remove(id: string): Promise<void> {
    this.app.removeTodo(id);
  }
}
