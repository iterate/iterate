import React, {
  type FormEvent,
  useCallback,
  useEffect,
  useState,
} from "https://esm.sh/react@19.2.4";
import { createRoot } from "https://esm.sh/react-dom@19.2.4/client";

type Todo = {
  createdAt: string;
  done: boolean;
  id: string;
  title: string;
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok)
    throw new Error((await response.text()) || `request failed (${response.status})`);
  return (response.status === 204 ? undefined : await response.json()) as T;
}

export function TodoClient() {
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [title, setTitle] = useState("");
  const [todos, setTodos] = useState<Todo[]>([]);

  const load = useCallback(async () => {
    try {
      setTodos(await api<Todo[]>("/api/todos"));
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const mutate = async (mutation: () => Promise<unknown>) => {
    setMutating(true);
    try {
      await mutation();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMutating(false);
    }
  };

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (title.trim().length === 0) return;
    await mutate(async () => {
      await api<Todo>("/api/todos", {
        body: JSON.stringify({ title }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      setTitle("");
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
        <button disabled={mutating} type="submit">
          Add
        </button>
      </form>
      {mutating && (
        <p aria-live="polite" data-spinner="true" role="status">
          Saving…
        </p>
      )}
      {error.length > 0 && <p role="alert">{error}</p>}
      {loading ? (
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
                  void mutate(async () => {
                    await api<void>(`/api/todos/${encodeURIComponent(todo.id)}`, {
                      body: JSON.stringify({ done }),
                      headers: { "content-type": "application/json" },
                      method: "PATCH",
                    });
                  });
                }}
                type="checkbox"
              />
              <span className={todo.done ? "done" : ""}>{todo.title}</span>
              <button
                onClick={() => {
                  void mutate(async () => {
                    await api<void>(`/api/todos/${encodeURIComponent(todo.id)}`, {
                      method: "DELETE",
                    });
                  });
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
createRoot(root).render(<TodoClient />);
