// THE CONTEXT VIEW — one context's stream with its processors and its presence, the general-purpose
// view every app reuses (the dash's activity pages, the agents feed's base): a strip (what this is,
// how many events, who is here, the mode, the two buttons), a filter row (a text query, the types
// left ticked), the log folded for reading (folds.tsx) as rows one line wide on a desktop and two
// on a phone, and two right-edge sheets — the inspector for one event, the processors with their
// live state. Three modes: Pretty (sentences, housekeeping folded, repeats counted),
// Pretty + raw (every event, sentence and raw line), Raw (the log as data). Nothing here ever
// scrolls sideways; the inspector shows what a line cuts.
// CONTROLLED: every choice a person makes here is `state` (context-view-search.ts — a URL's search
// in every app) and comes back as an `onStateChange` patch, so a view is a link: the mode, the
// filter, the inspected event, the open sheet. Only the folds opened in place stay local — scroll-
// position-grade ephemera. Pure otherwise: every datum arrives as a prop from the SDK's hooks.
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { FilterIcon, LayersIcon } from "lucide-react";
import { cn } from "cn";
import { Button } from "../button.tsx";
import { Input } from "../input.tsx";
import { Spinner } from "../spinner.tsx";
import {
  contextViewFilterOf,
  RIGHT_EDGE_CLOSED,
  type ContextViewState,
} from "./context-view-search.ts";
import { coreEventInspectors, coreEventRenderers } from "./core-renderers.tsx";
import { EventInspector } from "./event-inspector.tsx";
import { EventRow } from "./event-row.tsx";
import { DaySeparator, HousekeepingRow, RepeatRow } from "./feed-rows.tsx";
import { actorLabel, filterEvents, shortEventType, typeCounts } from "./filters.tsx";
import { foldEvents, lastEventOf, sentenceText, whoBefore } from "./folds.tsx";
import { PresenceStrip } from "./presence-strip.tsx";
import { ProcessorsPanel } from "./processors-panel.tsx";
import {
  type ContextViewEvent,
  type ContextViewMode,
  type ContextViewPresence,
  type ContextViewProcessor,
  type EventInspectors,
  type EventRenderers,
  rendererFor,
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
  state,
  onStateChange,
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
  /** The view's state — the route's parsed search (`validateSearch: ContextViewState`). */
  state: ContextViewState;
  /** A patch to the state; an `undefined` value drops the key (the route spreads it into the search). */
  onStateChange: (patch: Partial<ContextViewState>) => void;
  emptyText?: string;
  className?: string;
}) {
  const mode = state.mode || "pretty";
  const filter = useMemo(() => contextViewFilterOf(state), [state]);
  const filtering = Boolean(state.filter);
  const inspected = state.event;
  /** The folds opened in place, by item key. */
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  // the platform's own events read as sentences everywhere; an app's renderers lie over them
  const allRenderers = useMemo(() => ({ ...coreEventRenderers, ...renderers }), [renderers]);
  const allInspectors = useMemo(() => ({ ...coreEventInspectors, ...inspectors }), [inspectors]);
  const shown = useMemo(() => filterEvents(events, filter), [events, filter]);
  // the same fact = the same sentence: four sign-ins fold whatever their timestamps and ids say
  const factOf = useCallback(
    (event: ContextViewEvent) => {
      const sentence = rendererFor(allRenderers, event.type)?.(event);
      const text = sentence ? sentenceText(sentence) : "";
      return `${event.type}\u0000${text || JSON.stringify(event.payload ?? null)}`;
    },
    [allRenderers],
  );
  const items = useMemo(() => foldEvents(shown, mode, factOf), [shown, mode, factOf]);
  const namedBefore = useMemo(() => whoBefore(items, actorLabel), [items]);
  const types = useMemo(() => typeCounts(events), [events]);
  const filtered = Boolean(filter.query) || filter.types.size > 0 || Boolean(filter.actor);
  const toggleType = (type: string) => {
    const next = filter.types.has(type)
      ? [...filter.types].filter((held) => held !== type)
      : [...filter.types, type];
    onStateChange({ types: next.length > 0 ? next : undefined });
  };
  const toggleOpened = (key: string) =>
    setOpened((held) => {
      const next = new Set(held);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const inspect = (offset: number) => onStateChange({ ...RIGHT_EDGE_CLOSED, event: offset });
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
          onPick={(actor) => onStateChange({ actor: filter.actor === actor ? undefined : actor })}
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
              onClick={() =>
                onStateChange({ mode: candidate.id === "pretty" ? undefined : candidate.id })
              }
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
          onClick={() => onStateChange({ filter: filtering ? undefined : true })}
          aria-label="Filter"
          aria-expanded={filtering}
        >
          <FilterIcon className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onStateChange({ ...RIGHT_EDGE_CLOSED, processors: true })}
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
            onChange={(e) => onStateChange({ q: e.target.value || undefined })}
            placeholder="Search type or payload"
            className="h-8 text-sm"
          />
          <div className="flex flex-wrap gap-1">
            {types.map(([type, count]) => (
              <button
                key={type}
                type="button"
                onClick={() => toggleType(type)}
                aria-pressed={filter.types.has(type)}
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
                onClick={() => onStateChange({ q: undefined, types: undefined, actor: undefined })}
                className="px-1.5 py-0.5 text-xs text-muted-foreground underline-offset-2 hover:underline"
              >
                clear
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      {error ? (
        <p data-type="error" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
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
          // who acted is named when it changes hands: against the last row that WAS someone's (the
          // platform's housekeeping between two of a person's rows names nobody), afresh each day
          const showWho = actorLabel(first) !== namedBefore[index];
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
                onOpen={inspect}
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
                onOpen={inspect}
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
              onOpen={inspect}
            />
          );
        })}
      </div>
      <EventInspector
        event={inspected === undefined ? undefined : events.find((e) => e.offset === inspected)}
        renderers={allRenderers}
        inspectors={allInspectors}
        onClose={() => onStateChange({ event: undefined })}
      />
      <ProcessorsPanel
        open={Boolean(state.processors)}
        onClose={() => onStateChange({ processors: undefined })}
        processors={processors}
        renderCoreState={renderCoreState}
        renderLiveState={renderLiveState}
      />
    </div>
  );
}
