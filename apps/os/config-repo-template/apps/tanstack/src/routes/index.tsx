import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useTodos } from "../lib/use-todos.ts";

export const Route = createFileRoute("/")({ component: Todos });

// The project's shared todo list. Rows live in the app's Durable Object
// SQLite (src/worker.ts); this page hydrates, authenticates /api from the
// app cookie, and stays live — every project member's tab converges.
function Todos() {
  const { todos, api, error } = useTodos();
  const [draft, setDraft] = useState("");

  return (
    <main>
      <h1>TanStack todos</h1>
      {error !== null ? <p>{error}</p> : null}
      {todos === undefined ? (
        <p>connecting…</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0 }}>
          {todos.map((todo) => (
            <li key={todo.id} style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              <input
                type="checkbox"
                checked={todo.done}
                onChange={(event) => void api?.setDone(todo.id, event.target.checked)}
                aria-label={`done: ${todo.title}`}
              />
              <span
                style={{ flex: 1, textDecoration: todo.done ? "line-through" : "none" }}
                title="double-click to rename"
                onDoubleClick={() => {
                  const title = window.prompt("rename todo", todo.title);
                  if (title) void api?.rename(todo.id, title);
                }}
              >
                {todo.title}
              </span>
              <button
                type="button"
                onClick={() => void api?.remove(todo.id)}
                aria-label={`delete: ${todo.title}`}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (api && draft.trim()) {
            void api.add(draft);
            setDraft("");
          }
        }}
      >
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="add a todo"
          aria-label="add a todo"
          disabled={api === null}
        />
        <button type="submit" disabled={api === null}>
          add
        </button>
      </form>
      <form action="/_iterate/auth/logout" method="post">
        <button>Sign out</button>
      </form>
    </main>
  );
}
