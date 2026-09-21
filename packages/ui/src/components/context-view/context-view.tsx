// THE CONTEXT VIEW — one context's stream with its processors and its presence, the general-purpose
// view every app reuses (the dash's activity pages, the agents feed's base): a strip (what this is,
// how many events, who is here, the mode, the two buttons), a filter row (a text query, the types
// left ticked), the log folded for reading (folds.tsx) as rows one line wide on a desktop and two
// on a phone, and two right-edge sheets — the inspector for one event, the processors with their
// live state. apps/os's three modes: Pretty (sentences, housekeeping folded, repeats counted),
// Pretty + raw (every event, sentence and raw line), Raw (the log as data). Nothing here ever
// scrolls sideways; the inspector shows what a line cuts.
// Pure: every datum arrives as a prop from the SDK's hooks (`iterate/next/react`).
import { useMemo, useState, type ReactNode } from "react";
import { FilterIcon, LayersIcon } from "lucide-react";
import { Button } from "../button.tsx";
import { Input } from "../input.tsx";
import { Spinner } from "../spinner.tsx";
import { cn } from "../../lib/utils.ts";
import { coreEventInspectors, coreEventRenderers } from "./core-renderers.tsx";
import { EventInspector } from "./event-inspector.tsx";
import { EventRow } from "./event-row.tsx";
import { DaySeparator, HousekeepingRow, RepeatRow } from "./feed-rows.tsx";
import { foldEvents, lastEventOf } from "./folds.tsx";
import {
  actorLabel,
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
  EventInspectors,
  EventRenderers,
} from "./types.tsx";

const MODES: { id: ContextViewMode; label: string; short: string }[] = [
  { id: "pretty", label: "Pretty", short: "Pretty" },
  { id: "pretty-raw", label: "Pretty + raw", short: "+raw" },
  { id: "raw", label: "Raw", short: "Raw" },
];

export function ContextView({
  title,
  events,
  caughtUp,
  error,
  renderers,
  inspectors,
  processors = [],
  presence = { actors: [], rpcStubs: [] },
  renderCoreState,
  renderLiveState,
  defaultMode = "pretty",
  emptyText = "Nothing has happened on this context yet.",
  className,
}: {
  /** What this context is, for the strip: a path, a name. */
  title: ReactNode;
  events: readonly ContextViewEvent[];
  caughtUp: boolean;
  error?: string;
  renderers?: EventRenderers;
  /** Rich inspector bodies by type — over the platform's own (a script's code, its result). */
  inspectors?: EventInspectors;
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
  /** The folds opened in place, by item key. */
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  // the platform's own events read as sentences everywhere; an app's renderers lie over them
  const allRenderers = useMemo(() => ({ ...coreEventRenderers, ...renderers }), [renderers]);
  const allInspectors = useMemo(() => ({ ...coreEventInspectors, ...inspectors }), [inspectors]);
  const shown = useMemo(() => filterEvents(events, filter), [events, filter]);
  const items = useMemo(() => foldEvents(shown, mode), [shown, mode]);
  const toggleOpened = (key: string) =>
    setOpened((held) => {
      const next = new Set(held);
      if (!next.delete(key)) next.add(key);
      return next;
    });
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
          aria-label="How the log reads"
          className="flex rounded-md border p-0.5 text-xs"
        >
          {MODES.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              role="tab"
              aria-selected={mode === candidate.id}
              onClick={() => setMode(candidate.id)}
              className={cn(
                "rounded px-2 py-0.5 whitespace-nowrap",
                mode === candidate.id
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <span className="sm:hidden">{candidate.short}</span>
              <span className="hidden sm:inline">{candidate.label}</span>
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
        {items.map((item, index) => {
          const previous = lastEventOf(items[index - 1]);
          if (item.kind === "day") return <DaySeparator key={item.key} date={item.date} />;
          const first = item.kind === "event" ? item.event : item.events[0]!;
          // who acted is named when it changes hands — the row before was someone else's, or nobody's
          const showWho = !previous || actorLabel(previous) !== actorLabel(first);
          if (item.kind === "repeat")
            return (
              <RepeatRow
                key={item.key}
                events={item.events}
                previous={previous}
                renderers={allRenderers}
                showWho={showWho}
                open={opened.has(item.key)}
                onToggle={() => toggleOpened(item.key)}
                selected={inspected}
                onOpen={setInspected}
              />
            );
          if (item.kind === "housekeeping")
            return (
              <HousekeepingRow
                key={item.key}
                events={item.events}
                previous={previous}
                renderers={allRenderers}
                open={opened.has(item.key)}
                onToggle={() => toggleOpened(item.key)}
                selected={inspected}
                onOpen={setInspected}
              />
            );
          return (
            <EventRow
              key={item.key}
              event={item.event}
              previous={previous}
              renderers={allRenderers}
              mode={mode}
              showWho={showWho}
              selected={inspected === item.event.offset}
              onOpen={setInspected}
            />
          );
        })}
      </div>
      <EventInspector
        event={inspected === undefined ? undefined : events.find((e) => e.offset === inspected)}
        renderers={allRenderers}
        inspectors={allInspectors}
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
