import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";

const API_URL = typeof window !== "undefined" ? `${window.location.origin}/api` : "/api";

async function createAgent(name: string): Promise<boolean> {
  const res = await fetch(`${API_URL}/agents/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
  });
  return res.ok;
}

export function NewAgentForm() {
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
    <form onSubmit={handleSubmit} className="flex items-end gap-3">
      <div className="flex-1">
        <Label htmlFor="agent-name" className="sr-only">
          Agent name
        </Label>
        <Input
          id="agent-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Enter agent name..."
          disabled={creating}
          autoFocus
        />
      </div>
      <Button type="submit" disabled={creating || !name.trim()}>
        {creating ? "Creating..." : "Create Agent"}
      </Button>
    </form>
  );
}
