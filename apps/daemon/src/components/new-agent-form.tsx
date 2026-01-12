import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { useCreateAgent } from "@/hooks/use-agents.ts";

export function NewAgentForm() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const createAgent = useCreateAgent();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || createAgent.isPending) return;

    createAgent.mutate(
      { slug: trimmed, harnessType: "pi" },
      {
        onSuccess: () => {
          navigate({ to: "/agents/$agentId", params: { agentId: trimmed } });
        },
      },
    );
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
          disabled={createAgent.isPending}
          autoFocus
        />
      </div>
      <Button type="submit" disabled={createAgent.isPending || !name.trim()}>
        {createAgent.isPending ? "Creating..." : "Create Agent"}
      </Button>
    </form>
  );
}
