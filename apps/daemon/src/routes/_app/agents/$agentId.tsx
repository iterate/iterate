import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { Loader2Icon } from "lucide-react";

import {
  useStreamReducer,
  registryReducer,
  API_URL,
  type AgentInfo,
  type RegistryEvent,
} from "@/hooks/use-stream-reducer.tsx";

async function createAgent(name: string): Promise<boolean> {
  const res = await fetch(`${API_URL}/agents/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
  });
  return res.ok;
}

export const Route = createFileRoute("/_app/agents/$agentId")({
  component: AgentLayout,
  staticData: {
    breadcrumb: { label: "$agentId" },
  },
});

function AgentLayout() {
  const { agentId } = Route.useParams();
  const [agentReady, setAgentReady] = useState(false);

  const { data: agents, isLoaded: registryLoaded } = useStreamReducer<AgentInfo[], RegistryEvent>(
    `${API_URL}/agents/__registry__`,
    registryReducer,
    [],
  );

  useEffect(() => {
    if (!agentId) {
      setAgentReady(false);
      return;
    }
    const exists = agents.some((a) => a.path === agentId);
    if (exists) {
      setAgentReady(true);
    } else {
      setAgentReady(false);
      createAgent(agentId).then((ok) => {
        if (ok || !registryLoaded) {
          setAgentReady(true);
        }
      });
    }
  }, [agentId, agents, registryLoaded]);

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
