import { useCallback, useState, type FormEvent } from "react";
import {
  Bot,
  ChevronRight,
  Copy,
  Github,
  Mail,
  Pencil,
  Send,
  Slack,
  Star,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@iterate-com/ui/components/badge";
import { Button } from "@iterate-com/ui/components/button";
import { Input } from "@iterate-com/ui/components/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from "@iterate-com/ui/components/item";
import { Tooltip, TooltipContent, TooltipTrigger } from "@iterate-com/ui/components/tooltip";
import { toast } from "@iterate-com/ui/components/sonner";
import { cn } from "@iterate-com/ui/lib/utils";
import { AGENT_DISPLAY_STATE_PRESENTATION } from "./agent-presentation.ts";
import { agentNodeDisplayState, agentTitle, type AgentTreeNode } from "./agent-tree.ts";
import {
  deriveAgentDisplayState,
  type AgentBinding,
  type AgentRecord,
} from "~/domains/agents/agent-presence.ts";
import { formatTimeAgo } from "~/lib/format-relative-time.ts";

export type AgentVariant = "detail" | "catalog" | "sidebar";

export type AgentProps = {
  agent: AgentRecord;
  variant: AgentVariant;
  nowMs: number;
  tree?: Pick<
    AgentTreeNode,
    | "depth"
    | "children"
    | "aggregateRuntime"
    | "aggregateWaiting"
    | "aggregateLastWorkAt"
    | "aggregateAgentCount"
    | "aggregateActiveCount"
  > & { expanded: boolean };
  actions: {
    onOpen?: () => void;
    onTogglePinned: () => void | Promise<void>;
    onRename?: (title: string) => boolean | Promise<boolean>;
    onToggleChildren?: () => void;
  };
  shortcut?: boolean;
};

export function Agent({ agent, variant, nowMs, tree, actions, shortcut = false }: AgentProps) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [draftTitle, setDraftTitle] = useState(() => agentTitle(agent));
  const [updatingPin, setUpdatingPin] = useState(false);
  const detail = variant === "detail";
  const catalog = variant === "catalog";
  const sidebar = variant === "sidebar";
  const selfState = deriveAgentDisplayState(agent.runtime, agent.metadata.waitingFor);
  const selfRuntimeActive = deriveAgentDisplayState(agent.runtime) !== "idle";
  // A collapsed catalog/sidebar root represents its whole subtree. The
  // detail header represents the selected agent itself; descendants have
  // their own explicit summary immediately below it.
  const aggregateTree = detail ? undefined : tree;
  const displayState =
    aggregateTree === undefined ? selfState : agentNodeDisplayState(aggregateTree);
  const state = AGENT_DISPLAY_STATE_PRESENTATION[displayState];
  const StateIcon = state.icon;
  const BindingIcon = bindingIcon(agent.binding);
  const lastWorkAt = aggregateTree?.aggregateLastWorkAt ?? agent.timestamps.lastWorkAt;
  const descendantCount = Math.max(0, (tree?.aggregateAgentCount ?? 1) - 1);
  const activeDescendants = Math.max(
    0,
    (tree?.aggregateActiveCount ?? (selfRuntimeActive ? 1 : 0)) - (selfRuntimeActive ? 1 : 0),
  );
  const focusTitleInput = useCallback((node: HTMLInputElement | null) => node?.focus(), []);

  async function submitTitle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = draftTitle.trim();
    if (title === "" || actions.onRename === undefined) return;
    if (await actions.onRename(title)) setEditingTitle(false);
  }

  async function togglePinned() {
    if (updatingPin) return;
    setUpdatingPin(true);
    try {
      await actions.onTogglePinned();
    } finally {
      setUpdatingPin(false);
    }
  }

  async function copyPath() {
    try {
      if (navigator.clipboard === undefined) throw new Error("Clipboard access is unavailable.");
      await navigator.clipboard.writeText(agent.path);
      toast.success("Agent path copied.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not copy agent path.");
    }
  }

  return (
    <Item
      variant={detail || catalog ? "outline" : "default"}
      size={sidebar ? "xs" : detail ? "default" : "sm"}
      className={cn(
        "relative min-w-0 overflow-hidden",
        detail && "items-start p-4 sm:p-5",
        catalog && "bg-card/60",
        sidebar && "rounded-md border-0 px-1.5 hover:bg-sidebar-accent",
      )}
      data-agent-path={agent.path}
      data-agent-state={displayState}
      data-agent-variant={variant}
    >
      <span
        className={cn(
          "absolute inset-y-0 left-0 w-1",
          state.rail,
          state.active && "motion-safe:animate-pulse",
        )}
        aria-hidden
      />
      {tree !== undefined &&
      tree.children.length > 0 &&
      !shortcut &&
      actions.onToggleChildren !== undefined ? (
        <ItemMedia className={cn(sidebar ? "ml-0" : "ml-1")}>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={tree.expanded ? "Collapse child agents" : "Expand child agents"}
            aria-expanded={tree.expanded}
            onClick={(event) => {
              event.stopPropagation();
              actions.onToggleChildren?.();
            }}
          >
            <ChevronRight className={cn("transition-transform", tree.expanded && "rotate-90")} />
          </Button>
        </ItemMedia>
      ) : (
        <ItemMedia variant="icon" className={sidebar ? "ml-1" : "ml-2"}>
          {BindingIcon === Bot ? (
            <Bot className="text-muted-foreground" aria-hidden />
          ) : (
            <BindingIcon className="text-muted-foreground" aria-hidden />
          )}
        </ItemMedia>
      )}

      <ItemContent className="min-w-0">
        {editingTitle && detail ? (
          <form onSubmit={(event) => void submitTitle(event)} className="flex max-w-xl gap-2">
            <Input
              ref={focusTitleInput}
              value={draftTitle}
              onChange={(event) => setDraftTitle(event.target.value)}
              aria-label="Agent title"
            />
            <Button type="submit" size="sm">
              Save
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditingTitle(false)}>
              Cancel
            </Button>
          </form>
        ) : (
          <ItemTitle className={cn("max-w-full", detail && "text-lg")}>
            {actions.onOpen === undefined ? (
              <span className="min-w-0 truncate" title={agent.path}>
                {agentTitle(agent)}
              </span>
            ) : (
              <button
                type="button"
                className="min-w-0 truncate text-left hover:underline"
                onClick={actions.onOpen}
                title={agent.path}
              >
                {agentTitle(agent)}
              </button>
            )}
            {shortcut ? (
              <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
                Pinned
              </Badge>
            ) : null}
          </ItemTitle>
        )}

        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1 font-medium text-foreground/80">
            <StateIcon className={cn("size-3", state.active && "motion-safe:animate-pulse")} />
            {state.label}
          </span>
          {agent.binding === undefined ? null : <BindingBadge binding={agent.binding} />}
          {activeDescendants > 0 ? <span>{activeDescendants} active below</span> : null}
          {descendantCount > 0 ? (
            <span>
              {descendantCount} child agent{descendantCount === 1 ? "" : "s"}
            </span>
          ) : null}
          <time dateTime={lastWorkAt} title={lastWorkAt} className="tabular-nums">
            {formatTimeAgo(lastWorkAt, nowMs)}
          </time>
        </div>

        {agent.metadata.activity === undefined ? null : (
          <ItemDescription
            className={cn(sidebar && "line-clamp-1 text-[11px]", detail && "line-clamp-none")}
          >
            {agent.metadata.activity}
          </ItemDescription>
        )}
        {sidebar || agent.metadata.summary === undefined ? null : (
          <ItemDescription className={cn(detail ? "max-w-3xl line-clamp-none" : "line-clamp-2")}>
            {agent.metadata.summary}
          </ItemDescription>
        )}
        {sidebar ? null : <RuntimeCounts agent={agent} tree={aggregateTree} />}
      </ItemContent>

      <ItemActions className="ml-auto self-start">
        {detail && actions.onRename !== undefined && !editingTitle ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Rename agent"
                  onClick={(event) => {
                    event.stopPropagation();
                    setDraftTitle(agentTitle(agent));
                    setEditingTitle(true);
                  }}
                />
              }
            >
              <Pencil />
            </TooltipTrigger>
            <TooltipContent>Rename agent</TooltipContent>
          </Tooltip>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size={sidebar ? "icon-xs" : "icon-sm"}
                aria-label={agent.metadata.pinned ? "Unpin agent" : "Pin agent"}
                aria-pressed={agent.metadata.pinned}
                disabled={updatingPin}
                onClick={(event) => {
                  event.stopPropagation();
                  void togglePinned();
                }}
              />
            }
          >
            <Star className={cn(agent.metadata.pinned && "fill-amber-400 text-amber-500")} />
          </TooltipTrigger>
          <TooltipContent>{agent.metadata.pinned ? "Unpin agent" : "Pin agent"}</TooltipContent>
        </Tooltip>
      </ItemActions>

      {detail || catalog ? (
        <ItemFooter
          className={cn(
            "min-w-0 border-t pt-2 text-xs text-muted-foreground",
            detail && "w-full flex-col items-stretch gap-3",
          )}
        >
          <div className="flex min-w-0 items-start gap-2">
            {detail ? (
              <code className="min-w-0 flex-1 whitespace-normal break-all rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground/80">
                {agent.path}
              </code>
            ) : (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <code className="min-w-0 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]" />
                  }
                >
                  {agent.path}
                </TooltipTrigger>
                <TooltipContent>{agent.path}</TooltipContent>
              </Tooltip>
            )}
            {detail ? (
              <Button type="button" size="xs" variant="ghost" onClick={() => void copyPath()}>
                <Copy /> Copy path
              </Button>
            ) : null}
          </div>
          {detail ? <DetailTimestamps timestamps={agent.timestamps} nowMs={nowMs} /> : null}
        </ItemFooter>
      ) : null}
    </Item>
  );
}

/** Passive, cmdk-safe agent content. CommandItem remains the single
 * interactive option; pointer hit areas are marked for the owning option to
 * interpret without nesting buttons, links, or another listbox option. */
export function AgentCommandPresentation({
  expanded,
  node,
  nowMs,
  shortcut = false,
}: {
  expanded: boolean;
  node: AgentTreeNode;
  nowMs: number;
  shortcut?: boolean;
}) {
  const displayState = agentNodeDisplayState(node);
  const state = AGENT_DISPLAY_STATE_PRESENTATION[displayState];
  const activity = node.agent.metadata.activity;
  const childCount = node.aggregateAgentCount - 1;
  const hasChildren = node.children.length > 0;
  return (
    <>
      <span className="flex size-6 shrink-0 items-center justify-center" aria-hidden>
        {hasChildren && !shortcut ? (
          <span
            data-agent-disclosure
            className="-m-1 flex size-6 cursor-pointer items-center justify-center rounded hover:bg-muted"
            title={expanded ? "Collapse child agents" : "Expand child agents"}
          >
            <ChevronRight
              className={cn("size-3.5 transition-transform", expanded && "rotate-90")}
            />
          </span>
        ) : null}
        <span
          className={cn(
            "size-2 shrink-0 rounded-full",
            state.rail,
            hasChildren && !shortcut && "-ml-1 ring-2 ring-background",
          )}
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-medium">{agentTitle(node.agent)}</span>
          {shortcut ? <Star className="size-3 shrink-0 fill-amber-400 text-amber-500" /> : null}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="min-w-0 truncate" title={activity ?? node.agent.path}>
            {activity ?? node.agent.path}
          </span>
          {node.agent.binding === undefined ? null : (
            <BindingBadge binding={node.agent.binding} interactive={false} />
          )}
        </span>
      </span>
      <span className="shrink-0 text-right text-[10px] text-muted-foreground">
        <span className="block">{state.label}</span>
        <span className="block tabular-nums">{formatTimeAgo(node.aggregateLastWorkAt, nowMs)}</span>
      </span>
      {childCount > 0 ? (
        <span className="shrink-0 text-[10px] text-muted-foreground">{childCount} below</span>
      ) : null}
      <span
        data-agent-pin
        className="-m-1 flex size-7 shrink-0 cursor-pointer items-center justify-center rounded hover:bg-muted"
        title={node.agent.metadata.pinned ? "Unpin agent (Shift+P)" : "Pin agent (Shift+P)"}
        aria-hidden
      >
        <Star
          className={cn("size-3.5", node.agent.metadata.pinned && "fill-amber-400 text-amber-500")}
        />
      </span>
    </>
  );
}

function DetailTimestamps({
  timestamps,
  nowMs,
}: {
  timestamps: AgentRecord["timestamps"];
  nowMs: number;
}) {
  const entries = [
    ["Created", timestamps.createdAt],
    ["Last work", timestamps.lastWorkAt],
    ["Metadata updated", timestamps.metadataUpdatedAt],
    ["Activity updated", timestamps.activityUpdatedAt],
    ["Runtime updated", timestamps.runtimeUpdatedAt],
  ].filter((entry): entry is [string, string] => entry[1] !== undefined);
  return (
    <dl className="grid min-w-0 grid-cols-2 gap-x-5 gap-y-1 lg:grid-cols-3">
      {entries.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="text-[10px] font-medium uppercase tracking-wide">{label}</dt>
          <dd className="min-w-0 text-[11px] tabular-nums text-foreground/70">
            <time dateTime={value} title={value} aria-label={`${label}: ${value}`}>
              {formatTimeAgo(value, nowMs)}
            </time>
          </dd>
        </div>
      ))}
    </dl>
  );
}

function RuntimeCounts({ agent, tree }: { agent: AgentRecord; tree: AgentProps["tree"] }) {
  const runtime = tree?.aggregateRuntime ?? agent.runtime;
  const unreadyTriggers = Math.max(0, runtime.triggers.pending - runtime.triggers.runnable);
  const waiting = tree?.aggregateWaiting ?? {
    userInput: agent.metadata.waitingFor === "user_input" ? 1 : 0,
    externalEvent: agent.metadata.waitingFor === "external_event" ? 1 : 0,
    timer: agent.metadata.waitingFor === "timer" ? 1 : 0,
  };
  const counts = [
    runtime.runningScripts > 0
      ? `${runtime.runningScripts} script${runtime.runningScripts === 1 ? "" : "s"}`
      : null,
    runtime.llmRequests.started + runtime.llmRequests.requested > 0
      ? `${runtime.llmRequests.started + runtime.llmRequests.requested} model request${runtime.llmRequests.started + runtime.llmRequests.requested === 1 ? "" : "s"}`
      : null,
    runtime.llmRequests.scheduled + runtime.triggers.runnable > 0
      ? `${runtime.llmRequests.scheduled + runtime.triggers.runnable} queued`
      : null,
    unreadyTriggers > 0
      ? `${unreadyTriggers} pending trigger${unreadyTriggers === 1 ? "" : "s"}`
      : null,
    waiting !== undefined && waiting.userInput > 0 ? `${waiting.userInput} waiting for user` : null,
    waiting !== undefined && waiting.externalEvent > 0
      ? `${waiting.externalEvent} waiting externally`
      : null,
    waiting !== undefined && waiting.timer > 0 ? `${waiting.timer} waiting for timer` : null,
  ].filter((value): value is string => value !== null);
  if (counts.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 pt-0.5">
      {counts.map((count) => (
        <Badge key={count} variant="secondary" className="h-4 px-1.5 text-[10px] font-normal">
          {count}
        </Badge>
      ))}
    </div>
  );
}

function BindingBadge({
  binding,
  interactive = true,
}: {
  binding: AgentBinding;
  interactive?: boolean;
}) {
  const Icon = bindingIcon(binding);
  const label = bindingLabel(binding);
  const url = bindingUrl(binding);
  const content = (
    <Badge variant="outline" className="h-4 max-w-52 gap-1 px-1.5 text-[10px] font-normal">
      <Icon />
      <span className="truncate">{label}</span>
    </Badge>
  );
  if (!interactive || url === undefined) return content;
  return (
    <a href={url} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>
      {content}
    </a>
  );
}

function bindingIcon(binding: AgentBinding | undefined): LucideIcon {
  if (binding?.type === "slack_thread") return Slack;
  if (binding?.type === "telegram_thread") return Send;
  if (binding?.type === "email_thread") return Mail;
  if (binding?.type === "github_pull_request" || binding?.type === "github_check_run")
    return Github;
  return Bot;
}

function bindingLabel(binding: AgentBinding): string {
  switch (binding.type) {
    case "slack_thread":
      return `Slack · ${binding.channelName ?? binding.channelId}`;
    case "telegram_thread":
      return `Telegram · ${binding.chatId}`;
    case "email_thread":
      return `Email · ${binding.subject ?? binding.counterpart ?? binding.threadId}`;
    case "github_pull_request":
      return `GitHub · ${binding.owner}/${binding.repo} #${binding.number}`;
    case "github_check_run":
      return `GitHub check · ${binding.owner}/${binding.repo} #${binding.number}`;
  }
}

function bindingUrl(binding: AgentBinding): string | undefined {
  switch (binding.type) {
    case "slack_thread":
    case "github_pull_request":
    case "github_check_run":
      return binding.url;
    case "telegram_thread":
    case "email_thread":
      return undefined;
  }
}
