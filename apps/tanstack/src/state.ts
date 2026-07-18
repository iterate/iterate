import type { LiveStateRpc } from "iterate/live-state";

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
