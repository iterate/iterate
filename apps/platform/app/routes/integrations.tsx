import type { Route } from "./+types/integrations";
import { useState } from "react";
import { Link, ArrowRight, Github } from "lucide-react";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { DashboardLayout } from "../components/dashboard-layout";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Integrations - Iterate Dashboard" },
    {
      name: "description",
      content: "Connect your accounts to enable integrations across the platform",
    },
  ];
}

interface Integration {
  id: string;
  name: string;
  description: string;
  icon: string;
  connections: number;
  apps: number;
  isConnected: boolean;
}

export default function Integrations() {
  const [integrations, setIntegrations] = useState<Integration[]>([
    {
      id: "github",
      name: "GitHub",
      description: "Connect to your GitHub account",
      icon: "/github.png", // You'll need to add this
      connections: 0,
      apps: 2,
      isConnected: false,
    },
    {
      id: "slack",
      name: "Slack",
      description: "Connect to your Slack workspace",
      icon: "/slack.png",
      connections: 1,
      apps: 1,
      isConnected: true,
    },
  ]);

  const handleConnect = (integrationId: string) => {
    setIntegrations((prev) =>
      prev.map((integration) =>
        integration.id === integrationId
          ? {
              ...integration,
              isConnected: true,
              connections: integration.connections + 1,
            }
          : integration,
      ),
    );
  };

  return (
    <DashboardLayout>
      <div className="max-w-6xl mx-auto p-6">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold mb-2">Integrations</h1>
          <p className="text-muted-foreground text-lg">
            Connect your accounts to enable integrations across the platform
          </p>
        </div>

        {/* Integration Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {integrations.map((integration) => (
            <Card key={integration.id} className="relative">
              <CardHeader className="pb-4">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    {integration.id === "github" ? (
                      <div className="w-12 h-12 rounded-lg bg-gray-900 flex items-center justify-center">
                        <Github className="w-6 h-6 text-white" />
                      </div>
                    ) : (
                      <img
                        src={integration.icon}
                        alt={integration.name}
                        className="w-12 h-12 object-contain"
                      />
                    )}
                    <div>
                      <CardTitle className="text-lg">{integration.name}</CardTitle>
                      <CardDescription className="text-sm">
                        {integration.description}
                      </CardDescription>
                    </div>
                  </div>
                </div>
              </CardHeader>

              <CardContent className="pt-0">
                <div className="flex items-center gap-4 text-sm text-muted-foreground mb-4">
                  <div className="flex items-center gap-1">
                    <Link className="w-4 h-4" />
                    <span>
                      {integration.connections} connection
                      {integration.connections !== 1 ? "s" : ""} in {integration.apps} app
                      {integration.apps !== 1 ? "s" : ""}
                    </span>
                  </div>
                </div>

                {integration.isConnected ? (
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary" className="text-green-700 bg-green-100">
                      Connected
                    </Badge>
                    <Button variant="outline" size="sm">
                      Manage
                    </Button>
                  </div>
                ) : (
                  <Button className="w-full" onClick={() => handleConnect(integration.id)}>
                    Connect {integration.name}
                    <ArrowRight className="w-4 h-4 ml-2" />
                  </Button>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </DashboardLayout>
  );
}
