import { lazy, Suspense, useMemo } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { AlertCircleIcon, LoaderIcon } from "lucide-react";
import type { SerializedAgent } from "../../../../server/trpc/router.ts";
import { useTRPC, trpcClient } from "@/integrations/tanstack-query/trpc-client.tsx";
import { useEnsureAgentStarted } from "@/hooks/use-ensure-agent-started.ts";

const OPENCODE_BASE_URL = "http://localhost:4096";

const XtermTerminal = lazy(() =>
  import("@/components/xterm-terminal.tsx").then((mod) => ({
    default: mod.XtermTerminal,
  })),
);

/**
 * Get the CLI command to spawn for the agent.
 * For opencode: connects via attach command to existing SDK session
 * For claude/pi: spawns the CLI directly
 */
function getAgentCommand(agent: SerializedAgent): string | undefined {
  switch (agent.harnessType) {
    case "opencode":
      // OpenCode uses SDK - attach to the session by ID
      return agent.harnessSessionId
        ? `opencode attach "${OPENCODE_BASE_URL}" --session ${agent.harnessSessionId} --dir "${agent.workingDirectory}"`
        : "opencode";
    case "claude-code":
      // Claude CLI - use --resume if we have a session, otherwise start fresh
      return agent.initialPrompt ? `claude --prompt "${agent.initialPrompt}"` : "claude";
    case "pi":
      // Pi CLI - use initial prompt if available
      return agent.initialPrompt ? `pi --prompt "${agent.initialPrompt}"` : "pi";
    default:
      return undefined;
  }
}

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

  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center bg-[#1e1e1e]">
          <LoaderIcon className="size-6 animate-spin text-zinc-500" />
        </div>
      }
    >
      <XtermTerminal key={agent.slug} initialCommand={initialCommand} />
    </Suspense>
  );
}
