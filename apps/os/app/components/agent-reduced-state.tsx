import { Globe, Settings, Wrench } from "lucide-react";
import type { AugmentedCoreReducedState } from "../../backend/agent/agent-core-schemas.ts";
import { Badge } from "./ui/badge.tsx";
import { Alert, AlertDescription } from "./ui/alert.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs.tsx";
import { SerializedObjectCodeBlock } from "./serialized-object-code-block.tsx";

interface AgentReducedStateProps {
  reducedState: AugmentedCoreReducedState;
  className?: string;
}

export function AgentReducedState({ reducedState, className }: AgentReducedStateProps) {
  const rawReducedState = Object.fromEntries(
    reducedState.rawKeys.map((key) => [key, reducedState[key as keyof AugmentedCoreReducedState]]),
  );
  // Extract fields for different tabs
  const inputItems = reducedState?.inputItems || [];
  const ephemeralPromptFragments = reducedState?.ephemeralPromptFragments || {};
  const systemPrompt = reducedState?.systemPrompt;
  const toolSpecs = reducedState?.toolSpecs || [];
  const runtimeTools = reducedState?.runtimeTools || [];
  const mcpServers = reducedState?.mcpServers || [];
  const mcpConnections = (reducedState as any)?.mcpConnections || {};

  // Extract fields for the "other" tab (everything except the above)
  const otherFields = Object.entries(reducedState || {}).reduce(
    (acc, [key, value]) => {
      if (
        ![
          "inputItems",
          "ephemeralPromptFragments",
          "systemPrompt",
          "toolSpecs",
          "runtimeTools",
          "mcpServers",
          "mcpConnections",
        ].includes(key)
      ) {
        acc[key] = value;
      }
      return acc;
    },
    {} as Record<string, any>,
  );

  // Calculate counts for badges
  const ephemeralPromptFragmentsCount = Object.keys(ephemeralPromptFragments).length;
  const inputItemsCount = inputItems.length;
  const totalInputItemsCount = ephemeralPromptFragmentsCount + inputItemsCount;
  const toolSpecsCount = toolSpecs.length;
  const runtimeToolsCount = runtimeTools.length;
  const mcpServersCount = mcpServers.length;
  const mcpConnectionsCount = Object.keys(mcpConnections).length;

  return (
    <Tabs defaultValue="inputItems" className={`${className} flex flex-col`}>
      <TabsList className="grid w-full grid-cols-4 lg:grid-cols-9 flex-shrink-0">
        <TabsTrigger value="inputItems" className="flex items-center gap-1 text-xs">
          Input Items
          {totalInputItemsCount > 0 && (
            <Badge variant="secondary" className="h-4 px-1 text-[10px]">
              {totalInputItemsCount}
            </Badge>
          )}
        </TabsTrigger>
        <TabsTrigger value="systemPrompt" className="text-xs">
          System Prompt
        </TabsTrigger>
        <TabsTrigger value="toolSpecs" className="flex items-center gap-1 text-xs">
          Tool Specs
          {toolSpecsCount > 0 && (
            <Badge variant="secondary" className="h-4 px-1 text-[10px]">
              {toolSpecsCount}
            </Badge>
          )}
        </TabsTrigger>
        <TabsTrigger value="runtimeTools" className="flex items-center gap-1 text-xs">
          Runtime Tools
          {runtimeToolsCount > 0 && (
            <Badge variant="secondary" className="h-4 px-1 text-[10px]">
              {runtimeToolsCount}
            </Badge>
          )}
        </TabsTrigger>
        <TabsTrigger value="mcpServers" className="flex items-center gap-1 text-xs">
          <Settings className="h-3 w-3" />
          MCP Servers
          {mcpServersCount > 0 && (
            <Badge variant="secondary" className="h-4 px-1 text-[10px]">
              {mcpServersCount}
            </Badge>
          )}
        </TabsTrigger>
        <TabsTrigger value="mcpConnections" className="flex items-center gap-1 text-xs">
          <Globe className="h-3 w-3" />
          MCP Connections
          {mcpConnectionsCount > 0 && (
            <Badge variant="secondary" className="h-4 px-1 text-[10px]">
              {mcpConnectionsCount}
            </Badge>
          )}
        </TabsTrigger>
        <TabsTrigger value="other" className="text-xs">
          Other
        </TabsTrigger>
        <TabsTrigger value="raw" className="text-xs">
          Raw
        </TabsTrigger>
        <TabsTrigger value="augmented" className="text-xs">
          Augmented
        </TabsTrigger>
      </TabsList>

      <TabsContent value="inputItems" className="flex-1 overflow-auto mt-4">
        {totalInputItemsCount === 0 ? (
          <div className="text-center text-muted-foreground py-8">
            No input items or ephemeral prompt fragments
          </div>
        ) : (
          <SerializedObjectCodeBlock
            data={{
              ephemeralPromptFragments,
              inputItems,
            }}
            className="h-full"
          />
        )}
      </TabsContent>

      <TabsContent value="systemPrompt" className="flex-1 overflow-auto mt-4">
        {!systemPrompt ? (
          <div className="text-center text-muted-foreground py-8">No system prompt set</div>
        ) : (
          <div className="rounded-md border p-4 bg-muted/30 h-full overflow-auto">
            <pre className="whitespace-pre-wrap text-sm">{systemPrompt}</pre>
          </div>
        )}
      </TabsContent>

      <TabsContent value="toolSpecs" className="flex-1 overflow-auto mt-4">
        {toolSpecsCount === 0 ? (
          <div className="text-center text-muted-foreground py-8">No tool specs configured</div>
        ) : (
          <SerializedObjectCodeBlock data={toolSpecs} className="h-full" />
        )}
      </TabsContent>

      <TabsContent value="runtimeTools" className="flex-1 overflow-auto mt-4">
        {runtimeToolsCount === 0 ? (
          <div className="text-center text-muted-foreground py-8">No runtime tools loaded</div>
        ) : (
          <SerializedObjectCodeBlock data={runtimeTools} className="h-full" />
        )}
      </TabsContent>

      <TabsContent value="mcpServers" className="flex-1 overflow-auto mt-4">
        {mcpServersCount === 0 ? (
          <div className="text-center text-muted-foreground py-8">No MCP servers configured</div>
        ) : (
          <div className="space-y-4">
            {mcpServers.map((server: any, index: number) => (
              <Alert key={index} className="border-blue-200 dark:border-blue-800">
                <Settings className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                <AlertDescription>
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-[10px]">
                        {server.mode || "unknown"}
                      </Badge>
                      <span className="font-mono text-xs">{server.serverUrl || "No URL"}</span>
                    </div>
                    {server.integrationSlug && (
                      <div className="text-sm">Integration: {server.integrationSlug}</div>
                    )}
                  </div>
                </AlertDescription>
              </Alert>
            ))}
          </div>
        )}
      </TabsContent>

      <TabsContent value="mcpConnections" className="flex-1 overflow-auto mt-4">
        {mcpConnectionsCount === 0 ? (
          <div className="text-center text-muted-foreground py-8">
            No MCP connections established
          </div>
        ) : (
          <div className="space-y-4">
            {Object.entries(mcpConnections).map(
              ([_key, connection]: [string, any], index: number) => (
                <Alert key={index} className="border-green-200 dark:border-green-800">
                  <Globe className="h-4 w-4 text-green-600 dark:text-green-400" />
                  <AlertDescription>
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-[10px]">
                          {connection.mode || "unknown"}
                        </Badge>
                        <span className="font-mono text-xs">
                          {connection.serverUrl || "No URL"}
                        </span>
                      </div>
                      <div className="text-sm">Server: {connection.serverName || "Unknown"}</div>
                      {connection.integrationSlug && (
                        <div className="text-sm">Integration: {connection.integrationSlug}</div>
                      )}
                      {connection.connectedAt && (
                        <div className="text-xs text-muted-foreground">
                          Connected: {new Date(connection.connectedAt).toLocaleString()}
                        </div>
                      )}
                      <div className="flex items-center gap-4 text-xs">
                        <div className="flex items-center gap-1">
                          <Wrench className="h-3 w-3" />
                          <span>Tools: {connection.tools?.length || 0}</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <Settings className="h-3 w-3" />
                          <span>Prompts: {connection.prompts?.length || 0}</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <Globe className="h-3 w-3" />
                          <span>Resources: {connection.resources?.length || 0}</span>
                        </div>
                      </div>
                    </div>
                  </AlertDescription>
                </Alert>
              ),
            )}
          </div>
        )}
      </TabsContent>

      <TabsContent value="other" className="flex-1 overflow-auto mt-4">
        {Object.keys(otherFields).length === 0 ? (
          <div className="text-center text-muted-foreground py-8">No other fields</div>
        ) : (
          <SerializedObjectCodeBlock data={otherFields} className="h-full" />
        )}
      </TabsContent>

      <TabsContent value="raw" className="flex-1 overflow-auto mt-4">
        <SerializedObjectCodeBlock data={rawReducedState} className="h-full" />
      </TabsContent>

      <TabsContent value="augmented" className="flex-1 overflow-auto mt-4">
        <SerializedObjectCodeBlock data={reducedState} className="h-full" />
      </TabsContent>
    </Tabs>
  );
}
