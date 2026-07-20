import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTodos } from "../lib/use-todos.ts";

export const Route = createFileRoute("/")({ component: Todos });

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
      // The RPC cannot be cancelled. Keep the composer locked so a late
      // success cannot leave a stale error or allow a duplicate submission.
      setMutationError("Adding this todo is taking too long. Reload before retrying.");
    }, 15_000);
    return () => window.clearTimeout(timeout);
  }, [pendingAdd]);

  return (
    <main className="mx-auto max-w-xl px-4 py-12">
      <header className="flex items-baseline justify-between gap-4">
        <h1 className="text-3xl font-semibold tracking-tight">TanStack todos</h1>
        <form action="/_iterate/auth/logout" method="post">
          <button className="text-sm text-slate-400 transition hover:text-slate-600">
            Sign out
          </button>
        </form>
      </header>
      <p className="mt-1 text-sm text-slate-500" aria-live="polite">
        {todos === undefined
          ? "connecting…"
          : todos.length === 0
            ? "the project's shared list — every member sees the same todos, live"
            : remaining === 0
              ? "all done"
              : `${remaining} of ${todos.length} left`}
      </p>

      {visibleError !== null ? (
        <p
          className="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
          data-type="error"
        >
          {visibleError}
        </p>
      ) : null}

      <form
        className="mt-8 flex gap-3"
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
              // The pre-return-id API can answer briefly while its
              // stale-while-rebuild facet swaps. Its void response still
              // confirms success; identify that call by the first new
              // equal-title live-state row instead of inviting a duplicate.
              setPendingAdd((current) =>
                current === null
                  ? null
                  : id === undefined
                    ? { ...current, acceptNewMatchingTodo: true }
                    : { ...current, id },
              );
            })
            .catch((thrown: unknown) => {
              // A transport rejection can lose a successful call's ack. Keep
              // the composer locked until live state confirms the row (or a
              // reload proves otherwise), so retry cannot duplicate it.
              const message = thrown instanceof Error ? thrown.message : String(thrown);
              setMutationError(`${message} Reload before retrying.`);
            });
        }}
      >
        <input
          className="flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm shadow-sm outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="add a todo"
          aria-label="add a todo"
          disabled={api === null || todos === undefined || pendingAdd !== null}
        />
        <button
          type="submit"
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
          disabled={
            api === null || todos === undefined || draft.trim() === "" || pendingAdd !== null
          }
        >
          add
        </button>
      </form>

      {pendingAdd !== null && mutationError === null ? (
        <p className="mt-2 text-sm text-slate-500" data-spinner="true" aria-live="polite">
          adding “{pendingAdd.title}”…
        </p>
      ) : null}

      {todos !== undefined && todos.length > 0 ? (
        <ul className="mt-4 divide-y divide-slate-100 rounded-2xl border border-slate-200 bg-white shadow-sm">
          {todos.map((todo) => (
            <li key={todo.id} className="group flex items-center gap-3 px-4 py-3">
              <input
                type="checkbox"
                className="size-4 shrink-0 accent-indigo-600"
                checked={todo.done}
                onChange={(event) => void api?.setDone(todo.id, event.target.checked)}
                aria-label={`done: ${todo.title}`}
              />
              <span
                className={`min-w-0 flex-1 truncate text-sm transition ${
                  todo.done ? "text-slate-400 line-through" : ""
                }`}
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
                className="shrink-0 text-slate-300 transition hover:text-red-500"
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
