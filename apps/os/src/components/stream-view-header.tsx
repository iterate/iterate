import {
  CircleStopIcon,
  FilterIcon,
  HistoryIcon,
  MoreHorizontalIcon,
  PauseIcon,
  PlayIcon,
} from "lucide-react";
import { Button } from "@iterate-com/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@iterate-com/ui/components/dropdown-menu";
import { Spinner } from "@iterate-com/ui/components/spinner";
import { SidebarTrigger } from "@iterate-com/ui/components/sidebar";
import { Tabs, TabsList, TabsTrigger } from "@iterate-com/ui/components/tabs";
import type { AgentUiPresenceEntry } from "@iterate-com/ui/components/events/agent-ui-reducer";
import { cn } from "@iterate-com/ui/lib/utils";
import { StreamPathPill } from "~/components/stream-path-pill.tsx";
import { PresenceAvatar } from "~/components/stream-processors-panel.tsx";
import { feedFiltersActive } from "~/lib/stream-feed-filters.ts";
import { presenceLabel, sparklinePoints, type RttMetrics } from "~/lib/stream-presence.ts";
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
  streamKill: {
    kill: () => Promise<void>;
    pending: boolean;
  };
  /**
   * Full-panel layouts relegate the feed to a sheet; this renders the header
   * button that opens it (replacing mode tabs and filter, which live inside
   * the sheet instead).
   */
  eventsToggle?: { eventCount: number };
  metrics: RttMetrics;
  presence: readonly AgentUiPresenceEntry[];
  streamPath: string;
}) {
  const { search, setSearch } = useStreamViewSearch();
  const { focusedProcessorKey, focusProcessor, openProcessorsOverview } = useStreamViewPanels();
  const modes = modesForStream(streamPath);
  const activeMode = streamViewMode(search, streamPath);
  const caps = modeCapabilities(search, streamPath);
  const toolsOpen = search.filter === true;
  const showFilterToggle = eventsToggle == null && caps.filters;
  const filtersActive = feedFiltersActive(search, streamPath);

  return (
    <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 px-4 pb-1 pt-2.5">
      <SidebarTrigger className="-ml-1 md:hidden" />
      <StreamPathPill
        streamPath={streamPath}
        title={`${streamPath} — click or ⌘K to switch streams`}
      />

      <div className="ml-auto flex items-center gap-3">
        {presence.length === 0 ? null : (
          <div className="flex items-center pl-1.5">
            {presence.slice(0, MAX_PRESENCE_AVATARS).map((entry) => {
              const selected = entry.subscriptionKey === focusedProcessorKey;
              return (
                <button
                  key={entry.subscriptionKey}
                  type="button"
                  title={`${presenceLabel(entry)} — open processor`}
                  onClick={() => focusProcessor(entry.subscriptionKey)}
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
            {presence.length > MAX_PRESENCE_AVATARS ? (
              <button
                type="button"
                title="All processors"
                onClick={openProcessorsOverview}
                className="-ml-1.5 grid size-6 place-items-center rounded-full border-2 border-background bg-muted font-mono text-[9px] font-bold text-muted-foreground"
              >
                +{presence.length - MAX_PRESENCE_AVATARS}
              </button>
            ) : null}
          </div>
        )}
        <Button
          variant="ghost"
          size="sm"
          title="Stream health & processors"
          onClick={openProcessorsOverview}
          className="font-mono text-xs font-normal text-muted-foreground"
        >
          <svg width="24" height="11" viewBox="0 0 26 12" className="shrink-0">
            <polyline
              points={sparklinePoints(metrics.spark.slice(-12), 26, 12)}
              fill="none"
              className="stroke-emerald-600"
              strokeWidth="1.4"
              strokeLinejoin="round"
            />
          </svg>
          {metrics.rttNow}ms
        </Button>
        {eventsToggle != null ? (
          <Button
            variant="outline"
            size="sm"
            title="Stream events"
            aria-expanded={search.events === true}
            onClick={() => setSearch({ events: search.events === true ? undefined : true })}
            className="text-xs font-normal"
          >
            <HistoryIcon className="size-3.5" />
            Events
            <span className="font-mono text-[10px] text-muted-foreground">
              {eventsToggle.eventCount.toLocaleString()}
            </span>
          </Button>
        ) : (
          <>
            {modes.length > 0 ? (
              <Tabs
                value={activeMode}
                onValueChange={(value) => {
                  const mode = value as StreamViewMode;
                  const defaultMode = defaultModeForStream(streamPath);
                  setSearch({
                    mode: mode === defaultMode ? undefined : mode,
                    // Mode switch clears feed-items-only filters so they don't
                    // stick invisibly under Pretty; keep `q` for search continuity.
                    types: undefined,
                    components: undefined,
                    from: undefined,
                    to: undefined,
                    preset: undefined,
                  });
                }}
              >
                <TabsList className="h-8">
                  {modes.map((mode) => (
                    <TabsTrigger key={mode.id} value={mode.id} className="px-2.5 text-xs">
                      {mode.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            ) : null}
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
        <StreamActionMenu kill={streamKill} pause={agentPause} />
      </div>
    </header>
  );
}

function StreamActionMenu({
  kill,
  pause,
}: {
  kill: {
    kill: () => Promise<void>;
    pending: boolean;
  };
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
            title={pause == null ? "Stream actions" : "Agent actions"}
            className="rounded-full text-muted-foreground"
          />
        }
      >
        <MoreHorizontalIcon className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            {pause == null ? "Stream actions" : "Agent actions"}
          </DropdownMenuLabel>
          {pause == null ? null : (
            <DropdownMenuItem
              closeOnClick
              disabled={pause.pending}
              onClick={() => void pause.setPaused(!pause.paused)}
            >
              {pause.pending ? <Spinner /> : <PauseActionIcon />}
              {pause.paused ? "Resume agent" : "Pause agent"}
            </DropdownMenuItem>
          )}
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
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
