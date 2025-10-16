import { ArrowRight, Github, ChevronDown, X, Puzzle } from "lucide-react";
import { useState, useEffect } from "react";
import { useMutation, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Button } from "../../../../components/ui/button.tsx";
import { Badge } from "../../../../components/ui/badge.tsx";
import { Input } from "../../../../components/ui/input.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../../../components/ui/dialog.tsx";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
} from "../../../../components/ui/field.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../../../components/ui/alert-dialog.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../../components/ui/select.tsx";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "../../../../components/ui/accordion.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "../../../../components/ui/dropdown-menu.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../../../components/ui/table.tsx";
import { Card, CardContent, CardFooter } from "../../../../components/ui/card.tsx";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../../../../components/ui/tabs.tsx";
import { Item, ItemContent, ItemMedia, ItemTitle } from "../../../../components/ui/item.tsx";
import { useTRPC } from "../../../../lib/trpc.ts";
import { useEstateId } from "../../../../hooks/use-estate.ts";
import { useSlackConnection } from "../../../../hooks/use-slack-connection.ts";
import { authClient } from "../../../../lib/auth-client.ts";
import type { Route } from "./+types/index.ts";

export function meta(_args: Route.MetaArgs) {
  return [
    { title: "Iterate Connectors" },
    {
      name: "description",
      content: "Connect your iterate bot to third parties",
    },
  ];
}

function ScopesList({ scope }: { scope: string }) {
  // Split scopes by comma or space and clean them up
  const scopes = scope
    .split(/[,\s]+/)
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
    <Accordion type="single" collapsible>
      <AccordionItem value="permissions">
        <AccordionTrigger className="py-2 text-xs text-muted-foreground hover:text-foreground">
          {scopes.length} permission{scopes.length !== 1 ? "s" : ""}
        </AccordionTrigger>
        <AccordionContent>
          <div className="grid grid-cols-1 gap-1">
            {scopes.map((singleScope, index) => (
              <Badge key={index} variant="secondary" className="text-xs justify-start font-mono">
                {singleScope}
              </Badge>
            ))}
          </div>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}

type MCPConnection = {
  type: "mcp-oauth" | "mcp-params";
  id: string;
  name: string;
  providerId?: string;
  serverUrl?: string;
  mode: "company" | "personal";
  scope?: string | null;
  userId?: string | null;
  paramCount?: number;
  connectedAt: Date | string;
};

export default function Integrations() {
  const estateId = useEstateId();
  const trpc = useTRPC();
  const { data, refetch } = useSuspenseQuery(
    trpc.integrations.list.queryOptions({
      estateId: estateId,
    }),
  );

  const { data: estateInfo } = useSuspenseQuery(
    trpc.estate.get.queryOptions({
      estateId: estateId,
    }),
  );

  const isTrialEstate = !!estateInfo.slackTrialConnectChannelId;

  // Filter out Slack connector for trial estates since they're using Slack Connect
  const integrations = (data?.oauthIntegrations || []).filter(
    (integration: any) => !(isTrialEstate && integration.id === "slack-bot"),
  );
  const mcpConnections = (data?.mcpConnections || []) as MCPConnection[];

  // Count connections by mode
  const personalCount = mcpConnections.filter((c) => c.mode === "personal").length;
  const companyCount = mcpConnections.filter((c) => c.mode === "company").length;

  // Determine default tab: personal first, then company if personal is empty
  const defaultTab = personalCount > 0 ? "personal" : companyCount > 0 ? "company" : "personal";

  const { mutateAsync: startGithubAppInstallFlow } = useMutation(
    trpc.integrations.startGithubAppInstallFlow.mutationOptions({}),
  );
  const { mutateAsync: disconnectIntegration } = useMutation(
    trpc.integrations.disconnect.mutationOptions({}),
  );
  const { mutateAsync: disconnectMCP } = useMutation(
    trpc.integrations.disconnectMCP.mutationOptions({}),
  );

  // Use the Slack connection hook
  const { connectSlackBot, disconnectSlackBot } = useSlackConnection();

  const handleConnect = async (integrationId: string) => {
    if (integrationId === "github-app") {
      const { installationUrl } = await startGithubAppInstallFlow({
        estateId: estateId,
      });
      window.location.href = installationUrl.toString();
    } else if (integrationId === "slack-bot") {
      // Use the shared Slack connection logic
      await connectSlackBot("/integrations");
    } else if (integrationId === "google") {
      const result = await authClient.integrations.link.google({
        callbackURL: window.location.pathname,
      });
      window.location.href = result.url.toString();
    }
    // TODO: Implement OAuth flow for other integrations
    // This would redirect to the auth provider's OAuth URL
    console.log(`Connect to ${integrationId}`);
  };

  const handleDisconnect = async (
    integrationId: string,
    disconnectType: "estate" | "personal" | "both" = "both",
  ) => {
    try {
      if (integrationId === "slack-bot") {
        // Use the shared Slack disconnection logic
        await disconnectSlackBot(disconnectType);
      } else {
        await disconnectIntegration({
          estateId: estateId,
          providerId: integrationId,
          disconnectType,
        });
        // Refetch the integrations list to update the UI
        await refetch();
      }
    } catch (error) {
      console.error(`Failed to disconnect ${integrationId}:`, error);
      // You might want to show a toast notification here
    }
  };

  const handleDisconnectMCP = async (connection: MCPConnection) => {
    try {
      await disconnectMCP({
        estateId: estateId,
        connectionId: connection.id,
        connectionType: connection.type,
        mode: connection.mode,
      });
      await refetch();
    } catch (error) {
      console.error(`Failed to disconnect MCP connection:`, error);
    }
  };

  return (
    <div className="space-y-6">
      {/* Integrations Section */}
      <Card variant="muted">
        <CardContent>
          <h2 className="text-xl font-semibold mb-4">Built-in Connectors</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {integrations.map((integration: any) => (
              <Card key={integration.id}>
                <CardContent>
                  <Item className="p-0 mb-3">
                    <ItemMedia>
                      {integration.icon === "github" ? (
                        <Github className="w-6 h-6" />
                      ) : integration.icon === "slack" ? (
                        <img src="/slack.svg" alt={integration.name} className="w-6 h-6" />
                      ) : integration.icon === "google" ? (
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
                      ) : (
                        <span className="text-xs">{integration.name[0]}</span>
                      )}
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>{integration.name}</ItemTitle>
                      <div className="text-xs text-muted-foreground">
                        {integration.id === "google"
                          ? "Personal connection"
                          : integration.isEstateWide
                            ? "Shared with organization"
                            : integration.isPersonal
                              ? "Personal connection"
                              : ""}
                      </div>
                    </ItemContent>
                  </Item>

                  {integration.scope && (
                    <div>
                      <ScopesList scope={integration.scope} />
                    </div>
                  )}

                  {integration.isConnected ? (
                    <>
                      {integration.connectedAt && (
                        <p className="text-xs text-green-600 mb-2">
                          Connected on {new Date(integration.connectedAt).toLocaleDateString()}
                        </p>
                      )}
                      {/* Show dropdown if both estate-wide and personal connections exist */}
                      {integration.isEstateWide && integration.isPersonal ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="outline" size="sm" className="w-full">
                              Disconnect
                              <ChevronDown className="ml-1 h-3 w-3" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              onClick={() => handleDisconnect(integration.id, "estate")}
                            >
                              Disconnect from Estate
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => handleDisconnect(integration.id, "personal")}
                            >
                              Disconnect Personal
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className="text-red-600"
                              onClick={() => handleDisconnect(integration.id, "both")}
                            >
                              Disconnect All
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          className="w-full"
                          onClick={() => handleDisconnect(integration.id, "both")}
                        >
                          Disconnect
                        </Button>
                      )}
                    </>
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
        </CardContent>
      </Card>

      {/* MCP Connections Section - Always Visible */}
      <Card variant="muted">
        <CardContent>
          <h2 className="text-xl font-semibold mb-4">Remote MCP Server Connections</h2>

          {/* Always show tabs */}
          <Tabs defaultValue={defaultTab} className="w-full">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="personal" className="flex items-center gap-2">
                Personal
                <Badge variant="secondary" className="text-xs">
                  {personalCount}
                </Badge>
              </TabsTrigger>
              <TabsTrigger value="company" className="flex items-center gap-2">
                Shared with organization
                <Badge variant="secondary" className="text-xs">
                  {companyCount}
                </Badge>
              </TabsTrigger>
            </TabsList>

            <TabsContent value="personal" className="mt-4">
              <MCPConnectionsTable
                connections={mcpConnections.filter((c) => c.mode === "personal")}
                onDisconnect={handleDisconnectMCP}
                estateId={estateId}
                onUpdate={refetch}
              />
            </TabsContent>

            <TabsContent value="company" className="mt-4">
              <MCPConnectionsTable
                connections={mcpConnections.filter((c) => c.mode === "company")}
                onDisconnect={handleDisconnectMCP}
                estateId={estateId}
                onUpdate={refetch}
              />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}

function MCPConnectionsTable({
  connections,
  onDisconnect,
  estateId,
  onUpdate,
}: {
  connections: MCPConnection[];
  onDisconnect: (connection: MCPConnection) => void;
  estateId: string;
  onUpdate: () => void;
}) {
  const trpc = useTRPC();
  const [selectedConnection, setSelectedConnection] = useState<MCPConnection | null>(null);
  const [connectionToDisconnect, setConnectionToDisconnect] = useState<MCPConnection | null>(null);
  const [params, setParams] = useState<Array<{ key: string; value: string; type: string }>>([]);

  const { data: connectionDetails, isLoading: isLoadingDetails } = useQuery({
    ...trpc.integrations.getMCPConnectionDetails.queryOptions({
      estateId,
      connectionId: selectedConnection?.id || "",
      connectionType: selectedConnection?.type || "mcp-params",
    }),
    enabled: !!selectedConnection,
  });

  const { mutateAsync: updateParams, isPending: isUpdating } = useMutation(
    trpc.integrations.updateMCPConnectionParams.mutationOptions({}),
  );

  const handleRowClick = (connection: MCPConnection) => {
    setSelectedConnection(connection);
  };

  const handleClose = () => {
    setSelectedConnection(null);
    setParams([]);
  };

  const handleSaveParams = async () => {
    if (selectedConnection?.type === "mcp-params") {
      await updateParams({
        estateId,
        connectionKey: selectedConnection.id,
        params: params.map((p) => ({
          key: p.key,
          value: p.value,
          type: p.type as "header" | "query_param",
        })),
      });
      onUpdate();
      handleClose();
    }
  };

  // Initialize params when details load
  useEffect(() => {
    if (connectionDetails?.type === "params" && connectionDetails.params.length > 0) {
      setParams(connectionDetails.params);
    }
  }, [connectionDetails]);

  return (
    <>
      <div className="rounded-md border bg-background">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="h-12 px-4">Server</TableHead>
              <TableHead className="h-12 px-4">Type</TableHead>
              <TableHead className="h-12 px-4">Connected</TableHead>
              <TableHead className="h-12 px-4 w-[100px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {connections.length > 0 ? (
              connections.map((connection) => (
                <TableRow
                  key={connection.id}
                  className="hover:bg-muted/50 cursor-pointer"
                  onClick={() => handleRowClick(connection)}
                >
                  <TableCell className="px-4 py-3">
                    <code className="text-sm">
                      {connection.type === "mcp-params"
                        ? connection.serverUrl
                        : connection.providerId}
                    </code>
                  </TableCell>
                  <TableCell className="px-4 py-3">
                    <Badge variant="outline">
                      {connection.type === "mcp-oauth" ? "OAuth" : "Params"}
                    </Badge>
                  </TableCell>
                  <TableCell className="px-4 py-3 text-sm text-muted-foreground">
                    {connection.connectedAt &&
                      new Date(connection.connectedAt).toLocaleString(undefined, {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })}
                  </TableCell>
                  <TableCell className="px-4 py-3">
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        setConnectionToDisconnect(connection);
                      }}
                    >
                      Disconnect
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={4} className="px-4 py-8">
                  <div className="flex flex-col items-center justify-center text-center">
                    <Puzzle className="h-8 w-8 text-muted-foreground mb-2" />
                    <p className="text-sm text-muted-foreground">No MCP servers connected yet</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Just ask @iterate to connect to any remote MCP server URL
                    </p>
                  </div>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Connection Details Dialog */}
      <Dialog open={!!selectedConnection} onOpenChange={(open) => !open && handleClose()}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Connection Details</DialogTitle>
            <DialogDescription>
              {selectedConnection?.type === "mcp-params"
                ? "View and edit connection parameters"
                : "View OAuth client information"}
            </DialogDescription>
          </DialogHeader>

          {isLoadingDetails ? (
            <div className="py-8 text-center text-muted-foreground">Loading...</div>
          ) : connectionDetails?.type === "params" ? (
            <FieldGroup>
              <FieldSet>
                <FieldLegend>Connection Information</FieldLegend>
                <FieldGroup>
                  <Field>
                    <FieldLabel>Server URL</FieldLabel>
                    <code className="block p-2 bg-muted rounded text-sm">
                      {selectedConnection?.serverUrl}
                    </code>
                  </Field>
                </FieldGroup>
              </FieldSet>

              <FieldSeparator />

              <FieldSet>
                <FieldLegend>Parameters</FieldLegend>
                <FieldDescription>
                  Configure headers and query parameters for this MCP server connection
                </FieldDescription>
                <FieldGroup>
                  <div className="flex items-center justify-between">
                    <FieldLabel>Connection Parameters</FieldLabel>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setParams([...params, { key: "", value: "", type: "header" }])}
                    >
                      Add Parameter
                    </Button>
                  </div>

                  {params.length > 0 ? (
                    <div className="space-y-3">
                      {params.map((param, index) => (
                        <div
                          key={index}
                          className="grid grid-cols-[1fr_1fr_auto_auto] gap-2 items-end"
                        >
                          <Field>
                            <FieldLabel htmlFor={`param-key-${index}`}>Key</FieldLabel>
                            <Input
                              id={`param-key-${index}`}
                              placeholder="Authorization"
                              value={param.key}
                              onChange={(e) => {
                                const newParams = [...params];
                                newParams[index].key = e.target.value;
                                setParams(newParams);
                              }}
                            />
                          </Field>
                          <Field>
                            <FieldLabel htmlFor={`param-value-${index}`}>Value</FieldLabel>
                            <Input
                              id={`param-value-${index}`}
                              placeholder="••••••••"
                              type="password"
                              value={param.value}
                              onChange={(e) => {
                                const newParams = [...params];
                                newParams[index].value = e.target.value;
                                setParams(newParams);
                              }}
                            />
                          </Field>
                          <Field>
                            <FieldLabel htmlFor={`param-type-${index}`}>Type</FieldLabel>
                            <Select
                              value={param.type}
                              onValueChange={(value) => {
                                const newParams = [...params];
                                newParams[index].type = value;
                                setParams(newParams);
                              }}
                            >
                              <SelectTrigger id={`param-type-${index}`} className="w-[140px]">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="header">Header</SelectItem>
                                <SelectItem value="query_param">Query Param</SelectItem>
                              </SelectContent>
                            </Select>
                          </Field>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="flex-shrink-0"
                            onClick={() => {
                              setParams(params.filter((_, i) => i !== index));
                            }}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground text-center py-4">
                      No parameters configured. Click "Add Parameter" to add connection parameters.
                    </p>
                  )}
                </FieldGroup>
              </FieldSet>
            </FieldGroup>
          ) : connectionDetails?.type === "oauth" ? (
            <FieldGroup>
              <FieldSet>
                <FieldLegend>OAuth Connection</FieldLegend>
                <FieldDescription>
                  Details about your OAuth connection to this MCP server
                </FieldDescription>
                <FieldGroup>
                  <Field>
                    <FieldLabel>Provider ID</FieldLabel>
                    <code className="block p-2 bg-muted rounded text-sm">
                      {connectionDetails.providerId}
                    </code>
                  </Field>

                  {connectionDetails.scope && (
                    <Field>
                      <FieldLabel>Scopes</FieldLabel>
                      <div className="p-2 bg-muted rounded text-sm">
                        {connectionDetails.scope.split(" ").map((scope: string, i: number) => (
                          <Badge key={i} variant="secondary" className="mr-1 mb-1">
                            {scope}
                          </Badge>
                        ))}
                      </div>
                    </Field>
                  )}

                  {connectionDetails.clientInfo && (
                    <Field>
                      <FieldLabel>Client ID</FieldLabel>
                      <code className="block p-2 bg-muted rounded text-sm">
                        {connectionDetails.clientInfo.client_id}
                      </code>
                    </Field>
                  )}

                  <Field>
                    <FieldLabel>Connected</FieldLabel>
                    <div className="text-sm text-muted-foreground">
                      {new Date(connectionDetails.connectedAt).toLocaleString(undefined, {
                        dateStyle: "long",
                        timeStyle: "medium",
                      })}
                    </div>
                  </Field>
                </FieldGroup>
              </FieldSet>
            </FieldGroup>
          ) : null}

          {selectedConnection?.type === "mcp-params" && (
            <CardFooter className="justify-end">
              <Button onClick={handleSaveParams} disabled={isUpdating}>
                {isUpdating ? "Saving..." : "Save Changes"}
              </Button>
            </CardFooter>
          )}
        </DialogContent>
      </Dialog>

      {/* Disconnect Confirmation Dialog */}
      <AlertDialog
        open={!!connectionToDisconnect}
        onOpenChange={(open) => !open && setConnectionToDisconnect(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect MCP Server</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to disconnect from{" "}
              <code className="font-semibold">
                {connectionToDisconnect?.type === "mcp-params"
                  ? connectionToDisconnect?.serverUrl
                  : connectionToDisconnect?.providerId}
              </code>
              ? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (connectionToDisconnect) {
                  onDisconnect(connectionToDisconnect);
                  setConnectionToDisconnect(null);
                }
              }}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
