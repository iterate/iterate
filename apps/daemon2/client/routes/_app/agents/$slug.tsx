import { createFileRoute, redirect } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { AlertCircleIcon } from "lucide-react";
import { GhosttyTerminal } from "@/components/ghostty-terminal.tsx";
import { useTRPC, trpcClient } from "@/integrations/tanstack-query/trpc-client.tsx";
import { useEnsureAgentStarted } from "@/hooks/use-ensure-agent-started.ts";

export const Route = createFileRoute("/_app/agents/$slug")({
  beforeLoad: async ({ params }) => {
    const agent = await trpcClient.getAgent.query({ slug: params.slug });
    if (!agent) {
      throw redirect({
        to: "/agents/new",
        search: { name: params.slug },
      });
    }
  },
  component: AgentPage,
});

function AgentPage() {
  const { slug } = Route.useParams();
  const trpc = useTRPC();

  const { data: agent } = useSuspenseQuery(trpc.getAgent.queryOptions({ slug }));
  useEnsureAgentStarted(slug);

  if (!agent) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <AlertCircleIcon className="size-8 text-muted-foreground" />
        <p className="text-muted-foreground">Agent not found</p>
      </div>
    );
  }

  if (!agent.tmuxSession) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2">
        <AlertCircleIcon className="size-8 text-red-500" />
        <p className="text-muted-foreground">Agent has no tmux session configured</p>
      </div>
    );
  }

  return <GhosttyTerminal key={agent.tmuxSession} tmuxSessionName={agent.tmuxSession} />;
}
