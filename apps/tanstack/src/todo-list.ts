import { DurableObject } from "cloudflare:workers";
import { RpcTarget, newWorkersRpcResponse } from "capnweb";
import { LiveState, LiveStateRpcTarget } from "iterate/sdk/capnweb";
import { createDurableObjectClient, defineConfig, sql } from "sqlfu";
import type { Todo, TodoListApi, TodoListState } from "./state.ts";

/**
 * One todo list = one Durable Object, named by the list slug in the URL.
 * The rows live in the DO's embedded SQLite through sqlfu (schema, migration,
 * and typed queries all in the `db` config below); the in-memory `LiveState`
 * mirrors them and fans every change out to all connected browsers as
 * snapshot + patches. Multiplayer needs nothing else: every session mutates
 * SQLite, refreshes the one LiveState, and Cap'n Web pushes the diff.
 */
export class TodoListDurableObject extends DurableObject<unknown> {
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

  readonly #db: ReturnType<
    typeof TodoListDurableObject.db<ReturnType<typeof createDurableObjectClient>>
  >;
  readonly #live: LiveState<TodoListState>;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    // {sql} without transactionSync: the constructor is await-free and DO
    // SQLite commits one event-loop task atomically, so the single migration
    // cannot persist half-applied (same reasoning as SqliteSubscriptionCursorStore
    // in apps/os stream-storage.ts).
    this.#db = TodoListDurableObject.db(createDurableObjectClient({ sql: ctx.storage.sql }));
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

  add(title: string): void {
    const trimmed = title.trim().slice(0, 500);
    if (trimmed.length === 0) return;
    this.#db.insert({
      id: crypto.randomUUID(),
      title: trimmed,
      createdAt: new Date().toISOString(),
    });
    this.#refresh();
  }

  setDone(id: string, done: boolean): void {
    this.#db.setDone({ id, done: done ? 1 : 0 });
    this.#refresh();
  }

  rename(id: string, title: string): void {
    const trimmed = title.trim().slice(0, 500);
    if (trimmed.length === 0) return;
    this.#db.rename({ id, title: trimmed });
    this.#refresh();
  }

  remove(id: string): void {
    this.#db.remove({ id });
    this.#refresh();
  }

  liveState(): LiveStateRpcTarget<TodoListState> {
    return new LiveStateRpcTarget(this.#live);
  }

  /** WebSocket upgrades terminate here: each connection gets its own session capability. */
  override fetch(request: Request): Response | Promise<Response> {
    return newWorkersRpcResponse(request, new TodoListSession(this));
  }
}

/**
 * What one connected browser holds. A thin attenuation over the object: the
 * live state is read-only by construction, and the verbs are the whole write
 * surface — no storage, no other lists, nothing ambient.
 */
class TodoListSession extends RpcTarget implements TodoListApi {
  constructor(private readonly list: TodoListDurableObject) {
    super();
  }

  get liveState(): LiveStateRpcTarget<TodoListState> {
    return this.list.liveState();
  }

  async add(title: string): Promise<void> {
    this.list.add(title);
  }

  async setDone(id: string, done: boolean): Promise<void> {
    this.list.setDone(id, done);
  }

  async rename(id: string, title: string): Promise<void> {
    this.list.rename(id, title);
  }

  async remove(id: string): Promise<void> {
    this.list.remove(id);
  }
}
