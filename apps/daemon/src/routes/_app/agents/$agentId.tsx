import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { Loader2Icon } from "lucide-react";

import { useAgents, useCreateAgent } from "@/hooks/use-agents.ts";

export const Route = createFileRoute("/_app/agents/$agentId")({
  component: AgentLayout,
  staticData: {
    breadcrumb: { label: "$agentId" },
  },
});

function AgentLayout() {
  const { agentId } = Route.useParams();
  const [agentReady, setAgentReady] = useState(false);

  const { data: agents = [], isLoading } = useAgents();
  const createAgent = useCreateAgent();

  useEffect(() => {
    if (!agentId || isLoading) {
      return;
    }

    const exists = agents.some((a) => a.slug === agentId);
    if (exists) {
      setAgentReady(true);
    } else {
      setAgentReady(false);
      createAgent.mutate(
        { slug: agentId, harnessType: "pi" },
        {
          onSuccess: () => setAgentReady(true),
          onError: () => setAgentReady(true),
        },
      );
    }
  }, [agentId, agents, isLoading, createAgent]);

  if (!agentReady) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
        <Loader2Icon className="size-6 animate-spin mb-2" />
        <p>Creating agent...</p>
      </div>
    );
  }

  return (
    <div className="h-full">
      <Outlet />
    </div>
  );
}
