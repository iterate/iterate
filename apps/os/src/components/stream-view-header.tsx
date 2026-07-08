import {
  ChevronDownIcon,
  FilterIcon,
  HistoryIcon,
  MoreHorizontalIcon,
  PauseIcon,
  PlayIcon,
} from "lucide-react";
import { Badge } from "@iterate-com/ui/components/badge";
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
import { openGlobalCommandPalette } from "~/components/global-command-palette-events.ts";
import { PresenceAvatar } from "~/components/stream-processors-panel.tsx";
import { feedFiltersActive } from "~/lib/stream-feed-filters.ts";
import { presenceLabel, sparklinePoints, type RttMetrics } from "~/lib/stream-presence.ts";
import {
  streamViewTab,
  useStreamViewPanels,
  useStreamViewSearch,
  type StreamViewTab,
} from "~/lib/stream-view-search.ts";

const MAX_PRESENCE_AVATARS = 4;

/**
 * THE page header — the app renders no other. Pill path breadcrumb (⌘K
 * trigger) top-left; presence, metrics, Feed/State tabs, and the filter
 * toggle on the right. Tab/filter/panel state is read and written straight
 * from the URL (stream-view-search.ts), so this component needs no callbacks
 * from the view it heads.
 */
export function StreamViewHeader({
  agentBusy,
  agentPause,
  eventsToggle,
  metrics,
  presence,
  streamPath,
}: {
  agentBusy: boolean;
  agentPause?: {
    paused: boolean;
    pending: boolean;
    reason: string | null;
    setPaused: (paused: boolean) => Promise<void>;
  };
  /**
   * Full-panel layouts relegate the feed to a sheet; this renders the header
   * button that opens it (replacing the inline Feed/State tabs and filter
   * toggle, which live inside the sheet instead).
   */
  eventsToggle?: { eventCount: number };
  metrics: RttMetrics;
  presence: readonly AgentUiPresenceEntry[];
  streamPath: string;
}) {
  const { search, setSearch } = useStreamViewSearch();
  const { focusedProcessorKey, focusProcessor, openProcessorsOverview } = useStreamViewPanels();
  const toolsOpen = search.filter === true;
  // Signal active filters on the toggle even while the row is closed — a
  // filtered feed with no visible cue reads as missing events.
  const filtersActive = feedFiltersActive(search, streamPath);

  return (
    <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 px-4 pb-1 pt-2.5">
      <SidebarTrigger className="-ml-1 md:hidden" />
      <button
        type="button"
        aria-haspopup="dialog"
        title={`${streamPath} — click or ⌘K to switch streams`}
        onClick={() => openGlobalCommandPalette()}
        className="flex h-9 min-w-0 cursor-pointer items-center gap-2 rounded-full bg-muted px-3.5 hover:bg-muted/70"
      >
        <span className="truncate font-mono text-sm">{streamPath}</span>
        <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
        <kbd className="hidden shrink-0 rounded bg-background px-1.5 py-px text-[10px] text-muted-foreground sm:inline">
          ⌘K
        </kbd>
      </button>

      <div className="ml-auto flex items-center gap-3">
        {agentPause == null ? null : (
          <Badge
            variant={agentPause.paused ? "destructive" : "secondary"}
            title={agentPause.reason ?? (agentPause.paused ? "Agent paused" : "Agent running")}
          >
            {agentPause.paused ? "Paused" : "Running"}
          </Badge>
        )}
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
                  // The selected ring renders outside the avatar; lift it above
                  // the overlapping siblings so it isn't clipped.
                  className={cn("-ml-1.5 rounded-full", selected && "relative z-10")}
                >
                  <PresenceAvatar
                    entry={entry}
                    busy={agentBusy}
                    // The avatar already reserves a 2px border to separate
                    // overlapping siblings; recolor that same border for the
                    // selected one instead of stacking a ring outside it.
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
          title="Stream health & metrics"
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
            <Tabs
              value={streamViewTab(search)}
              onValueChange={(value) => {
                const tab = value as StreamViewTab;
                setSearch({ tab: tab === "feed" ? undefined : tab });
              }}
            >
              <TabsList className="h-8">
                <TabsTrigger value="feed" className="px-3 text-xs">
                  Feed
                </TabsTrigger>
                <TabsTrigger value="state" className="px-3 text-xs">
                  State
                </TabsTrigger>
              </TabsList>
            </Tabs>
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
          </>
        )}
        {agentPause == null ? null : <AgentActionMenu pause={agentPause} />}
      </div>
    </header>
  );
}

function AgentActionMenu({
  pause,
}: {
  pause: {
    paused: boolean;
    pending: boolean;
    setPaused: (paused: boolean) => Promise<void>;
  };
}) {
  const Icon = pause.paused ? PlayIcon : PauseIcon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            title="Agent actions"
            className="rounded-full text-muted-foreground"
          />
        }
      >
        <MoreHorizontalIcon className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Agent actions</DropdownMenuLabel>
          <DropdownMenuItem
            closeOnClick
            disabled={pause.pending}
            onClick={() => void pause.setPaused(!pause.paused)}
          >
            {pause.pending ? <Spinner /> : <Icon />}
            {pause.paused ? "Resume agent" : "Pause agent"}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
