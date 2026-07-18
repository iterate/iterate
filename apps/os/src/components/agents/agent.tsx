import { useCallback, useState, type FormEvent, type MouseEvent } from "react";
import { ChevronRight, Copy, Pencil, Star } from "lucide-react";
import { Badge } from "@iterate-com/ui/components/badge";
import { Button } from "@iterate-com/ui/components/button";
import { Input } from "@iterate-com/ui/components/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@iterate-com/ui/components/tooltip";
import { toast } from "@iterate-com/ui/components/sonner";
import { cn } from "@iterate-com/ui/lib/utils";
import {
  AGENT_DISPLAY_STATE_PRESENTATION,
  bindingIcon,
  bindingLabel,
  bindingUrl,
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
          {agent.summary.activity === undefined ? null : (
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
  const expandable = node.children.length > 0 && onToggleChildren !== undefined;
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
          {agent.summary.activity === undefined ? null : (
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
          {agent.binding === undefined && waitingFor === undefined ? null : (
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
  const sinceMs = since === undefined ? null : Date.parse(since);
  const nowMs = useTickingNowMs(LIVE_RUNTIME_TICK_MS, active && sinceMs !== null);
  const label =
    runtimeState === "running_code"
      ? "Running code"
      : runtimeState === "idle"
        ? "Idle"
        : "Waiting for response";
  const elapsed = active && sinceMs !== null ? formatElapsedSeconds(nowMs - sinceMs) : null;

  return (
    <span className="shrink-0 tabular-nums" data-testid="agent-runtime-status" title={since}>
      {label}
      {elapsed === null ? null : ` ${elapsed}`}
    </span>
  );
}

function AgentWaitingBadge({ waitingFor }: { waitingFor: AgentRecord["summary"]["waitingFor"] }) {
  if (waitingFor === undefined) return null;
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
  const counts = runtimeCountSummaries(agent);
  const focusTitleInput = useCallback((node: HTMLInputElement | null) => node?.focus(), []);

  async function submitTitle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = draftTitle.trim();
    if (title === "" || onRename === undefined) return;
    if (await onRename(title)) setEditingTitle(false);
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
          {onRename !== undefined && !editingTitle ? (
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
      {agent.summary.activity === undefined ? null : (
        <p className="max-w-3xl text-sm">{agent.summary.activity}</p>
      )}
      {agent.summary.description === undefined ? null : (
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

/** Passive, cmdk-safe agent content. CommandItem remains the single
 * interactive option; pointer hit areas are marked for the owning option to
 * interpret without nesting buttons, links, or another listbox option. */
export function AgentCommandPresentation({
  expanded,
  node,
  nowMs,
}: {
  expanded: boolean;
  node: AgentTreeNode;
  nowMs: number;
}) {
  const displayState = agentNodeDisplayState(node);
  const state = AGENT_DISPLAY_STATE_PRESENTATION[displayState];
  const activity = node.agent.summary.activity;
  const childCount = node.aggregateAgentCount - 1;
  const hasChildren = node.children.length > 0;
  return (
    <>
      <span className="flex size-6 shrink-0 items-center justify-center" aria-hidden>
        {hasChildren ? (
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
        <StateDot state={state} className={cn(hasChildren && "-ml-1 ring-2 ring-background")} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-medium">{agentTitle(node.agent)}</span>
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="min-w-0 truncate" title={activity ?? node.agent.path}>
            {activity ?? node.agent.path}
          </span>
          {node.agent.binding === undefined ? null : (
            <span className="max-w-48 shrink-0 truncate">{bindingLabel(node.agent.binding)}</span>
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
        title={node.agent.summary.pinned ? "Unpin agent (Shift+P)" : "Pin agent (Shift+P)"}
        aria-hidden
      >
        <Star
          className={cn("size-3.5", node.agent.summary.pinned && "fill-amber-400 text-amber-500")}
        />
      </span>
    </>
  );
}

function StateDot({
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

function PinButton({
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
  ].filter((entry): entry is [string, string] => entry[1] !== undefined);
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

/** Self-only in-flight work, phrased as short "count noun" fragments. */
function runtimeCountSummaries(agent: AgentRecord): string[] {
  const runtime = agent.runtime;
  if (runtime === undefined) return [];
  const unreadyTriggers = Math.max(0, runtime.triggers.pending - runtime.triggers.runnable);
  const modelRequests = runtime.llmRequests.started + runtime.llmRequests.requested;
  const queued = runtime.llmRequests.scheduled + runtime.triggers.runnable;
  return [
    runtime.runningScripts > 0 ? pluralCount(runtime.runningScripts, "script") : null,
    modelRequests > 0 ? pluralCount(modelRequests, "model request") : null,
    queued > 0 ? `${queued} queued` : null,
    unreadyTriggers > 0 ? pluralCount(unreadyTriggers, "pending trigger") : null,
  ].filter((value): value is string => value !== null);
}

function pluralCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function BindingLink({
  binding,
  className,
}: {
  binding: AgentBinding | undefined;
  className?: string;
}) {
  if (binding === undefined) return null;
  const label = bindingLabel(binding);
  const url = bindingUrl(binding);
  if (url === undefined) return <span className={cn("truncate", className)}>{label}</span>;
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
