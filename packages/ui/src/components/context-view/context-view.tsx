// THE CONTEXT VIEW — one context's stream with its processors and its presence, the general-purpose
// view every app reuses (the dash's activity pages, the agents feed's base): a strip (what this is,
// how many events, who is here, the two buttons), a filter row (a text query, the types left
// ticked), the rows (a renderer's rich body per type where the app plugged one in, else the default),
// a Rendered / Raw switch for how the rows read, and two right-edge sheets — the inspector for one
// event, the processors with their live state. The rows are single lines the view's width: nothing
// here ever scrolls sideways; the inspector shows what a line cuts.
// Pure: every datum arrives as a prop from the SDK's hooks (`iterate/next/react`).
import { useMemo, useState, type ReactNode } from "react";
import { FilterIcon, LayersIcon } from "lucide-react";
import { Button } from "../button.tsx";
import { Input } from "../input.tsx";
import { Spinner } from "../spinner.tsx";
import { cn } from "../../lib/utils.ts";
import { coreEventRenderers } from "./core-renderers.tsx";
import { EventInspector } from "./event-inspector.tsx";
import { EventRow } from "./event-row.tsx";
import {
  EMPTY_FILTER,
  filterEvents,
  shortEventType,
  typeCounts,
  type ContextViewFilter,
} from "./filters.tsx";
import { PresenceStrip } from "./presence-strip.tsx";
import { ProcessorsPanel } from "./processors-panel.tsx";
import type {
  ContextViewEvent,
  ContextViewMode,
  ContextViewPresence,
  ContextViewProcessor,
  EventRenderers,
} from "./types.tsx";

export function ContextView({
  title,
  events,
  caughtUp,
  error,
  renderers,
  processors = [],
  presence = { actors: [], rpcStubs: [] },
  renderCoreState,
  renderLiveState,
  defaultMode = "rendered",
  emptyText = "Nothing has happened on this context yet.",
  className,
}: {
  /** What this context is, for the strip: a path, a name. */
  title: ReactNode;
  events: readonly ContextViewEvent[];
  caughtUp: boolean;
  error?: string;
  renderers?: EventRenderers;
  processors?: readonly ContextViewProcessor[];
  presence?: { actors: readonly ContextViewPresence[]; rpcStubs: readonly string[] };
  renderCoreState?: () => ReactNode;
  renderLiveState?: (facetName: string) => ReactNode;
  /** How the rows read at first — the switch in the strip changes it. */
  defaultMode?: ContextViewMode;
  emptyText?: string;
  className?: string;
}) {
  const [filter, setFilter] = useState<ContextViewFilter>(EMPTY_FILTER);
  const [filtering, setFiltering] = useState(false);
  const [inspected, setInspected] = useState<number | undefined>();
  const [processorsOpen, setProcessorsOpen] = useState(false);
  const [mode, setMode] = useState<ContextViewMode>(defaultMode);
  // the platform's own events read as sentences everywhere; an app's renderers lie over them
  const allRenderers = useMemo(() => ({ ...coreEventRenderers, ...renderers }), [renderers]);
  const shown = useMemo(() => filterEvents(events, filter), [events, filter]);
  const types = useMemo(() => typeCounts(events), [events]);
  const filtered = Boolean(filter.query) || filter.types.size > 0 || Boolean(filter.actor);
  const toggleType = (type: string) =>
    setFilter((held) => {
      const next = new Set(held.types);
      if (!next.delete(type)) next.add(type);
      return { ...held, types: next };
    });
  return (
    <div className={cn("flex min-h-0 min-w-0 flex-col gap-2", className)}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <div className="min-w-0 flex-1 truncate text-sm">{title}</div>
        <span className="text-xs text-muted-foreground tabular-nums">
          {filtered ? `${shown.length} of ${events.length}` : String(events.length)} events
          {caughtUp ? "" : " · loading"}
        </span>
        <PresenceStrip
          actors={presence.actors}
          rpcStubs={presence.rpcStubs}
          onPick={(actor) =>
            setFilter((held) => ({ ...held, actor: held.actor === actor ? undefined : actor }))
          }
        />
        <div
          role="tablist"
          aria-label="How the rows read"
          className="flex rounded-md border p-0.5 text-xs"
        >
          {(["rendered", "raw"] as const).map((candidate) => (
            <button
              key={candidate}
              type="button"
              role="tab"
              aria-selected={mode === candidate}
              onClick={() => setMode(candidate)}
              className={cn(
                "rounded px-2 py-0.5",
                mode === candidate
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {candidate === "rendered" ? "Rendered" : "Raw"}
            </button>
          ))}
        </div>
        <Button
          variant={filtering || filtered ? "secondary" : "ghost"}
          size="sm"
          onClick={() => setFiltering((held) => !held)}
          aria-label="Filter"
        >
          <FilterIcon className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setProcessorsOpen(true)}
          aria-label="Processors"
        >
          <LayersIcon className="size-4" />
          <span className="ml-1 text-xs">{processors.length}</span>
        </Button>
      </div>
      {filtering ? (
        <div className="flex flex-col gap-2">
          <Input
            value={filter.query}
            onChange={(e) => setFilter((held) => ({ ...held, query: e.target.value }))}
            placeholder="Search type or payload"
            className="h-8 text-sm"
          />
          <div className="flex flex-wrap gap-1">
            {types.map(([type, count]) => (
              <button
                key={type}
                type="button"
                onClick={() => toggleType(type)}
                className={cn(
                  "rounded px-1.5 py-0.5 font-mono text-xs hover:bg-muted",
                  filter.types.has(type) ? "bg-muted text-foreground" : "text-muted-foreground",
                )}
              >
                {shortEventType(type)} <span className="tabular-nums">{count}</span>
              </button>
            ))}
            {filtered ? (
              <button
                type="button"
                onClick={() => setFilter(EMPTY_FILTER)}
                className="px-1.5 py-0.5 text-xs text-muted-foreground underline-offset-2 hover:underline"
              >
                clear
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <div className="flex min-h-0 min-w-0 flex-col overflow-hidden">
        {shown.length === 0 && caughtUp && !error ? (
          <p className="px-2 py-6 text-sm text-muted-foreground">
            {filtered ? "No event matches the filter." : emptyText}
          </p>
        ) : null}
        {shown.length === 0 && !caughtUp && !error ? (
          <div className="flex items-center gap-2 px-2 py-6 text-sm text-muted-foreground">
            <Spinner /> Loading the log…
          </div>
        ) : null}
        {shown.map((event, index) => (
          <EventRow
            key={event.offset}
            event={event}
            previous={shown[index - 1]}
            renderers={allRenderers}
            mode={mode}
            selected={inspected === event.offset}
            onOpen={setInspected}
          />
        ))}
      </div>
      <EventInspector
        event={inspected === undefined ? undefined : events.find((e) => e.offset === inspected)}
        onClose={() => setInspected(undefined)}
      />
      <ProcessorsPanel
        open={processorsOpen}
        onClose={() => setProcessorsOpen(false)}
        processors={processors}
        renderCoreState={renderCoreState}
        renderLiveState={renderLiveState}
      />
    </div>
  );
}
