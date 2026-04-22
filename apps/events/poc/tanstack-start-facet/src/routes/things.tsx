import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

interface Thing {
  id: string;
  name: string;
  createdAt: string;
}

async function fetchThings(): Promise<Thing[]> {
  const res = await fetch("/api/things");
  if (!res.ok) throw new Error(`Failed to fetch things: ${res.status}`);
  return res.json();
}

async function createThing(name: string): Promise<Thing> {
  const res = await fetch("/api/things", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`Failed to create thing: ${res.status}`);
  return res.json();
}

async function deleteThing(id: string): Promise<void> {
  const res = await fetch(`/api/things/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Failed to delete thing: ${res.status}`);
}

export const Route = createFileRoute("/things")({
  component: Things,
});

function Things() {
  const queryClient = useQueryClient();
  const [newName, setNewName] = useState("");

  const {
    data: things,
    isPending,
    error,
  } = useQuery({
    queryKey: ["things"],
    queryFn: fetchThings,
  });

  const createMutation = useMutation({
    mutationFn: createThing,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["things"] });
      setNewName("");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteThing,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["things"] });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newName.trim();
    if (!trimmed) return;
    createMutation.mutate(trimmed);
  };

  return (
    <main>
      <h1>Things</h1>
      <p>
        CRUD demo backed by SQLite inside a Durable Object. Data persists across requests via the
        DO's embedded database.
      </p>

      {/* Create form */}
      <form
        onSubmit={handleSubmit}
        style={{ display: "flex", gap: "0.5rem", marginBottom: "1.5rem" }}
      >
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="New thing name..."
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

      {createMutation.error && (
        <div className="error-box" style={{ marginBottom: "1rem" }}>
          {createMutation.error.message}
        </div>
      )}

      {/* List */}
      {isPending && <p style={{ color: "#888" }}>Loading things...</p>}

      {error && <div className="error-box">{error.message}</div>}

      {things && things.length === 0 && (
        <div className="empty-state">No things yet. Create one above.</div>
      )}

      {things && things.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          {things.map((thing) => (
            <div key={thing.id} className="thing-item">
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 500, color: "#e0e0e0" }}>{thing.name}</div>
                <div style={{ fontSize: "0.75rem", color: "#666", marginTop: "0.25rem" }}>
                  {thing.id} &middot; {new Date(thing.createdAt).toLocaleString()}
                </div>
              </div>
              <button
                className="btn-danger"
                onClick={() => deleteMutation.mutate(thing.id)}
                disabled={deleteMutation.isPending}
                style={{ marginLeft: "0.75rem", fontSize: "0.8rem", padding: "0.35rem 0.75rem" }}
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      )}

      <p style={{ marginTop: "1.5rem", fontSize: "0.85rem" }}>
        The <code style={{ color: "#f59e0b" }}>/api/things</code> endpoints are handled by the
        Durable Object wrapper, not TanStack server functions. The React client fetches data via{" "}
        <code style={{ color: "#f59e0b" }}>@tanstack/react-query</code>.
      </p>
    </main>
  );
}
