import { useCallback, useState, type FormEvent, type MouseEvent } from "react";
import { ChevronRight, Copy, Pencil, Star } from "lucide-react";
import { Badge } from "@iterate-com/ui/components/badge";
import { Button } from "@iterate-com/ui/components/button";
import { CommandItem } from "@iterate-com/ui/components/command";
import { Input } from "@iterate-com/ui/components/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@iterate-com/ui/components/tooltip";
import { toast } from "@iterate-com/ui/components/sonner";
import { cn } from "@iterate-com/ui/lib/utils";
import { agentCommandValue } from "../command-palette-model.ts";
import {
  AGENT_DISPLAY_STATE_PRESENTATION,
  agentCommandAccessibleLabel,
  bindingIcon,
  bindingLabel,
  bindingUrl,
  runtimeCountFragments,
} from "./agent-presentation.ts";
import {
  agentNodeDisplayState,
  agentNodeWaitingFor,
  agentTitle,
  type AgentTreeNode,
} from "./agent-tree.ts";
import type { AgentRuntimeTransition } from "~/domains/agents/agent-processor-contract.ts";
import {
  deriveAgentDisplayState,
  deriveAgentRuntimeDisplayState,
  type AgentBinding,
  type AgentDisplayState,
  type AgentRecord,
} from "~/domains/agents/agent-presence.ts";
import { formatElapsedSeconds } from "~/lib/feed-format.ts";
import { formatTimeAgo } from "~/lib/format-relative-time.ts";
import { useTickingNowMs } from "~/lib/use-ticking-now-ms.ts";

const LIVE_RUNTIME_TICK_MS = 100;

const AGENT_COMMAND_GRID =
  "grid-cols-[minmax(0,1fr)_6rem_1.75rem] sm:grid-cols-[minmax(12rem,2fr)_8rem_minmax(10rem,2fr)_1.75rem] lg:grid-cols-[minmax(12rem,2fr)_8rem_minmax(10rem,2fr)_6rem_1.75rem]";

const WAITING_FOR_LABEL = {
  user_input: "Needs input",
  external_event: "Waiting for external event",
  timer: "Waiting for timer",
} as const;

/**
 * Two-line sidebar shortcut: channel icon, title, live activity, and the
 * attention dot on the right. Pinning and every other control live in the
 * catalog and the agent state sheet; the full stream path is the tooltip.
 */
export function AgentSidebarRow({ node, onOpen }: { node: AgentTreeNode; onOpen: () => void }) {
  const agent = node.agent;
  const displayState = agentNodeDisplayState(node);
  const state = AGENT_DISPLAY_STATE_PRESENTATION[displayState];
  const BindingIcon = bindingIcon(agent.binding);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={onOpen}
            className="flex w-full items-start gap-2 rounded-md px-2 py-1 text-left hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            data-agent-path={agent.path}
            data-agent-state={displayState}
            data-agent-variant="sidebar"
          />
        }
      >
        <BindingIcon className="mt-1 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm">{agentTitle(agent)}</span>
            <StateDot state={state} className="size-1.5" />
          </span>
          {!agent.summary.activity ? null : (
            <span
              className={cn(
                "block truncate text-[11px] text-muted-foreground",
                state.active && "motion-safe:animate-pulse",
              )}
            >
              {agent.summary.activity}
            </span>
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent side="right">{agent.path}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Flat catalog list row: title and recency on the first line, state and
 * current activity on the second. The dot aggregates the whole collapsed
 * subtree; the chevron gutter is the only tree chrome.
 */
export function AgentListRow({
  node,
  nowMs,
  runtimeTransition,
  expanded,
  onOpen,
  onTogglePinned,
  onToggleChildren,
}: {
  node: AgentTreeNode;
  nowMs: number;
  runtimeTransition?: AgentRuntimeTransition;
  expanded: boolean;
  onOpen: () => void;
  onTogglePinned: () => void | Promise<unknown>;
  onToggleChildren?: () => void;
}) {
  const agent = node.agent;
  const runtime = runtimeTransition?.runtime ?? node.aggregateRuntime;
  const runtimeState = deriveAgentRuntimeDisplayState(runtime);
  const displayState = runtimeState === "idle" ? agentNodeDisplayState(node) : runtimeState;
  const waitingFor = expanded ? agent.summary.waitingFor : agentNodeWaitingFor(node);
  const state = AGENT_DISPLAY_STATE_PRESENTATION[displayState];
  const descendantCount = node.aggregateAgentCount - 1;
  const expandable = node.children.length > 0 && !!onToggleChildren;
  return (
    <div
      className="group/agent relative flex items-start gap-2 border-b py-2.5 pr-2 hover:bg-accent/40"
      data-agent-path={agent.path}
      data-agent-state={displayState}
      data-agent-runtime-state={runtimeState}
      data-agent-variant="catalog"
    >
      <span className="flex w-4 shrink-0 justify-end pt-0.5">
        {expandable ? (
          // z-10 lifts the chevron above the title's stretched-link overlay;
          // without it the whole row would navigate instead of toggling.
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="relative z-10 size-4 text-muted-foreground"
            aria-label={expanded ? "Collapse child agents" : "Expand child agents"}
            aria-expanded={expanded}
            onClick={onToggleChildren}
          >
            <ChevronRight
              className={cn("size-3.5 transition-transform", expanded && "rotate-90")}
            />
          </Button>
        ) : null}
      </span>
      <StateDot state={state} className="mt-1.5" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          {/* Stretched link: the title's ::after covers the row, so the whole
              row opens the agent while staying a single keyboard target. */}
          <button
            type="button"
            onClick={onOpen}
            title={agent.path}
            className="min-w-0 truncate text-left text-sm font-medium after:absolute after:inset-0 hover:underline"
          >
            {agentTitle(agent)}
          </button>
          {agent.summary.pinned ? (
            <Star
              className="size-3 shrink-0 self-center fill-amber-400 text-amber-500 group-hover/agent:opacity-0"
              aria-hidden
            />
          ) : null}
          <time
            dateTime={node.aggregateLastWorkAt}
            title={node.aggregateLastWorkAt}
            className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground group-hover/agent:opacity-0"
          >
            {formatTimeAgo(node.aggregateLastWorkAt, nowMs)}
          </time>
        </div>
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          {!agent.summary.activity ? null : (
            <>
              <span className="min-w-0 truncate">{agent.summary.activity}</span>
              <span aria-hidden>·</span>
            </>
          )}
          <AgentRuntimeStatus
            runtimeState={runtimeState}
            since={runtimeTransition?.since ?? agent.timestamps.runtimeUpdatedAt}
          />
          {descendantCount > 0 ? (
            <span className="shrink-0">
              · {descendantCount} subagent{descendantCount === 1 ? "" : "s"}
            </span>
          ) : null}
          {!agent.binding && !waitingFor ? null : (
            <span
              className="relative z-10 ml-auto flex min-w-0 shrink-0 items-center gap-1.5"
              data-agent-row-tail
            >
              <BindingLink binding={agent.binding} className="max-w-48 shrink-0" />
              <AgentWaitingBadge waitingFor={waitingFor} />
            </span>
          )}
        </div>
      </div>
      <PinButton
        pinned={agent.summary.pinned}
        onToggle={onTogglePinned}
        className="absolute right-1 top-1.5 opacity-0 focus-visible:opacity-100 group-hover/agent:opacity-100"
      />
    </div>
  );
}

function AgentRuntimeStatus({
  runtimeState,
  since,
}: {
  runtimeState: "running_code" | "waiting_for_model" | "queued" | "idle";
  since?: string;
}) {
  const active = runtimeState !== "idle";
  const sinceMs = !since ? null : Date.parse(since);
  const nowMs = useTickingNowMs(LIVE_RUNTIME_TICK_MS, active && Number.isFinite(sinceMs));
  const label =
    runtimeState === "running_code"
      ? "Running code"
      : runtimeState === "idle"
        ? "Idle"
        : "Waiting for response";
  const elapsed = active && Number.isFinite(sinceMs) ? formatElapsedSeconds(nowMs - sinceMs) : null;

  return (
    <span className="shrink-0 tabular-nums" data-testid="agent-runtime-status" title={since}>
      {label}
      {!elapsed ? null : ` ${elapsed}`}
    </span>
  );
}

function AgentWaitingBadge({ waitingFor }: { waitingFor: AgentRecord["summary"]["waitingFor"] }) {
  if (!waitingFor) return null;
  return (
    <Badge variant="secondary" data-agent-waiting-for={waitingFor}>
      {WAITING_FOR_LABEL[waitingFor]}
    </Badge>
  );
}

/**
 * The detail header is the one roomy surface: full activity and description,
 * runtime counts, the durable path, and exact timestamps — all as quiet text.
 */
export function AgentDetailCard({
  agent,
  nowMs,
  onTogglePinned,
  onRename,
}: {
  agent: AgentRecord;
  nowMs: number;
  onTogglePinned: () => void | Promise<unknown>;
  onRename?: (title: string) => boolean | Promise<boolean>;
}) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [draftTitle, setDraftTitle] = useState(() => agentTitle(agent));
  const displayState = deriveAgentDisplayState(agent.runtime, agent.summary.waitingFor);
  const state = AGENT_DISPLAY_STATE_PRESENTATION[displayState];
  const counts = runtimeCountFragments(agent.runtime);
  const focusTitleInput = useCallback((node: HTMLInputElement | null) => node?.focus(), []);

  async function submitTitle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = draftTitle.trim();
    if (title === "" || !onRename) return;
    if (await onRename(title)) setEditingTitle(false);
  }

  async function copyPath() {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard access is unavailable.");
      await navigator.clipboard.writeText(agent.path);
      toast.success("Agent path copied.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not copy agent path.");
    }
  }

  return (
    <div
      className="flex min-w-0 flex-col gap-2"
      data-agent-path={agent.path}
      data-agent-state={displayState}
      data-agent-variant="detail"
    >
      <div className="flex items-start gap-2.5">
        <StateDot state={state} className="mt-2.5" />
        <div className="min-w-0 flex-1">
          {editingTitle ? (
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
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setEditingTitle(false)}
              >
                Cancel
              </Button>
            </form>
          ) : (
            <h2
              className="min-w-0 truncate text-lg font-semibold tracking-tight"
              title={agent.path}
            >
              {agentTitle(agent)}
            </h2>
          )}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            <span>{state.label}</span>
            <BindingLink binding={agent.binding} className="max-w-64" />
            <time
              dateTime={agent.timestamps.lastWorkAt}
              title={agent.timestamps.lastWorkAt}
              className="tabular-nums"
            >
              {formatTimeAgo(agent.timestamps.lastWorkAt, nowMs)}
            </time>
            {counts.map((count) => (
              <span key={count}>{count}</span>
            ))}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {onRename && !editingTitle ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Rename agent"
                    onClick={() => {
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
          <PinButton pinned={agent.summary.pinned} onToggle={onTogglePinned} size="icon-sm" />
        </div>
      </div>
      {!agent.summary.activity ? null : (
        <p className="max-w-3xl text-sm">{agent.summary.activity}</p>
      )}
      {!agent.summary.description ? null : (
        <p className="max-w-3xl text-sm text-muted-foreground">{agent.summary.description}</p>
      )}
      <div className="flex min-w-0 flex-col gap-1.5 text-xs text-muted-foreground">
        <div className="flex min-w-0 items-center gap-1">
          <code className="min-w-0 truncate font-mono text-[11px]" title={agent.path}>
            {agent.path}
          </code>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Copy agent path"
                  onClick={() => void copyPath()}
                />
              }
            >
              <Copy />
            </TooltipTrigger>
            <TooltipContent>Copy agent path</TooltipContent>
          </Tooltip>
        </div>
        <DetailTimestamps timestamps={agent.timestamps} nowMs={nowMs} />
      </div>
    </div>
  );
}

/** Column labels shared by every agent option in the Cmd+K result group. */
export function AgentCommandHeader() {
  return (
    <div
      className={cn(
        "sticky top-0 z-10 grid gap-2 border-b bg-background px-3 py-2 text-xs font-medium text-muted-foreground",
        AGENT_COMMAND_GRID,
      )}
      aria-hidden
    >
      <span>Agent</span>
      <span>Status</span>
      <span className="hidden sm:block">Activity</span>
      <span className="hidden lg:block">Last work</span>
      <span />
    </div>
  );
}

/** The sole interactive option for one Cmd+K agent result. */
export function AgentCommandItem({
  node,
  depth = 0,
  expanded = false,
  nowMs,
  onOpen,
  onToggleExpanded,
  onTogglePinned,
}: {
  node: AgentTreeNode;
  depth?: number;
  expanded?: boolean;
  nowMs: number;
  onOpen: (path: string) => void;
  onToggleExpanded: (path: string) => void;
  onTogglePinned: (agent: AgentRecord) => void | Promise<void>;
}) {
  const hasChildren = node.children.length > 0;
  return (
    <CommandItem
      value={agentCommandValue(node.agent.path)}
      onSelect={() => onOpen(node.agent.path)}
      className={cn(
        "grid items-start gap-2 border-b border-border/60 px-3 py-2.5 last:border-b-0",
        AGENT_COMMAND_GRID,
      )}
      aria-label={agentCommandAccessibleLabel(node, expanded)}
      aria-expanded={hasChildren ? expanded : undefined}
      aria-keyshortcuts="Shift+P"
      onClickCapture={(event) => {
        if (!(event.target instanceof Element)) return;
        const target = event.target;
        if (target.closest("[data-agent-pin]")) {
          event.preventDefault();
          event.stopPropagation();
          void onTogglePinned(node.agent);
        } else if (hasChildren && target.closest("[data-agent-disclosure]")) {
          event.preventDefault();
          event.stopPropagation();
          onToggleExpanded(node.agent.path);
        }
      }}
    >
      <AgentCommandPresentation depth={depth} expanded={expanded} node={node} nowMs={nowMs} />
    </CommandItem>
  );
}

/** Passive, cmdk-safe content matching the /agents catalog row layout. */
export function AgentCommandPresentation({
  depth = 0,
  expanded,
  node,
  nowMs,
}: {
  depth?: number;
  expanded: boolean;
  node: AgentTreeNode;
  nowMs: number;
}) {
  const agent = node.agent;
  const displayState = agentNodeDisplayState(node);
  const state = AGENT_DISPLAY_STATE_PRESENTATION[displayState];
  const activity = agent.summary.activity;
  const descendantCount = node.aggregateAgentCount - 1;
  const hasChildren = node.children.length > 0;
  return (
    <>
      <span
        className="flex min-w-0 items-start gap-2"
        style={{ paddingLeft: `${Math.min(depth, 6) * 16}px` }}
      >
        <span className="flex size-4 shrink-0 justify-end pt-0.5" aria-hidden>
          {hasChildren ? (
            <span
              data-agent-disclosure
              className="-m-1 flex size-4 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:bg-muted"
              title={expanded ? "Collapse child agents" : "Expand child agents"}
            >
              <ChevronRight
                className={cn("size-3.5 transition-transform", expanded && "rotate-90")}
              />
            </span>
          ) : null}
        </span>
        <StateDot state={state} className="mt-1.5" />
        <span className="min-w-0">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm font-medium">{agentTitle(agent)}</span>
            {agent.summary.pinned ? (
              <Star className="size-3 shrink-0 fill-amber-400 text-amber-500" aria-hidden />
            ) : null}
          </span>
          <span className="block truncate font-mono text-[11px] text-muted-foreground">
            {agent.path}
          </span>
        </span>
      </span>
      <span className="min-w-0 text-xs">
        <span className="block truncate">{state.label}</span>
        <span className="block truncate text-muted-foreground">
          {!agent.binding
            ? descendantCount > 0
              ? `${descendantCount} subagent${descendantCount === 1 ? "" : "s"}`
              : "—"
            : bindingLabel(agent.binding)}
        </span>
      </span>
      <span className="hidden min-w-0 sm:block">
        <span className="block truncate text-xs">{activity ?? "—"}</span>
        {!agent.summary.description ? null : (
          <span className="block truncate text-[11px] text-muted-foreground">
            {agent.summary.description}
          </span>
        )}
      </span>
      <time
        dateTime={node.aggregateLastWorkAt}
        title={node.aggregateLastWorkAt}
        className="hidden text-xs tabular-nums text-muted-foreground lg:block"
      >
        {formatTimeAgo(node.aggregateLastWorkAt, nowMs)}
      </time>
      <span
        data-agent-pin
        className="-m-1 flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
        title={agent.summary.pinned ? "Unpin agent (Shift+P)" : "Pin agent (Shift+P)"}
        aria-hidden
      >
        <Star className={cn("size-3.5", agent.summary.pinned && "fill-amber-400 text-amber-500")} />
      </span>
    </>
  );
}

export function StateDot({
  state,
  className,
}: {
  state: (typeof AGENT_DISPLAY_STATE_PRESENTATION)[AgentDisplayState];
  className?: string;
}) {
  return (
    <span
      className={cn(
        "size-2 shrink-0 rounded-full",
        state.dot,
        state.active && "motion-safe:animate-pulse",
        className,
      )}
      aria-hidden
    />
  );
}

export function PinButton({
  pinned,
  onToggle,
  size = "icon-xs",
  className,
}: {
  pinned: boolean;
  onToggle: () => void | Promise<unknown>;
  size?: "icon-xs" | "icon-sm";
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  async function toggle(event: MouseEvent) {
    event.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      await onToggle();
    } finally {
      setBusy(false);
    }
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size={size}
            className={cn("bg-background/80", className)}
            aria-label={pinned ? "Unpin agent" : "Pin agent"}
            aria-pressed={pinned}
            disabled={busy}
            onClick={(event) => void toggle(event)}
          />
        }
      >
        <Star className={cn(pinned && "fill-amber-400 text-amber-500")} />
      </TooltipTrigger>
      <TooltipContent>{pinned ? "Unpin agent" : "Pin agent"}</TooltipContent>
    </Tooltip>
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
    ["Summary updated", timestamps.summaryUpdatedAt],
    ["Activity updated", timestamps.activityUpdatedAt],
    ["Runtime updated", timestamps.runtimeUpdatedAt],
  ].filter((entry): entry is [string, string] => !!entry[1]);
  return (
    <dl className="flex flex-wrap gap-x-4 gap-y-1">
      {entries.map(([label, value]) => (
        <div key={label} className="flex items-baseline gap-1.5">
          <dt>{label}</dt>
          <dd className="tabular-nums text-foreground/70">
            <time dateTime={value} title={value} aria-label={`${label}: ${value}`}>
              {formatTimeAgo(value, nowMs)}
            </time>
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function BindingLink({
  binding,
  className,
}: {
  binding: AgentBinding | undefined;
  className?: string;
}) {
  if (!binding) return null;
  const label = bindingLabel(binding);
  const url = bindingUrl(binding);
  if (!url) return <span className={cn("truncate", className)}>{label}</span>;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => event.stopPropagation()}
      className={cn("truncate hover:text-foreground hover:underline", className)}
    >
      {label}
    </a>
  );
}
