import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTodoList } from "../lib/use-todo-list.ts";
import { normalizeListSlug } from "../state.ts";

export const Route = createFileRoute("/l/$slug")({ component: TodoListPage });

function TodoListPage() {
  // A hand-typed URL ("/l/MyList") normalizes to the same list the home form
  // would open; only a slug with nothing salvageable dead-ends.
  const slug = normalizeListSlug(Route.useParams().slug);
  if (!slug) {
    return (
      <main>
        <p>Not a usable list name.</p>
        <p>
          <Link to="/">← lists</Link>
        </p>
      </main>
    );
  }
  return <TodoList slug={slug} />;
}

function TodoList({ slug }: { slug: string }) {
  const { todos, api } = useTodoList(slug);
  const [draft, setDraft] = useState("");

  return (
    <main>
      <p>
        <Link to="/">← lists</Link>
      </p>
      <h1>{slug}</h1>
      {todos ? (
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
      ) : (
        <p>connecting…</p>
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
          disabled={!api}
        />
        <button type="submit" disabled={!api}>
          add
        </button>
      </form>
    </main>
  );
}
