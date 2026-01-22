import { lazy, Suspense, useMemo } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { AlertCircleIcon, LoaderIcon } from "lucide-react";
import type { SerializedAgent } from "../../../../server/trpc/router.ts";
import { orpc, orpcClient } from "@/integrations/tanstack-query/trpc-client.tsx";
import { useEnsureAgentStarted } from "@/hooks/use-ensure-agent-started.ts";

const XtermTerminal = lazy(() =>
  import("@/components/xterm-terminal.tsx").then((mod) => ({
    default: mod.XtermTerminal,
  })),
);

/**
 * Get the CLI command for agents that don't use tmux sessions.
 * For opencode: connects via attach command to existing SDK session
 * For claude/pi: spawns the CLI directly
 */
function getAgentCommand(agent: SerializedAgent): string | undefined {
  // If agent has a tmux session, we attach to that instead
  if (agent.tmuxSession) return undefined;

  switch (agent.harnessType) {
    case "opencode":
      // OpenCode uses SDK - attach to the session by ID
      return agent.harnessSessionId ? `opencode attach ${agent.harnessSessionId}` : "opencode";
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
    const agent = await orpcClient.getAgent({ slug: params.slug });
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
  const { data: agent } = useSuspenseQuery(orpc.getAgent.queryOptions({ input: { slug } }));
  useEnsureAgentStarted(slug);

  // Get the command to run for agents without tmux sessions
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

  // Connect to agent's tmux session or spawn CLI directly
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center bg-[#1e1e1e]">
          <LoaderIcon className="size-6 animate-spin text-zinc-500" />
        </div>
      }
    >
      <XtermTerminal
        key={agent.slug}
        tmuxSessionName={agent.tmuxSession ?? undefined}
        initialCommand={initialCommand}
      />
    </Suspense>
  );
}
