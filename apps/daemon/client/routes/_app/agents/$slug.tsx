import { lazy, Suspense, useMemo } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { AlertCircleIcon, LoaderIcon } from "lucide-react";
import type { SerializedAgent } from "../../../../server/trpc/router.ts";
import { useTRPC, trpcClient } from "@/integrations/tanstack-query/trpc-client.tsx";

const XtermTerminal = lazy(() =>
  import("@/components/xterm-terminal.tsx").then((mod) => ({
    default: mod.XtermTerminal,
  })),
);

const OPENCODE_BASE_URL = "http://localhost:4096";

/** Build an attach command when the active route is an OpenCode session. */
function getAgentCommand(agent: SerializedAgent): string | undefined {
  const destination = agent.activeRoute?.destination;
  if (!destination) return undefined;
  const match = destination.match(/^\/opencode\/sessions\/(.+)$/);
  if (!match) return undefined;
  return `opencode attach ${OPENCODE_BASE_URL} -s ${match[1]}`;
}

export const Route = createFileRoute("/_app/agents/$slug")({
  beforeLoad: async ({ params }) => {
    const agentPath = decodeURIComponent(params.slug);
    const agent = await trpcClient.getAgent.query({ path: agentPath });
    if (!agent) {
      throw redirect({
        to: "/agents/new",
        search: { path: agentPath },
      });
    }
  },
  component: AgentPage,
});

function AgentPage() {
  const { slug } = Route.useParams();
  const agentPath = decodeURIComponent(slug);
  const trpc = useTRPC();

  const { data: agent } = useSuspenseQuery(trpc.getAgent.queryOptions({ path: agentPath }));

  const initialCommand = useMemo(() => {
    if (!agent) return undefined;
    const command = getAgentCommand(agent);
    return command ? { command, autorun: true } : undefined;
  }, [agent]);

  if (!agent) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <AlertCircleIcon className="size-8 text-muted-foreground" />
        <p className="text-muted-foreground">Agent not found</p>
      </div>
    );
  }

  // Open a shell and attach if an active OpenCode session exists
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center bg-[#1e1e1e]">
          <LoaderIcon className="size-6 animate-spin text-zinc-500" />
        </div>
      }
    >
      <XtermTerminal key={agent.path} initialCommand={initialCommand} />
    </Suspense>
  );
}
