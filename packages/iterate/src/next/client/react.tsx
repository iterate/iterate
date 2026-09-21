/** @jsxImportSource react */
// client/react.tsx — the REACT binding for clean-room live state, shared by every UI (the hosted
// /demo and the control-plane console). `useLiveState` subscribes a component to a producer's live
// state (a processor slug, a mini-app key), seeds through its door, and re-renders on every synced
// delta via `useSyncExternalStore` over the LiveStateStore. The transport and the store
// (client/live-state.ts) stay framework-free, so this is the ONE file that imports React.
//
// Adapted from apps/os's `useLiveState` (packages/iterate/src/sdk/capnweb/react.tsx), kept to the one
// shape a UI/test needs — no reconnect/backoff/ping-watchdog (that policy belongs to whoever owns the
// capnweb session; here the caller passes a ready `itx`).
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  connectLiveState,
  type LiveStateItx,
  type LiveStateSeed,
  type LiveStateStore,
} from "./live-state.ts";

export type LiveStateStatus = "connecting" | "live" | "error";

/** Subscribe to a producer's live state and render its latest value. Pass a ready `itx` (a capnweb
 *  `api.authenticate(credentials).user` or `.projects.get(id)`), the producer's `key`, and a `door`
 *  thunk that reads `{rev, state}` (`() => itx.invoke("itx.facets.get('slug').liveSnapshot()")`).
 *  Re-subscribes when the session, `key`, or `name` changes; unmount (and every re-subscribe)
 *  disposes the previous server-side subscription. */
export function useLiveState<S>(
  itx: LiveStateItx | undefined,
  opts: { key: string; name?: string; door: () => Promise<LiveStateSeed<S>> },
): { value: S | undefined; rev: number | null; status: LiveStateStatus; error?: string } {
  const [store, setStore] = useState<LiveStateStore<S> | undefined>();
  const [status, setStatus] = useState<LiveStateStatus>("connecting");
  const [error, setError] = useState<string | undefined>();
  // The door thunk is a fresh arrow every render; hold the latest so the effect need not re-run per
  // render. The effect SNAPSHOTS it at connect time, so an old subscription's gap heal can never
  // read a NEWER key's door (cross-key contamination after a key/session switch).
  const doorRef = useRef(opts.door);
  doorRef.current = opts.door;

  useEffect(() => {
    setStore(undefined);
    setStatus("connecting");
    setError(undefined);
    if (!itx) return;
    const door = doorRef.current; // pinned to THIS key/session for the connection's whole life
    let disposed = false;
    let dispose: (() => Promise<void>) | undefined;
    const unmounted = new AbortController(); // an unmount while the first seed is pending recalls the row
    connectLiveState<S>(itx, {
      key: opts.key,
      name: opts.name,
      door,
      signal: unmounted.signal,
      onResync: (r) => {
        if (disposed) return;
        if (r === "healed") {
          setStatus("live");
          setError(undefined);
        } else {
          // the store keeps its last value; the next delta retries the heal
          setStatus("error");
          setError(r.message);
        }
      },
    }).then(
      (conn) => {
        dispose = conn.dispose;
        if (disposed) {
          void conn.dispose(); // unmounted while connecting — still tear the mount down
          return;
        }
        setStore(conn.store);
        setStatus("live");
      },
      (e: unknown) => {
        if (disposed) return;
        setError(e instanceof Error ? e.message : String(e));
        setStatus("error");
      },
    );
    return () => {
      disposed = true;
      unmounted.abort();
      void dispose?.();
    };
  }, [itx, opts.key, opts.name]);

  const subscribe = useCallback(
    (cb: () => void) => (store ? store.subscribe(cb) : () => {}),
    [store],
  );
  const value = useSyncExternalStore(
    subscribe,
    () => store?.get(),
    () => undefined,
  );
  return { value, rev: store?.rev() ?? null, status, error };
}

// ── the context's log, processors and presence ── the data half of a general-purpose context view
// (packages/ui `components/context-view`, the rendering half): every committed event of a context,
// live; the rows of its processors table; who is here. Hooks here, pure components there, so the UI
// kit stays free of the SDK and any app — the dash, the agents app — composes the two.

/** One committed event as the log hooks hand it out: the itx envelope, structurally. */
export type ContextLogEvent = {
  offset: number;
  type: string;
  createdAt: string;
  payload?: unknown;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
  source?: {
    principal?: { actor: string; email?: string };
    grant?: string;
    processor?: { slug: string; version: string };
  };
};

/** The slice of a context handle the log hook reads — a capnweb `IterateContextApi` stub satisfies it. */
export type ContextLogItx = LiveStateItx & {
  readEvents(
    afterOffset?: number,
    limit?: number,
  ): Promise<{ events: unknown[]; atHead: boolean; scannedThroughOffset: number }>;
};

/** A wire event (a capnweb proxy value or a plain object) as a `ContextLogEvent`, or null when it is
 *  not a committed row. Structural, not a schema: the transport validated it; this only refuses a
 *  shape the view cannot place (no offset, type or time). */
function toContextLogEvent(raw: unknown): ContextLogEvent | null {
  const value = JSON.parse(JSON.stringify(raw)) as Record<string, unknown> | null;
  if (
    !value ||
    typeof value.offset !== "number" ||
    typeof value.type !== "string" ||
    typeof value.createdAt !== "string"
  )
    return null;
  return value as unknown as ContextLogEvent; // the three fields checked are all the hooks index by
}

/** THE LOG, live: subscribe to every committed event (or `consumes`) BEFORE the catch-up read, so
 *  nothing lands between the two; pushes and pages both dedupe into one map by offset. `caughtUp`
 *  once the read reached the head; `error` when the connect failed. Re-connects when `itx` changes;
 *  unmount disposes the server-side subscription. The same shape the agents app grew for its feed,
 *  generalized. */
export function useContextLog(
  itx: ContextLogItx | undefined,
  opts: { consumes?: string[] } = {},
): { events: ContextLogEvent[]; caughtUp: boolean; error?: string } {
  const [events, setEvents] = useState<Map<number, ContextLogEvent>>(() => new Map());
  const [caughtUp, setCaughtUp] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const consumesKey = JSON.stringify(opts.consumes || ["*"]);
  useEffect(() => {
    setEvents(new Map());
    setCaughtUp(false);
    setError(undefined);
    if (!itx) return;
    let disposed = false;
    const merge = (batch: unknown[]) =>
      setEvents((held) => {
        const next = new Map(held);
        for (const raw of batch) {
          const event = toContextLogEvent(raw);
          if (event) next.set(event.offset, event);
        }
        return next;
      });
    let subscription: { [Symbol.dispose](): void } | undefined;
    (async () => {
      const handle = await itx.subscribe({
        consumes: JSON.parse(consumesKey) as string[],
        target: (batch) => !disposed && merge(batch),
      });
      // An unmount while the subscribe was pending ran the cleanup before this handle existed:
      // release it here, or the server keeps delivering to nobody.
      if (disposed) {
        handle[Symbol.dispose]();
        return;
      }
      subscription = handle;
      for (let after = 0; ; ) {
        const page = await itx.readEvents(after, 500);
        if (disposed) return;
        merge(page.events);
        if (page.atHead || page.scannedThroughOffset <= after) break;
        after = page.scannedThroughOffset;
      }
      setCaughtUp(true);
    })().catch((e: unknown) => !disposed && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      disposed = true;
      subscription?.[Symbol.dispose]();
    };
  }, [itx, consumesKey]);
  const sorted = useMemo(() => [...events.values()].sort((a, b) => a.offset - b.offset), [events]);
  return { events: sorted, caughtUp, error };
}

/** One row of a context's processors table (`itx.processors.list()`), structurally. */
export type ContextProcessorRow = {
  name: string;
  target: string;
  consumes?: string[];
  configuredAtOffset: number;
  hostedFacet?: { name: string; className: string; cacheKey?: string; restarts: number };
};

/** The slice of a context handle the processors and presence hooks read. `rpcStubs` is optional:
 *  a handle typed without the census (a project context's client type) still gets the actors. */
export type ContextTablesItx = {
  processors: { list(): Promise<ContextProcessorRow[]> | ContextProcessorRow[] };
  rpcStubs?: { list(): Promise<string[]> | string[] };
};

/** THE PROCESSORS TABLE, re-read whenever the log grows a row-changing event (a subscription
 *  configured, halted or resumed) — the table is core state, one call away, no push of its own. */
export function useContextProcessors(
  itx: ContextTablesItx | undefined,
  events: readonly ContextLogEvent[],
): { rows: ContextProcessorRow[]; loaded: boolean; error?: string } {
  // The table and the last failure remember WHICH itx they came from: a page that swaps contexts
  // (one route, another organization) shows an empty, not-yet-loaded table for the new one rather
  // than the old one's rows or error until the new read lands.
  const [table, setTable] = useState<{ itx: ContextTablesItx; rows: ContextProcessorRow[] }>();
  const [failure, setFailure] = useState<{ itx: ContextTablesItx; message: string }>();
  const tableVersion = events.reduce(
    (last, event) =>
      event.type.startsWith("events.iterate.com/stream/subscription-") ? event.offset : last,
    0,
  );
  useEffect(() => {
    if (!itx) return;
    let disposed = false;
    Promise.resolve(itx.processors.list()).then(
      (list) => {
        if (disposed) return;
        setTable({ itx, rows: list });
        setFailure(undefined); // a read that recovered clears the last failure
      },
      (e: unknown) =>
        !disposed && setFailure({ itx, message: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      disposed = true;
    };
  }, [itx, tableVersion]);
  const current = itx && table?.itx === itx ? table : undefined;
  return {
    rows: current?.rows || [],
    loaded: Boolean(current),
    error: itx && failure?.itx === itx ? failure.message : undefined,
  };
}

/** One presence: who acted on the context and when last, from the log's stamps. */
export type ContextPresence = { actor: string; email?: string; grant?: string; lastSeenAt: string };

/** WHO IS HERE: the rpc stubs lent right now (`itx.rpcStubs.list()` — physical, re-read on every
 *  batch the log delivers, since presence changes are ephemeral facts) and, from the log, every
 *  principal that acted, newest first. */
export function useContextPresence(
  itx: ContextTablesItx | undefined,
  events: readonly ContextLogEvent[],
): { rpcStubs: string[]; actors: ContextPresence[] } {
  const [census, setCensus] = useState<{ itx: ContextTablesItx; rpcStubs: string[] }>();
  const head = events.at(-1)?.offset ?? 0;
  useEffect(() => {
    if (!itx?.rpcStubs) return;
    let disposed = false;
    Promise.resolve(itx.rpcStubs.list()).then(
      (list) => !disposed && setCensus({ itx, rpcStubs: list }),
      () => undefined, // presence is nice to have; a failed census shows nothing
    );
    return () => {
      disposed = true;
    };
  }, [itx, head]);
  // keyed by its itx: a swapped context shows no census until its own lands
  const rpcStubs = itx && census?.itx === itx ? census.rpcStubs : [];
  const actors = useMemo(() => {
    const byActor = new Map<string, ContextPresence>();
    for (const event of events) {
      const principal = event.source?.principal;
      if (!principal) continue;
      byActor.set(principal.actor, {
        actor: principal.actor,
        email: principal.email,
        grant: event.source?.grant,
        lastSeenAt: event.createdAt,
      });
    }
    return [...byActor.values()].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  }, [events]);
  return { rpcStubs, actors };
}
