/**
 * Todo UI — one reconnectable Cap'n Web provider, consumed by useLiveState.
 */
import { newWebSocketRpcSession, type RpcStub } from "@iterate-com/capnweb";
import React, { type FormEvent, useState } from "react";
import { createRoot } from "react-dom/client";
import type { LiveStateRpc } from "iterate/live-state";
import { CapnWebProvider, useCapnWebRoot, useLiveState } from "iterate/live-state/react";

type TodoApi = {
  liveState: LiveStateRpc<{
    todos: Array<{ createdAt: string; done: boolean; id: string; title: string }>;
  }>;
  add(title: string): Promise<void>;
  setDone(id: string, done: boolean): Promise<void>;
  remove(id: string): Promise<void>;
};

function makeConnection() {
  const endpoint = new URL("/api", window.location.href);
  endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
  return newWebSocketRpcSession<TodoApi>(endpoint.toString());
}

export function TodoClient() {
  const api = useCapnWebRoot<RpcStub<TodoApi>>();
  const { value: state, error: liveError } = useLiveState(
    (session: RpcStub<TodoApi>) => session.liveState,
    (s) => s,
  );
  const [title, setTitle] = useState("");
  const [actionError, setActionError] = useState("");

  const error = liveError ?? (actionError.length > 0 ? actionError : undefined);
  const todos = state?.todos ?? [];

  const run = async (action: () => Promise<void>) => {
    setActionError("");
    try {
      await action();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (api == null || title.trim().length === 0) return;
    const next = title;
    setTitle("");
    await run(() => api.add(next));
  };

  return (
    <>
      <h1>Todo</h1>
      <form onSubmit={add}>
        <input
          aria-label="New todo"
          id="new-todo"
          maxLength={200}
          onChange={(event) => setTitle(event.currentTarget.value)}
          placeholder="What needs doing?"
          required
          type="text"
          value={title}
        />
        <button disabled={api == null} type="submit">
          Add
        </button>
      </form>
      {error !== undefined && <p role="alert">{error}</p>}
      {state === undefined ? (
        <p>Loading…</p>
      ) : todos.length === 0 ? (
        <p>No todos yet.</p>
      ) : (
        <ul>
          {todos.map((todo) => (
            <li key={todo.id}>
              <input
                aria-label={`Mark ${todo.title} ${todo.done ? "not done" : "done"}`}
                checked={todo.done}
                onChange={(event) => {
                  const done = event.currentTarget.checked;
                  if (api == null) return;
                  void run(() => api.setDone(todo.id, done));
                }}
                type="checkbox"
              />
              <span className={todo.done ? "done" : ""}>{todo.title}</span>
              <button
                onClick={() => {
                  if (api == null) return;
                  void run(() => api.remove(todo.id));
                }}
                type="button"
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("missing #root");
createRoot(root).render(
  <CapnWebProvider makeConnection={makeConnection}>
    <TodoClient />
  </CapnWebProvider>,
);
