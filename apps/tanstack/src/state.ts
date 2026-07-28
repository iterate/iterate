import type { LiveStateRpc } from "iterate/sdk/capnweb";

/** One todo row, exactly as the Durable Object's SQLite stores it. */
export type Todo = {
  id: string;
  title: string;
  done: boolean;
  createdAt: string;
};

/** The whole list — the live-state value every connected browser mirrors. */
export type TodoListState = { todos: Todo[] };

/**
 * The Cap'n Web capability a browser holds after connecting to a list's
 * Durable Object: the read side is live state (snapshot + patches), the write
 * side is plain imperative verbs. Shared by the server session (todo-list.ts)
 * and the client hook (lib/use-todo-list.ts) so the wire contract is one type.
 */
export type TodoListApi = {
  liveState: LiveStateRpc<TodoListState>;
  add(title: string): Promise<void>;
  setDone(id: string, done: boolean): Promise<void>;
  rename(id: string, title: string): Promise<void>;
  remove(id: string): Promise<void>;
};

/**
 * One slug grammar for everything: the home form, the /l/$slug page, and the
 * worker's /api/lists/<slug> route all normalize with this, so a URL typed by
 * hand ("/l/MyList") reaches the same Durable Object the form navigation
 * would have.
 */
export function normalizeListSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 64);
}
