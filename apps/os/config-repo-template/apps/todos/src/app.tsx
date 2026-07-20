import { useEffect, useState } from "react";
import { useTodos } from "./lib/use-todos.ts";

// The project's shared todo list. Rows live in the app's Durable Object
// SQLite (src/todos-app.ts); this page hydrates, authenticates /api from the
// app cookie, and stays live — every project member's tab converges.
export function Todos() {
  const { todos, api, error } = useTodos();
  const [draft, setDraft] = useState("");
  const [pendingAdd, setPendingAdd] = useState<{
    acceptNewMatchingTodo: boolean;
    existingTodoIds: readonly string[];
    id: string | null;
    title: string;
  } | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const remaining = todos?.filter((todo) => !todo.done).length ?? 0;
  const visibleError = error ?? mutationError;

  useEffect(() => {
    if (pendingAdd === null || todos === undefined) return;
    const observed =
      (pendingAdd.id !== null && todos.some((todo) => todo.id === pendingAdd.id)) ||
      (pendingAdd.acceptNewMatchingTodo &&
        todos.some(
          (todo) =>
            todo.title === pendingAdd.title && !pendingAdd.existingTodoIds.includes(todo.id),
        ));
    if (observed) {
      setPendingAdd(null);
      setMutationError(null);
    }
  }, [pendingAdd, todos]);

  useEffect(() => {
    if (pendingAdd === null) return;
    const timeout = window.setTimeout(() => {
      setMutationError("Adding this todo is taking too long. Reload before retrying.");
    }, 15_000);
    return () => window.clearTimeout(timeout);
  }, [pendingAdd]);

  return (
    <main style={styles.main}>
      <header style={styles.header}>
        <h1 style={styles.h1}>Todos</h1>
        <form action="/_iterate/auth/logout" method="post">
          <button style={styles.linkButton}>Sign out</button>
        </form>
      </header>
      <p style={styles.meta} aria-live="polite">
        {todos === undefined
          ? "connecting…"
          : todos.length === 0
            ? "the project's shared list — every member sees the same todos, live"
            : remaining === 0
              ? "all done"
              : `${remaining} of ${todos.length} left`}
      </p>

      {visibleError !== null ? (
        <p style={styles.error} data-type="error">
          {visibleError}
        </p>
      ) : null}

      <form
        style={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          const title = draft.trim().slice(0, 500);
          if (api === null || todos === undefined || title === "" || pendingAdd !== null) return;
          setMutationError(null);
          setPendingAdd({
            acceptNewMatchingTodo: false,
            existingTodoIds: todos.map((todo) => todo.id),
            id: null,
            title,
          });
          setDraft("");
          void api
            .add(title)
            .then((id) => {
              setPendingAdd((current) =>
                current === null
                  ? null
                  : id === undefined
                    ? { ...current, acceptNewMatchingTodo: true }
                    : { ...current, id },
              );
            })
            .catch((thrown: unknown) => {
              const message = thrown instanceof Error ? thrown.message : String(thrown);
              setMutationError(`${message} Reload before retrying.`);
            });
        }}
      >
        <input
          style={styles.input}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="add a todo"
          aria-label="add a todo"
          disabled={api === null || todos === undefined || pendingAdd !== null}
        />
        <button
          type="submit"
          style={styles.button}
          disabled={
            api === null || todos === undefined || draft.trim() === "" || pendingAdd !== null
          }
        >
          add
        </button>
      </form>

      {pendingAdd !== null && mutationError === null ? (
        <p style={styles.hint} data-spinner="true" aria-live="polite">
          adding “{pendingAdd.title}”…
        </p>
      ) : null}

      {todos !== undefined && todos.length > 0 ? (
        <ul style={styles.list}>
          {todos.map((todo) => (
            <li key={todo.id} style={styles.item}>
              <input
                type="checkbox"
                checked={todo.done}
                onChange={(event) => void api?.setDone(todo.id, event.target.checked)}
                aria-label={`done: ${todo.title}`}
              />
              <span
                style={{
                  ...styles.title,
                  ...(todo.done ? { color: "#94a3b8", textDecoration: "line-through" } : {}),
                }}
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
                style={styles.delete}
                onClick={() => void api?.remove(todo.id)}
                aria-label={`delete: ${todo.title}`}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </main>
  );
}

const styles = {
  main: {
    fontFamily: "system-ui, sans-serif",
    maxWidth: 560,
    margin: "0 auto",
    padding: "48px 16px",
  },
  header: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16 },
  h1: { fontSize: 28, margin: 0 },
  linkButton: {
    border: 0,
    background: "transparent",
    color: "#94a3b8",
    fontSize: 14,
    cursor: "pointer",
  },
  meta: { marginTop: 4, fontSize: 14, color: "#64748b" },
  error: {
    marginTop: 24,
    padding: "12px 16px",
    border: "1px solid #fecaca",
    background: "#fef2f2",
    color: "#b91c1c",
    borderRadius: 8,
    fontSize: 14,
  },
  form: { marginTop: 32, display: "flex", gap: 12 },
  input: {
    flex: 1,
    border: "1px solid #e2e8f0",
    borderRadius: 8,
    padding: "8px 12px",
    fontSize: 14,
  },
  button: {
    border: 0,
    borderRadius: 8,
    padding: "8px 16px",
    background: "#4f46e5",
    color: "#fff",
    fontSize: 14,
    fontWeight: 500,
    cursor: "pointer",
  },
  hint: { marginTop: 8, fontSize: 14, color: "#64748b" },
  list: {
    marginTop: 16,
    padding: 0,
    listStyle: "none",
    border: "1px solid #e2e8f0",
    borderRadius: 16,
    background: "#fff",
    overflow: "hidden",
  },
  item: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "12px 16px",
    borderTop: "1px solid #f1f5f9",
  },
  title: { flex: 1, minWidth: 0, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis" },
  delete: {
    border: 0,
    background: "transparent",
    color: "#cbd5e1",
    cursor: "pointer",
  },
} as const;
