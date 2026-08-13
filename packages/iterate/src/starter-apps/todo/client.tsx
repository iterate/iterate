/**
 * Todo UI — one reconnectable Cap'n Web provider, consumed by useLiveState.
 * @jsxImportSource react
 */
import React, { type FormEvent, useState } from "react";
import { createRoot } from "react-dom/client";
import { newWebSocketRpcSession, type RpcStub } from "../../sdk/capnweb/index.ts";
import { CapnWebProvider, useCapnWebRoot, useLiveState } from "../../sdk/capnweb/react.tsx";
import type { TodoApi } from "./worker.ts";

function makeConnection() {
  const endpoint = new URL("/api", window.location.href);
  endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
  return newWebSocketRpcSession<TodoApi>(endpoint.toString());
}

export function TodoClient() {
  const api = useCapnWebRoot<RpcStub<TodoApi>>();
  const { value: state, error: liveError } = useLiveState(
    (session: RpcStub<TodoApi>) => session.liveState,
    (value) => value,
  );
  const [title, setTitle] = useState("");
  const [actionError, setActionError] = useState("");
  const [pendingMutations, setPendingMutations] = useState(0);
  const mutating = pendingMutations > 0;

  const error = liveError || (actionError.length ? actionError : undefined);
  const todos = state?.todos || [];

  const run = async (action: () => Promise<void>) => {
    setActionError("");
    setPendingMutations((current) => current + 1);
    try {
      await action();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPendingMutations((current) => current - 1);
    }
  };

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (!api || !title.trim().length) return;
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
        <button disabled={!api || mutating} type="submit">
          Add
        </button>
      </form>
      {mutating && (
        <p aria-live="polite" data-spinner="true" role="status">
          Saving…
        </p>
      )}
      {!!error && <p role="alert">{error}</p>}
      {!state ? (
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
                disabled={mutating}
                onChange={(event) => {
                  const done = event.currentTarget.checked;
                  if (!api) return;
                  void run(() => api.setDone(todo.id, done));
                }}
                type="checkbox"
              />
              <span className={todo.done ? "done" : ""}>{todo.title}</span>
              <button
                disabled={mutating}
                onClick={() => {
                  if (!api) return;
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
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <CapnWebProvider makeConnection={makeConnection}>
    <TodoClient />
  </CapnWebProvider>,
);
