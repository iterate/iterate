import { Link } from "react-router";
import { DashboardLayout } from "../components/dashboard-layout.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.tsx";

export default function AgentsIndexPage() {
  // Example agent instances - in a real app, this would come from your API
  const exampleAgents = [
    {
      agentClassName: "IterateAgent",
      durableObjectName: "test-agent-1",
      description: "A test agent instance for development",
    },
    {
      agentClassName: "IterateAgent", 
      durableObjectName: "demo-agent",
      description: "Demo agent for showcasing functionality",
    },
  ];

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

          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {exampleAgents.map((agent) => (
              <Card key={`${agent.agentClassName}-${agent.durableObjectName}`}>
                <CardHeader>
                  <CardTitle className="text-lg">
                    {agent.durableObjectName}
                  </CardTitle>
                  <CardDescription>
                    {agent.agentClassName} • {agent.description}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Link 
                    to={`/agents/${agent.agentClassName}/${agent.durableObjectName}`}
                  >
                    <Button className="w-full">
                      View Agent
                    </Button>
                  </Link>
                </CardContent>
              </Card>
            ))}
          </div>

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
