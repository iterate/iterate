import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Suspense } from "react";

import { GhosttyTerminal } from "@/components/ghostty-terminal.tsx";
import { useTRPC } from "@/integrations/trpc/react.ts";

export const Route = createFileRoute("/_app/agents/$agentId/pty")({
  component: AgentPtyPage,
});

function AgentPtyPage() {
  const { agentId } = Route.useParams();
  return (
    <Suspense fallback={<div className="p-4 text-muted-foreground">Loading...</div>}>
      <AgentPtyContent agentId={agentId} />
    </Suspense>
  );
}

function AgentPtyContent({ agentId }: { agentId: string }) {
  const trpc = useTRPC();
  const { data: sessionInfo } = useSuspenseQuery(
    trpc.getAgentSessionInfo.queryOptions({ slug: agentId }),
  );

  const command = sessionInfo.sessionFile ? `pi --session ${sessionInfo.sessionFile}` : "pi";

  return <GhosttyTerminal key={agentId} initialCommand={command} />;
}
