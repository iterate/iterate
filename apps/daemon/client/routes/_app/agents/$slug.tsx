import { createFileRoute, redirect } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { AlertCircleIcon } from "lucide-react";
import { GhosttyTerminal } from "@/components/ghostty-terminal.tsx";
import { useTRPC, trpcClient } from "@/integrations/tanstack-query/trpc-client.tsx";
import { useEnsureSessionStarted } from "@/hooks/use-ensure-session-started.ts";

/**
 * Build tmux session name from slug.
 * Must match the server-side buildSessionName function.
 */
function buildSessionName(slug: string): string {
  return `agent_${slug}`;
}

export const Route = createFileRoute("/_app/agents/$slug")({
  beforeLoad: async ({ params }) => {
    const session = await trpcClient.getSession.query({ slug: params.slug });
    if (!session) {
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

  const { data: session } = useSuspenseQuery(trpc.getSession.queryOptions({ slug }));
  useEnsureSessionStarted(slug);

  if (!session) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <AlertCircleIcon className="size-8 text-muted-foreground" />
        <p className="text-muted-foreground">Agent not found</p>
      </div>
    );
  }

  const tmuxSessionName = buildSessionName(session.slug);

  return <GhosttyTerminal key={tmuxSessionName} tmuxSessionName={tmuxSessionName} />;
}
