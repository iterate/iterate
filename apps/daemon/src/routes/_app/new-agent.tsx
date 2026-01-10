import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";

const API_URL = typeof window !== "undefined" ? `${window.location.origin}/api` : "/api";

async function createAgent(name: string): Promise<boolean> {
  const res = await fetch(`${API_URL}/agents/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
  });
  return res.ok;
}

export const Route = createFileRoute("/_app/new-agent")({
  component: NewAgentPage,
  staticData: {
    breadcrumb: { label: "New Agent" },
  },
});

function NewAgentPage() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || creating) return;

    setCreating(true);
    const ok = await createAgent(trimmed);
    setCreating(false);

    if (ok) {
      navigate({ to: "/agents/$agentId", params: { agentId: trimmed } });
    }
  };

  return (
    <div className="p-6 max-w-md">
      <h1 className="text-2xl font-semibold mb-6">Create New Agent</h1>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="agent-name" className="block text-sm font-medium mb-2">
            Agent Name
          </label>
          <Input
            id="agent-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-agent"
            disabled={creating}
            autoFocus
          />
        </div>
        <Button type="submit" disabled={creating || !name.trim()}>
          {creating ? "Creating..." : "Create Agent"}
        </Button>
      </form>
    </div>
  );
}
