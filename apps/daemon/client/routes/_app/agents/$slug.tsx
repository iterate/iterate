import { lazy, Suspense } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { AlertCircleIcon, LoaderIcon } from "lucide-react";
import { useTRPC, trpcClient } from "@/integrations/tanstack-query/trpc-client.tsx";
import { useEnsureAgentStarted } from "@/hooks/use-ensure-agent-started.ts";

const XtermTerminal = lazy(() =>
  import("@/components/xterm-terminal.tsx").then((mod) => ({
    default: mod.XtermTerminal,
  })),
);

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

  // Connect directly to agent CLI via PTY (no tmux)
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center bg-[#1e1e1e]">
          <LoaderIcon className="size-6 animate-spin text-zinc-500" />
        </div>
      }
    >
      <XtermTerminal key={agent.slug} agentSlug={agent.slug} />
    </Suspense>
  );
}
