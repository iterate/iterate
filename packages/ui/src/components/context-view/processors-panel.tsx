// The processors panel — everything live about one context, in one right-edge sheet, read top to
// bottom (the old platform's stream-state panel, on today's data):
// - VITALS: the head, the append rate, the context's age and incarnation, the pause; a sparkline of
//   appends per minute over the last hour (from the loaded log's timestamps: no metric of its own).
// - WHO IS HERE: every principal that acted, newest first, with when (a click narrows the feed to
//   them), and the rpc stubs lent right now.
// - SUBSCRIBERS: every row of the subscriptions table (`itx.subscriptions.list()`), one section each —
//   what it consumes, where it is delivered, since when; a PROCESSOR (a row hosting a facet) with its
//   class, its restarts and its live state; a LIVE CALLBACK (a session's lent stub) connected or not;
//   an ITX CALL with its cursor (confirmed offset, lag, retries) or where it halted.
// - THE CONTEXT: the core reduce's snapshot, and the offset it reduced through.
// One Pretty / Raw toggle for every state here: fields (pretty-state.tsx) or YAML.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { cn } from "cn";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../sheet.tsx";
import { shortEventType } from "./filters.tsx";
import { LiveStateValue } from "./live-state-value.tsx";
import { record } from "./renderer-helpers.tsx";
import type {
  ContextViewEvent,
  ContextViewPresence,
  ContextViewProcessor,
  LiveStateView,
} from "./types.tsx";

export function ProcessorsPanel({
  open,
  onClose,
  processors,
  presence,
  liveState,
  events,
  head,
  onPickActor,
}: {
  open: boolean;
  onClose: () => void;
  /** The subscriptions table: every subscriber; a row hosting a facet is a processor. */
  processors: readonly ContextViewProcessor[];
  presence: { actors: readonly ContextViewPresence[]; rpcStubs: readonly string[] };
  /** Each live state by name — `core`, and every hosted facet's. */
  liveState: Record<string, LiveStateView>;
  /** The loaded log, sorted by offset: the append rate is read off its tail. */
  events: readonly ContextViewEvent[];
  head: number | undefined;
  /** Narrow the feed to one actor. */
  onPickActor: (actor: string) => void;
}) {
  const [view, setView] = useState<"pretty" | "raw">("pretty");
  const now = useNow(open);
  const rpcStubs = useMemo(() => new Set(presence.rpcStubs), [presence.rpcStubs]);
  const subscribers = useMemo(
    () =>
      [...processors].sort(
        (a, b) =>
          kindRank(kindOf(a)) - kindRank(kindOf(b)) || a.configuredAtOffset - b.configuredAtOffset,
      ),
    [processors],
  );
  // the stubs that are a subscriber's live callback show under that subscriber
  const callbackStubs = new Set(subscribers.flatMap((row) => lentStubKey(row) ?? []));
  const otherStubs = presence.rpcStubs.filter((key) => !callbackStubs.has(key));
  const core = liveState.core || CONNECTING;
  const delivered = subscribers.filter((row) => kindOf(row) !== "callback");
  const liveCallbacks = subscribers.filter(
    (row) => kindOf(row) === "callback" && rpcStubs.has(lentStubKey(row)!),
  );
  const orphanedCallbacks = subscribers.filter(
    (row) => kindOf(row) === "callback" && !rpcStubs.has(lentStubKey(row)!),
  );
  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent
        side="right"
        className="overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-2xl"
      >
        <SheetHeader className="flex-row items-start gap-3">
          <div className="min-w-0 flex-1">
            <SheetTitle>Processors</SheetTitle>
            <SheetDescription>
              Who is here, what subscribes to this context, and what each has folded.
            </SheetDescription>
          </div>
          <div
            role="tablist"
            aria-label="How state reads"
            className="mr-8 flex shrink-0 rounded-md border p-0.5 text-xs"
          >
            {(["pretty", "raw"] as const).map((candidate) => (
              <button
                key={candidate}
                type="button"
                role="tab"
                aria-selected={view === candidate}
                onClick={() => setView(candidate)}
                className={cn(
                  "rounded px-2 py-0.5 capitalize",
                  view === candidate
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {candidate}
              </button>
            ))}
          </div>
        </SheetHeader>
        <div className="flex min-w-0 flex-col gap-6 px-4 pb-8">
          <Vitals events={events} head={head} core={core.value} now={now} />

          <Section title="Here" count={presence.actors.length}>
            {presence.actors.length === 0 ? (
              <Quiet>Nobody has acted on this context in the loaded log.</Quiet>
            ) : (
              <ul className="flex flex-col">
                {presence.actors.map((who) => (
                  <li key={who.actor}>
                    <button
                      type="button"
                      onClick={() => onPickActor(who.actor)}
                      title={`Show only what ${who.email || who.actor} did`}
                      className="flex w-full min-w-0 items-baseline gap-3 rounded px-1 py-0.5 text-left text-xs hover:bg-muted"
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {who.email || who.actor}
                        {who.email ? (
                          <span className="ml-2 font-mono text-muted-foreground">{who.actor}</span>
                        ) : null}
                      </span>
                      {who.grant ? (
                        <span className="hidden truncate font-mono text-muted-foreground sm:inline">
                          {who.grant}
                        </span>
                      ) : null}
                      <span
                        className="shrink-0 text-muted-foreground tabular-nums"
                        title={who.lastSeenAt}
                      >
                        {ago(who.lastSeenAt, now)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className="px-1 text-xs text-muted-foreground">
              {presence.rpcStubs.length === 0
                ? "No rpc stub is lent to this context right now."
                : `${presence.rpcStubs.length} rpc ${presence.rpcStubs.length === 1 ? "stub" : "stubs"} lent right now${
                    otherStubs.length < presence.rpcStubs.length
                      ? `, ${presence.rpcStubs.length - otherStubs.length} of them for the live callbacks below`
                      : ""
                  }.`}
            </p>
            {otherStubs.length > 0 ? (
              <ul className="flex flex-col px-1">
                {otherStubs.map((key) => (
                  <li key={key} className="truncate font-mono text-xs" title={key}>
                    {key}
                  </li>
                ))}
              </ul>
            ) : null}
          </Section>

          <Section title="Subscribers" count={subscribers.length}>
            {subscribers.length === 0 ? (
              <Quiet>Nothing subscribes to this context.</Quiet>
            ) : (
              <div className="flex flex-col divide-y">
                {delivered.map((row) => (
                  <Subscriber
                    key={row.name}
                    row={row}
                    head={head}
                    state={row.hostedFacet ? liveState[row.hostedFacet.name] : undefined}
                    view={view}
                  />
                ))}
              </div>
            )}
            {liveCallbacks.length > 0 ? (
              <div className="flex flex-col gap-0.5">
                <p className="text-xs text-muted-foreground">
                  Live callbacks: a session&apos;s subscription, delivered to the stub it lent
                </p>
                {liveCallbacks.map((row) => (
                  <LiveCallback key={row.name} row={row} connected />
                ))}
                {orphanedCallbacks.length > 0 ? (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                      {orphanedCallbacks.length} not connected: their session ended and the row
                      stayed
                    </summary>
                    {orphanedCallbacks.map((row) => (
                      <LiveCallback key={row.name} row={row} connected={false} />
                    ))}
                  </details>
                ) : null}
              </div>
            ) : null}
          </Section>

          <Section
            title="The context"
            aside={
              typeof core.rev === "number" ? (
                <span className="tabular-nums">reduced through #{core.rev.toLocaleString()}</span>
              ) : null
            }
          >
            <p className="text-xs text-muted-foreground">
              The core reduce: rewrite rules, subscriptions, schedules, fetch routes, open runs, the
              pause.
            </p>
            <LiveStateValue state={core} view={view} core />
          </Section>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** One subscriber: a heading line (name, kind, status), its facts as label / value lines, and a
 *  processor's live state under them. */
function Subscriber({
  row,
  head,
  state,
  view,
}: {
  row: ContextViewProcessor;
  head: number | undefined;
  state: LiveStateView | undefined;
  view: "pretty" | "raw";
}) {
  const kind = kindOf(row);
  const status = statusOf(row, kind);
  const lag =
    row.cursor && head !== undefined ? Math.max(0, head - row.cursor.confirmedOffset) : undefined;
  return (
    <section className="flex min-w-0 flex-col gap-1.5 py-3 first:pt-1">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <h4 className="min-w-0 font-mono text-sm font-medium break-all">{row.name}</h4>
        <span className="text-xs text-muted-foreground">{KIND_LABEL[kind]}</span>
        <span className={cn("ml-auto text-xs", status.tone)}>{status.label}</span>
      </div>
      <dl className="grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
        <Fact label="consumes">
          <span className="font-mono break-all">{consumesText(row.consumes)}</span>
        </Fact>
        <Fact label="delivers to">
          <span className="font-mono break-all">{row.target}</span>
        </Fact>
        {row.hostedFacet ? (
          <Fact label="hosts">
            <span className="font-mono break-all">
              {row.hostedFacet.className}
              {row.hostedFacet.name === row.name ? "" : ` as ${row.hostedFacet.name}`}
            </span>
            <span
              className={cn(
                "ml-2",
                row.hostedFacet.restarts > 0 ? "text-amber-700" : "text-muted-foreground",
              )}
              title="How often the platform failed the facet at its start and restarted it"
            >
              {row.hostedFacet.restarts > 0
                ? `restarted ${row.hostedFacet.restarts}×`
                : "never restarted"}
            </span>
          </Fact>
        ) : null}
        <Fact label="since">
          <span className="tabular-nums">
            configured at #{row.configuredAtOffset.toLocaleString()}
            {row.afterOffset !== undefined && row.afterOffset !== row.configuredAtOffset
              ? `, delivering after #${row.afterOffset.toLocaleString()}`
              : ""}
          </span>
        </Fact>
        {row.cursor ? (
          <Fact label="confirmed">
            <span className="tabular-nums">
              #{row.cursor.confirmedOffset.toLocaleString()}
              {lag === undefined ? null : (
                <span className={cn("ml-2", lag > 0 ? "text-amber-700" : "text-muted-foreground")}>
                  lag {lag.toLocaleString()}
                </span>
              )}
            </span>
          </Fact>
        ) : null}
        {row.halted ? (
          <Fact label="halted">
            <span className="text-destructive">
              after #{row.halted.afterOffset.toLocaleString()}, {row.halted.attempts} attempts
              {row.halted.error ? `: ${row.halted.error}` : ""}
            </span>
          </Fact>
        ) : null}
      </dl>
      {state ? (
        <div className="flex min-w-0 flex-col gap-1 pt-1">
          <p className="text-xs text-muted-foreground">Live state</p>
          <LiveStateValue state={state} view={view} core={false} />
        </div>
      ) : null}
    </section>
  );
}

/** A session's live callback, one line: its name, what it consumes, whether its stub is lent now. */
function LiveCallback({ row, connected }: { row: ContextViewProcessor; connected: boolean }) {
  return (
    <p className="flex min-w-0 items-baseline gap-3 text-xs" title={row.target}>
      <span className="shrink-0 font-mono">{row.name}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
        {consumesText(row.consumes)}
      </span>
      <span className="shrink-0 text-muted-foreground tabular-nums">
        #{row.configuredAtOffset.toLocaleString()}
      </span>
      <span className={cn("shrink-0", connected ? "text-emerald-700" : "text-muted-foreground")}>
        {connected ? "connected" : "gone"}
      </span>
    </p>
  );
}

/** The head, the rate, the age and the pause on one line; a sparkline of the last hour under it. */
function Vitals({
  events,
  head,
  core,
  now,
}: {
  events: readonly ContextViewEvent[];
  head: number | undefined;
  core: unknown;
  now: number;
}) {
  const perMinute = useMemo(() => appendsPerMinute(events, now), [events, now]);
  const lastFive = perMinute.slice(-5).reduce((sum, count) => sum + count, 0) / 5;
  const state = record(core);
  const paused = state.paused ? record(state.paused) : undefined;
  const peak = Math.max(...perMinute);
  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <Stat label="head" value={head === undefined ? "—" : `#${head.toLocaleString()}`} />
        <Stat
          label="appends / min"
          value={lastFive >= 10 ? String(Math.round(lastFive)) : lastFive.toFixed(1)}
          title="Mean over the last five minutes, from the loaded log"
        />
        <Stat
          label="age"
          value={typeof state.createdAt === "string" ? ago(state.createdAt, now, "") : "—"}
          title={typeof state.createdAt === "string" ? `Created ${state.createdAt}` : undefined}
        />
        <Stat
          label="incarnation"
          value={typeof state.incarnation === "number" ? String(state.incarnation) : "—"}
          title="The Durable Object's wake count: growth across idle is hibernation"
        />
        <Stat
          label="paused"
          value={paused ? "yes" : "no"}
          title={typeof paused?.reason === "string" ? paused.reason : undefined}
          tone={paused ? "text-amber-700" : undefined}
        />
      </div>
      <Sparkline counts={perMinute} />
      <p className="text-[11px] text-muted-foreground">
        Appends per minute over the last hour{peak > 0 ? `, peak ${peak}` : ""}, from the loaded
        log.
      </p>
    </section>
  );
}

function Stat({
  label,
  value,
  title,
  tone,
}: {
  label: string;
  value: string;
  title?: string;
  tone?: string;
}) {
  return (
    <div title={title}>
      <div className="text-[10px] tracking-wide text-muted-foreground uppercase">{label}</div>
      <div className={cn("font-mono text-sm tabular-nums", tone)}>{value}</div>
    </div>
  );
}

/** One series as an area and its line, scaled to its own peak (floored at 5, so one event is not
 *  a mountain). */
function Sparkline({ counts }: { counts: readonly number[] }) {
  const width = 360;
  const height = 36;
  const max = Math.max(5, ...counts);
  const step = width / Math.max(1, counts.length - 1);
  const points = counts
    .map(
      (count, index) =>
        `${(index * step).toFixed(1)},${(height - 1 - (count / max) * (height - 4)).toFixed(1)}`,
    )
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="h-9 w-full text-sky-600"
      aria-hidden
    >
      <polygon points={`0,${height} ${points} ${width},${height}`} className="fill-sky-500/10" />
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function Section({
  title,
  count,
  aside,
  children,
}: {
  title: string;
  count?: number;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <h3 className="flex items-baseline gap-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {title}
        {count === undefined ? null : <span className="tabular-nums">{count}</span>}
        {aside ? (
          <span className="ml-auto text-xs font-normal tracking-normal normal-case">{aside}</span>
        ) : null}
      </h3>
      {children}
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

function Quiet({ children }: { children: ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}

type Kind = "processor" | "callback" | "call";

const KIND_LABEL: Record<Kind, string> = {
  processor: "processor",
  callback: "live callback",
  call: "itx call",
};

const kindRank = (kind: Kind) => ["processor", "call", "callback"].indexOf(kind);

/** A row hosting a facet is a processor; one delivered to a lent stub is a session's live
 *  callback; anything else is an itx call the context delivers at-least-once. */
function kindOf(row: ContextViewProcessor): Kind {
  if (row.hostedFacet) return "processor";
  return lentStubKey(row) === undefined ? "call" : "callback";
}

/** The key of the rpc stub a row delivers to (`itx.builtins.rpcStubs.get('<key>')…`), if it does. */
function lentStubKey(row: ContextViewProcessor): string | undefined {
  return /rpcStubs\.get\((["'])(.+?)\1\)/.exec(row.target)?.[2];
}

function statusOf(row: ContextViewProcessor, kind: Kind): { label: string; tone: string } {
  if (row.halted) return { label: "halted", tone: "text-destructive" };
  if (row.cursor?.nextAttemptAtMs !== undefined)
    return {
      label: `retrying, attempt ${row.cursor.attempt}`,
      tone: "text-amber-700",
    };
  if (kind === "processor") return { label: "hosted", tone: "text-emerald-700" };
  return { label: "delivering", tone: "text-emerald-700" };
}

/** What a row consumes, short: its types without the `events.iterate.com/` prefix; none or `*` is
 *  every durable event. */
function consumesText(consumes: readonly string[] | undefined): string {
  if (!consumes?.length || consumes.includes("*")) return "every durable event";
  return consumes.map(shortEventType).join(", ");
}

const CONNECTING: LiveStateView = { status: "connecting", value: undefined };

/** Appends per minute over the last hour (60 buckets, oldest first), read backwards off the
 *  loaded log's tail until an event is older than the window. */
function appendsPerMinute(events: readonly ContextViewEvent[], now: number): number[] {
  const counts = Array.from({ length: 60 }, () => 0);
  const start = now - 60 * 60_000;
  for (let index = events.length - 1; index >= 0; index--) {
    const at = Date.parse(events[index]!.createdAt);
    if (Number.isNaN(at)) continue;
    if (at < start) break;
    counts[Math.min(59, Math.floor((at - start) / 60_000))]!++;
  }
  return counts;
}

/** A compact age: `12s`, `5m`, `3.2h`, `4d`, with `suffix` after it. */
function ago(iso: string, now: number, suffix = " ago"): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (Number.isNaN(seconds)) return "—";
  if (seconds < 60) return `${seconds}s${suffix}`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m${suffix}`;
  if (seconds < 86_400) return `${(seconds / 3600).toFixed(1)}h${suffix}`;
  return `${Math.round(seconds / 86_400)}d${suffix}`;
}

/** The clock, ticking every 15 s while `running` (the panel is open). */
function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}
