import type { LiveStateRpc } from "iterate/live-state";

/** One todo row, exactly as the Durable Object's SQLite stores it. */
export type Todo = { id: string; title: string; done: boolean; createdAt: string };

/** The whole list — the live-state value every connected browser mirrors. */
export type TodoListState = { todos: Todo[] };

/** What the browser holds after authenticating the /api Cap'n Web session. */
export type TodoSessionApi = {
  liveState: LiveStateRpc<TodoListState>;
  add(title: string): Promise<void>;
  setDone(id: string, done: boolean): Promise<void>;
  rename(id: string, title: string): Promise<void>;
  remove(id: string): Promise<void>;
};
