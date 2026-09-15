/** @jsxImportSource react */
import React, { type FormEvent, useState } from "react";
import { createRoot } from "react-dom/client";
import { newWebSocketRpcSession, type RpcStub } from "../../sdk/capnweb/index.ts";
import { CapnWebProvider, useCapnWebRoot, useLiveState } from "../../sdk/capnweb/react.tsx";
import type { TodoApi } from "./worker.ts";

type PendingOperation =
  | { type: "add"; id: string; title: string }
  | { type: "setDone"; id: string; done: boolean }
  | { type: "remove"; id: string };

export function TodoClient() {
  const api = useCapnWebRoot<RpcStub<TodoApi>>();
  const { value: state, error: liveError } = useLiveState(
    (session: RpcStub<TodoApi>) => session.liveState,
    (value) => value,
  );
  const [title, setTitle] = useState("");
  const [actionError, setActionError] = useState("");
  const [pending, setPending] = useState<PendingOperation[]>([]);
  const remaining = state
    ? pending.filter((operation) => {
        const todo = state.todos.find((todo) => todo.id === operation.id);
        switch (operation.type) {
          case "add":
            return !todo;
          case "setDone":
            return !!todo && todo.done !== operation.done;
          case "remove":
            return !!todo;
        }
      })
    : pending;
  // Retire confirmed operations permanently, so a later remote edit or
  // deletion cannot resurrect an optimistic row or restart its spinner.
  if (remaining.length !== pending.length) setPending(remaining);

  const error = liveError || (actionError.length > 0 ? actionError : undefined);
  const todos = [
    ...(state?.todos || []),
    ...remaining
      .filter((operation) => operation.type === "add")
      .map(({ id, title }) => ({ id, title, done: false })),
  ];

  const run = async (operation: PendingOperation) => {
    if (api === undefined) return;
    setActionError("");
    setPending((current) => [...current, operation]);
    try {
      switch (operation.type) {
        case "add":
          await api.add(operation.title, operation.id);
          break;
        case "setDone":
          await api.setDone(operation.id, operation.done);
          break;
        case "remove":
          await api.remove(operation.id);
          break;
      }
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
      // A late rejection must not clear a newer operation on the same row.
      setPending((current) => current.filter((entry) => entry !== operation));
    }
  };

  const add = (event: FormEvent) => {
    event.preventDefault();
    if (api === undefined || title.trim().length === 0) return;
    const next = title.trim().slice(0, 200);
    const id = crypto.randomUUID();
    setTitle("");
    void run({ type: "add", id, title: next });
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
        <button disabled={api === undefined} type="submit">
          Add
        </button>
      </form>
      {remaining.length > 0 && (
        <p aria-live="polite" data-spinner="true" role="status">
          Saving…
        </p>
      )}
      {error && (
        <p role="alert" data-type="error">
          {error}
        </p>
      )}
      {!state ? (
        <p data-spinner="true">Loading…</p>
      ) : todos.length === 0 ? (
        <p>No todos yet.</p>
      ) : (
        <ul>
          {todos.map((todo) => {
            const operation = remaining.find((operation) => operation.id === todo.id);
            return (
              <li key={todo.id} data-spinner={operation ? "true" : undefined}>
                <input
                  aria-label={`Mark ${todo.title} ${todo.done ? "not done" : "done"}`}
                  checked={todo.done}
                  disabled={api === undefined || !!operation}
                  onChange={(event) => {
                    const done = event.currentTarget.checked;
                    void run({ type: "setDone", id: todo.id, done });
                  }}
                  type="checkbox"
                />
                <span className={todo.done ? "done" : ""}>{todo.title}</span>
                <button
                  disabled={api === undefined || !!operation}
                  onClick={() => {
                    void run({ type: "remove", id: todo.id });
                  }}
                  type="button"
                >
                  {operation?.type === "remove" ? "Deleting…" : "Delete"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function makeConnection() {
  const endpoint = new URL("/api", window.location.href);
  endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
  return newWebSocketRpcSession<TodoApi>(endpoint.toString());
}

const root = document.getElementById("root");
if (root === null) throw new Error("missing #root");
createRoot(root).render(
  <CapnWebProvider makeConnection={makeConnection}>
    <TodoClient />
  </CapnWebProvider>,
);
