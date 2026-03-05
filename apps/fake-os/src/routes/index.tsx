import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { orpc } from "@/lib/orpc.ts";
import { useState } from "react";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");

  const todosQuery = useQuery(orpc.todos.list.queryOptions());
  const createMutation = useMutation(
    orpc.todos.create.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: orpc.todos.list.key() });
        setTitle("");
      },
    }),
  );
  const toggleMutation = useMutation(
    orpc.todos.toggle.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: orpc.todos.list.key() });
      },
    }),
  );
  const deleteMutation = useMutation(
    orpc.todos.delete.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: orpc.todos.list.key() });
      },
    }),
  );

  return (
    <main className="mx-auto max-w-md p-4">
      <h1 className="mb-4 text-2xl font-bold">fake-os</h1>

      <form
        className="mb-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim()) createMutation.mutate({ title: title.trim() });
        }}
      >
        <input
          className="flex-1 rounded-lg border bg-card px-3 py-2 text-sm"
          placeholder="Add a todo..."
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <button
          type="submit"
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          disabled={createMutation.isPending}
        >
          Add
        </button>
      </form>

      {todosQuery.isPending && <p className="text-muted-foreground text-sm">Loading...</p>}

      <ul className="space-y-2">
        {todosQuery.data?.map((todo) => (
          <li key={todo.id} className="flex items-center gap-3 rounded-lg border bg-card p-3">
            <button
              type="button"
              className={`h-5 w-5 rounded border ${todo.completed ? "bg-primary border-primary" : "border-input"}`}
              onClick={() => toggleMutation.mutate({ id: todo.id })}
            />
            <span className={`flex-1 text-sm ${todo.completed ? "line-through text-muted-foreground" : ""}`}>
              {todo.title}
            </span>
            <button
              type="button"
              className="text-xs text-destructive hover:underline"
              onClick={() => deleteMutation.mutate({ id: todo.id })}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}
