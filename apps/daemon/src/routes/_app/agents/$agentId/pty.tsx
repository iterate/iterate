import { createFileRoute } from "@tanstack/react-router";

import { GhosttyTerminal } from "@/components/ghostty-terminal.tsx";

export const Route = createFileRoute("/_app/agents/$agentId/pty")({
  component: AgentPtyPage,
});

function AgentPtyPage() {
  return <GhosttyTerminal />;
}
