import { useState, useCallback, useMemo } from "react";
import {
  ArrowUp,
  Bot,
  Brain,
  ChevronDown,
  ChevronUp,
  Circle,
  Clock,
  Copy,
  Download,
  Paperclip,
  Pause,
  Play,
  Search,
  Settings,
  Square,
  StopCircle,
  User,
  Users,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import clsx from "clsx";
import type OpenAI from "openai";
import type {
  AgentCoreEvent,
  AugmentedCoreReducedState,
} from "../../backend/agent/agent-core-schemas.ts";
import type { SlackSliceEvent, SlackSliceState } from "../../backend/agent/slack-slice.ts";
import type { SlackWebhookPayload } from "../../backend/agent/slack.types.ts";
import { isThinking } from "../../backend/agent/agent-core-schemas.ts";
import { fulltextSearchInObject } from "../../backend/utils/type-helpers.ts";
import { resolveEmoji } from "../lib/emoji-mapping.ts";
import { Button } from "./ui/button.tsx";
import { Badge } from "./ui/badge.tsx";
import { Alert, AlertDescription } from "./ui/alert.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";
import { Message, MessageContent, MessageAvatar } from "./ai-elements/message.tsx";
import { Tool, ToolHeader, ToolContent, ToolInput, ToolOutput } from "./ai-elements/tool.tsx";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "./ai-elements/conversation.tsx";
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
} from "./ai-elements/prompt-input.tsx";
import { Reasoning, ReasoningTrigger, ReasoningContent } from "./ai-elements/reasoning.tsx";
import { Response } from "./ai-elements/response.tsx";
import { SerializedObjectCodeBlock } from "./serialized-object-code-block.tsx";
import { AgentReducedState } from "./agent-reduced-state.tsx";
import { PagerDialog } from "./pager-dialog.tsx";

type AgentEvent = AgentCoreEvent | SlackSliceEvent;

export interface AgentDetailDataGetters {
  getFileUrl: (iterateFileId: string, disposition?: "inline" | "attachment") => string;
  getReducedStateAtEventIndex: (
    eventIndex: number,
  ) => Promise<AugmentedCoreReducedState> | AugmentedCoreReducedState;
  getBraintrustPermalink: () => Promise<string | undefined> | string | undefined;
}

export interface AgentDetailActions {
  onSendMessage: (message: { text: string; role: "user" | "developer" }) => void | Promise<void>;
  onPauseResume: () => void | Promise<void>;
  onCancelLLMRequest: () => void | Promise<void>;
  onExport?: () => void | Promise<void>;
  onInjectToolCallClick: () => void;
  onUploadFilesClick: () => void;
}

export interface AgentDetailProps {
  events: AgentEvent[];
  estateId: string;
  agentClassName: string;
  reducedState: AugmentedCoreReducedState;
  isWebsocketConnected?: boolean;
  getters: AgentDetailDataGetters;
  actions?: AgentDetailActions;
  headerLeft?: React.ReactNode;
  isSendingMessage?: boolean;
  isExporting?: boolean;
}

const getTimeDeltaColor = (ms: number): string => {
  if (ms <= 100) return "text-gray-400";
  if (ms <= 500) return "text-gray-500";
  if (ms <= 1000) return "text-yellow-500";
  if (ms <= 3000) return "text-orange-500";
  return "text-red-500";
};

function MessageRenderer({
  data,
  createdAt,
}: {
  data: OpenAI.Responses.ResponseInputItem;
  createdAt: string;
}): React.ReactElement | null {
  if (!data || data.type !== "message") {
    return null;
  }

  const message = data;
  const from = message.role === "assistant" ? "assistant" : "user";

  const contentItems = Array.isArray(message.content)
    ? message.content
    : [{ type: "input_text", text: message.content }];

  return (
    <div className="mb-4">
      {contentItems.map((contentItem, idx) => {
        switch (contentItem.type) {
          case "input_text":
          case "output_text":
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
                  <MessageAvatar src="/logo.svg" name="iterate" />
                </Message>
              );
            } else {
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
                  <MessageAvatar icon={<User className="h-4 w-4" />} name="user" />
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
          case "input_file": {
            const icon = contentItem.type === "input_image" ? "🖼️" : "📎";
            const label = contentItem.type === "input_image" ? "Image" : "File";

            if (from === "assistant") {
              return (
                <Message key={`${contentItem.type}-${idx}`} from="assistant" className="mb-4">
                  <div className="flex flex-col items-start">
                    {createdAt && (
                      <div className="text-xs text-muted-foreground mb-1">
                        {new Date(createdAt).toLocaleTimeString()}
                      </div>
                    )}
                    <MessageContent variant="contained">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-lg">{icon}</span>
                        <Badge variant="outline" className="text-xs">
                          {label}
                        </Badge>
                      </div>
                      <div className="text-sm opacity-75">[{label} content not rendered]</div>
                    </MessageContent>
                  </div>
                  <MessageAvatar src="/logo.svg" name="iterate" />
                </Message>
              );
            } else {
              return (
                <Message key={`${contentItem.type}-${idx}`} from="user" className="mb-4">
                  <div className="flex flex-col items-end">
                    {createdAt && (
                      <div className="text-xs text-muted-foreground mb-1">
                        {new Date(createdAt).toLocaleTimeString()}
                      </div>
                    )}
                    <MessageContent variant="contained">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-lg">{icon}</span>
                        <Badge variant="outline" className="text-xs">
                          {label}
                        </Badge>
                      </div>
                      <div className="text-sm opacity-75">[{label} content not rendered]</div>
                    </MessageContent>
                  </div>
                  <MessageAvatar icon={<User className="h-4 w-4" />} name="user" />
                </Message>
              );
            }
          }
          default:
            return null;
        }
      })}
    </div>
  );
}

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

function MetaEventWrapper({
  event,
  index,
  array,
  renderer: Renderer,
  onEventClick,
  estateId,
  botUserId,
  getFileUrl,
}: {
  event: AgentEvent;
  index: number;
  array: AgentEvent[];
  renderer?: React.ComponentType<{
    event: AgentEvent;
    estateId: string;
    botUserId?: string;
    getFileUrl: (fileId: string, disposition?: "inline" | "attachment") => string;
  }>;
  onEventClick?: (eventIndex: number) => void;
  estateId: string;
  botUserId?: string;
  getFileUrl: (fileId: string, disposition?: "inline" | "attachment") => string;
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
            botUserId={botUserId}
            getFileUrl={getFileUrl}
          />
        </div>
      )}
    </div>
  );
}

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
    <div className="mb-3 border border-blue-200 dark:border-blue-800 bg-blue-50/30 dark:bg-blue-950/30 rounded-lg">
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <CollapsibleTrigger className="w-full">
          <div className="p-3 cursor-pointer hover:bg-blue-100/50 dark:hover:bg-blue-900/50 transition-colors rounded-lg">
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
    </div>
  );
}

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

function CoreEventRenderer({
  event,
  botUserId,
  getFileUrl,
}: {
  event: AgentEvent;
  estateId: string;
  botUserId?: string;
  getFileUrl: (fileId: string, disposition?: "inline" | "attachment") => string;
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
      const data = event.data as OpenAI.Responses.ResponseInputItem;
      return <MessageRenderer data={data} createdAt={event.createdAt} />;
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
              {event.data.role && (
                <div className="flex items-center gap-2">
                  <span>Role:</span>
                  <Badge
                    variant="outline"
                    className={clsx(
                      "text-xs",
                      event.data.role === "admin" &&
                        "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
                      event.data.role === "owner" &&
                        "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
                      event.data.role === "guest" &&
                        "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200",
                      event.data.role === "external" &&
                        "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200",
                      event.data.role === "member" &&
                        "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
                    )}
                  >
                    {event.data.role}
                  </Badge>
                </div>
              )}
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

            {isImage && (
              <div className="mb-3">
                <img
                  src={getFileUrl(iterateFileId, "inline")}
                  alt={originalFilename || "Shared image"}
                  className="max-w-full h-auto rounded border"
                  style={{ maxHeight: "400px" }}
                  onError={(e) => {
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

            <div className="mt-3 pt-3 border-t">
              <Button variant="outline" size="sm" asChild className="w-full sm:w-auto">
                <a
                  href={getFileUrl(iterateFileId, "attachment")}
                  download={originalFilename || "file"}
                >
                  <Download className="h-4 w-4 mr-2" />
                  Download File
                </a>
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      );
    }

    case "CORE:LOCAL_FUNCTION_TOOL_CALL": {
      const { call, result, executionTimeMs } = event.data;
      const isSuccess = result.success;

      let parsedArguments: Record<string, unknown> = {};
      try {
        parsedArguments = JSON.parse(call.arguments);
      } catch (_e) {
        parsedArguments = { _raw: call.arguments };
      }

      const toolState = isSuccess ? "output-available" : "output-error";

      return (
        <Tool defaultOpen={false}>
          <ToolHeader type={`tool-${call.name}`} state={toolState} />
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

      const isFromBot = botUserId && "user" in slackEvent && slackEvent.user === botUserId;

      if (slackEvent.type === "message" && "text" in slackEvent && slackEvent.text) {
        const messageData: OpenAI.Responses.ResponseInputItem = {
          type: "message",
          role: isFromBot ? "assistant" : "user",
          content: [
            {
              type: "input_text",
              text: slackEvent.text,
            },
          ],
        };

        return <MessageRenderer data={messageData} createdAt={event.createdAt} />;
      }

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

      if (slackEvent.type === "reaction_added" || slackEvent.type === "reaction_removed") {
        const userName = isFromBot ? "@bot" : `@${slackEvent.user || "unknown"}`;
        const action = slackEvent.type === "reaction_added" ? "reacted with" : "removed reaction";
        const messageRef =
          "item" in slackEvent && slackEvent.item && "ts" in slackEvent.item
            ? slackEvent.item.ts
            : "unknown";

        const from = isFromBot ? "assistant" : "user";

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
              src={isFromBot ? "/logo.svg" : undefined}
              icon={isFromBot ? undefined : <User className="h-4 w-4" />}
              name={isFromBot ? "iterate" : userName}
            />
          </Message>
        );
      }

      return (
        <div className={`mb-3 ${borderColor} ${bgColor} border rounded-lg p-3`}>
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
                      ? payload.event.channel.slice(-8)
                      : payload.event.channel.id?.slice(-8)
                    : "Unknown"}
                </Badge>
                <Badge variant="outline" className="text-xs">
                  Team: {payload.team_id?.slice(-8) || "Unknown"}
                </Badge>
              </div>
            </div>
          </div>
        </div>
      );
    }

    default:
      return null;
  }
}

function EventDetailsDialog({
  event,
  getReducedStateAtEventIndex,
}: {
  event: AgentEvent;
  getReducedStateAtEventIndex: (
    eventIndex: number,
  ) => Promise<AugmentedCoreReducedState> | AugmentedCoreReducedState;
}) {
  const [reducedState, setReducedState] = useState<AugmentedCoreReducedState | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useState(() => {
    const loadState = async () => {
      if (event.eventIndex !== undefined) {
        try {
          const result = await getReducedStateAtEventIndex(event.eventIndex);
          setReducedState(result);
        } finally {
          setIsLoading(false);
        }
      } else {
        setIsLoading(false);
      }
    };
    loadState();
  });

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
        {isLoading ? (
          <div className="flex items-center justify-center h-full bg-muted rounded-lg">
            <Clock className="h-4 w-4 animate-spin mr-2" />
            <span className="text-sm text-muted-foreground">Loading reduced state...</span>
          </div>
        ) : reducedState ? (
          <AgentReducedState reducedState={reducedState} className="h-full" />
        ) : (
          <div className="text-xs bg-muted p-4 rounded-lg h-full flex items-center justify-center">
            <span className="text-muted-foreground">Failed to load reduced state</span>
          </div>
        )}
      </TabsContent>
    </Tabs>
  );
}

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

export function AgentDetailRenderer({
  events,
  estateId,
  agentClassName,
  reducedState,
  isWebsocketConnected = false,
  getters,
  actions,
  headerLeft,
  isSendingMessage = false,
  isExporting = false,
}: AgentDetailProps) {
  const [message, setMessage] = useState("");
  const [messageRole, setMessageRole] = useState<"user" | "developer">("user");
  const [searchText, setSearchText] = useState("");
  const [selectedEventIndex, setSelectedEventIndex] = useState<number | null>(null);

  const filteredEvents = useMemo(() => {
    if (!searchText.trim()) {
      return events;
    }
    return events.filter((event) => fulltextSearchInObject(event, searchText.trim()));
  }, [events, searchText]);

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
        return;
      }

      if (event.type === "CORE:LOCAL_FUNCTION_TOOL_CALL" && event.data.llmRequestStartEventIndex) {
        const llmRequestStartEventIndex = event.data.llmRequestStartEventIndex;

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
          parallelEvents.sort((a, b) => a.originalIndex - b.originalIndex);

          groups.push({
            type: "parallel",
            llmRequestStartEventIndex,
            events: parallelEvents,
          });
        } else {
          groups.push({
            type: "single",
            event,
            originalIndex: index,
          });
        }
      } else {
        groups.push({
          type: "single",
          event,
          originalIndex: index,
        });
      }
    });

    return groups;
  }, [filteredEvents]);

  const handleEventClick = useCallback(
    (eventIndex: number) => {
      const arrayIndex = filteredEvents.findIndex((e) => e.eventIndex === eventIndex);
      if (arrayIndex >= 0) {
        setSelectedEventIndex(arrayIndex);
      }
    },
    [filteredEvents],
  );

  const copyAllEventsAsJson = async () => {
    try {
      const jsonString = JSON.stringify(filteredEvents, null, 2);
      await navigator.clipboard.writeText(jsonString);
    } catch (error) {
      console.error("Failed to copy events to clipboard:", error);
    }
  };

  const handleBraintrustClick = async () => {
    const permalink = await getters.getBraintrustPermalink();
    if (permalink) {
      window.open(permalink, "_blank");
    } else {
      window.alert("No Braintrust trace found for this agent");
    }
  };

  const handleSendMessage = () => {
    if (!message.trim() || !actions) {
      return;
    }

    actions.onSendMessage({ text: message, role: messageRole });
    setMessage("");
  };

  const isAgentThinking = reducedState ? isThinking(reducedState) : false;
  const botUserId =
    agentClassName === "SlackAgent" ? (reducedState as SlackSliceState).botUserId : undefined;

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] overflow-hidden -m-6">
      {/* Header */}
      <div className="flex-shrink-0 flex items-center gap-2 py-2 px-4 border-b">
        {headerLeft}

        <div className="flex items-center gap-2 ml-auto">
          {actions?.onExport && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={actions.onExport}
                  disabled={isExporting}
                  className="h-7 px-2"
                >
                  {isExporting ? (
                    <Clock className="h-3 w-3 mr-1 animate-spin" />
                  ) : (
                    <Download className="h-3 w-3 mr-1" />
                  )}
                  <span className="text-xs">Export</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>Export agent trace as zip archive</p>
              </TooltipContent>
            </Tooltip>
          )}

          {actions && (
            <PauseResumeButton
              isPaused={reducedState?.paused || false}
              onPauseResume={actions.onPauseResume}
              disabled={isSendingMessage}
            />
          )}

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

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Events feed */}
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          {events.length > 0 && (
            <div className="flex-shrink-0 px-4 py-2 border-b">
              <FilterBar
                value={searchText}
                onChange={setSearchText}
                placeholder="Search events..."
                count={filteredEvents.length}
                onCopy={copyAllEventsAsJson}
                onBrainClick={handleBraintrustClick}
              />
            </div>
          )}

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
                      return (
                        <div
                          key={`${group.event?.type}-${group.event?.eventIndex || group.originalIndex}-${groupIndex}`}
                          className="max-w-full overflow-hidden"
                        >
                          <MetaEventWrapper
                            event={group.event!}
                            index={group.originalIndex!}
                            array={filteredEvents}
                            renderer={CoreEventRenderer}
                            onEventClick={handleEventClick}
                            estateId={estateId}
                            botUserId={botUserId}
                            getFileUrl={getters.getFileUrl}
                          />
                        </div>
                      );
                    } else {
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
                              <div key={`parallel-${event.eventIndex}-${originalIndex}`}>
                                <MetaEventWrapper
                                  event={event}
                                  index={originalIndex}
                                  array={filteredEvents}
                                  renderer={CoreEventRenderer}
                                  onEventClick={handleEventClick}
                                  estateId={estateId}
                                  botUserId={botUserId}
                                  getFileUrl={getters.getFileUrl}
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

      {/* Message input */}
      {actions && (
        <div className="flex-shrink-0 border-t bg-background">
          <div className="px-4 py-3">
            <PromptInput onSubmit={handleSendMessage}>
              <PromptInputBody>
                <PromptInputTextarea
                  placeholder="Message (Enter to send, Shift+Enter for newline)"
                  disabled={isSendingMessage}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                />

                <PromptInputToolbar>
                  <PromptInputTools>
                    {actions.onInjectToolCallClick && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <PromptInputButton onClick={actions.onInjectToolCallClick}>
                            <Wrench className="h-4 w-4" />
                          </PromptInputButton>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>Inject tool call</p>
                        </TooltipContent>
                      </Tooltip>
                    )}

                    {actions.onUploadFilesClick && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <PromptInputButton onClick={actions.onUploadFilesClick}>
                            <Paperclip className="h-4 w-4" />
                          </PromptInputButton>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>Upload files</p>
                        </TooltipContent>
                      </Tooltip>
                    )}
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
                        {isAgentThinking ? (
                          <PromptInputButton
                            onClick={actions.onCancelLLMRequest}
                            variant="outline"
                            className={clsx(
                              "h-8 w-8 p-0 rounded-full relative overflow-hidden",
                              "after:absolute after:inset-0 after:rounded-full after:border-2 after:border-transparent",
                              "after:border-t-primary after:animate-spin",
                            )}
                          >
                            <Square className="h-3 w-3" />
                          </PromptInputButton>
                        ) : (
                          <PromptInputSubmit
                            disabled={isSendingMessage}
                            className="h-8 w-8 p-0 rounded-full"
                          >
                            <ArrowUp className="h-3 w-3" />
                          </PromptInputSubmit>
                        )}
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
      )}

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
              {event.type || "Event"} – Event #{event.eventIndex} – {index + 1} /{" "}
              {filteredEvents.length}
            </span>
          )}
          render={(event) => (
            <EventDetailsDialog
              event={event}
              getReducedStateAtEventIndex={getters.getReducedStateAtEventIndex}
            />
          )}
          size="large"
        />
      )}
    </div>
  );
}
