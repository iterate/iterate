import {
  BotIcon,
  CircleStopIcon,
  FilterIcon,
  HistoryIcon,
  MoreHorizontalIcon,
  PauseIcon,
  PlayIcon,
  RadioIcon,
  UsersIcon,
} from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@iterate-com/ui/components/dropdown-menu";
import { Spinner } from "@iterate-com/ui/components/spinner";
import { SidebarTrigger } from "@iterate-com/ui/components/sidebar";
import { Tabs, TabsList, TabsTrigger } from "@iterate-com/ui/components/tabs";
import type { AgentUiPresenceEntry } from "@iterate-com/ui/components/events/agent-ui-reducer";
import { useIsMobile } from "@iterate-com/ui/hooks/use-mobile";
import { cn } from "@iterate-com/ui/lib/utils";
import { StreamPathPill } from "~/components/stream-path-pill.tsx";
import { PresenceAvatar } from "~/components/stream-state-panel.tsx";
import { feedFiltersActive } from "~/lib/stream-feed-filters.ts";
import {
  presenceLabel,
  sparklinePoints,
  type BrowserStreamMetricsView,
} from "~/lib/stream-presence.ts";
import {
  defaultModeForStream,
  modeCapabilities,
  modesForStream,
  streamViewMode,
  useStreamViewPanels,
  useStreamViewSearch,
  type StreamViewMode,
} from "~/lib/stream-view-search.ts";

const MAX_PRESENCE_AVATARS = 4;

/**
 * THE page header — the app renders no other. Pill path breadcrumb (⌘K
 * trigger) top-left; presence, metrics, mode tabs (when the stream offers
 * more than one), and the filter toggle (when the active mode opts in) on
 * the right. Tab/filter/panel state is URL-backed (stream-view-search.ts).
 *
 * Mobile: presence avatars and the RTT sparkline leave the chrome row (they
 * force sideways scroll) and live under the ⋮ menu instead. The row itself is
 * a single non-wrapping flex line with overflow clipped.
 */
export function StreamViewHeader({
  agentBusy,
  agentPause,
  eventsToggle,
  metrics,
  presence,
  streamKill,
  streamPath,
}: {
  agentBusy: boolean;
  agentPause?: {
    paused: boolean;
    pending: boolean;
    reason: string | null;
    setPaused: (paused: boolean) => Promise<void>;
  };
  streamKill?: {
    kill: () => Promise<void>;
    pending: boolean;
  };
  /**
   * Full-panel layouts relegate the feed to a sheet; this renders the header
   * button that opens it (replacing mode tabs and filter, which live inside
   * the sheet instead).
   */
  eventsToggle?: { eventCount?: number };
  /** This browser's REAL measured metrics (see useBrowserStreamMetrics) — "—" until samples exist. */
  metrics: BrowserStreamMetricsView;
  presence: readonly AgentUiPresenceEntry[];
  streamPath: string;
}) {
  const isMobile = useIsMobile();
  const { search, setSearch } = useStreamViewSearch();
  const {
    focusedProcessorKey,
    focusProcessor,
    openProcessorsOverview,
    openAgentDetails,
    eventsSheetOpen,
    openEventsSheet,
    closeEventsSheet,
  } = useStreamViewPanels();
  const caps = modeCapabilities(search, streamPath);
  // Presence = who is here NOW. The reduced roster keeps disconnected
  // entries (the panel needs them for asleep/parked rows), but avatars and
  // the +N overflow must not count corpses — a listing stream accumulates
  // every browser tab that ever visited.
  const connectedPresence = presence.filter((entry) => entry.connected);
  const toolsOpen = search.filter === true;
  const showFilterToggle = eventsToggle == null && caps.filters;
  const filtersActive = feedFiltersActive(search, streamPath);
  const showOverflowMenu = agentPause != null || isMobile;
  const latencyLabel = metrics.transportRttMs === null ? "—" : `${metrics.transportRttMs.last}ms`;

  return (
    <header className="flex min-w-0 shrink-0 items-center gap-2 overflow-x-hidden px-3 pb-1 pt-2.5 sm:gap-3 sm:px-4">
      <SidebarTrigger className="-ml-1 shrink-0 md:hidden" />
      <StreamPathPill
        streamPath={streamPath}
        title={`${streamPath} — click or ⌘K to switch streams`}
        className="min-w-0 flex-1 basis-0 sm:flex-initial sm:basis-auto sm:max-w-md"
      />

      <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-3">
        {isMobile || connectedPresence.length === 0 ? null : (
          <div className="flex items-center pl-1.5">
            {connectedPresence.slice(0, MAX_PRESENCE_AVATARS).map((entry) => {
              const selected = entry.connectionKey === focusedProcessorKey;
              return (
                <button
                  key={entry.connectionKey}
                  type="button"
                  aria-label={`${presenceLabel(entry)} — open processor`}
                  onClick={() => focusProcessor(entry.connectionKey)}
                  className={cn("-ml-1.5 rounded-full", selected && "relative z-10")}
                >
                  <PresenceAvatar
                    entry={entry}
                    busy={agentBusy}
                    className={cn("border-2", selected ? "border-foreground" : "border-background")}
                  />
                </button>
              );
            })}
            {connectedPresence.length > MAX_PRESENCE_AVATARS ? (
              <button
                type="button"
                title="Stream state"
                onClick={openProcessorsOverview}
                className="-ml-1.5 grid size-6 place-items-center rounded-full border-2 border-background bg-muted font-mono text-[9px] font-bold text-muted-foreground"
              >
                +{connectedPresence.length - MAX_PRESENCE_AVATARS}
              </button>
            ) : null}
          </div>
        )}
        {isMobile ? null : <StreamStateButton metrics={metrics} />}
        {eventsToggle != null ? (
          <Button
            variant="outline"
            size="sm"
            title="Stream events"
            aria-expanded={eventsSheetOpen}
            onClick={() => (eventsSheetOpen ? closeEventsSheet() : openEventsSheet())}
            className="text-xs font-normal"
          >
            <HistoryIcon className="size-3.5" />
            <span className="hidden sm:inline">Events</span>
            {eventsToggle.eventCount == null ? null : (
              <span className="font-mono text-[10px] text-muted-foreground">
                {eventsToggle.eventCount.toLocaleString()}
              </span>
            )}
          </Button>
        ) : (
          <>
            <StreamModeTabs streamPath={streamPath} compact={isMobile} />
            {showFilterToggle ? (
              <Button
                variant="ghost"
                size="icon"
                title="Search & filter"
                aria-expanded={toolsOpen}
                onClick={() => setSearch({ filter: toolsOpen ? undefined : true })}
                className="relative rounded-full text-muted-foreground"
              >
                <FilterIcon className="size-3.5" />
                {filtersActive ? (
                  <span
                    aria-hidden="true"
                    className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-primary"
                  />
                ) : null}
              </Button>
            ) : null}
          </>
        )}
        {showOverflowMenu ? (
          <StreamOverflowMenu
            agentBusy={agentBusy}
            connectedPresence={connectedPresence}
            focusedProcessorKey={focusedProcessorKey}
            isMobile={isMobile}
            kill={streamKill}
            latencyLabel={latencyLabel}
            metrics={metrics}
            onFocusPresence={focusProcessor}
            onOpenAgentDetails={agentPause == null ? undefined : openAgentDetails}
            onOpenStreamState={openProcessorsOverview}
            pause={agentPause}
          />
        ) : null}
      </div>
    </header>
  );
}

/**
 * Latency sparkline that opens the processors/stream-state sheet. Shared by
 * the page header and the full-panel Events sheet.
 */
export function StreamStateButton({ metrics }: { metrics: BrowserStreamMetricsView }) {
  const { openProcessorsOverview } = useStreamViewPanels();
  const latencyLabel = metrics.transportRttMs === null ? "—" : `${metrics.transportRttMs.last}ms`;
  return (
    <Button
      variant="ghost"
      size="sm"
      title="Stream state"
      onClick={openProcessorsOverview}
      className="font-mono text-xs font-normal text-muted-foreground"
    >
      {metrics.spark.length === 0 ? null : (
        <svg width="24" height="11" viewBox="0 0 26 12" className="shrink-0">
          <polyline
            points={sparklinePoints(metrics.spark.slice(-12), 26, 12)}
            fill="none"
            className="stroke-emerald-600"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        </svg>
      )}
      {latencyLabel}
    </Button>
  );
}

/**
 * The Pretty / Pretty+raw / Raw mode switch — URL-backed, hidden on streams
 * that offer only the implicit raw feed. Shared by the page header and the
 * full-panel Events sheet. Switching modes clears feed-items-only filters so
 * they don't stick invisibly under Pretty; `q` is kept for search continuity.
 */
export function StreamModeTabs({
  streamPath,
  compact = false,
}: {
  streamPath: string;
  /** Tighter triggers so the header stays on one line on phones. */
  compact?: boolean;
}) {
  const { search, setSearch } = useStreamViewSearch();
  const modes = modesForStream(streamPath);
  const activeMode = streamViewMode(search, streamPath);
  if (modes.length === 0) return null;
  return (
    <Tabs
      value={activeMode}
      onValueChange={(value) => {
        const mode = value as StreamViewMode;
        const defaultMode = defaultModeForStream(streamPath);
        setSearch({
          mode: mode === defaultMode ? undefined : mode,
          types: undefined,
          components: undefined,
          from: undefined,
          to: undefined,
        });
      }}
    >
      <TabsList className={cn("h-8", compact && "h-7 gap-0")}>
        {modes.map((mode) => (
          <TabsTrigger
            key={mode.id}
            value={mode.id}
            className={cn("px-2.5 text-xs", compact && "px-1.5 text-[11px]")}
          >
            {compact ? compactModeLabel(mode.label) : mode.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

function compactModeLabel(label: string) {
  if (label === "Pretty + raw" || label === "Pretty+raw") return "P+R";
  if (label === "Pretty") return "P";
  if (label === "Raw") return "R";
  return label;
}

function StreamOverflowMenu({
  agentBusy,
  connectedPresence,
  focusedProcessorKey,
  isMobile,
  kill,
  latencyLabel,
  metrics,
  onFocusPresence,
  onOpenAgentDetails,
  onOpenStreamState,
  pause,
}: {
  agentBusy: boolean;
  connectedPresence: readonly AgentUiPresenceEntry[];
  focusedProcessorKey: string | null;
  isMobile: boolean;
  kill?: {
    kill: () => Promise<void>;
    pending: boolean;
  };
  latencyLabel: string;
  metrics: BrowserStreamMetricsView;
  onFocusPresence: (connectionKey: string) => void;
  /** Present only on agent streams — opens the agent details sheet. */
  onOpenAgentDetails?: () => void;
  onOpenStreamState: () => void;
  pause?: {
    paused: boolean;
    pending: boolean;
    setPaused: (paused: boolean) => Promise<void>;
  };
}) {
  const PauseActionIcon = pause?.paused ? PlayIcon : PauseIcon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            title="More"
            className="rounded-full text-muted-foreground"
          />
        }
      >
        <MoreHorizontalIcon className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {isMobile ? (
          <>
            <DropdownMenuGroup>
              <DropdownMenuLabel>Stream</DropdownMenuLabel>
              <DropdownMenuItem closeOnClick onClick={onOpenStreamState}>
                <RadioIcon />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span>Stream state</span>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {metrics.spark.length === 0 ? "latency " : ""}
                    {latencyLabel}
                  </span>
                </span>
              </DropdownMenuItem>
            </DropdownMenuGroup>
            {connectedPresence.length === 0 ? null : (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuLabel>
                    Presence · {connectedPresence.length} connected
                  </DropdownMenuLabel>
                  {connectedPresence.slice(0, 8).map((entry) => (
                    <DropdownMenuItem
                      key={entry.connectionKey}
                      closeOnClick
                      onClick={() => onFocusPresence(entry.connectionKey)}
                    >
                      <PresenceAvatar
                        entry={entry}
                        busy={agentBusy}
                        className="size-5 text-[8px]"
                      />
                      <span className="min-w-0 truncate">{presenceLabel(entry)}</span>
                      {entry.connectionKey === focusedProcessorKey ? (
                        <span className="ml-auto text-[10px] text-muted-foreground">open</span>
                      ) : null}
                    </DropdownMenuItem>
                  ))}
                  {connectedPresence.length > 8 ? (
                    <DropdownMenuItem closeOnClick onClick={onOpenStreamState}>
                      <UsersIcon />+{connectedPresence.length - 8} more in stream state
                    </DropdownMenuItem>
                  ) : null}
                </DropdownMenuGroup>
              </>
            )}
          </>
        ) : null}
        {pause == null || kill == null ? null : (
          <>
            {isMobile ? <DropdownMenuSeparator /> : null}
            <DropdownMenuGroup>
              <DropdownMenuLabel>Agent actions</DropdownMenuLabel>
              {onOpenAgentDetails == null ? null : (
                <DropdownMenuItem closeOnClick onClick={onOpenAgentDetails}>
                  <BotIcon />
                  Agent details
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                closeOnClick
                disabled={pause.pending}
                onClick={() => void pause.setPaused(!pause.paused)}
              >
                {pause.pending ? <Spinner /> : <PauseActionIcon />}
                {pause.paused ? "Resume agent" : "Pause agent"}
              </DropdownMenuItem>
              <DropdownMenuItem
                closeOnClick
                disabled={kill.pending}
                variant="destructive"
                onClick={() => void kill.kill()}
              >
                {kill.pending ? <Spinner /> : <CircleStopIcon />}
                Kill stream
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
