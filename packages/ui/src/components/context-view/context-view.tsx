// THE CONTEXT VIEW — one context's stream with its processors and its presence, the general-purpose
// view every app reuses (the dash's activity pages, the agents feed's base): a strip, one line (what
// this is — a path once, each segment a link up, `context-path.tsx` —, how many events, who is here,
// then Pretty | Raw, Filter and Processors as labelled text buttons), a filter row (a text query, the types
// left ticked), the log folded for reading (folds.tsx) as rows one line wide on a desktop and two
// on a phone, and two right-edge sheets — the inspector for one event, the processors with their
// live state. Two modes on the strip: Pretty (sentences, housekeeping folded, repeats counted) and
// Raw (the log as data); Pretty + raw (every event, sentence and raw line) is still a URL's
// `mode=pretty-raw`, and what an opened fold lists. Nothing here ever
// scrolls sideways; the inspector shows what a line cuts.
// BUILT FOR 100,000 EVENTS: the log arrives newest page first and grows at both ends (live
// appends, older pages as the reader scrolls up — `older`); the filter, the type counts and the fold
// follow that growth instead of passing over the whole log again (folds.tsx `refold`), and the rows
// are one virtual list in the view's own scroll region (feed-list.tsx), so the view needs a bounded
// height from its caller (a flex child that fills the page).
// CONTROLLED: every choice a person makes here is `state` (context-view-search.ts — a URL's search
// in every app) and comes back as an `onStateChange` patch, so a view is a link: the mode, the
// filter, the inspected event, the open sheet. Only the folds opened in place stay local — scroll-
// position-grade ephemera. Pure otherwise: the context arrives as ONE prop, `context` — what the
// SDK's `useIterateContext(itx)` returns, typed structurally here (`ContextViewSource`) so the UI kit
// stays free of the SDK: `<ContextView context={useIterateContext(itx)} … />`.
// APPENDING: given `onAppend` (the caller's `itx.append`), a raw YAML composer sits under the feed
// (append-composer.tsx), closed to one button; what it appends arrives by the live subscription, and
// the feed follows its tail so it lands in view. No `onAppend`, no composer.
import { useCallback, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "cn";
import { Spinner } from "../spinner.tsx";
import { ContextPathLinksContext, type ContextPathLinks } from "./context-path.tsx";
import {
  contextViewFilterOf,
  RIGHT_EDGE_CLOSED,
  type ContextViewState,
} from "./context-view-search.ts";
import { coreEventInspectors, coreEventRenderers } from "./core-renderers.tsx";
import { EventInspector } from "./event-inspector.tsx";
import { FeedList } from "./feed-list.tsx";
import {
  actorLabel,
  narrows,
  recount,
  refilter,
  sortedCounts,
  type Filtered,
  type TypeCounts,
} from "./filters.tsx";
import { refold, sentenceText, type Fold } from "./folds.tsx";
import { AppendComposer } from "./append-composer.tsx";
import { type ContextViewAppendEvent } from "./append-events.ts";
import { FilterRow } from "./filter-row.tsx";
import { EventRate, PresenceStrip } from "./presence-strip.tsx";
import { ProcessorsPanel } from "./processors-panel.tsx";
import {
  type ContextViewEvent,
  type ContextViewMode,
  type ContextViewPresence,
  type ContextViewProcessor,
  type LiveStateView,
  type EventInspectors,
  type EventRenderers,
  rendererFor,
} from "./types.tsx";

const MODES: { id: ContextViewMode; label: string }[] = [
  { id: "pretty", label: "Pretty" },
  { id: "raw", label: "Raw" },
];

/** The strip's text buttons: a word, muted, the one that is on on a quiet fill — no border. */
const stripButton = (on: boolean) =>
  cn(
    "rounded-md px-2 py-0.5 whitespace-nowrap",
    on ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
  );

export function ContextView({
  title,
  context,
  error: callerError,
  renderers,
  inspectors,
  state,
  onStateChange,
  onAppend,
  pathLinks,
  emptyText = "Nothing has happened on this context yet.",
  className,
}: {
  /** What this context is, for the strip: a path (`ContextPath`), a name. */
  title: ReactNode;
  /** The context, live: what `useIterateContext(itx)` returns. */
  context: ContextViewSource;
  /** The caller's own failure (opening the context), shown over the context's. */
  error?: string;
  renderers?: EventRenderers;
  /** Rich inspector bodies by type — over the platform's own (a script's code, its result). */
  inspectors?: EventInspectors;
  /** The view's state — the route's parsed search (`validateSearch: ContextViewState`). */
  state: ContextViewState;
  /** A patch to the state; an `undefined` value drops the key (the route spreads it into the search). */
  onStateChange: (patch: Partial<ContextViewState>) => void;
  /** Append to the context (`(events) => itx.append(...events)`); omitted = a view with no composer.
   *  The platform stamps who appended: nothing to add here. */
  onAppend?: (events: ContextViewAppendEvent[]) => Promise<unknown>;
  /** Where a context path a row names links (a child context's); omitted = plain text. */
  pathLinks?: ContextPathLinks;
  emptyText?: string;
  className?: string;
}) {
  const { events, caughtUp, older = OLDER_EXHAUSTED, head, presence, liveState } = context;
  const processors = context.processors.rows;
  const error = callerError || context.error || context.processors.error;
  const mode = state.mode || "pretty";
  const filter = useMemo(() => contextViewFilterOf(state), [state]);
  const filtering = Boolean(state.filter);
  const inspected = state.event;
  /** The folds opened in place, by item key. */
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  /** Bumped by each append from here: the feed goes back to its tail to show it land. */
  const [followTail, setFollowTail] = useState(0);
  // the platform's own events read as sentences everywhere; an app's renderers lie over them
  const allRenderers = useMemo(() => ({ ...coreEventRenderers, ...renderers }), [renderers]);
  const allInspectors = useMemo(() => ({ ...coreEventInspectors, ...inspectors }), [inspectors]);
  // Each pass below keeps what it made last (a ref) and redoes only what the log's growth changed:
  // the added events filtered, the fold's seam re-folded, the added types counted.
  const filteredRef = useRef<Filtered>(undefined);
  const shown = useMemo(
    () => (filteredRef.current = refilter(filteredRef.current, events, filter)).shown,
    [events, filter],
  );
  // the same fact = the same sentence: four sign-ins fold whatever their timestamps and ids say.
  // Remembered per event: a fold asks it of every event it passes, and a render per ask is most of
  // a fold's time.
  const factOf = useMemo(() => {
    const facts = new WeakMap<ContextViewEvent, string>();
    return (event: ContextViewEvent) => {
      let fact = facts.get(event);
      if (!fact) {
        const sentence = rendererFor(allRenderers, event.type)?.(event);
        const text = sentence ? sentenceText(sentence) : "";
        fact = `${event.type}\u0000${text || JSON.stringify(event.payload ?? null)}`;
        facts.set(event, fact);
      }
      return fact;
    };
  }, [allRenderers]);
  const foldRef = useRef<Fold>(undefined);
  const { items, namedBefore } = useMemo(
    () => (foldRef.current = refold(foldRef.current, shown, mode, factOf, actorLabel)),
    [shown, mode, factOf],
  );
  // counted only while the filter row that lists them is open
  const countsRef = useRef<TypeCounts>(undefined);
  const types = useMemo(
    () =>
      filtering
        ? sortedCounts((countsRef.current = recount(countsRef.current, events)).counts)
        : [],
    [events, filtering],
  );
  const filtered = narrows(filter);
  // stable, so the memoised rows skip the re-render every scroll frame and every append brings
  const toggleOpened = useCallback(
    (key: string) =>
      setOpened((held) => {
        const next = new Set(held);
        if (!next.delete(key)) next.add(key);
        return next;
      }),
    [],
  );
  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;
  const inspect = useCallback(
    (offset: number) => onStateChangeRef.current({ ...RIGHT_EDGE_CLOSED, event: offset }),
    [],
  );
  const loaded = events.length.toLocaleString();
  const count = filtered
    ? `${shown.length.toLocaleString()} of ${loaded} loaded events`
    : older.exhausted
      ? `${loaded} events`
      : `${loaded} loaded of ~${(head ?? 0).toLocaleString()} events`;
  // every row's columns start in line: the offset gutter fits the largest offset, `#` included
  // (the feed's rows, the day marks and the composer read it); cast: React's CSSProperties has no
  // index for a custom property
  const gutter = {
    "--offset-width": `${String(String(events.at(-1)?.offset ?? 0).length + 1)}ch`,
  } as CSSProperties;
  return (
    <div className={cn("flex min-h-0 min-w-0 flex-col", className)} style={gutter}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 sm:px-4 py-1.5">
        <div className="flex min-w-0 items-baseline gap-4">
          <div className="min-w-0 truncate text-sm">{title}</div>
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {count}
            {caughtUp ? "" : " · loading"}
            <EventRate events={events} />
          </span>
        </div>
        <PresenceStrip
          className="hidden min-w-0 xl:flex"
          actors={presence.actors}
          rpcStubs={presence.rpcStubs}
          onPick={(actor) => onStateChange({ actor: filter.actor === actor ? undefined : actor })}
        />
        <div className="ml-auto flex items-center gap-3 text-xs">
          <div role="tablist" aria-label="How the log reads" className="flex gap-0.5">
            {MODES.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                role="tab"
                aria-selected={mode === candidate.id}
                onClick={() =>
                  onStateChange({ mode: candidate.id === "pretty" ? undefined : candidate.id })
                }
                className={stripButton(mode === candidate.id)}
              >
                {candidate.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => onStateChange({ filter: filtering ? undefined : true })}
            aria-expanded={filtering}
            className={stripButton(filtering || filtered)}
          >
            Filter
          </button>
          <button
            type="button"
            onClick={() => onStateChange({ ...RIGHT_EDGE_CLOSED, processors: true })}
            className={stripButton(false)}
          >
            Processors <span className="text-foreground tabular-nums">{processors.length}</span>
          </button>
        </div>
      </div>
      {filtering ? (
        <div className="px-3 sm:px-4 pb-2">
          <FilterRow
            filter={filter}
            counts={types}
            narrowed={filtered}
            partial={!older.exhausted}
            loaded={loaded}
            onStateChange={onStateChange}
          />
        </div>
      ) : null}
      {error ? (
        <p data-type="error" className="px-3 sm:px-4 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <ContextPathLinksContext value={pathLinks}>
        <FeedList
          items={items}
          namedBefore={namedBefore}
          mode={mode}
          renderers={allRenderers}
          inspected={inspected}
          onInspect={inspect}
          opened={opened}
          onToggle={toggleOpened}
          older={older}
          followTail={followTail}
          empty={
            error ? null : caughtUp ? (
              <p className="px-3 sm:px-4 py-6 text-sm text-muted-foreground">
                {filtered ? "No event matches the filter." : emptyText}
              </p>
            ) : (
              <div className="flex items-center gap-2 px-3 sm:px-4 py-6 text-sm text-muted-foreground">
                <Spinner /> Loading the log…
              </div>
            )
          }
        />
      </ContextPathLinksContext>
      {onAppend ? (
        <AppendComposer
          onAppend={onAppend}
          onAppended={() => setFollowTail((count) => count + 1)}
          events={events}
          processors={processors}
        />
      ) : null}
      <EventInspector
        events={events}
        offset={inspected}
        older={older}
        renderers={allRenderers}
        inspectors={allInspectors}
        onNavigate={inspect}
        onClose={() => onStateChange({ event: undefined })}
      />
      <ProcessorsPanel
        open={Boolean(state.processors)}
        onClose={() => onStateChange({ processors: undefined })}
        processors={processors}
        presence={presence}
        liveState={liveState}
        events={events}
        head={head}
        onPickActor={(actor) => onStateChange({ actor, processors: undefined })}
      />
    </div>
  );
}

/** What `ContextView` reads of the SDK's `useIterateContext` result — structural, so any source of
 *  the same shape renders (a test's fixture, a recorded log). */
export type ContextViewSource = {
  /** The events loaded, sorted by offset. */
  events: readonly ContextViewEvent[];
  caughtUp: boolean;
  error?: string;
  /** Reading the log below what is loaded; omitted = the whole log is loaded. */
  older?: { loadOlder(): void; loading: boolean; exhausted: boolean };
  /** The newest offset of the log, so the strip can say how much of it is loaded. */
  head?: number;
  /** The subscriptions table (`itx.subscriptions.list()`): a row hosting a facet is a processor. */
  processors: { rows: readonly ContextViewProcessor[]; error?: string };
  presence: { actors: readonly ContextViewPresence[]; rpcStubs: readonly string[] };
  /** Each live state by name — `core`, and every hosted facet's — for the processors panel. */
  liveState: Record<string, LiveStateView>;
};

/** The whole log is loaded: nothing older to read. */
const OLDER_EXHAUSTED = { loadOlder: () => {}, loading: false, exhausted: true };
