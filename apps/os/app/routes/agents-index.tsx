import { Link } from "react-router";
import { DashboardLayout } from "../components/dashboard-layout.tsx";
import { Button } from "../components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { trpc } from "../lib/trpc.ts";
import { useEstateId, useEstateUrl } from "../hooks/use-estate.ts";

export default function AgentsIndexPage() {
  const estateId = useEstateId();
  const getEstateUrl = useEstateUrl();

  const [agents] = trpc.agents.list.useSuspenseQuery({
    estateId: estateId,
  });

  return (
    <DashboardLayout>
      <div className="p-6">
        <div className="max-w-6xl mx-auto">
          <div className="mb-8">
            <h1 className="text-3xl font-bold text-slate-900 dark:text-white mb-4">
              Manage Agents
            </h1>
            <p className="text-slate-600 dark:text-slate-300 text-lg">
              View and interact with your agent instances
            </p>
          </div>

          {agents.length > 0 ? (
            <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
              {agents.map((agent) => (
                <Card key={agent.id}>
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-lg truncate">{agent.durableObjectName}</CardTitle>
                      <Badge variant={agent.className === "SlackAgent" ? "default" : "secondary"}>
                        {agent.className}
                      </Badge>
                    </div>
                    <CardDescription>
                      <pre>{JSON.stringify(agent.metadata, null, 2)}</pre>
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2">
                      <Link
                        to={getEstateUrl(`agents/${agent.className}/${agent.durableObjectName}`)}
                      >
                        <Button className="w-full">View Agent</Button>
                      </Link>
                      <div className="text-xs text-muted-foreground space-y-1">
                        <div>Created: {new Date(agent.createdAt).toLocaleDateString()}</div>
                        <div className="truncate" title={agent.durableObjectId}>
                          ID: {agent.durableObjectId.slice(0, 12)}...
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <div className="text-center py-12">
              <div className="mx-auto w-24 h-24 bg-gray-100 dark:bg-gray-800 rounded-full flex items-center justify-center mb-4">
                <svg
                  className="w-12 h-12 text-gray-400"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                  />
                </svg>
              </div>
              <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">
                No agents found
              </h3>
              <p className="text-gray-600 dark:text-gray-400 mb-4">
                No agent instances have been created for this estate yet.
              </p>
            </div>
          )}

          <div className="mt-8 p-6 border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg">
            <div className="text-center">
              <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">
                Custom Agent Access
              </h3>
              <p className="text-gray-600 dark:text-gray-400 mb-4">
                Access any agent directly using the URL pattern:
              </p>
              <code className="bg-gray-100 dark:bg-gray-800 px-3 py-1 rounded text-sm">
                /agents/[agentClassName]/[durableObjectName]
              </code>
              <p className="text-sm text-gray-500 dark:text-gray-500 mt-2">
                Example: /agents/IterateAgent/my-custom-agent
              </p>
            </div>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
