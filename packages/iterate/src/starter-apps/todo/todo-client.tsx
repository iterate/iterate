/** @jsxImportSource react */
import React, { type FormEvent, useState } from "react";
import type { RpcStub } from "../../sdk/capnweb/index.ts";
import { useCapnWebRoot, useLiveState } from "../../sdk/capnweb/react.tsx";
import type { TodoApi } from "./worker.ts";

export function TodoClient() {
  const api = useCapnWebRoot<RpcStub<TodoApi>>();
  const { value: state, error: liveError } = useLiveState(
    (session: RpcStub<TodoApi>) => session.liveState,
    (value) => value,
  );
  const [title, setTitle] = useState("");
  const [actionError, setActionError] = useState("");
  const [pending, setPending] = useState<{
    count: number;
    added: { id: string; title: string } | null;
  }>({ count: 0, added: null });
  const confirmed = pending.added && state?.todos.some((todo) => todo.id === pending.added!.id);
  // Retire the optimistic item permanently when this browser receives it.
  // A later deletion by another client must not resurrect the local draft.
  if (confirmed) setPending({ ...pending, added: null });
  const optimistic = confirmed ? null : pending.added;
  const mutating = pending.count > 0 || !!optimistic;

  const error = liveError || (actionError.length > 0 ? actionError : undefined);
  const todos = [
    ...(state?.todos || []),
    ...(optimistic ? [{ ...optimistic, id: "pending-add", done: false }] : []),
  ];

  const run = async (action: () => Promise<void>) => {
    setActionError("");
    setPending((current) => ({ ...current, count: current.count + 1 }));
    try {
      await action();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
      setPending((current) => ({ ...current, added: null }));
    } finally {
      setPending((current) => ({ ...current, count: current.count - 1 }));
    }
  };

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (api === undefined || title.trim().length === 0) return;
    const next = title.trim().slice(0, 200);
    const id = crypto.randomUUID();
    setTitle("");
    setPending((current) => ({ ...current, added: { id, title: next } }));
    await run(async () => {
      await api.add(next, id);
    });
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
        <button disabled={api === undefined || mutating} type="submit">
          Add
        </button>
      </form>
      {mutating && (
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
          {todos.map((todo) => (
            <li key={todo.id} data-spinner={todo.id === "pending-add" ? "true" : undefined}>
              <input
                aria-label={`Mark ${todo.title} ${todo.done ? "not done" : "done"}`}
                checked={todo.done}
                disabled={mutating}
                onChange={(event) => {
                  const done = event.currentTarget.checked;
                  if (api === undefined) return;
                  void run(() => api.setDone(todo.id, done));
                }}
                type="checkbox"
              />
              <span className={todo.done ? "done" : ""}>{todo.title}</span>
              <button
                disabled={mutating}
                onClick={() => {
                  if (api === undefined) return;
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
