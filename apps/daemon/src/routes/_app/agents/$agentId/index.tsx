import { createFileRoute } from "@tanstack/react-router";

import { AgentChat } from "@/components/agent-chat.tsx";

const API_URL = typeof window !== "undefined" ? `${window.location.origin}/api` : "/api";

export const Route = createFileRoute("/_app/agents/$agentId/")({
  component: AgentChatPage,
});

function AgentChatPage() {
  const { agentId } = Route.useParams();

  return (
    <div className="h-full">
      <AgentChat agentPath={agentId} apiURL={API_URL} />
    </div>
  );
}
