// Stateful todo host: SQLite rows projected into LiveState, Cap'n Web to the
// browser. createWorker so platform virtual modules inject iterate/live-state
// and capnweb. Mutations refresh live state; every open tab repaints via
// useLiveStateRpc (same hook shape as the guestbook).
import { RpcTarget, newWorkersWebSocketRpcResponse } from "@iterate-com/capnweb";
import { LiveState, LiveStateRpcTarget, type LiveStateRpc } from "iterate/live-state";
import { IterateDurableObject } from "iterate/sdk";

export type Todo = {
  createdAt: string;
  done: boolean;
  id: string;
  title: string;
};

export type TodoListState = { todos: Todo[] };

export type TodoApi = {
  liveState: LiveStateRpc<TodoListState>;
  add(title: string): Promise<void>;
  setDone(id: string, done: boolean): Promise<void>;
  remove(id: string): Promise<void>;
};

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
    return newWorkersWebSocketRpcResponse(request, new PublicTodoApi(this, this.#live));
  }
}

class PublicTodoApi extends RpcTarget implements TodoApi {
  // Cached for the session — see guestbook host: fresh stubs thrash clients.
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
