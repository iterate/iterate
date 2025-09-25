import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useParams, Link } from "react-router";
import {
  ArrowLeft,
  ArrowUp,
  Bot,
  Brain,
  ChevronDown,
  ChevronUp,
  Circle,
  Clock,
  Copy,
  Paperclip,
  Pause,
  Play,
  Search,
  Settings,
  Square,
  StopCircle,
  Upload,
  Users,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { useAgent } from "agents/react";
import clsx from "clsx";
import { useMutation, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useTRPC } from "../lib/trpc.ts";
import { Button } from "../components/ui/button.tsx";
import { useEstateId, useEstateUrl } from "../hooks/use-estate.ts";
import { Badge } from "../components/ui/badge.tsx";
import { Alert, AlertDescription } from "../components/ui/alert.tsx";
import { Card } from "../components/ui/card.tsx";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../components/ui/collapsible.tsx";
import { Label } from "../components/ui/label.tsx";
import { Textarea } from "../components/ui/textarea.tsx";
import { Checkbox } from "../components/ui/checkbox.tsx";
import { Input } from "../components/ui/input.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select.tsx";
import { Drawer, DrawerContent } from "../components/ui/drawer.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs.tsx";

// AI elements imports
import { Message, MessageContent, MessageAvatar } from "../components/ai-elements/message.tsx";
import {
  Tool,
  ToolHeader,
  ToolContent,
  ToolInput,
  ToolOutput,
} from "../components/ai-elements/tool.tsx";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "../components/ai-elements/conversation.tsx";
import {
  PromptInput,
  PromptInputBody,
  PromptInputTextarea,
  PromptInputToolbar,
  PromptInputTools,
  PromptInputButton,
  PromptInputSubmit,
  PromptInputModelSelect,
  PromptInputModelSelectTrigger,
  PromptInputModelSelectContent,
  PromptInputModelSelectItem,
  PromptInputModelSelectValue,
} from "../components/ai-elements/prompt-input.tsx";
import {
  Reasoning,
  ReasoningTrigger,
  ReasoningContent,
} from "../components/ai-elements/reasoning.tsx";
import { Response } from "../components/ai-elements/response.tsx";
import { SerializedObjectCodeBlock } from "../components/serialized-object-code-block.tsx";
import { AgentReducedState } from "../components/agent-reduced-state.tsx";
import { PagerDialog } from "../components/pager-dialog.tsx";
import type { IterateAgentState } from "../../backend/agent/iterate-agent.ts";
import type {
  AgentCoreEvent,
  AgentCoreEventInput,
  CoreReducedState,
} from "../../backend/agent/agent-core-schemas.ts";
import type { SlackSliceEvent, SlackSliceState } from "../../backend/agent/slack-slice.ts";
import { isThinking } from "../../backend/agent/agent-core-schemas.ts";
import { fulltextSearchInObject } from "../../backend/utils/type-helpers.ts";
import type { SlackWebhookPayload } from "../../backend/agent/slack.types.ts";
import { resolveEmoji } from "../lib/emoji-mapping.ts";

// Types and interfaces
interface FilterState {
  searchText: string;
}

type AgentEvent = AgentCoreEvent | SlackSliceEvent;

// Helper function to get color for time delta based on milliseconds
const getTimeDeltaColor = (ms: number): string => {
  if (ms <= 100) {
    return "text-gray-400";
  }
  if (ms <= 500) {
    return "text-gray-500";
  }
  if (ms <= 1000) {
    return "text-yellow-500";
  }
  if (ms <= 3000) {
    return "text-orange-500";
  }
  return "text-red-500"; // Very long delays (3+ seconds) - red
};

// AI elements message renderer
function MessageRenderer({
  data,
  createdAt,
  currentUser,
}: {
  data: any;
  createdAt?: string;
  currentUser: { name: string; email: string; image?: string | null };
}): React.ReactElement | null {
  if (!data || data.type !== "message") {
    return null;
  }

  const message = data;
  const from = message.role === "assistant" ? "assistant" : "user";

  // Handle both array and string content formats
  const contentItems = Array.isArray(message.content)
    ? message.content
    : [{ type: "input_text", text: message.content }];

  return (
    <div className="mb-4">
      {contentItems.map((contentItem: any, idx: number) => {
        switch (contentItem.type) {
          case "input_text":
          case "output_text":
            // Handle developer messages differently
            if (message.role === "developer") {
              return (
                <Alert
                  key={`dev-${idx}`}
                  className="mb-4 bg-orange-50/50 dark:bg-orange-900/20 border-orange-200 dark:border-orange-800"
                >
                  <AlertDescription>
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <Badge
                          variant="outline"
                          className="text-xs bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200"
                        >
                          Developer
                        </Badge>
                        {createdAt && (
                          <span className="text-xs text-muted-foreground">
                            {new Date(createdAt).toLocaleTimeString()}
                          </span>
                        )}
                      </div>
                      <pre className="whitespace-pre-wrap text-sm font-mono leading-relaxed text-orange-800 dark:text-orange-200 overflow-wrap-anywhere">
                        {contentItem.text}
                      </pre>
                    </div>
                  </AlertDescription>
                </Alert>
              );
            }

            // Use AI components for proper message rendering
            if (from === "assistant") {
              return (
                <Message key={`text-${idx}`} from="assistant" className="mb-4">
                  <div className="flex flex-col items-start">
                    {createdAt && (
                      <div className="text-xs text-muted-foreground mb-1">
                        {new Date(createdAt).toLocaleTimeString()}
                      </div>
                    )}
                    <MessageContent variant="contained">
                      <Response>{contentItem.text}</Response>
                    </MessageContent>
                  </div>
                  <MessageAvatar src="/logo.svg" name="AI" />
                </Message>
              );
            } else {
              // User messages with avatar
              const userInitials = currentUser.name
                .split(" ")
                .map((name) => name.charAt(0))
                .join("")
                .toUpperCase()
                .slice(0, 2);

              return (
                <Message key={`text-${idx}`} from="user" className="mb-4">
                  <div className="flex flex-col items-end">
                    {createdAt && (
                      <div className="text-xs text-muted-foreground mb-1">
                        {new Date(createdAt).toLocaleTimeString()}
                      </div>
                    )}
                    <MessageContent variant="contained">
                      <Response>{contentItem.text}</Response>
                    </MessageContent>
                  </div>
                  <MessageAvatar src={currentUser.image || ""} name={userInitials} />
                </Message>
              );
            }

          case "reasoning":
            return (
              <div key={`reasoning-${idx}`} className="mb-4">
                <Reasoning defaultOpen={true}>
                  <ReasoningTrigger />
                  <ReasoningContent>{contentItem.text}</ReasoningContent>
                </Reasoning>
              </div>
            );

          case "input_image":
            if (from === "assistant") {
              return (
                <Message key={`image-${idx}`} from="assistant" className="mb-4">
                  <div className="flex flex-col items-start">
                    {createdAt && (
                      <div className="text-xs text-muted-foreground mb-1">
                        {new Date(createdAt).toLocaleTimeString()}
                      </div>
                    )}
                    <MessageContent variant="contained">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-lg">🖼️</span>
                        <Badge variant="outline" className="text-xs">
                          Image
                        </Badge>
                      </div>
                      <div className="text-sm opacity-75">[Image content not rendered]</div>
                    </MessageContent>
                  </div>
                  <MessageAvatar src="/logo.svg" name="AI" />
                </Message>
              );
            } else {
              const userInitials = currentUser.name
                .split(" ")
                .map((name) => name.charAt(0))
                .join("")
                .toUpperCase()
                .slice(0, 2);

              return (
                <Message key={`image-${idx}`} from="user" className="mb-4">
                  <div className="flex flex-col items-end">
                    {createdAt && (
                      <div className="text-xs text-muted-foreground mb-1">
                        {new Date(createdAt).toLocaleTimeString()}
                      </div>
                    )}
                    <MessageContent variant="contained">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-lg">🖼️</span>
                        <Badge variant="outline" className="text-xs">
                          Image
                        </Badge>
                      </div>
                      <div className="text-sm opacity-75">[Image content not rendered]</div>
                    </MessageContent>
                  </div>
                  <MessageAvatar src={currentUser.image || ""} name={userInitials} />
                </Message>
              );
            }

          case "input_file":
            if (from === "assistant") {
              return (
                <Message key={`file-${idx}`} from="assistant" className="mb-4">
                  <div className="flex flex-col items-start">
                    {createdAt && (
                      <div className="text-xs text-muted-foreground mb-1">
                        {new Date(createdAt).toLocaleTimeString()}
                      </div>
                    )}
                    <MessageContent variant="contained">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-lg">📎</span>
                        <Badge variant="outline" className="text-xs">
                          File
                        </Badge>
                      </div>
                      <div className="text-sm opacity-75">[File content not rendered]</div>
                    </MessageContent>
                  </div>
                  <MessageAvatar src="/logo.svg" name="AI" />
                </Message>
              );
            } else {
              const userInitials = currentUser.name
                .split(" ")
                .map((name) => name.charAt(0))
                .join("")
                .toUpperCase()
                .slice(0, 2);

              return (
                <Message key={`file-${idx}`} from="user" className="mb-4">
                  <div className="flex flex-col items-end">
                    {createdAt && (
                      <div className="text-xs text-muted-foreground mb-1">
                        {new Date(createdAt).toLocaleTimeString()}
                      </div>
                    )}
                    <MessageContent variant="contained">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-lg">📎</span>
                        <Badge variant="outline" className="text-xs">
                          File
                        </Badge>
                      </div>
                      <div className="text-sm opacity-75">[File content not rendered]</div>
                    </MessageContent>
                  </div>
                  <MessageAvatar src={currentUser.image || ""} name={userInitials} />
                </Message>
              );
            }

          default:
            // Skip unknown content types
            return null;
        }
      })}
    </div>
  );
}

// Filter bar component
function FilterBar({
  value,
  onChange,
  placeholder,
  count,
  onClear,
  onCopy,
  onBrainClick,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  count: number;
  onClear?: () => void;
  onCopy?: () => void;
  onBrainClick?: () => void;
}) {
  return (
    <div className="flex items-center gap-2 h-9 pb-2">
      <div className="flex-1 relative">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
        <input
          type="text"
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full h-6 pl-7 pr-8 text-xs rounded border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
        />
        {value && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => onChange("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 h-4 w-4 rounded hover:bg-muted flex items-center justify-center"
              >
                <X className="h-3 w-3" />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Clear search</p>
            </TooltipContent>
          </Tooltip>
        )}
      </div>
      <Badge variant="secondary" className="h-4 text-[10px] px-1 mr-1">
        {count}
      </Badge>
      <div className="flex items-center gap-1">
        {onCopy && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="sm" onClick={onCopy} className="h-6 w-6 p-0">
                <Copy className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Copy JSON</p>
            </TooltipContent>
          </Tooltip>
        )}
        {onBrainClick && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="sm" onClick={onBrainClick} className="h-6 w-6 p-0">
                <Brain className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>View in Braintrust</p>
            </TooltipContent>
          </Tooltip>
        )}
        {onClear && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={onClear}
                className="h-6 w-6 p-0"
                disabled={count === 0}
              >
                <X className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Clear all</p>
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

// Meta event wrapper component
function MetaEventWrapper({
  event,
  index,
  array,
  renderer: Renderer,
  onEventClick,
  estateId,
  currentUser,
  botUserId,
}: {
  event: AgentEvent;
  index: number;
  array: AgentEvent[];
  renderer?: React.ComponentType<{
    event: AgentEvent;
    estateId: string;
    currentUser: { name: string; email: string; image?: string | null };
    botUserId?: string;
  }>;
  onEventClick?: (eventIndex: number) => void;
  estateId: string;
  currentUser: { name: string; email: string; image?: string | null };
  botUserId?: string;
}): React.ReactElement {
  const label = event.type || "Core Event";
  const getDate = (ev: AgentEvent) => new Date(ev.createdAt);
  const date = getDate(event);
  const msSinceLast = date.getTime() - getDate(array[index - 1] ?? event).getTime();
  const msSinceFirst = date.getTime() - getDate(array[0]).getTime();

  return (
    <div className="mb-2">
      <div className="w-full flex items-center justify-end text-xs text-muted-foreground/70 mb-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="flex items-center gap-2 cursor-pointer group py-0.5 px-1 rounded hover:bg-muted/30 hover:text-muted-foreground"
              onClick={() => onEventClick?.(event.eventIndex ?? 0)}
            >
              {index > 0 && (
                <span
                  title={`${msSinceLast}ms since previous event`}
                  className={clsx(
                    "text-[10px] opacity-60 group-hover:opacity-100 font-mono",
                    getTimeDeltaColor(msSinceLast),
                  )}
                >
                  +{msSinceLast.toLocaleString()}ms
                </span>
              )}
              <span className="font-mono text-[11px]">{label}</span>
              <span
                title={`${msSinceFirst / 1000}s since first`}
                className="text-[10px] opacity-60 group-hover:opacity-100"
              >
                ⏱️ {msSinceFirst / 1000}s
              </span>
              <span className="text-[10px] opacity-60 group-hover:opacity-100">
                {date.toISOString()}
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Show raw event as well as reduced state after that event</p>
          </TooltipContent>
        </Tooltip>
      </div>

      {Renderer && (
        <div>
          <Renderer
            event={event}
            estateId={estateId}
            currentUser={currentUser}
            botUserId={botUserId}
          />
        </div>
      )}
    </div>
  );
}

// Event Details Content Component for PagerDialog
function EventDetailsContent({
  event,
  estateId,
  agentInstanceName,
  agentClassName,
}: {
  event: AgentEvent;
  estateId: string;
  agentInstanceName: string;
  agentClassName: "IterateAgent" | "SlackAgent";
}) {
  const eventIndex = event.eventIndex;

  const trpc = useTRPC();

  // Get reduced state at this event index
  const reducedStateQuery = useQuery(
    trpc.agents.getReducedStateAtEventIndex.queryOptions(
      {
        estateId,
        agentInstanceName,
        agentClassName: agentClassName,
        eventIndex: eventIndex,
      },
      { enabled: eventIndex !== undefined },
    ),
  );

  return (
    <Tabs defaultValue="event" className="flex flex-col h-full">
      <TabsList className="w-fit">
        <TabsTrigger value="event">Raw Event Data</TabsTrigger>
        <TabsTrigger value="state">Reduced State</TabsTrigger>
      </TabsList>

      <TabsContent value="event" className="flex-1 overflow-auto">
        <SerializedObjectCodeBlock data={event} className="h-full" />
      </TabsContent>

      <TabsContent value="state" className="flex-1 overflow-auto">
        {reducedStateQuery.isLoading ? (
          <div className="flex items-center justify-center h-full bg-muted rounded-lg">
            <Clock className="h-4 w-4 animate-spin mr-2" />
            <span className="text-sm text-muted-foreground">Loading reduced state...</span>
          </div>
        ) : reducedStateQuery.isSuccess ? (
          <AgentReducedState reducedState={reducedStateQuery.data as never} className="h-full" />
        ) : (
          <div className="text-xs bg-muted p-4 rounded-lg h-full flex items-center justify-center">
            <span className="text-muted-foreground">
              Failed to load reduced state{" "}
              {reducedStateQuery.error?.message || `Status: ${reducedStateQuery.status}`}
            </span>
          </div>
        )}
      </TabsContent>
    </Tabs>
  );
}

// Tool Call Injector Component
interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, any>;
}

// JSON Schema Form Field Component
function JsonSchemaFormField({
  name,
  schema,
  value,
  onChange,
  required = false,
}: {
  name: string;
  schema: any;
  value: any;
  onChange: (value: any) => void;
  required?: boolean;
}) {
  const { type, description, enum: enumValues, default: defaultValue } = schema;

  const handleChange = (newValue: any) => {
    // Convert string inputs to appropriate types
    if (type === "number" || type === "integer") {
      const numValue = parseFloat(newValue);
      onChange(isNaN(numValue) ? undefined : numValue);
    } else if (type === "boolean") {
      onChange(newValue === "true" || newValue === true);
    } else {
      onChange(newValue || undefined);
    }
  };

  if (enumValues && Array.isArray(enumValues)) {
    // Enum/Select field
    return (
      <div className="space-y-2">
        <Label className="text-sm font-medium">
          {name} {required && <span className="text-red-500">*</span>}
        </Label>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
        <Select value={value?.toString() || ""} onValueChange={handleChange}>
          <SelectTrigger>
            <SelectValue placeholder="Select an option..." />
          </SelectTrigger>
          <SelectContent>
            {!required && (
              <SelectItem value="">
                <span className="text-muted-foreground">None</span>
              </SelectItem>
            )}
            {enumValues.map((option) => (
              <SelectItem key={option} value={option.toString()}>
                {option.toString()}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }

  if (type === "boolean") {
    // Boolean/Checkbox field
    return (
      <div className="space-y-2">
        <div className="flex items-center space-x-2">
          <Checkbox
            id={name}
            checked={value === true}
            onCheckedChange={(checked) => handleChange(checked)}
          />
          <Label htmlFor={name} className="text-sm font-medium">
            {name} {required && <span className="text-red-500">*</span>}
          </Label>
        </div>
        {description && <p className="text-xs text-muted-foreground ml-6">{description}</p>}
      </div>
    );
  }

  if (type === "string" && (schema.maxLength > 100 || !schema.maxLength)) {
    // Large text area
    return (
      <div className="space-y-2">
        <Label htmlFor={name} className="text-sm font-medium">
          {name} {required && <span className="text-red-500">*</span>}
        </Label>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
        <Textarea
          id={name}
          value={value || ""}
          onChange={(e) => handleChange(e.target.value)}
          placeholder={defaultValue?.toString() || ""}
          className="min-h-[80px]"
        />
      </div>
    );
  }

  // Default: Input field for strings, numbers, etc.
  return (
    <div className="space-y-2">
      <Label htmlFor={name} className="text-sm font-medium">
        {name} {required && <span className="text-red-500">*</span>}
      </Label>
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
      <Input
        id={name}
        type={type === "number" || type === "integer" ? "number" : "text"}
        value={value?.toString() || ""}
        onChange={(e) => handleChange(e.target.value)}
        placeholder={defaultValue?.toString() || ""}
        step={type === "number" ? "any" : undefined}
      />
    </div>
  );
}

function ToolCallInjector({
  estateId,
  agentInstanceName,
  agentClassName,
  reducedState,
  onClose,
}: {
  estateId: string;
  agentInstanceName: string;
  agentClassName: "IterateAgent" | "SlackAgent";
  reducedState: any;
  onClose: () => void;
}) {
  const [selectedToolIndex, setSelectedToolIndex] = useState<number | null>(null);
  const [formData, setFormData] = useState<Record<string, any>>({});
  const [triggerLLMRequest, setTriggerLLMRequest] = useState(true);

  const trpc = useTRPC();

  const injectToolCallMutation = useMutation(
    trpc.agents.injectToolCall.mutationOptions({
      onSuccess: () => {
        onClose();
      },
      onError: (error) => {
        console.error("Failed to inject tool call:", error);
      },
    }),
  );

  // Extract function tools from reduced state
  const availableTools = useMemo((): ToolDefinition[] => {
    if (!reducedState?.runtimeTools) {
      return [];
    }

    return reducedState.runtimeTools
      .filter((tool: any) => tool.type === "function")
      .map(
        (tool: any): ToolDefinition => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters || {},
        }),
      );
  }, [reducedState]);

  const selectedTool = selectedToolIndex !== null ? availableTools[selectedToolIndex] : null;

  const handleExecuteTool = async () => {
    if (!selectedTool) {
      return;
    }

    // Filter out undefined values and clean the form data
    const cleanedFormData = Object.fromEntries(
      Object.entries(formData).filter(([, value]) => value !== undefined && value !== ""),
    );

    injectToolCallMutation.mutate({
      estateId,
      agentInstanceName,
      agentClassName,
      toolName: selectedTool.name,
      args: cleanedFormData,
      triggerLLMRequest,
    });
  };

  // Reset form data when tool changes
  useEffect(() => {
    if (selectedTool) {
      const initialData: Record<string, any> = {};
      const params = selectedTool.parameters;

      if (params?.properties) {
        Object.entries(params.properties).forEach(([key, schema]: [string, any]) => {
          if (schema.default !== undefined) {
            initialData[key] = schema.default;
          }
        });
      }

      setFormData(initialData);
    }
  }, [selectedTool]);

  useEffect(() => {
    if (availableTools.length > 0 && selectedToolIndex === null) {
      setSelectedToolIndex(0);
    }
  }, [availableTools.length, selectedToolIndex]);

  return (
    <div className="py-4">
      <h2 className="text-lg font-semibold mb-4">Inject Tool Call</h2>

      {availableTools.length === 0 ? (
        <p className="text-sm text-muted-foreground">No function tools available for injection.</p>
      ) : (
        <div className="flex gap-4 h-[calc(80vh-12rem)]">
          {/* Tool selector */}
          <Card className="w-80 flex-shrink-0 p-0 flex flex-col">
            <div className="p-4 flex flex-col h-full">
              <h3 className="font-medium mb-3 flex-shrink-0">Available Tools</h3>
              <div className="space-y-1 flex-1 overflow-y-auto pr-2">
                {availableTools.map((tool, index) => (
                  <button
                    key={tool.name}
                    onClick={() => setSelectedToolIndex(index)}
                    className={`w-full text-left p-3 rounded-lg border transition-colors ${
                      selectedToolIndex === index
                        ? "bg-primary/10 border-primary"
                        : "hover:bg-muted/50 border-border"
                    }`}
                  >
                    <div className="font-medium text-sm">{tool.name}</div>
                    {tool.description && (
                      <div className="text-xs text-muted-foreground mt-1 line-clamp-2">
                        {tool.description}
                      </div>
                    )}
                  </button>
                ))}
              </div>
            </div>
          </Card>

          {/* Tool configuration */}
          <Card className="flex-1 p-0">
            <div className="p-4 h-full flex flex-col">
              {selectedTool ? (
                <>
                  <h3 className="font-medium mb-3">{selectedTool.name}</h3>
                  {selectedTool.description && (
                    <p className="text-sm text-muted-foreground mb-4">{selectedTool.description}</p>
                  )}

                  <div className="flex-1 flex flex-col min-h-0">
                    {(() => {
                      const params = selectedTool.parameters;

                      // Check if there are any parameters
                      if (!params?.properties || Object.keys(params.properties).length === 0) {
                        return (
                          <div className="flex-1 flex items-center justify-center text-center py-8">
                            <div>
                              <p className="text-sm text-muted-foreground">
                                This tool does not require any parameters.
                              </p>
                            </div>
                          </div>
                        );
                      }

                      const requiredFields = params.required || [];

                      return (
                        <div className="space-y-4 flex-1 overflow-y-auto pr-2">
                          <div className="text-sm font-medium text-muted-foreground mb-3">
                            Parameters
                          </div>
                          {Object.entries(params.properties).map(
                            ([fieldName, fieldSchema]: [string, any]) => (
                              <JsonSchemaFormField
                                key={fieldName}
                                name={fieldName}
                                schema={fieldSchema}
                                value={formData[fieldName]}
                                onChange={(value) => {
                                  setFormData((prev) => ({
                                    ...prev,
                                    [fieldName]: value,
                                  }));
                                }}
                                required={requiredFields.includes(fieldName)}
                              />
                            ),
                          )}
                        </div>
                      );
                    })()}
                  </div>

                  <div className="mt-4 pt-4 border-t flex-shrink-0">
                    <div className="flex items-center space-x-2 mb-4">
                      <Checkbox
                        id="trigger-llm"
                        checked={triggerLLMRequest}
                        onCheckedChange={(checked) => setTriggerLLMRequest(checked as boolean)}
                      />
                      <Label htmlFor="trigger-llm" className="text-sm">
                        Trigger LLM request after tool execution
                      </Label>
                    </div>

                    <div className="flex gap-2 justify-end">
                      <Button variant="outline" onClick={onClose}>
                        Cancel
                      </Button>
                      <Button
                        onClick={handleExecuteTool}
                        disabled={injectToolCallMutation.isPending}
                      >
                        {injectToolCallMutation.isPending && (
                          <Clock className="mr-2 h-4 w-4 animate-spin" />
                        )}
                        Execute Tool
                      </Button>
                    </div>
                  </div>
                </>
              ) : (
                <div className="flex items-center justify-center h-full">
                  <p className="text-muted-foreground">Select a tool to configure</p>
                </div>
              )}
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

// Parallel Tool Group Component (similar to old project)
function ParallelToolGroup({
  llmRequestStartEventIndex,
  toolCalls,
  children,
}: {
  llmRequestStartEventIndex: number;
  toolCalls: Array<{
    event: AgentEvent;
    originalIndex: number;
  }>;
  children: React.ReactNode;
}) {
  const [isOpen, setIsOpen] = useState(true);

  const totalExecutionTime =
    toolCalls.length > 0
      ? Math.max(...toolCalls.map((call) => (call.event.data as any).executionTimeMs || 0))
      : 0;

  const successCount = toolCalls.filter((call) => (call.event.data as any).result.success).length;
  const errorCount = toolCalls.length - successCount;

  return (
    <Card className="mb-3 border-blue-200 dark:border-blue-800 bg-blue-50/30 dark:bg-blue-950/30 p-0">
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <CollapsibleTrigger className="w-full">
          <div className="p-3 cursor-pointer hover:bg-blue-100/50 dark:hover:bg-blue-900/50 transition-colors">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Zap className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                <div className="text-left">
                  <div className="font-medium text-sm">
                    Parallel Tool Execution
                    <code className="ml-2 text-xs bg-blue-200 dark:bg-blue-800 px-1.5 py-0.5 rounded font-mono">
                      {llmRequestStartEventIndex}
                    </code>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {toolCalls.length} tools executed simultaneously
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2">
                {/* Success/Error summary */}
                <div className="flex gap-1">
                  {successCount > 0 && (
                    <Badge
                      variant="outline"
                      className="text-xs bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
                    >
                      {successCount} ✓
                    </Badge>
                  )}
                  {errorCount > 0 && (
                    <Badge
                      variant="outline"
                      className="text-xs bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200"
                    >
                      {errorCount} ✗
                    </Badge>
                  )}
                </div>

                {/* Total execution time */}
                {totalExecutionTime > 0 && (
                  <Badge variant="outline" className="text-xs font-mono">
                    {totalExecutionTime < 1000
                      ? `${totalExecutionTime}ms`
                      : `${(totalExecutionTime / 1000).toFixed(2)}s`}{" "}
                    total
                  </Badge>
                )}

                <ChevronDown className="h-4 w-4 transition-transform data-[state=open]:rotate-180" />
              </div>
            </div>
          </div>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="px-3 pb-3 pt-0">
            <div className="space-y-1 border-t pt-2">{children}</div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

// Core event renderer component
function CoreEventRenderer({
  event,
  estateId,
  currentUser,
  botUserId,
}: {
  event: AgentEvent;
  estateId: string;
  currentUser: { name: string; email: string; image?: string | null };
  botUserId?: string;
}): React.ReactElement | null {
  if (!event) {
    return null;
  }

  switch (event.type) {
    case "CORE:INITIALIZED_WITH_EVENTS": {
      return (
        <div className="flex items-center gap-2 my-2 text-purple-600 dark:text-purple-400">
          <div className="flex-1 h-px bg-purple-200 dark:bg-purple-800/50" />
          <span className="text-xs">
            Agent Durable Object woke from hibernation with {event.data.eventCount} events
          </span>
          <div className="flex-1 h-px bg-purple-200 dark:bg-purple-800/50" />
        </div>
      );
    }

    case "CORE:INTERNAL_ERROR": {
      return (
        <Alert variant="destructive" className="mb-4 bg-muted/30">
          <AlertDescription>
            <div className="space-y-3">
              <div className="font-semibold">Internal Error</div>
              <div className="font-mono text-sm whitespace-pre-wrap">{event.data.error}</div>
              {event.data.stack && (
                <details className="cursor-pointer">
                  <summary className="font-semibold hover:opacity-80 text-sm">
                    Stack Trace (click to expand)
                  </summary>
                  <pre className="mt-2 p-3 rounded text-xs overflow-x-auto whitespace-pre-wrap border">
                    {event.data.stack}
                  </pre>
                </details>
              )}
            </div>
          </AlertDescription>
        </Alert>
      );
    }

    case "CORE:LLM_REQUEST_CANCEL": {
      return (
        <Alert variant="destructive" className="mb-4 bg-muted/30">
          <StopCircle className="h-4 w-4" />
          <AlertDescription>
            <div className="space-y-2">
              <div className="font-semibold text-sm">LLM request cancelled</div>
              <div className="text-sm">{event.data.reason}</div>
            </div>
          </AlertDescription>
        </Alert>
      );
    }

    case "CORE:LLM_OUTPUT_ITEM":
    case "CORE:LLM_INPUT_ITEM": {
      const data = event.data;

      // Use the MessageRenderer component for conversation items
      return <MessageRenderer data={data} createdAt={event.createdAt} currentUser={currentUser} />;
    }

    case "CORE:SET_SYSTEM_PROMPT":
      return <ExpandableSystemPromptAlert prompt={event.data.prompt} />;

    case "CORE:SET_MODEL_OPTS":
      return (
        <Alert className="mb-4 bg-muted/30 border-blue-200 dark:border-blue-800">
          <Settings className="h-4 w-4 text-blue-600 dark:text-blue-400" />
          <AlertDescription>
            <div className="font-semibold mb-2">Model Configuration Updated</div>
            <div className="space-y-1 text-sm">
              <div>
                <span className="font-medium">Model:</span> {event.data.model}
              </div>
              {event.data.temperature !== undefined && (
                <div>
                  <span className="font-medium">Temperature:</span> {event.data.temperature}
                </div>
              )}
            </div>
          </AlertDescription>
        </Alert>
      );

    case "CORE:PARTICIPANT_JOINED":
      return (
        <Alert className="mb-4 bg-muted/30 border-green-200 dark:border-green-800">
          <Users className="h-4 w-4 text-green-600 dark:text-green-400" />
          <AlertDescription>
            <div className="font-semibold mb-2">Participant Joined</div>
            <div className="space-y-1 text-sm">
              <div>User ID: {event.data.internalUserId}</div>
              {event.data.email && <div>Email: {event.data.email}</div>}
              {event.data.displayName && <div>Name: {event.data.displayName}</div>}
              <div className="text-xs text-muted-foreground">
                User has joined the agent conversation
              </div>
            </div>
          </AlertDescription>
        </Alert>
      );

    case "CORE:PARTICIPANT_LEFT":
      return (
        <Alert className="mb-4 bg-muted/30 border-orange-200 dark:border-orange-800">
          <Users className="h-4 w-4 text-orange-600 dark:text-orange-400" />
          <AlertDescription>
            <div className="font-semibold mb-2">Participant Left</div>
            <div className="space-y-1 text-sm">
              <div>User ID: {event.data.internalUserId}</div>
              <div className="text-xs text-muted-foreground">
                User has left the agent conversation
              </div>
            </div>
          </AlertDescription>
        </Alert>
      );

    case "CORE:FILE_SHARED": {
      const { direction, iterateFileId, originalFilename, mimeType, size, openAIFileId } =
        event.data;
      const isFromUser = direction === "from-user-to-agent";
      const isImage = mimeType?.startsWith("image/");

      // Format file size
      const formatFileSize = (bytes: number): string => {
        if (bytes === 0) {
          return "0 B";
        }
        const sizes = ["B", "KB", "MB", "GB"];
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return `${(bytes / 1024 ** i).toFixed(1)} ${sizes[i]}`;
      };

      return (
        <Alert className="mb-4 bg-muted/30 border-blue-200 dark:border-blue-800">
          <Paperclip className="h-4 w-4 text-blue-600 dark:text-blue-400" />
          <AlertDescription>
            <div className="font-semibold mb-2">
              {isFromUser ? "File Shared with Agent" : "File Shared by Agent"}
            </div>

            {/* Display image if it's an image file */}
            {isImage && (
              <div className="mb-3">
                <img
                  src={`/api/estate/${estateId}/files/${iterateFileId}`}
                  alt={originalFilename || "Shared image"}
                  className="max-w-full h-auto rounded border"
                  style={{ maxHeight: "400px" }}
                  onError={(e) => {
                    // If image fails to load, show fallback text
                    e.currentTarget.style.display = "none";
                    if (e.currentTarget.nextElementSibling) {
                      (e.currentTarget.nextElementSibling as HTMLElement).style.display = "block";
                    }
                  }}
                />
                <div className="text-sm text-muted-foreground mt-1" style={{ display: "none" }}>
                  [Image failed to load]
                </div>
              </div>
            )}

            <div className="space-y-1 text-sm">
              {originalFilename && (
                <div className="flex items-center gap-2">
                  <span className="font-medium text-muted-foreground">Filename:</span>
                  <span className="font-mono text-xs bg-muted px-2 py-0.5 rounded">
                    {originalFilename}
                  </span>
                </div>
              )}
              {mimeType && (
                <div className="flex items-center gap-2">
                  <span className="font-medium text-muted-foreground">Type:</span>
                  <span>{mimeType}</span>
                </div>
              )}
              {size && (
                <div className="flex items-center gap-2">
                  <span className="font-medium text-muted-foreground">Size:</span>
                  <span>{formatFileSize(size)}</span>
                </div>
              )}
              <div className="flex items-center gap-2">
                <span className="font-medium text-muted-foreground">ID:</span>
                <span className="font-mono text-xs">{iterateFileId}</span>
              </div>
              {openAIFileId && (
                <div className="flex items-center gap-2">
                  <span className="font-medium text-muted-foreground">OpenAI ID:</span>
                  <span className="font-mono text-xs">{openAIFileId}</span>
                </div>
              )}
            </div>
          </AlertDescription>
        </Alert>
      );
    }

    case "CORE:LOCAL_FUNCTION_TOOL_CALL": {
      const { call, result, executionTimeMs } = event.data;
      const isSuccess = result.success;

      // Parse the arguments string to an object
      let parsedArguments: Record<string, unknown> = {};
      try {
        parsedArguments = JSON.parse(call.arguments);
      } catch (_e) {
        // If parsing fails, show the raw string
        parsedArguments = { _raw: call.arguments };
      }

      // Map our state to the Tool component state format
      const toolState = isSuccess ? "output-available" : "output-error";

      return (
        <Tool defaultOpen={false}>
          <ToolHeader type={`tool-${call.name}` as `tool-${string}`} state={toolState} />
          <ToolContent>
            <ToolInput input={parsedArguments} />
            <ToolOutput
              output={isSuccess ? result.output : undefined}
              errorText={isSuccess ? undefined : result.error}
            />
            {executionTimeMs !== undefined && (
              <div className="px-4 pb-4">
                <div className="text-xs text-muted-foreground">
                  Execution time:{" "}
                  {executionTimeMs < 1000
                    ? `${executionTimeMs}ms`
                    : `${(executionTimeMs / 1000).toFixed(2)}s`}
                </div>
              </div>
            )}
          </ToolContent>
        </Tool>
      );
    }

    case "SLACK:WEBHOOK_EVENT_RECEIVED": {
      const payload = event.data.payload as SlackWebhookPayload;
      const slackEvent = payload?.event;

      if (!slackEvent) {
        return null;
      }

      // Check if this event is from the bot (agent) itself
      const isFromBot = botUserId && "user" in slackEvent && slackEvent.user === botUserId;

      // For message events, render as conversation messages
      if (slackEvent.type === "message" && "text" in slackEvent && slackEvent.text) {
        // Create message data similar to LLM messages
        const messageData = {
          type: "message" as const,
          role: isFromBot ? "assistant" : "user",
          content: [
            {
              type: "input_text" as const,
              text: slackEvent.text,
            },
          ],
        };

        // Use the existing MessageRenderer component
        return (
          <MessageRenderer
            data={messageData}
            createdAt={event.createdAt}
            currentUser={currentUser}
          />
        );
      }

      // For non-message events (reactions, etc.), show as expanded cards
      const isBot = isFromBot;
      const borderColor = isBot
        ? "border-purple-200 dark:border-purple-800"
        : "border-blue-200 dark:border-blue-800";
      const bgColor = isBot
        ? "bg-purple-50/30 dark:bg-purple-950/30"
        : "bg-blue-50/30 dark:bg-blue-950/30";
      const iconColor = isBot
        ? "text-purple-600 dark:text-purple-400"
        : "text-blue-600 dark:text-blue-400";
      const Icon = isBot ? Bot : Users;
      const title = isBot ? "Agent Slack Activity" : "User Slack Activity";

      // For reaction events, show as aligned message-like bubbles
      if (slackEvent.type === "reaction_added" || slackEvent.type === "reaction_removed") {
        const userName = isFromBot ? "@bot" : `@${slackEvent.user || "unknown"}`;
        const action = slackEvent.type === "reaction_added" ? "reacted with" : "removed reaction";
        const messageRef =
          "item" in slackEvent && slackEvent.item && "ts" in slackEvent.item
            ? slackEvent.item.ts
            : "unknown";

        const from = isFromBot ? "assistant" : "user";
        const userInitials = isFromBot
          ? "AI"
          : currentUser.name
              .split(" ")
              .map((name) => name.charAt(0))
              .join("")
              .toUpperCase()
              .slice(0, 2);

        return (
          <Message from={from} className="mb-4">
            <div className={`flex flex-col ${from === "assistant" ? "items-start" : "items-end"}`}>
              <div className="text-xs text-muted-foreground mb-1">
                {new Date(event.createdAt).toLocaleTimeString()}
              </div>
              <div
                className={`px-3 py-2 rounded-lg border-2 border-dashed text-sm ${
                  from === "assistant"
                    ? "bg-muted/30 border-muted-foreground/30"
                    : "bg-primary/5 border-primary/30"
                }`}
              >
                {userName} {action} {resolveEmoji(slackEvent.reaction)} to {messageRef}
              </div>
            </div>
            <MessageAvatar
              src={isFromBot ? "/logo.svg" : currentUser.image || ""}
              name={isFromBot ? "AI" : userInitials}
            />
          </Message>
        );
      }

      // For other non-message events, show expanded card
      return (
        <Card className={`mb-3 ${borderColor} ${bgColor} p-3`}>
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <Icon className={`h-4 w-4 ${iconColor}`} />
              <div>
                <div className="font-medium text-sm">{title}</div>
                <div className="text-xs text-muted-foreground">
                  {slackEvent.type}
                  {"subtype" in slackEvent && slackEvent.subtype && `: ${slackEvent.subtype}`}
                </div>
              </div>
            </div>
            <div className="text-sm">
              <strong>Slack event: {slackEvent.type}</strong>
              {"subtype" in slackEvent && slackEvent.subtype && (
                <span className="text-muted-foreground"> ({slackEvent.subtype})</span>
              )}
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                  View raw event data
                </summary>
                <SerializedObjectCodeBlock data={slackEvent} className="mt-2" />
              </details>
            </div>
            <div className="pt-2 border-t border-muted">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary" className="text-xs">
                  {slackEvent.type}
                  {"subtype" in slackEvent && slackEvent.subtype && `: ${slackEvent.subtype}`}
                </Badge>
                <Badge variant="outline" className="text-xs">
                  Channel:{" "}
                  {payload.event && "channel" in payload.event
                    ? typeof payload.event.channel === "string"
                      ? payload.event.channel.slice(-8) // Show last 8 chars for readability
                      : payload.event.channel.id?.slice(-8)
                    : "Unknown"}
                </Badge>
                <Badge variant="outline" className="text-xs">
                  Team: {payload.team_id?.slice(-8) || "Unknown"}
                </Badge>
              </div>
            </div>
          </div>
        </Card>
      );
    }

    default:
      return null;
  }
}

// Expandable system prompt alert
function ExpandableSystemPromptAlert({ prompt }: { prompt: string }) {
  const [isExpanded, setIsExpanded] = useState(false);

  const lines = prompt.split("\n");
  const hasMoreLines = lines.length > 3 || lines.slice(0, 3).join("\n").length !== prompt.length;
  const visibleContent = isExpanded ? prompt : lines.slice(0, 3).join("\n");

  return (
    <Alert className="mb-4 bg-muted/30 border-green-200 dark:border-green-800">
      <Bot className="h-4 w-4 text-green-600 dark:text-green-400" />
      <AlertDescription>
        <div className="space-y-2">
          <div className="font-semibold">System Prompt Set</div>
          <div>
            <pre className="whitespace-pre-wrap text-sm">{visibleContent}</pre>
          </div>
          {hasMoreLines && (
            <div className="pt-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setIsExpanded(!isExpanded)}
                className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground w-full justify-start"
              >
                {isExpanded ? (
                  <>
                    <ChevronUp className="h-3 w-3 mr-1" />
                    Show less
                  </>
                ) : (
                  <>
                    <ChevronDown className="h-3 w-3 mr-1" />
                    Show more
                  </>
                )}
              </Button>
            </div>
          )}
        </div>
      </AlertDescription>
    </Alert>
  );
}

// Pause/Resume Button Component
function PauseResumeButton({
  isPaused,
  onPauseResume,
  disabled,
}: {
  isPaused: boolean;
  onPauseResume: () => void;
  disabled: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={isPaused ? "destructive" : "ghost"}
          size="sm"
          onClick={onPauseResume}
          className={clsx("h-7 px-2", isPaused && "bg-red-500 hover:bg-red-600 text-white")}
          disabled={disabled}
        >
          {isPaused ? (
            <>
              <Play className="h-3 w-3 mr-1" />
              <span className="text-xs">Resume paused agent</span>
            </>
          ) : (
            <>
              <Pause className="h-3 w-3 mr-1" />
              <span className="text-xs">Pause agent</span>
            </>
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        <p>{isPaused ? "Resume LLM requests" : "Pause LLM requests"}</p>
      </TooltipContent>
    </Tooltip>
  );
}

// Simple File Upload Component
function FileUploadDialog({
  estateId,
  agentInstanceName,
  agentClassName,
  onClose,
}: {
  estateId: string;
  agentInstanceName: string;
  agentClassName: "IterateAgent" | "SlackAgent";
  onClose: () => void;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<Map<File, number>>(new Map());
  const fileInputRef = useRef<HTMLInputElement>(null);

  const trpc = useTRPC();
  const addEventsMutation = useMutation(trpc.agents.addEvents.mutationOptions({}));

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(e.target.files || []);
    setFiles((prev) => [...prev, ...selectedFiles]);
  };

  const removeFile = (fileToRemove: File) => {
    setFiles((prev) => prev.filter((f) => f !== fileToRemove));
  };

  const handleUpload = async () => {
    if (files.length === 0) {
      return;
    }

    setUploading(true);
    const uploadedFiles: Array<{
      file: File;
      iterateId: string;
      openAIFileId?: string;
      uploadedFileData?: {
        filename: string;
        fileSize?: number;
        mimeType?: string;
      };
    }> = [];

    try {
      // Upload each file
      for (const file of files) {
        const xhr = new XMLHttpRequest();

        await new Promise<void>((resolve, reject) => {
          xhr.upload.addEventListener("progress", (event) => {
            if (event.lengthComputable) {
              const progress = (event.loaded / event.total) * 100;
              setUploadProgress((prev) => new Map(prev).set(file, Math.min(progress, 95)));
            }
          });

          xhr.addEventListener("load", () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              try {
                const uploadedFile = JSON.parse(xhr.responseText) as {
                  id: string;
                  filename: string;
                  status: string;
                  fileSize?: number;
                  mimeType?: string;
                  openAIFileId?: string;
                };

                uploadedFiles.push({
                  file,
                  iterateId: uploadedFile.id,
                  openAIFileId: uploadedFile.openAIFileId,
                  uploadedFileData: {
                    filename: uploadedFile.filename,
                    fileSize: uploadedFile.fileSize,
                    mimeType: uploadedFile.mimeType,
                  },
                });

                setUploadProgress((prev) => new Map(prev).set(file, 100));
                resolve();
              } catch {
                reject(new Error("Failed to parse upload response"));
              }
            } else {
              reject(new Error(`Upload failed: ${xhr.statusText}`));
            }
          });

          xhr.addEventListener("error", () => {
            reject(new Error("Network error during upload"));
          });

          // Use the existing upload endpoint with estate ID
          xhr.open(
            "POST",
            `/api/estate/${estateId}/files?filename=${encodeURIComponent(file.name)}`,
          );
          xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
          xhr.send(file);
        });
      }

      // Create file sharing events
      const fileEvents = uploadedFiles.map(
        ({ file, iterateId, openAIFileId, uploadedFileData }) => ({
          type: "CORE:FILE_SHARED" as const,
          data: {
            direction: "from-user-to-agent" as const,
            iterateFileId: iterateId,
            originalFilename: uploadedFileData?.filename || file.name,
            mimeType: uploadedFileData?.mimeType || file.type,
            size: uploadedFileData?.fileSize || file.size,
            openAIFileId,
          },
        }),
      );

      // Submit the file sharing events
      await addEventsMutation.mutateAsync({
        estateId,
        agentInstanceName,
        agentClassName,
        events: fileEvents,
      });

      console.log(
        `Shared ${fileEvents.length} file${fileEvents.length > 1 ? "s" : ""} with the agent`,
      );
      onClose();
    } catch (error) {
      console.error("Error uploading files:", error);
    } finally {
      setUploading(false);
    }
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) {
      return "0 B";
    }
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / 1024 ** i).toFixed(1)} ${sizes[i]}`;
  };

  return (
    <div className="py-4">
      <h2 className="text-lg font-semibold mb-4">Upload Files</h2>

      <div className="space-y-4">
        {/* File input area */}
        <div
          className="border-2 border-dashed border-muted-foreground/25 rounded-lg p-8 text-center cursor-pointer hover:border-muted-foreground/50 transition-colors"
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
          <p className="text-sm font-medium">Click to browse files</p>
          <p className="text-xs text-muted-foreground mt-1">
            Support for images, documents, and other file types
          </p>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={handleFileSelect}
            className="hidden"
          />
        </div>

        {/* File list */}
        {files.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-sm font-medium">Selected Files ({files.length})</h3>
            <div className="space-y-2 max-h-40 overflow-y-auto">
              {files.map((file, index) => {
                const progress = uploadProgress.get(file) || 0;
                return (
                  <div key={index} className="flex items-center gap-2 p-2 border rounded">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{file.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {formatFileSize(file.size)} • {file.type || "Unknown type"}
                      </div>
                      {uploading && progress > 0 && (
                        <div className="w-full bg-muted rounded-full h-1 mt-1">
                          <div
                            className="bg-primary h-1 rounded-full transition-all"
                            style={{ width: `${progress}%` }}
                          />
                        </div>
                      )}
                    </div>
                    {!uploading && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => removeFile(file)}
                        className="h-6 w-6 p-0"
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-2 justify-end">
          <Button variant="outline" onClick={onClose} disabled={uploading}>
            Cancel
          </Button>
          <Button onClick={handleUpload} disabled={files.length === 0 || uploading}>
            {uploading ? (
              <>
                <Clock className="mr-2 h-4 w-4 animate-spin" />
                Uploading...
              </>
            ) : (
              `Upload ${files.length} file${files.length !== 1 ? "s" : ""}`
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function AgentsPage() {
  const params = useParams();
  const { agentClassName, durableObjectName } = params;
  const estateId = useEstateId();
  const getEstateUrl = useEstateUrl();
  const trpc = useTRPC();
  const { data: currentUser } = useSuspenseQuery(trpc.user.me.queryOptions());

  if (
    !(agentClassName === "IterateAgent" || agentClassName === "SlackAgent") ||
    !durableObjectName
  ) {
    throw new Error("Invalid agent class name or durable object name");
  }

  // State management
  const [message, setMessage] = useState("");
  const [messageRole, setMessageRole] = useState<"user" | "developer">("user");
  const [agentState, setAgentState] = useState<IterateAgentState | null>(null);
  const [filters, setFilters] = useState<FilterState>({ searchText: "" });
  const [selectedEventIndex, setSelectedEventIndex] = useState<number | null>(null);
  const [showToolInjector, setShowToolInjector] = useState(false);
  const [showFileUpload, setShowFileUpload] = useState(false);
  const [isWebsocketConnected, setIsWebsocketConnected] = useState(false);

  // Get initial events
  const { data: initialEvents } = useSuspenseQuery(
    trpc.agents.getEvents.queryOptions({
      estateId,
      agentInstanceName: durableObjectName,
      agentClassName,
    }),
  );

  const [events, setEvents] = useState<AgentEvent[]>(initialEvents as unknown as AgentEvent[]);

  // Connect to agent via WebSocket
  const agentConnection = useAgent({
    agent: "why-is-this-required-I-don't-need-to-use-it",
    basePath: `api/agents/${estateId}/${agentClassName}/${durableObjectName}`,
    onStateUpdate: (newState: IterateAgentState) => {
      setAgentState(newState);
    },
    onMessage: (message) => {
      const messageData = JSON.parse(message.data);
      if (messageData.type === "events_added") {
        setEvents(messageData.events);
      }
    },
  });

  // Check WebSocket connection status
  useEffect(() => {
    const checkConnectionStatus = () => {
      if (agentConnection && agentConnection.readyState === WebSocket.OPEN) {
        setIsWebsocketConnected(true);
      } else {
        setIsWebsocketConnected(false);
      }
    };

    checkConnectionStatus();
    const interval = setInterval(checkConnectionStatus, 1000);
    return () => clearInterval(interval);
  }, [agentConnection]);

  // Mutations
  const addEventsMutation = useMutation(trpc.agents.addEvents.mutationOptions({}));

  // Get current reduced state
  const { data: reducedState } = useQuery(
    trpc.agents.getReducedStateAtEventIndex.queryOptions(
      {
        estateId,
        agentInstanceName: durableObjectName,
        agentClassName,
        eventIndex: (events.length ?? 0) - 1,
      },
      {
        enabled: !!agentState,
      },
    ),
  );

  // Get Braintrust permalink
  const { data: braintrustPermalinkResult } = useQuery(
    trpc.agents.getBraintrustPermalink.queryOptions({
      estateId,
      agentInstanceName: durableObjectName,
      agentClassName,
    }),
  );

  const botUserId =
    agentClassName === "SlackAgent" && reducedState
      ? (reducedState as SlackSliceState).botUserId
      : undefined;

  // Filter events
  const filteredEvents = useMemo(() => {
    if (!filters.searchText.trim()) {
      return events;
    }
    return events.filter((event) => fulltextSearchInObject(event, filters.searchText.trim()));
  }, [events, filters.searchText]);

  // Group parallel tool calls together
  const groupedEvents = useMemo(() => {
    const groups: Array<{
      type: "single" | "parallel";
      event?: AgentEvent;
      events?: Array<{ event: AgentEvent; originalIndex: number }>;
      originalIndex?: number;
      llmRequestStartEventIndex?: number;
    }> = [];
    const processedIndices = new Set<number>();

    filteredEvents.forEach((event, index) => {
      if (processedIndices.has(index)) {
        return; // Already processed as part of a parallel group
      }

      // Check if this is a parallel tool call
      if (event.type === "CORE:LOCAL_FUNCTION_TOOL_CALL" && event.data.llmRequestStartEventIndex) {
        const llmRequestStartEventIndex = event.data.llmRequestStartEventIndex;

        // Find all events with the same LLM request start event index
        const parallelEvents: Array<{ event: AgentEvent; originalIndex: number }> = [];

        filteredEvents.forEach((otherEvent, otherIndex) => {
          if (
            otherEvent.type === "CORE:LOCAL_FUNCTION_TOOL_CALL" &&
            otherEvent.data.llmRequestStartEventIndex === llmRequestStartEventIndex
          ) {
            parallelEvents.push({ event: otherEvent, originalIndex: otherIndex });
            processedIndices.add(otherIndex);
          }
        });

        if (parallelEvents.length > 1) {
          // Sort by original order to maintain chronological sequence
          parallelEvents.sort((a, b) => a.originalIndex - b.originalIndex);

          groups.push({
            type: "parallel",
            llmRequestStartEventIndex,
            events: parallelEvents,
          });
        } else {
          // Single event, treat normally
          groups.push({
            type: "single",
            event,
            originalIndex: index,
          });
        }
      } else {
        // Non-parallel event
        groups.push({
          type: "single",
          event,
          originalIndex: index,
        });
      }
    });

    return groups;
  }, [filteredEvents]);

  // Handle pause/resume agent
  const handlePauseResume = (e?: React.MouseEvent) => {
    e?.preventDefault();
    e?.stopPropagation();

    const isPaused = reducedState && reducedState.paused;

    try {
      const event = {
        type: isPaused ? "CORE:RESUME_LLM_REQUESTS" : "CORE:PAUSE_LLM_REQUESTS",
      } as const;

      addEventsMutation.mutate({
        estateId,
        agentInstanceName: durableObjectName,
        agentClassName,
        events: [event],
      });
    } catch (error) {
      console.error("Error toggling agent pause state:", error);
    }
  };

  // Handle cancel LLM request
  const handleCancelLLMRequest = () => {
    try {
      const cancelEvent = {
        type: "CORE:LLM_REQUEST_CANCEL",
        data: {
          reason: "User requested cancellation",
        },
      } as const;

      addEventsMutation.mutate({
        estateId,
        agentInstanceName: durableObjectName,
        agentClassName,
        events: [cancelEvent],
      });
    } catch (error) {
      console.error("Error preparing cancel event:", error);
    }
  };

  // Handle event click for details - now uses filteredEvents index
  const handleEventClick = useCallback(
    (eventIndex: number) => {
      const arrayIndex = filteredEvents.findIndex((e) => e.eventIndex === eventIndex);
      if (arrayIndex >= 0) {
        setSelectedEventIndex(arrayIndex);
      }
    },
    [filteredEvents],
  );

  // Copy events as JSON
  const copyAllEventsAsJson = async () => {
    try {
      const jsonString = JSON.stringify(filteredEvents, null, 2);
      await navigator.clipboard.writeText(jsonString);
      console.log("Events copied to clipboard as JSON");
    } catch (error) {
      console.error("Failed to copy events to clipboard:", error);
    }
  };

  // Check if agent is thinking
  const isAgentThinking = reducedState
    ? isThinking(reducedState as unknown as CoreReducedState)
    : false;

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] overflow-hidden">
      {/* Breadcrumb navigation - Fixed height */}
      <div className="flex-shrink-0 flex items-center gap-2 py-2 px-4 border-b">
        <Link to={getEstateUrl("agents")}>
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Agents
          </Button>
        </Link>

        <div className="flex items-center gap-2 ml-auto">
          {/* Pause/Resume Agent Button */}
          <PauseResumeButton
            isPaused={reducedState?.paused || false}
            onPauseResume={handlePauseResume}
            disabled={addEventsMutation.isPending}
          />

          {/* WebSocket Status */}
          <Button variant="ghost" size="sm" className="h-7 px-2" disabled>
            <Circle
              className={clsx(
                "h-3 w-3 mr-1",
                isWebsocketConnected ? "text-green-500" : "text-red-500",
              )}
            />
            <span className="text-xs">{isWebsocketConnected ? "Connected" : "Disconnected"}</span>
          </Button>
        </div>
      </div>

      {/* Main content area - Flexible height */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Events feed - Scrollable area */}
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          {/* Search bar - Fixed height */}
          {events.length > 0 && (
            <div className="flex-shrink-0 px-4 py-2 border-b">
              <FilterBar
                value={filters.searchText}
                onChange={(searchText) => setFilters({ ...filters, searchText })}
                placeholder="Search events..."
                count={filteredEvents.length}
                onCopy={copyAllEventsAsJson}
                onBrainClick={
                  braintrustPermalinkResult?.permalink
                    ? () => {
                        window.open(braintrustPermalinkResult.permalink, "_blank");
                      }
                    : undefined
                }
              />
            </div>
          )}

          {/* Events list - Scrollable content */}
          <Conversation className="flex-1 overflow-y-auto overflow-x-hidden relative pr-2">
            <ConversationContent className="max-w-full px-4 py-2">
              {filteredEvents.length === 0 ? (
                <ConversationEmptyState
                  title={events.length === 0 ? "No events yet..." : "No events match the search"}
                  description={
                    events.length === 0
                      ? "Agent events will appear here as they occur"
                      : "Try adjusting your search terms"
                  }
                />
              ) : (
                <div className="space-y-1">
                  {groupedEvents.map((group, groupIndex) => {
                    if (group.type === "single") {
                      // Render single event normally
                      return (
                        <div
                          key={`${group.event?.type}-${(group.event as any)?.eventIndex || group.originalIndex}-${groupIndex}`}
                          className="max-w-full overflow-hidden"
                        >
                          <MetaEventWrapper
                            event={group.event!}
                            index={group.originalIndex!}
                            array={filteredEvents}
                            renderer={CoreEventRenderer}
                            onEventClick={handleEventClick}
                            estateId={estateId}
                            currentUser={currentUser}
                            botUserId={botUserId}
                          />
                        </div>
                      );
                    } else {
                      // Render parallel tool calls in a group
                      return (
                        <div
                          key={`parallel-${group.llmRequestStartEventIndex}-${groupIndex}`}
                          className="max-w-full overflow-hidden"
                        >
                          <ParallelToolGroup
                            llmRequestStartEventIndex={group.llmRequestStartEventIndex!}
                            toolCalls={group.events!}
                          >
                            {group.events!.map(({ event, originalIndex }) => (
                              <div
                                key={`parallel-${(event as any).eventIndex || originalIndex}-${originalIndex}`}
                              >
                                <MetaEventWrapper
                                  event={event}
                                  index={originalIndex}
                                  array={filteredEvents}
                                  renderer={CoreEventRenderer}
                                  onEventClick={handleEventClick}
                                  estateId={estateId}
                                  currentUser={currentUser}
                                  botUserId={botUserId}
                                />
                              </div>
                            ))}
                          </ParallelToolGroup>
                        </div>
                      );
                    }
                  })}
                </div>
              )}
            </ConversationContent>
            <ConversationScrollButton />
          </Conversation>
        </div>
      </div>

      {/* Message input - Fixed height */}
      <div className="flex-shrink-0 border-t bg-background">
        <div className="px-4 py-3">
          <PromptInput
            onSubmit={(promptMessage) => {
              if (!promptMessage.text?.trim()) {
                return;
              }

              const messageEvent = {
                type: "CORE:LLM_INPUT_ITEM" as const,
                data: {
                  type: "message" as const,
                  role: messageRole,
                  content: [
                    {
                      type: "input_text" as const,
                      text: promptMessage.text || "",
                    },
                  ],
                },
                triggerLLMRequest: true,
              } satisfies AgentCoreEventInput;

              addEventsMutation.mutate({
                estateId,
                agentInstanceName: durableObjectName,
                agentClassName,
                events: [messageEvent],
              });

              // Clear the input after successful submission
              setMessage("");
            }}
          >
            <PromptInputBody>
              <PromptInputTextarea
                placeholder="Message (Enter to send, Shift+Enter for newline)"
                disabled={addEventsMutation.isPending}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />

              <PromptInputToolbar>
                <PromptInputTools>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <PromptInputButton onClick={() => setShowToolInjector(true)}>
                        <Wrench className="h-4 w-4" />
                      </PromptInputButton>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>Inject tool call</p>
                    </TooltipContent>
                  </Tooltip>

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <PromptInputButton onClick={() => setShowFileUpload(true)}>
                        <Paperclip className="h-4 w-4" />
                      </PromptInputButton>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>Upload files</p>
                    </TooltipContent>
                  </Tooltip>
                </PromptInputTools>

                <div className="flex items-center gap-3">
                  <PromptInputModelSelect
                    value={messageRole}
                    onValueChange={(value: "user" | "developer") => setMessageRole(value)}
                  >
                    <PromptInputModelSelectTrigger className="w-36 h-7 text-xs">
                      <PromptInputModelSelectValue>
                        {messageRole === "user" ? "Role: User" : "Role: Developer"}
                      </PromptInputModelSelectValue>
                    </PromptInputModelSelectTrigger>
                    <PromptInputModelSelectContent>
                      <PromptInputModelSelectItem value="user">
                        Role: User
                      </PromptInputModelSelectItem>
                      <PromptInputModelSelectItem value="developer">
                        Role: Developer
                      </PromptInputModelSelectItem>
                    </PromptInputModelSelectContent>
                  </PromptInputModelSelect>

                  <Tooltip>
                    <TooltipTrigger asChild>
                      {(() => {
                        if (isAgentThinking) {
                          return (
                            <PromptInputButton
                              onClick={handleCancelLLMRequest}
                              variant="outline"
                              className={clsx(
                                "h-8 w-8 p-0 rounded-full relative overflow-hidden",
                                "after:absolute after:inset-0 after:rounded-full after:border-2 after:border-transparent",
                                "after:border-t-primary after:animate-spin",
                              )}
                            >
                              <Square className="h-3 w-3" />
                            </PromptInputButton>
                          );
                        } else {
                          return (
                            <PromptInputSubmit
                              disabled={addEventsMutation.isPending}
                              className="h-8 w-8 p-0 rounded-full"
                            >
                              <ArrowUp className="h-3 w-3" />
                            </PromptInputSubmit>
                          );
                        }
                      })()}
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{isAgentThinking ? "Stop LLM request" : "Send message (Enter)"}</p>
                    </TooltipContent>
                  </Tooltip>
                </div>
              </PromptInputToolbar>
            </PromptInputBody>
          </PromptInput>
        </div>
      </div>

      {/* Tool Injector Drawer */}
      <Drawer open={showToolInjector} onOpenChange={setShowToolInjector}>
        <DrawerContent className="h-[80vh] p-0">
          <div className="px-4 pb-4 h-full overflow-auto pr-6">
            <ToolCallInjector
              estateId={estateId}
              agentInstanceName={durableObjectName}
              agentClassName={agentClassName}
              reducedState={reducedState}
              onClose={() => setShowToolInjector(false)}
            />
          </div>
        </DrawerContent>
      </Drawer>

      {/* File Upload Drawer */}
      <Drawer open={showFileUpload} onOpenChange={setShowFileUpload}>
        <DrawerContent className="h-[80vh] p-0">
          <div className="px-4 pb-4 h-full overflow-auto pr-6">
            <FileUploadDialog
              estateId={estateId}
              agentInstanceName={durableObjectName}
              agentClassName={agentClassName}
              onClose={() => setShowFileUpload(false)}
            />
          </div>
        </DrawerContent>
      </Drawer>

      {/* Event Details Dialog */}
      {selectedEventIndex !== null && (
        <PagerDialog
          open={selectedEventIndex !== null}
          onOpenChange={(open) => !open && setSelectedEventIndex(null)}
          items={filteredEvents}
          selectedIndex={selectedEventIndex}
          onSelectedIndexChange={setSelectedEventIndex}
          title={(event, index) => (
            <span>
              {event.type || "Event"} – Event #{(event as any).eventIndex ?? "?"} – {index + 1} /{" "}
              {filteredEvents.length}
            </span>
          )}
          render={(event) => (
            <EventDetailsContent
              event={event}
              estateId={estateId}
              agentInstanceName={durableObjectName}
              agentClassName={agentClassName}
            />
          )}
          size="large"
        />
      )}

      {/* Error display */}
      {addEventsMutation.error && (
        <Alert variant="destructive" className="mt-4">
          <AlertDescription>
            <div className="font-semibold">Error sending message:</div>
            <div className="text-sm mt-1">
              {addEventsMutation.error instanceof Error
                ? addEventsMutation.error.message
                : "An unknown error occurred"}
            </div>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
