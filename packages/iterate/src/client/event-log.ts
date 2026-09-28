// client/event-log.ts — a context's log held in memory, the log half of `useIterateContext`
// (client/react.tsx), framework-free like client/live-state.ts. Subscribe first, then read: every
// committed event (or `consumes`) the subscription pushes and every page the reads return merge into
// ONE array sorted by offset, deduped by offset, published at most once per animation frame.
//
// BUILT FOR A LOG OF 100,000 EVENTS: `history: "tail"` reads only the newest page to be caught up
// (the head from a one-row probe, then the page below it) and reads older pages when asked
// (`loadOlder`); `"all"` reads every page from the first, for a consumer that folds the whole log
// (the agents chat). A batch merges without copying what is held but once per frame (an append is
// a concat, a prepend too; only a batch landing inside the held range re-sorts), each wire batch
// is cloned once, and who acted and the processors table's version are kept as events arrive
// rather than recomputed from the whole log.
import type { StreamEvent } from "../stream/processor.ts";
import type { LiveStateItx } from "./live-state.ts";

/** How much of the log to read: the newest page, older ones on request — or all of it. */
export type EventLogHistory = "tail" | "all";

/** The slice of a context the log reads: its subscription and its pages. */
export type EventLogItx = LiveStateItx & {
  readEvents(
    afterOffset?: number,
    limit?: number,
  ): Promise<{ events: unknown[]; atHead: boolean; scannedThroughOffset: number }>;
};

/** One presence: who acted on the context and when last, from the log's stamps. */
export type EventLogPresence = {
  actor: string;
  email?: string;
  grant?: string;
  lastSeenAt: string;
};

/** The log as a render reads it: a new object whenever anything in it changed, so it can be a
 *  `useSyncExternalStore` snapshot. */
export type EventLogSnapshot = {
  /** Every event held, sorted by offset. */
  events: StreamEvent[];
  /** The first read reached the head: everything since then arrives by the subscription. */
  caughtUp: boolean;
  error?: string;
  /** The highest offset known: the head the probe read, or the newest event since. */
  head: number;
  /** Reading older pages: one in flight; none left (the log is held from its first event). */
  older: { loading: boolean; exhausted: boolean };
  /** Every principal that acted on an event held, newest first. */
  actors: EventLogPresence[];
  /** The offset of the newest subscription change held — what the processors table is as of. */
  tableVersion: number;
};

export const EMPTY_EVENT_LOG: EventLogSnapshot = {
  events: [],
  caughtUp: false,
  head: 0,
  older: { loading: false, exhausted: false },
  actors: [],
  tableVersion: 0,
};

/** Offsets per read: the platform's page cap (apps/os `stream.ts` READ_PAGE_MAX_EVENTS). */
const PAGE = 1000;

export type EventLogConnection = {
  get(): EventLogSnapshot;
  subscribe(listener: () => void): () => void;
  /** Read the page of offsets below the lowest held (and on, while a page of a sparse log holds
   *  few events). One read in flight; a no-op once exhausted or before the first read is done. */
  loadOlder(): void;
  /** Stop publishing and release the server-side subscription. */
  dispose(): void;
};

/** Subscribe to a context's log and read it — the newest page (`"tail"`) or all of it (`"all"`). */
export function connectEventLog(
  itx: EventLogItx,
  opts: { consumes: string[]; history: EventLogHistory },
): EventLogConnection {
  let disposed = false;
  let subscription: { [Symbol.dispose](): void } | undefined;
  const listeners = new Set<() => void>();
  let snapshot = EMPTY_EVENT_LOG;
  // what the next frame publishes
  const seen = new Set<number>();
  let events: StreamEvent[] = [];
  let pending: StreamEvent[] = [];
  let caughtUp = false;
  let error: string | undefined;
  let head = 0;
  /** Every durable event after this offset is held (or pending); 0 = the log from its first. */
  let floor = 0;
  let loadingOlder = false;
  let tableVersion = 0;
  const byActor = new Map<string, EventLogPresence & { offset: number }>();
  let actors: EventLogPresence[] = [];
  let scheduled = false;

  const schedule = () => {
    if (scheduled || disposed) return;
    scheduled = true;
    // a hidden tab runs no frames: what arrives meanwhile publishes as one when it is shown
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(flush);
    else setTimeout(flush, 16);
  };
  const flush = () => {
    scheduled = false;
    if (disposed) return;
    const fresh: StreamEvent[] = [];
    let actorsChanged = false;
    for (const event of pending) {
      if (seen.has(event.offset)) continue; // a committed offset never changes: the first copy stands
      seen.add(event.offset);
      fresh.push(event);
      if (event.offset > head) head = event.offset;
      if (event.type.startsWith("events.iterate.com/itx/subscription-"))
        tableVersion = Math.max(tableVersion, event.offset);
      const principal = event.source?.principal;
      const held = principal && byActor.get(principal.actor);
      if (principal && (!held || held.offset < event.offset)) {
        byActor.set(principal.actor, {
          actor: principal.actor,
          email: principal.email,
          grant: event.source?.grant,
          lastSeenAt: event.createdAt,
          offset: event.offset,
        });
        actorsChanged = true;
      }
    }
    pending = [];
    if (fresh.length > 0) {
      fresh.sort((a, b) => a.offset - b.offset);
      if (events.length === 0 || fresh[0]!.offset > events.at(-1)!.offset)
        events = events.concat(fresh);
      else if (fresh.at(-1)!.offset < events[0]!.offset) events = fresh.concat(events);
      else events = events.concat(fresh).sort((a, b) => a.offset - b.offset);
    }
    if (actorsChanged)
      actors = [...byActor.values()]
        .map(({ offset: _, ...presence }) => presence)
        .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
    snapshot = {
      events,
      caughtUp,
      error,
      head,
      // before the first read, `floor` is not known yet: what lies below a push that landed first
      // is loading, never the start of the log
      older: {
        loading: loadingOlder || (!caughtUp && !error),
        exhausted: caughtUp && floor === 0,
      },
      actors,
      tableVersion,
    };
    for (const listener of listeners) listener();
  };
  const take = (events: StreamEvent[]) => {
    for (const event of events) pending.push(event);
    schedule();
  };
  const fail = (caught: unknown) => {
    if (disposed) return;
    error = caught instanceof Error ? caught.message : String(caught);
    schedule();
  };
  /** Read every durable event in (after, through] — pages are cut by count AND bytes, and a log's
   *  offsets have gaps (ephemerals take offsets the log never stores), so read on until the scan
   *  reaches `through` (or the head). A page holds `limit` EVENTS, so under a gap it runs past
   *  `through`: what it holds above is already held. Returns how many events were in the window. */
  const readThrough = async (after: number, through: number): Promise<number> => {
    let taken = 0;
    for (;;) {
      const page = await itx.readEvents(after, Math.min(PAGE, through - after));
      if (disposed) return taken;
      const inWindow = toStreamEvents(page.events).filter((event) => event.offset <= through);
      take(inWindow);
      taken += inWindow.length;
      if (page.atHead || page.scannedThroughOffset >= through || page.scannedThroughOffset <= after)
        return taken;
      after = page.scannedThroughOffset;
    }
  };

  (async () => {
    const handle = await itx.subscribe({
      consumes: opts.consumes,
      target: (batch) => !disposed && take(toStreamEvents(batch)),
    });
    // disposed while the subscribe was pending: release it here, or the server keeps delivering
    // to nobody
    if (disposed) {
      handle[Symbol.dispose]();
      return;
    }
    subscription = handle;
    if (opts.history === "tail") {
      // the head, from a one-row probe past it: an empty page at the head names the durable mark
      const probe = await itx.readEvents(Number.MAX_SAFE_INTEGER, 1);
      if (disposed) return;
      head = Math.max(head, probe.scannedThroughOffset);
      floor = Math.max(0, probe.scannedThroughOffset - PAGE);
    }
    await readThrough(floor, Infinity);
    caughtUp = true;
    schedule();
  })().catch(fail);

  return {
    get: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    loadOlder() {
      if (disposed || !caughtUp || loadingOlder || floor === 0) return;
      loadingOlder = true;
      schedule();
      (async () => {
        // a page of offsets at a time, and on while they hold few events (a log of mostly
        // ephemerals is sparse): the window doubles, to a cap that bounds one call's reads
        let window = PAGE;
        let taken = 0;
        while (floor > 0 && taken < PAGE / 4) {
          const from = Math.max(0, floor - window);
          taken += await readThrough(from, floor);
          if (disposed) return;
          floor = from;
          window = Math.min(window * 2, 16 * PAGE);
        }
      })()
        .catch(fail)
        .finally(() => {
          loadingOlder = false;
          schedule();
        });
    },
    dispose() {
      disposed = true;
      listeners.clear();
      subscription?.[Symbol.dispose]();
    },
  };
}

/** A wire batch (capnweb proxy values or plain objects) as `StreamEvent`s — one clone per batch,
 *  not per event — without the rows the view cannot place (no offset, type or time). Structural,
 *  not a schema: the transport validated them; the three fields checked are all the log indexes by. */
function toStreamEvents(batch: unknown[]): StreamEvent[] {
  const values = JSON.parse(JSON.stringify(batch)) as (Record<string, unknown> | null)[];
  return values.filter(
    (value) =>
      value &&
      typeof value.offset === "number" &&
      typeof value.type === "string" &&
      typeof value.createdAt === "string",
  ) as unknown as StreamEvent[];
}
