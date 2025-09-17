import type { Route } from "./+types/integrations";
import { Link, ArrowRight, Github, ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { DashboardLayout } from "../components/dashboard-layout";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible";
import { trpc } from "../lib/trpc.ts";
import { useState } from "react";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Integrations - Iterate Dashboard" },
    {
      name: "description",
      content: "Connect your accounts to enable integrations across the platform",
    },
  ];
}

function ScopesList({ scope }: { scope: string }) {
  const [isOpen, setIsOpen] = useState(false);

  // Split scopes by comma and clean them up
  const scopes = scope
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (scopes.length <= 1) {
    return (
      <Badge variant="outline" className="text-xs">
        {scope}
      </Badge>
    );
  }

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-auto p-0 text-xs text-muted-foreground hover:text-foreground"
        >
          <span className="mr-1">
            {scopes.length} scope{scopes.length !== 1 ? "s" : ""}
          </span>
          {isOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2">
        <ul className="space-y-1">
          {scopes.map((singleScope, index) => (
            <li key={index} className="flex items-center text-xs text-muted-foreground">
              <span className="w-1 h-1 bg-muted-foreground rounded-full mr-2 flex-shrink-0" />
              <span className="break-all">{singleScope}</span>
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

export default function Integrations() {
  const { data: integrations, isLoading, error } = trpc.integrations.list.useQuery();

  const handleConnect = (integrationId: string) => {
    // TODO: Implement OAuth flow for connecting integrations
    // This would redirect to the auth provider's OAuth URL
    console.log(`Connect to ${integrationId}`);
  };

  if (isLoading) {
    return (
      <DashboardLayout>
        <div className="max-w-6xl mx-auto p-6">
          <div className="mb-8">
            <h1 className="text-3xl font-bold mb-2">Integrations</h1>
            <p className="text-muted-foreground text-lg">
              Connect your accounts to enable integrations across the platform
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {[...Array(2)].map((_, i) => (
              <Card key={i} className="animate-pulse">
                <CardHeader>
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-lg bg-gray-200"></div>
                    <div>
                      <div className="h-4 bg-gray-200 rounded w-20 mb-2"></div>
                      <div className="h-3 bg-gray-200 rounded w-32"></div>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="h-8 bg-gray-200 rounded w-full"></div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </DashboardLayout>
    );
  }

  if (error) {
    return (
      <DashboardLayout>
        <div className="max-w-6xl mx-auto p-6">
          <div className="mb-8">
            <h1 className="text-3xl font-bold mb-2">Integrations</h1>
            <p className="text-muted-foreground text-lg">
              Connect your accounts to enable integrations across the platform
            </p>
          </div>
          <div className="text-red-500">Error loading integrations: {error.message}</div>
        </div>
      </DashboardLayout>
    );
  }

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
          {integrations?.map((integration) => (
            <Card key={integration.id} className="relative">
              <CardHeader className="pb-4">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    {integration.icon === "github" ? (
                      <div className="w-12 h-12 rounded-lg bg-gray-900 flex items-center justify-center">
                        <Github className="w-6 h-6 text-white" />
                      </div>
                    ) : integration.icon === "slack" ? (
                      <img
                        src="/slack.png"
                        alt={integration.name}
                        className="w-12 h-12 object-contain"
                      />
                    ) : integration.icon === "google" ? (
                      <div className="w-12 h-12 rounded-lg bg-white border border-gray-200 flex items-center justify-center">
                        <svg className="w-6 h-6" viewBox="0 0 24 24">
                          <path
                            fill="#4285F4"
                            d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                          />
                          <path
                            fill="#34A853"
                            d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                          />
                          <path
                            fill="#FBBC05"
                            d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                          />
                          <path
                            fill="#EA4335"
                            d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                          />
                        </svg>
                      </div>
                    ) : (
                      <div className="w-12 h-12 rounded-lg bg-gray-200 flex items-center justify-center">
                        <span className="text-xs">{integration.name[0]}</span>
                      </div>
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

                {integration.scope && (
                  <div className="mb-4">
                    <p className="text-xs text-muted-foreground mb-1">Scopes:</p>
                    <ScopesList scope={integration.scope} />
                  </div>
                )}

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

                {integration.connectedAt && (
                  <p className="text-xs text-muted-foreground mt-2">
                    Connected on {new Date(integration.connectedAt).toLocaleDateString()}
                  </p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </DashboardLayout>
  );
}
