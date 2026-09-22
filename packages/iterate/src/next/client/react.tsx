/** @jsxImportSource react */
// client/react.tsx — the React binding for live state, shared by every UI (the hosted
// /demo and the control-plane console). `useLiveState` subscribes a component to a producer's live
// state (a processor slug, a mini-app key), seeds through its door, and re-renders on every synced
// delta via `useSyncExternalStore` over the LiveStateStore. The transport and the store
// (client/live-state.ts) stay framework-free, so this is the ONE file that imports React.
//
// Kept to the one shape a UI or test needs — no reconnect/backoff/ping-watchdog (that policy belongs
// to whoever owns the
// capnweb session; here the caller passes a ready `itx`).
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  connectLiveState,
  type LiveStateItx,
  type LiveStateSeed,
  type LiveStateStore,
} from "./live-state.ts";

export type LiveStateStatus = "connecting" | "live" | "error";

/** One live state as a component reads it: the latest value (undefined until the first seed lands),
 *  the revision it is at, whether its subscription is connecting, live or failed, and the failure. */
export type LiveStateResult<S = unknown> = {
  value: S | undefined;
  rev: number | null;
  status: LiveStateStatus;
  error?: string;
};

/** Subscribe to a producer's live state and render its latest value. Pass a ready `itx` (a capnweb
 *  `api.authenticate(credentials).user` or `.projects.get(id)`), the producer's `key`, and a `door`
 *  thunk that reads `{rev, state}` (`() => itx.invoke("itx.facets.get('slug').liveSnapshot()")`).
 *  Re-subscribes when the session, `key`, or `name` changes; unmount (and every re-subscribe)
 *  disposes the previous server-side subscription. */
export function useLiveState<S>(
  itx: LiveStateItx | undefined,
  opts: { key: string; name?: string; door: () => Promise<LiveStateSeed<S>> },
): LiveStateResult<S> {
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

// ── the iterate context ── the data half of a general-purpose context view (packages/ui
// `components/context-view`, the rendering half): every committed event of a context, live; the rows
// of its processors table; who is here; named facets' live state. ONE hook here, pure components
// there, so the UI kit stays free of the SDK and any app — the dash, the agents app — composes the two.

/** One committed event as the hook hands it out: the itx envelope, structurally. */
export type IterateContextEvent = {
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

/** One row of a context's processors table (`itx.processors.list()`), structurally. */
export type IterateContextProcessorRow = {
  name: string;
  target: string;
  consumes?: string[];
  configuredAtOffset: number;
  hostedFacet?: { name: string; className: string; cacheKey?: string; restarts: number };
};

/** One presence: who acted on the context and when last, from the log's stamps. */
export type IterateContextPresence = {
  actor: string;
  email?: string;
  grant?: string;
  lastSeenAt: string;
};

/** The slice of a context handle `useIterateContext` reads — a capnweb `IterateContextApi` stub
 *  satisfies it structurally. `rpcStubs` is optional: a handle typed without the census (a project
 *  context's client type) still gets the log, the table and the actors. `invoke` seeds a named
 *  facet's live state (`itx.facets.get('<name>').liveSnapshot()`, as an expression). */
export type IterateContextHandle = LiveStateItx & {
  readEvents(
    afterOffset?: number,
    limit?: number,
  ): Promise<{ events: unknown[]; atHead: boolean; scannedThroughOffset: number }>;
  processors: { list(): Promise<IterateContextProcessorRow[]> | IterateContextProcessorRow[] };
  rpcStubs?: { list(): Promise<string[]> | string[] };
  invoke(call: string): Promise<unknown>;
};

/** A wire event (a capnweb proxy value or a plain object) as an `IterateContextEvent`, or null when
 *  it is not a committed row. Structural, not a schema: the transport validated it; this only refuses
 *  a shape the view cannot place (no offset, type or time). */
function toIterateContextEvent(raw: unknown): IterateContextEvent | null {
  const value = JSON.parse(JSON.stringify(raw)) as Record<string, unknown> | null;
  if (
    !value ||
    typeof value.offset !== "number" ||
    typeof value.type !== "string" ||
    typeof value.createdAt !== "string"
  )
    return null;
  return value as unknown as IterateContextEvent; // the three fields checked are all the hook indexes by
}

/** A named live state before its first seed lands — and before the effect that opens it has run. */
const LIVE_STATE_CONNECTING: LiveStateResult = {
  value: undefined,
  rev: null,
  status: "connecting",
};

/** THE ITERATE CONTEXT, live — one hook, one stream subscription. THE LOG: subscribe to every
 *  committed event (or `consumes`) BEFORE the catch-up read, so nothing lands between the two;
 *  pushes and pages both dedupe into one map by offset; `caughtUp` once the read reached the head;
 *  `error` when the connect failed. Off that same log, THE PROCESSORS TABLE, re-read whenever the
 *  log grows a row-changing event (a subscription configured, halted or resumed — the table is core
 *  state, one call away, no push of its own), and WHO IS HERE: the rpc stubs lent right now
 *  (`itx.rpcStubs.list()` — physical, re-read at every new head, since presence changes are
 *  ephemeral facts) and, from the log, every principal that acted, newest first. And named facets'
 *  LIVE STATE, each seeded through `itx.facets.get('<name>').liveSnapshot()` — one entry per name,
 *  always. `liveState` OMITTED opens `core` (the core reduce answers under that name) plus every
 *  hosted facet in the processors table the hook holds, following the table as it loads and changes;
 *  `liveState` GIVEN is exactly the names to open, no implicit `core`. Re-connects when `itx`
 *  changes; unmount disposes every server-side subscription. */
export function useIterateContext(
  itx: IterateContextHandle | undefined,
  opts: { consumes?: string[]; liveState?: string[] } = {},
): {
  events: IterateContextEvent[];
  caughtUp: boolean;
  error?: string;
  processors: { rows: IterateContextProcessorRow[]; loaded: boolean; error?: string };
  presence: { actors: IterateContextPresence[]; rpcStubs: string[] };
  liveState: Record<string, LiveStateResult>;
} {
  // ── the log ──
  const [events, setEvents] = useState<Map<number, IterateContextEvent>>(() => new Map());
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
          const event = toIterateContextEvent(raw);
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

  // ── the processors table ──
  // The table and the last failure remember WHICH itx they came from: a page that swaps contexts
  // (one route, another organization) shows an empty, not-yet-loaded table for the new one rather
  // than the old one's rows or error until the new read lands.
  const [table, setTable] = useState<{
    itx: IterateContextHandle;
    rows: IterateContextProcessorRow[];
  }>();
  const [failure, setFailure] = useState<{ itx: IterateContextHandle; message: string }>();
  const tableVersion = sorted.reduce(
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
  const currentTable = itx && table?.itx === itx ? table : undefined;

  // ── who is here ──
  const [census, setCensus] = useState<{ itx: IterateContextHandle; rpcStubs: string[] }>();
  const head = sorted.at(-1)?.offset ?? 0;
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
    const byActor = new Map<string, IterateContextPresence>();
    for (const event of sorted) {
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
  }, [sorted]);

  // ── named facets' live state ──
  // N subscriptions in ONE effect keyed by the name set — it changes at runtime as the processors
  // table loads (the default set is `core` plus the table's hosted facets) — since hooks cannot run
  // in a loop: client/live-state.ts's store reduces each, and this mirrors every change into React
  // state. The entries remember WHICH itx and name set they came from (as the table does), so a
  // swapped context or a changed set shows fresh connecting entries, never the last one's values.
  const liveStateKey = JSON.stringify(
    opts.liveState || [
      "core",
      ...(currentTable?.rows || []).flatMap((row) =>
        row.hostedFacet ? [row.hostedFacet.name] : [],
      ),
    ],
  );
  const [liveStates, setLiveStates] = useState<{
    itx: IterateContextHandle;
    key: string;
    entries: Record<string, LiveStateResult>;
  }>();
  useEffect(() => {
    if (!itx) return;
    const names = JSON.parse(liveStateKey) as string[];
    if (names.length === 0) return;
    let disposed = false;
    const unmounted = new AbortController(); // an unmount while a first seed is pending recalls that row
    const disposers: Array<() => void | Promise<void>> = [];
    const patch = (name: string, change: Partial<LiveStateResult>) =>
      setLiveStates((held) =>
        held && held.itx === itx && held.key === liveStateKey
          ? { ...held, entries: { ...held.entries, [name]: { ...held.entries[name], ...change } } }
          : held,
      );
    setLiveStates({
      itx,
      key: liveStateKey,
      entries: Object.fromEntries(names.map((name) => [name, LIVE_STATE_CONNECTING])),
    });
    for (const name of names) {
      connectLiveState<unknown>(itx, {
        key: name,
        door: async () =>
          // the engine's own `{ rev, state }` seed, as `liveSnapshot()` answers it
          (await itx.invoke(`itx.facets.get('${name}').liveSnapshot()`)) as LiveStateSeed<unknown>,
        signal: unmounted.signal,
        onResync: (result) => {
          if (disposed) return;
          if (result === "healed") patch(name, { status: "live", error: undefined });
          // the store keeps its last value; the next delta retries the heal
          else patch(name, { status: "error", error: result.message });
        },
      }).then(
        (connection) => {
          if (disposed) {
            void connection.dispose(); // unmounted while connecting — still tear the row down
            return;
          }
          disposers.push(connection.dispose);
          disposers.push(
            connection.store.subscribe(() =>
              patch(name, { value: connection.store.get(), rev: connection.store.rev() }),
            ),
          );
          patch(name, {
            value: connection.store.get(),
            rev: connection.store.rev(),
            status: "live",
          });
        },
        (e: unknown) => {
          if (disposed) return;
          patch(name, { status: "error", error: e instanceof Error ? e.message : String(e) });
        },
      );
    }
    return () => {
      disposed = true;
      unmounted.abort();
      for (const dispose of disposers) void dispose();
    };
  }, [itx, liveStateKey]);
  // One entry per name, always: a name the effect has not reached yet (the render right after the
  // set changed) reads as connecting rather than missing.
  const liveState = useMemo(() => {
    const names = JSON.parse(liveStateKey) as string[];
    const held =
      itx && liveStates?.itx === itx && liveStates.key === liveStateKey ? liveStates.entries : {};
    return Object.fromEntries(names.map((name) => [name, held[name] || LIVE_STATE_CONNECTING]));
  }, [itx, liveStateKey, liveStates]);

  return {
    events: sorted,
    caughtUp,
    error,
    processors: {
      rows: currentTable?.rows || [],
      loaded: Boolean(currentTable),
      error: itx && failure?.itx === itx ? failure.message : undefined,
    },
    presence: { actors, rpcStubs },
    liveState,
  };
}
