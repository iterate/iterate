import { createFileRoute, Outlet } from "@tanstack/react-router";
import { Loader2Icon, AlertCircleIcon } from "lucide-react";

import { useAgents, useCreateAgent } from "@/hooks/use-agents.ts";

export const Route = createFileRoute("/_app/agents/$agentId")({
  component: AgentLayout,
  staticData: {
    breadcrumb: { label: "$agentId" },
  },
});

function AgentLayout() {
  const { agentId } = Route.useParams();
  return <AgentEnsureExists key={agentId} agentId={agentId} />;
}

function AgentEnsureExists({ agentId }: { agentId: string }) {
  const { data: agents = [], isLoading } = useAgents();
  const createAgent = useCreateAgent();

  const exists = agents.some((a) => a.slug === agentId);

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
        <Loader2Icon className="size-6 animate-spin mb-2" />
        <p>Loading...</p>
      </div>
    );
  }

  if (!exists && !createAgent.isPending && !createAgent.isSuccess && !createAgent.isError) {
    createAgent.mutate({ slug: agentId, harnessType: "pi" });
  }

  if (createAgent.isError) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
        <AlertCircleIcon className="size-6 mb-2 text-destructive" />
        <p>Failed to create agent</p>
      </div>
    );
  }

  if (!exists && !createAgent.isSuccess) {
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
