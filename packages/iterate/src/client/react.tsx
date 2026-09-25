/** @jsxImportSource react */
// client/react.tsx — the React binding for live state, shared by every UI. `useLiveState` subscribes a component to a producer's live
// state (a processor slug, a mini-app key), seeds from it, and re-renders on every synced
// delta via `useSyncExternalStore` over the LiveStateStore. The transport and the store
// (client/live-state.ts) stay framework-free, so this is the ONE file that imports React.
//
// Kept to the one shape a UI or test needs — no reconnect/backoff/ping-watchdog (that policy belongs
// to whoever owns the capnweb session; here the caller passes a ready `itx`).
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type DependencyList,
} from "react";
import { z } from "zod";
import type { SubscriptionListEntry } from "../api.ts";
import type { StreamEvent } from "../stream/processor.ts";
import {
  connectEventLog,
  EMPTY_EVENT_LOG,
  type EventLogConnection,
  type EventLogHistory,
  type EventLogPresence,
} from "./event-log.ts";
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
 *  `api.authenticate(credentials).user` or `.projects.get(id)`), the producer's `key`, and a `readSeed`
 *  thunk that reads `{rev, state}` (`() => itx.invoke("itx.facets.get('slug').liveSnapshot()")`).
 *  Re-subscribes when the session, `key`, or `name` changes; unmount (and every re-subscribe)
 *  disposes the previous server-side subscription. */
export function useLiveState<S>(
  itx: LiveStateItx | undefined,
  opts: { key: string; name?: string; readSeed: () => Promise<LiveStateSeed<S>> },
): LiveStateResult<S> {
  const [store, setStore] = useState<LiveStateStore<S> | undefined>();
  const [status, setStatus] = useState<LiveStateStatus>("connecting");
  const [error, setError] = useState<string | undefined>();
  // The readSeed thunk is a fresh arrow every render; hold the latest so the effect need not re-run per
  // render. The effect SNAPSHOTS it at connect time, so an old subscription's gap heal can never
  // read a NEWER key's seed (cross-key contamination after a key/session switch).
  const readSeedRef = useRef(opts.readSeed);
  readSeedRef.current = opts.readSeed;

  useEffect(() => {
    setStore(undefined);
    setStatus("connecting");
    setError(undefined);
    if (!itx) return;
    const readSeed = readSeedRef.current; // pinned to THIS key/session for the connection's whole life
    let disposed = false;
    let dispose: (() => Promise<void>) | undefined;
    const unmounted = new AbortController(); // an unmount while the first seed is pending recalls the row
    connectLiveState<S>(itx, {
      key: opts.key,
      name: opts.name,
      readSeed,
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

/** The live state of a facet hosted on a held context — `useLiveState` seeded by the facet's own
 *  `liveSnapshot()` (`{ rev, state }`). The value is unparsed: deltas arrive unvalidated, so a
 *  caller parses what it reads (`Schema.safeParse(live.value)`). */
export function useFacetLiveState(
  itx: (LiveStateItx & { invoke(call: string): Promise<unknown> }) | undefined,
  facet: string,
): LiveStateResult<unknown> {
  return useLiveState<unknown>(itx, {
    key: facet,
    readSeed: async () =>
      FacetLiveSnapshot.parse(await itx!.invoke(`itx.facets.get('${facet}').liveSnapshot()`)),
  });
}

/** What a facet's `liveSnapshot()` answers. */
const FacetLiveSnapshot = z.object({ rev: z.number(), state: z.unknown() });

type ContextStubState<S> = { stub?: S; error?: string; pending: boolean };

/** Hold a capnweb context stub for as long as the component wants it: `open()` —
 *  `() => api.projects.get(id)`, `() => root.cd(path)` — runs when `deps` change, and the stub is
 *  disposed on unmount, on every re-open, and when it arrives after the component moved on (every
 *  open stub is a subscription row and a pinned Durable Object on the platform). `open` null opens
 *  nothing; `pending` while an open is in flight; `error` the refusal. */
export function useContextStub<S extends Disposable>(
  open: (() => PromiseLike<S>) | null,
  deps: DependencyList,
): ContextStubState<S> {
  const [state, setState] = useState<ContextStubState<S>>(() => ({ pending: Boolean(open) }));
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- the caller's `deps` are what `open` closes over; `open` itself is a fresh closure every render
  useEffect(() => {
    if (!open) {
      setState({ pending: false });
      return;
    }
    setState((previous) => (previous.pending && !previous.stub ? previous : { pending: true }));
    let disposed = false;
    let held: S | undefined;
    // The stub is held inside an object: a capnweb stub is a callable proxy, and handed to a state
    // setter directly React would take it for an updater and CALL it.
    open().then(
      (stub) => {
        if (disposed) return stub[Symbol.dispose]();
        held = stub;
        setState({ stub, pending: false });
      },
      (caught: unknown) =>
        !disposed &&
        setState({
          error: caught instanceof Error ? caught.message : String(caught),
          pending: false,
        }),
    );
    return () => {
      disposed = true;
      held?.[Symbol.dispose]();
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- as above: `deps` is the caller's list
  }, deps);
  return state;
}

// ── the iterate context ── the data half of a general-purpose context view (packages/ui
// `components/context-view`, the rendering half): every committed event of a context, live; the rows
// of its processors table; who is here; named facets' live state. ONE hook here, pure components
// there, so the UI kit stays free of the SDK and any app — the dash, the agents app — composes the two.

/** One presence: who acted on the context and when last, from the log's stamps. */
export type IterateContextPresence = EventLogPresence;

/** The slice of a context handle `useIterateContext` reads — a capnweb `IterateContextApi` stub
 *  satisfies it structurally. `invoke` seeds a named facet's live state
 *  (`itx.facets.get('<name>').liveSnapshot()`, as an expression). */
export type IterateContextHandle = LiveStateItx & {
  readEvents(
    afterOffset?: number,
    limit?: number,
  ): Promise<{ events: unknown[]; atHead: boolean; scannedThroughOffset: number }>;
  processors: { list(): Promise<SubscriptionListEntry[]> | SubscriptionListEntry[] };
  rpcStubs: { list(): Promise<string[]> | string[] };
  invoke(call: string): Promise<unknown>;
};

/** A named live state before its first seed lands — and before the effect that opens it has run. */
const LIVE_STATE_CONNECTING: LiveStateResult = {
  value: undefined,
  rev: null,
  status: "connecting",
};

/** THE ITERATE CONTEXT, live — one hook, one stream subscription. THE LOG (client/event-log.ts):
 *  subscribe to every committed event (or `consumes`) BEFORE the catch-up read, so nothing lands
 *  between the two; pushes and pages both dedupe by offset into one sorted array, published at most
 *  once a frame; `caughtUp` once the read reached the head; `error` when the connect failed.
 *  `history: "tail"` (the default) reads the newest page only — a context of 100,000 events opens
 *  as fast as one of 10 — and `older.loadOlder()` reads the page below what is held; `"all"` reads
 *  every page from the first, for a consumer that folds the whole log (the agents chat). `head` is
 *  the newest offset known, so a view can say how much of the log it holds. Off that same log, THE PROCESSORS TABLE, re-read whenever the
 *  log grows a row-changing event (a subscription configured, halted or resumed — the table is core
 *  state, one call away, no push of its own), and WHO IS HERE: the rpc stubs lent right now
 *  (`itx.rpcStubs.list()` — physical, re-read at every new head, since presence changes are
 *  ephemeral facts) and, from the log, every principal that acted, newest first. And named facets'
 *  LIVE STATE, each seeded through `itx.facets.get('<name>').liveSnapshot()` — one entry per name,
 *  always; `core`, the core reduce, has no live state and is its `snapshot()` re-read at each new
 *  head (its `rev` the snapshot's offset). `liveState` OMITTED opens `core` plus every
 *  hosted facet in the processors table the hook holds, following the table as it loads and changes;
 *  `liveState` GIVEN is exactly the names to open, no implicit `core`. Re-connects when `itx`
 *  changes; unmount disposes every server-side subscription. */
export function useIterateContext(
  itx: IterateContextHandle | undefined,
  opts: { consumes?: string[]; liveState?: string[]; history?: EventLogHistory } = {},
): {
  events: StreamEvent[];
  caughtUp: boolean;
  error?: string;
  head: number;
  older: { loadOlder(): void; loading: boolean; exhausted: boolean };
  processors: { rows: SubscriptionListEntry[]; loaded: boolean; error?: string };
  presence: { actors: IterateContextPresence[]; rpcStubs: string[] };
  liveState: Record<string, LiveStateResult>;
} {
  // ── the log ──
  const [log, setLog] = useState<{ itx: IterateContextHandle; connection: EventLogConnection }>();
  const consumesKey = JSON.stringify(opts.consumes || ["*"]);
  const history = opts.history || "tail";
  useEffect(() => {
    setLog(undefined);
    if (!itx) return;
    const connection = connectEventLog(itx, {
      consumes: JSON.parse(consumesKey) as string[],
      history,
    });
    setLog({ itx, connection });
    return () => connection.dispose();
  }, [itx, consumesKey, history]);
  // keyed by its itx: a swapped context shows an empty log until its own connects
  const connection = itx && log?.itx === itx ? log.connection : undefined;
  const subscribeLog = useCallback(
    (listener: () => void) => (connection ? connection.subscribe(listener) : () => {}),
    [connection],
  );
  const held = useSyncExternalStore(
    subscribeLog,
    () => connection?.get() ?? EMPTY_EVENT_LOG,
    () => EMPTY_EVENT_LOG,
  );
  const { events: sorted, caughtUp, head, tableVersion } = held;
  const loadOlder = useCallback(() => connection?.loadOlder(), [connection]);
  const older = useMemo(
    () => ({ loadOlder, loading: held.older.loading, exhausted: held.older.exhausted }),
    [loadOlder, held.older],
  );
  // the census and the core reduce are re-read as the head moves, at most once a second: a live
  // tail of many events a second (or the catch-up of a whole log) is one read a second, not one
  // per frame
  const headForReads = useThrottled(head, 1000);

  // ── the processors table ──
  // The table and the last failure remember WHICH itx they came from: a page that swaps contexts
  // (one route, another organization) shows an empty, not-yet-loaded table for the new one rather
  // than the old one's rows or error until the new read lands.
  const [table, setTable] = useState<{
    itx: IterateContextHandle;
    rows: SubscriptionListEntry[];
  }>();
  const [failure, setFailure] = useState<{ itx: IterateContextHandle; message: string }>();
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
  useEffect(() => {
    if (!itx) return;
    let disposed = false;
    Promise.resolve(itx.rpcStubs.list()).then(
      (list) => !disposed && setCensus({ itx, rpcStubs: list }),
      () => undefined, // presence is nice to have; a failed census shows nothing
    );
    return () => {
      disposed = true;
    };
  }, [itx, headForReads]);
  // keyed by its itx: a swapped context shows no census until its own lands
  const rpcStubs = itx && census?.itx === itx ? census.rpcStubs : [];
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
      if (name === "core") continue; // no live state of its own: read below
      connectLiveState<unknown>(itx, {
        key: name,
        readSeed: async () =>
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
  // THE CORE REDUCE has no live state (#2819 removed it: a delta per commit on every context, for
  // one panel): its `snapshot()` — `{ offset, state }` — is read once caught up and again as the
  // head moves (at most once a second), one read in flight; a head that moves during a read is
  // read once more after it.
  const wantsCore = (JSON.parse(liveStateKey) as string[]).includes("core");
  const [core, setCore] = useState<{ itx: IterateContextHandle; result: LiveStateResult }>();
  const coreReads = useRef<{ itx?: IterateContextHandle; inFlight: boolean; again: boolean }>({
    inFlight: false,
    again: false,
  });
  useEffect(() => {
    if (!itx || !wantsCore || !caughtUp) return;
    const reads = coreReads.current;
    if (reads.itx !== itx) Object.assign(reads, { itx, inFlight: false, again: false });
    if (reads.inFlight) {
      reads.again = true;
      return;
    }
    const read = (): void => {
      reads.inFlight = true;
      reads.again = false;
      itx
        .invoke("itx.facets.get('core').snapshot()")
        .then(
          (answer) => {
            const snapshot = answer as { offset: number; state: unknown };
            if (reads.itx !== itx) return;
            setCore({
              itx,
              result: { value: snapshot.state, rev: snapshot.offset, status: "live" },
            });
          },
          (e: unknown) =>
            reads.itx === itx &&
            setCore({
              itx,
              result: {
                value: undefined,
                rev: null,
                status: "error",
                error: e instanceof Error ? e.message : String(e),
              },
            }),
        )
        .finally(() => {
          if (reads.itx !== itx) return;
          reads.inFlight = false;
          if (reads.again) read();
        });
    };
    read();
  }, [itx, wantsCore, caughtUp, headForReads]);
  useEffect(
    () => () => {
      coreReads.current.itx = undefined; // unmounted: a read that lands after is dropped
    },
    [],
  );

  // One entry per name, always: a name the effect has not reached yet (the render right after the
  // set changed) reads as connecting rather than missing.
  const liveState = useMemo(() => {
    const names = JSON.parse(liveStateKey) as string[];
    const held: Record<string, LiveStateResult> = {
      ...(itx && liveStates?.itx === itx && liveStates.key === liveStateKey && liveStates.entries),
    };
    if (itx && core?.itx === itx) held.core = core.result;
    else delete held.core;
    return Object.fromEntries(names.map((name) => [name, held[name] || LIVE_STATE_CONNECTING]));
  }, [itx, liveStateKey, liveStates, core]);

  return {
    events: sorted,
    caughtUp,
    error: held.error,
    head,
    older,
    processors: {
      rows: currentTable?.rows || [],
      loaded: Boolean(currentTable),
      error: itx && failure?.itx === itx ? failure.message : undefined,
    },
    presence: { actors: held.actors, rpcStubs },
    liveState,
  };
}

/** `value`, changing at most once per `ms`: the latest value lands `ms` after the last change let
 *  through (at once when that is past), so a value that moves every frame is read once a period and
 *  its last move is never lost. */
function useThrottled<T>(value: T, ms: number): T {
  const [held, setHeld] = useState(value);
  const lastLetThrough = useRef(0);
  useEffect(() => {
    if (Object.is(value, held)) return;
    const timer = setTimeout(
      () => {
        lastLetThrough.current = Date.now();
        setHeld(value);
      },
      Math.max(0, lastLetThrough.current + ms - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [value, held, ms]);
  return held;
}
