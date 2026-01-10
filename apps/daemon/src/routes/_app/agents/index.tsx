import { createFileRoute, Link } from "@tanstack/react-router";
import { NewAgentForm } from "@/components/new-agent-form.tsx";

import {
  useStreamReducer,
  registryReducer,
  API_URL,
  type AgentInfo,
  type RegistryEvent,
} from "@/hooks/use-stream-reducer.tsx";

export const Route = createFileRoute("/_app/agents/")({
  component: AgentsListPage,
});

function AgentsListPage() {
  const { data: agents } = useStreamReducer<AgentInfo[], RegistryEvent>(
    `${API_URL}/agents/__registry__`,
    registryReducer,
    [],
  );

  const sortedAgents = [...agents].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  return (
    <div className="p-6 space-y-6">
      <div className="max-w-md">
        <NewAgentForm />
      </div>

      {agents.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-48 text-muted-foreground">
          <div className="text-4xl mb-2">🤖</div>
          <p>No agents yet</p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {sortedAgents.map((agent) => (
            <Link
              key={agent.path}
              to="/agents/$agentId"
              params={{ agentId: agent.path }}
              className="block p-4 rounded-lg border bg-card hover:bg-accent transition-colors"
            >
              <div className="font-medium truncate">{agent.path}</div>
              <div className="text-sm text-muted-foreground mt-1">
                Created {new Date(agent.createdAt).toLocaleDateString()}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
