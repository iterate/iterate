import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { getClient, orpc } from "../orpc/client";

export const Route = createFileRoute("/things")({
  component: Things,
});

function Things() {
  const queryClient = useQueryClient();
  const client = getClient();
  const [newName, setNewName] = useState("");

  const { data, isPending, error } = useQuery(orpc.things.list.queryOptions());

  const createMutation = useMutation({
    mutationFn: (name: string) => client.things.create({ name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orpc.things.list.queryOptions().queryKey });
      setNewName("");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => client.things.remove({ id }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orpc.things.list.queryOptions().queryKey });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newName.trim();
    if (!trimmed) return;
    createMutation.mutate(trimmed);
  };

  const things = data?.items ?? [];

  return (
    <main>
      <h1>Things</h1>
      <p>
        CRUD via <code>@orpc/openapi-client</code> → <code>OpenAPIHandler</code>. Typed end-to-end
        from contract to UI.
      </p>

      <form
        onSubmit={handleSubmit}
        style={{ display: "flex", gap: "0.5rem", marginBottom: "1.5rem" }}
      >
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="New thing..."
          disabled={createMutation.isPending}
          style={{ flex: 1 }}
        />
        <button
          type="submit"
          className="btn-primary"
          disabled={createMutation.isPending || !newName.trim()}
        >
          {createMutation.isPending ? "Creating..." : "Create"}
        </button>
      </form>

      {isPending && <p style={{ color: "#888" }}>Loading...</p>}
      {error && <pre style={{ color: "#fca5a5", background: "#450a0a" }}>{error.message}</pre>}

      {things.length === 0 && !isPending && (
        <p style={{ color: "#555", textAlign: "center", padding: "2rem" }}>No things yet.</p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        {things.map((thing) => (
          <div
            key={thing.id}
            className="card"
            style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}
          >
            <div>
              <div style={{ fontWeight: 500 }}>{thing.name}</div>
              <div style={{ fontSize: "0.75rem", color: "#666", marginTop: "0.2rem" }}>
                {thing.id} · {new Date(thing.createdAt).toLocaleString()}
              </div>
            </div>
            <button
              className="btn-danger"
              onClick={() => deleteMutation.mutate(thing.id)}
              disabled={deleteMutation.isPending}
              style={{ fontSize: "0.75rem", padding: "0.3rem 0.6rem" }}
            >
              Delete
            </button>
          </div>
        ))}
      </div>

      {data && (
        <p style={{ marginTop: "1rem", fontSize: "0.8rem", color: "#555" }}>
          {data.total} total · via <code>OpenAPILink</code> → <code>GET /api/things</code>
        </p>
      )}
    </main>
  );
}
