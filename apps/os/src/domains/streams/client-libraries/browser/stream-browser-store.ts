// Component-owned stream runtime.
//
// One runtime per (path, processor slug), shared across every React view that mounts that
// key in a tab (so two views of the same processor share one capnweb connection). The
// SQLite Browser Mirror is shared one level up, per stream path, so a stream's processors
// share one OPFS worker. Cross-tab, Web Locks elect a single writer; followers read the
// same mirror reactively.
//
// A view encodes its own processor + resume config (no central registry): it passes the
// processor, its schema version (for the writer-lock name), the tables to clear on a
// mirror discard, and how to read its durable checkpoint back. The runtime always opens a
// connection (so a follower can still append / read runtimeState) and — only as leader —
// hosts the processor over a fresh subscription, mirroring the Durable-Object-side
// stream processor host.

import type { ProcessorRuntimeState, SubscriptionKey } from "../../rpc-types.ts";
import type { StreamEvent, StreamEventInput } from "../../schemas.ts";
import type { Stream } from "../../../../itx-api.generated.ts";
import {
  announceContract,
  hostRuntimeCapabilities,
  type AnyHostedProcessor,
} from "../../processor-host-capabilities.ts";
import { LatencyRing, type LatencyStats } from "../../stream-runtime-metrics.ts";
import type { SubscriberMetricsReport } from "../../subscriber-metrics.ts";
import { parseBrowserCoreProcessorState } from "./core-processor-state.ts";
import { deleteBrowserProcessorState } from "./processor-state-storage.ts";
import { acquireWriterRole, streamWriterLockName, type WriterRole } from "./stream-leader.ts";
import {
  StreamBrowserDatabase,
  type SqlClient,
  type StreamDatabaseInfo,
} from "./stream-browser-db.ts";

const LIVE_PROGRESS_NOTIFICATION_MS = 16;
const DEFAULT_STREAM_PROJECT_ID = "default";

// --- Catch-up + flow-control tuning ----------------------------------------------------
// The server's live subscription pump is deliberately one-directional: it never waits for
// the client (see stream-subscribers.ts #open). That is perfect for the live tail and
// fatal for a cold mirror thousands of events behind — the whole backlog gets blasted at
// the socket faster than SQLite can apply it (measured: ~20k events/s delivered vs
// ~1-4k events/s applied; a 1M-event replay ballooned a browser tab to >1.3GB of queued
// batches and redelivered 3.26× through reconnect churn). So the leader PULLS history
// with paged `getEvents` reads — client-paced, so backpressure is structural — and only
// subscribes for the tail once it is within CATCHUP_THRESHOLD_EVENTS of the head.

/** How far behind the server head a checkpoint may be before we page instead of subscribe. */
const CATCHUP_THRESHOLD_EVENTS = 1_000;
/** `getEvents` page size (its server-side maximum). */
const CATCHUP_PAGE_LIMIT = 500;
/**
 * Live-tail safety valve: if the un-applied delivery backlog exceeds this many events, the
 * subscription has outrun SQLite. Cut the connection (dropping the queued batches — the
 * superseded-election guard already discards them) and reconnect; the fresh election
 * pull-pages back to the head at the mirror's own pace. One control action when
 * overwhelmed, zero protocol chatter in steady state — delivery frames stay one-way.
 */
const MAX_PENDING_INGEST_EVENTS = 20_000;

/** Retries for `appendBatch` across reconnects/stream-DO restarts (~30s of backoff). */
const APPEND_MAX_RETRIES = 8;
export type StreamBrowserConnectionStatus = "connecting" | "connected" | "closed" | "error";

/**
 * The slice of `StreamProcessor` the browser runtime drives: read the
 * checkpoint to pick the replay cursor, then feed delivered batches into
 * `ingest`. Structural so views construct whatever processor class they like.
 * This is exactly the surface the Durable-Object-side host drives, so it is
 * that host's type rather than a duplicate.
 */
type BrowserHostedProcessor = AnyHostedProcessor;

export type StreamBrowserSnapshot = {
  connectionStatus: StreamBrowserConnectionStatus | "reconnecting" | "subscribing" | "subscribed";
  subscriptionStatus: "idle" | "electing" | "leader" | "follower";
  clearVersion: number;
  connectionError: string | undefined;
  databaseInfo: StreamDatabaseInfo | undefined;
};

/** What a view tells the runtime about the processor it wants hosted. */
export type BrowserProcessorConfig = {
  /** Stable processor identity, used for runtime dedupe, locks, and state rows. */
  slug: string;
  /** Bumped into the writer-lock name so a schema migration lets a fresh tab take over. */
  schemaVersion: number;
  /**
   * When true, a changed schemaVersion clears this processor's projection tables
   * and checkpoint before replay. Use for processors whose projection table
   * shares a SQLite file and cannot own PRAGMA user_version.
   */
  resetOnSchemaVersionChange?: boolean;
  /** Tables this processor owns, cleared together when the local mirror is discarded. */
  tables: string[];
  /** Create the concrete processor once the browser runtime has a stream connection. */
  createProcessor(args: {
    stream: Stream;
    /** The mirrored stream's identity — the StreamProcessor base deps' path/projectId. */
    path: string;
    projectId: string;
    sql: SqlClient;
    subscriptionKey: string;
  }): BrowserHostedProcessor;
};

type BrowserStreamConnectionConfig = {
  projectId?: string;
  createStreamClient: BrowserStreamClientFactory;
  streamUrl?: string | URL | ((args: { projectId: string; streamPath: string }) => string | URL);
  /**
   * Evict the transport `createStreamClient` dials through, so the NEXT call
   * dials fresh. The runtime calls this when the transport looks dead in a way
   * the factory cannot see: a half-open socket (mobile suspend/resume, laptop
   * sleep — no close frame ever arrives) hangs every RPC forever, and a
   * factory that memoizes its connection would re-dial through that corpse on
   * every reconnect. Timeout-shaped failures (probe strikes, dial deadline)
   * and repeated connect failures trigger it; a factory whose transport is
   * per-call fresh can omit it.
   */
  resetTransport?: () => void;
};

/**
 * The browser-hosted runtime only depends on the stream core state. The public
 * `Stream.runtimeState()` also returns server-side runtime diagnostics, but
 * browser processors should not type or depend on that debug payload.
 */
export type StreamRuntimeState = {
  coreProcessorState: unknown;
};

/** The full server runtime debug view (connections, subscriptions, throughput). */
export type StreamServerRuntimeState = Awaited<ReturnType<Stream["runtimeState"]>>;

/**
 * This browser's own REAL stream metrics — every value is measured, never
 * synthesized. `transportRttMs` samples come from timing RPCs the store makes
 * anyway (liveness probes, nudges, debug polls). `subscriber` is the hosted
 * processor's self-measured consumption report (append round trip,
 * consume-own-append loop, ingest stats) — present only on the leader tab,
 * which is the tab that actually consumes; followers report `undefined` and
 * UIs render "—".
 */
export type BrowserStreamMetrics = {
  transportRttMs: LatencyStats | null;
  subscriber: SubscriberMetricsReport | undefined;
};

/**
 * What `appendBatch`/`runtimeState` return. When the connection is ready this is the genuine
 * capnweb `RpcPromise` (lazy + disposable). When the connection is transiently reconnecting
 * the call awaits readiness first and returns a plain awaitable that still carries a no-op
 * `[Symbol.dispose]`, so callers that dispose un-awaited results keep working either way.
 */
export type StreamRpcResult<T> = Promise<T> & Disposable;

export type BrowserStreamClient = Disposable &
  Stream & {
    /**
     * Evict the exact transport THIS client rides, bound at creation (see
     * evictItxSocketIfCurrent) — so a late suspicion verdict against this
     * connection can never evict a successor socket, and a genuinely-dead
     * young socket can be evicted without waiting out an age guard. Absent
     * on clients whose factory can't bind identity; the runtime then falls
     * back to the config-level resetTransport (age-guarded).
     */
    evictTransport?: () => void;
  };

export type BrowserStreamClientFactory = (args: {
  projectId: string;
  streamPath: string;
  streamUrl?: string | URL;
  onConnectionStatusChange?: (
    status: StreamBrowserConnectionStatus,
    error: string | undefined,
  ) => void;
}) => Promise<BrowserStreamClient>;

export function asBrowserStreamClient(
  stream: Stream,
  dispose: () => void,
  evictTransport?: () => void,
): BrowserStreamClient {
  return new Proxy(stream, {
    get(target, property, receiver) {
      if (property === Symbol.dispose) return dispose;
      if (property === "evictTransport") return evictTransport;
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => Reflect.apply(value, target, args);
    },
  }) as BrowserStreamClient;
}

export type StreamBrowserStore = Disposable & {
  readonly streamDatabase: StreamBrowserDatabase;
  appendBatch(args: { events: StreamEventInput[] }): StreamRpcResult<StreamEvent[]>;
  runtimeState(): StreamRpcResult<StreamRuntimeState>;
  /**
   * The full server runtime debug view, RTT-timed: each call also lands one
   * transport-RTT sample in {@link StreamBrowserStore.metrics}. The processors
   * panel polls this while open.
   */
  debugRuntimeState(): Promise<StreamServerRuntimeState>;
  /** This browser's own measured metrics (see {@link BrowserStreamMetrics}). Poll-friendly. */
  metrics(): BrowserStreamMetrics;
  /**
   * An append THIS browser initiated through a lane the store doesn't carry
   * (e.g. `itx.agents.get(path).message(...)`) committed at
   * `maxCommittedOffset`. Feeds the same consume-own-append loop as
   * `appendBatch`: the loop closes when this tab's own subscription ingests
   * past the offset. `t0` is when the caller initiated the append.
   */
  noteExternalAppend(args: { maxCommittedOffset: number; t0: number }): void;
  getProcessorRuntimeState(args: {
    subscriptionKey: SubscriptionKey;
  }): StreamRpcResult<ProcessorRuntimeState | null>;
  /** Clear local tables + checkpoint and reconnect, letting reconcile + replay rebuild the mirror from the server. */
  clearLocalDatabase(): Promise<void>;
  /**
   * On-demand delivery check for when the caller knows the server is about to
   * (or just did) append — reconnects within seconds if the subscription is
   * stale instead of waiting for the next paced probe.
   */
  nudge(): Promise<void>;
  getSnapshot(): StreamBrowserSnapshot;
  getServerSnapshot(): StreamBrowserSnapshot;
  subscribe(listener: () => void): () => void;
  /**
   * True once the runtime tore down (last subscriber gone, idle grace
   * elapsed). A caller holding a memoized reference to a disposed runtime
   * must RE-ACQUIRE, not subscribe — see useStreamProcessorStore's self-heal.
   */
  isDisposed(): boolean;
};

/**
 * How a runtime reaches (and, on suspicion, evicts) the server: the dial and
 * its evictor travel as ONE value so they can never come from two different
 * transports (a factory dialing socket A while timeouts evict socket B would
 * re-arm the wedge this store exists to prevent).
 */
type BrowserStreamTransport = {
  createStreamClient: BrowserStreamClientFactory;
  resetTransport: (() => void) | undefined;
};

// --- Registries: one runtime per (path, slug), one DB per path -------------------------
// The runtime registry leans on the store's own listener lifecycle as its refcount (it
// self-removes on dispose); the DB registry counts the runtimes holding it.

const databaseRegistry = new Map<string, { db: StreamBrowserDatabase; refs: number }>();

function acquireDatabase(projectId: string, streamPath: string) {
  const key = `${projectId}\0${streamPath}`;
  let entry = databaseRegistry.get(key);
  if (entry === undefined) {
    entry = { db: new StreamBrowserDatabase(projectId, streamPath), refs: 0 };
    databaseRegistry.set(key, entry);
  }
  entry.refs += 1;
  const held = entry;
  return {
    db: held.db,
    release() {
      held.refs -= 1;
      if (held.refs === 0) {
        held.db.dispose();
        databaseRegistry.delete(key);
      }
    },
  };
}

const runtimeRegistry = new Map<
  string,
  {
    runtime: StreamBrowserStore;
    refreshTransport: (transport: BrowserStreamTransport) => void;
    retain: () => void;
  }
>();

// Console-accessible view of every live runtime's internals
// (`__streamRuntimeDebug()` in devtools): which runtimes exist, their
// connection/subscription status, and how far deliveries have progressed.
// Exists because this exact information was uninspectable while debugging
// silent per-runtime delivery stalls in deployed environments.
const debugRegistry = new Map<string, () => Record<string, unknown>>();
(globalThis as { __streamRuntimeDebug?: () => Record<string, unknown> }).__streamRuntimeDebug =
  () => Object.fromEntries([...debugRegistry].map(([key, read]) => [key, read()]));

/** Get (or lazily create) the shared runtime for one (path, processor). */
export function acquireStreamRuntime(
  args: { streamPath: string } & BrowserProcessorConfig & BrowserStreamConnectionConfig,
): StreamBrowserStore {
  const projectId = args.projectId ?? DEFAULT_STREAM_PROJECT_ID;
  const slug = args.slug;
  const key = `${projectId} ${args.streamPath} ${slug}`;
  const existing = runtimeRegistry.get(key);
  if (existing !== undefined) {
    // The runtime outlives the render that created it; a stale factory here is
    // a permanent wedge once its captured transport dies. Re-acquires always
    // hand over the current transport WHOLESALE (dial + evictor are one value;
    // pairing acquire N's factory with acquire N-1's evictor would point
    // eviction at a different transport than the one being dialed).
    existing.refreshTransport({
      createStreamClient: args.createStreamClient,
      resetTransport: args.resetTransport,
    });
    // A pending idle-dispose must not fire between this acquire and the
    // commit's subscribe() — see retain()'s docstring.
    existing.retain();
    return existing.runtime;
  }
  const created = createStreamRuntime({
    ...args,
    projectId,
    onDispose: () => runtimeRegistry.delete(key),
  });
  runtimeRegistry.set(key, created);
  return created.runtime;
}

function createStreamRuntime(
  args: {
    projectId: string;
    streamPath: string;
    onDispose?: () => void;
  } & BrowserProcessorConfig &
    BrowserStreamConnectionConfig,
): {
  runtime: StreamBrowserStore;
  refreshTransport: (transport: BrowserStreamTransport) => void;
  retain: () => void;
} {
  // Mutable on purpose: re-acquires refresh it (see acquireStreamRuntime), and
  // connect()/eviction read it per use — a captured-at-creation factory whose
  // transport died would otherwise be dialed forever.
  let transport: BrowserStreamTransport = {
    createStreamClient: args.createStreamClient,
    resetTransport: args.resetTransport,
  };
  const { schemaVersion, tables } = args;
  const slug = args.slug;
  const { db: streamDatabase, release: releaseDatabase } = acquireDatabase(
    args.projectId,
    args.streamPath,
  );

  // A plain SQLite client for the processor. Each committed write nudges the reactive
  // queries (coalesced to one notify per tick so a replay storm shows partial progress).
  const sql: SqlClient = {
    exec: (statement, params) =>
      streamDatabase
        .exec(statement, params)
        .then((rows) => {
          if (isWriteStatement(statement)) notifyDatabaseChangedSoon();
          return rows;
        })
        .catch(onMirrorWriteError),
    batch: (statements, options) =>
      streamDatabase
        .batch(statements, options)
        .then(() => {
          if (statements.some((statement) => isWriteStatement(statement.sql)))
            notifyDatabaseChangedSoon();
        })
        .catch(onMirrorWriteError),
  };

  const listeners = new Set<() => void>();
  let stream: BrowserStreamClient | undefined;
  let subscriptionHandle: { unsubscribe(): void } | undefined;
  let writerRole: WriterRole | undefined;
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let databaseInfoTimer: ReturnType<typeof setTimeout> | undefined;
  let databaseChangeTimer: ReturnType<typeof setTimeout> | undefined;
  let disposeTimer: ReturnType<typeof setTimeout> | undefined;
  let livenessTimer: ReturnType<typeof setInterval> | undefined;
  let disposed = false;
  let started = false;
  // Bumped on every connect() so a stale connection's late callbacks (status changes,
  // subscribe steps) can recognise they no longer own the runtime and bail (B1).
  let connectionEpoch = 0;
  // Resolvers waiting for the next "stream is ready" transition (B2). When stream becomes
  // defined we resolve them all; on dispose we reject them.
  let readyWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  // Self-heal backoff for browser-side ingest failures (C1).
  let ingestFailureCount = 0;
  // Events delivered by the live subscription but not yet applied to SQLite — the
  // in-memory backlog the MAX_PENDING_INGEST_EVENTS valve bounds. Reset whenever the
  // connection is replaced (the superseded-election guard discards the queue with it).
  let pendingIngestEvents = 0;
  // The server incarnation this connection reconciled against, how far deliveries have
  // progressed, and a counter + wall-clock stamp bumped every time a delivery ARRIVES
  // (before the possibly-slow ingest). The delivery check (verifyDelivery) compares these
  // against fresh runtimeState() so an orphaned-but-healthy-looking subscription (the stream
  // was recreated underneath us, or the server moved ahead while deliveries silently
  // stopped) reconnects instead of wedging. Arrival — not ingest completion — is the
  // aliveness signal: a large batch can take longer than a check interval to apply, and that
  // must not read as "orphaned"; the stamp is what lets a check see an arrival that PREDATES
  // it but is still being ingested.
  //
  // Contract of the two arrival stamps (both per-connection evidence, like the strike
  // ledger; both reset where a fresh connection is installed and again when its liveness
  // probe starts, so an arrival on a previous socket — or a pre-subscribe catch-up page —
  // never vouches for the current live subscription).
  //
  // Exact window semantics: verifyDelivery anchors BOTH windows at checkStartedAt — the
  // moment the check acquired its single-flight latch, BEFORE its guarded read (up to two
  // GUARDED_CALL_TIMEOUT_MS windows with the retry) and BEFORE its delivery grace. The
  // stamps themselves are re-read at judgment time (after the grace), so an arrival during
  // the read or the grace is newer than the anchor and always counts; what the early anchor
  // guarantees is that read latency and the grace wait can never shift a window LATE and
  // silently shrink it (judging against a post-grace `now` disqualified arrivals from early
  // in the current probe interval and revoked the first paced probe's baseline grace):
  //   - lastDeliveryArrivalAt: REAL arrivals only. `undefined` means no delivery has
  //     arrived on the current connection since its probe started. Liveness for EVERY
  //     caller of verifyDelivery, exactly when
  //       checkStartedAt - lastDeliveryArrivalAt <= LIVENESS_PROBE_INTERVAL_MS
  //     — an arrival within the probe interval ending when the check began counts, and so
  //     does anything newer.
  //   - arrivalBaselineAt: when the current connection started counting. It is grace, not
  //     liveness: only the paced probe (and resume checks) treat a fresh, arrival-less
  //     subscription as "too early to judge", exactly when
  //       checkStartedAt - arrivalBaselineAt <= LIVENESS_PROBE_INTERVAL_MS + DELIVERY_GRACE_MS.
  //     The + DELIVERY_GRACE_MS slack is what makes the promised grace real: the first
  //     paced probe fires exactly one interval after the baseline is stamped (the same
  //     startLivenessProbe stamps it and starts the setInterval), so a bare-interval bound
  //     would leave the first probe's grace to timer lag. With the slack the first probe
  //     always starts inside the window and the second (two intervals after the baseline)
  //     always starts outside — the second paced probe is the earliest that can declare an
  //     arrival-less subscription orphaned. A nudge does NOT honor this baseline: a nudge
  //     carries caller evidence that the server just appended, so a server-ahead
  //     subscription with ZERO real arrivals is escalated right after the delivery grace
  //     instead of no-oping for up to a full probe interval.
  let reconciledIncarnation: string | undefined;
  let lastDeliveredOffset = -1;
  let deliveryArrivals = 0;
  let lastDeliveryArrivalAt: number | undefined;
  let arrivalBaselineAt = 0;
  // Debug counters (surfaced via __streamRuntimeDebug): how many EVENTS the
  // deliveries actually carried — distinguishes "no deliveries" from
  // "deliveries arrive but carry no events" from "events arrive but writes
  // produce nothing".
  let totalDeliveredEvents = 0;
  let lastBatchEvents = 0;
  let ingestFailures = 0;
  // Real transport-RTT samples from RPCs the store makes anyway (probes,
  // nudges, debug polls). Success-only: a timed-out call is not a sample.
  const transportRtt = new LatencyRing();
  // The leader election's live hosted processor. Its StreamProcessor-provided
  // `subscriberMetrics` is the ONE place this browser's consumption metrics
  // live: appendBatch feeds committed offsets in, the base class's ingest
  // closes the consume-own-append loop, and stream-side pings land their
  // clock-offset estimate here too. Followers host no processor → no
  // self-measured metrics, honestly.
  let currentProcessor: BrowserHostedProcessor | undefined;

  /** The one builder for this browser's measured metrics (store API + debug registry). */
  function readMetrics(): BrowserStreamMetrics {
    return {
      transportRttMs: transportRtt.stats(),
      subscriber: currentProcessor?.subscriberMetrics.report(),
    };
  }

  /**
   * Time one RPC into the transport-RTT ring. Success only — and bounded:
   * callers race these calls against timeouts, and a call the caller already
   * abandoned can still resolve much later (a half-open socket healing).
   * Recording that late duration would poison the ring with a sample the
   * user never experienced as a success, so anything slower than the
   * guarded lane's own deadline is treated as a failure, not a sample.
   */
  function timed<T>(promise: Promise<T>): Promise<T> {
    const t0 = Date.now();
    return promise.then((value) => {
      const elapsed = Date.now() - t0;
      if (elapsed <= GUARDED_CALL_TIMEOUT_MS) transportRtt.record(elapsed, Date.now());
      return value;
    });
  }

  function resolveReadyWaiters() {
    const waiters = readyWaiters;
    readyWaiters = [];
    for (const waiter of waiters) waiter.resolve();
  }

  function rejectReadyWaiters(error: Error) {
    const waiters = readyWaiters;
    readyWaiters = [];
    for (const waiter of waiters) waiter.reject(error);
  }

  // Resolve once the connection is usable again, reject if the runtime is disposed or the
  // wait exceeds the bound. Used by appendBatch/runtimeState so a transient reconnect waits
  // instead of throwing "disposed" (B2).
  function whenStreamReady(timeoutMs = 10_000): Promise<void> {
    if (disposed) return Promise.reject(new Error("stream runtime is disposed"));
    if (stream !== undefined) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        readyWaiters = readyWaiters.filter((entry) => entry !== waiter);
        // StepTimeoutError so appendBatch's retry classifier treats "the
        // reconnect didn't land in time" as transient (retry), unlike an
        // app-level rejection (throw immediately).
        reject(new StepTimeoutError("timed out waiting for stream connection to reconnect"));
      }, timeoutMs);
      readyWaiters.push(waiter);
    });
  }
  const browserSubscriberStorageKey = "stream-browser-subscriber-id";
  const browserSubscriberId =
    localStorage.getItem(browserSubscriberStorageKey) ?? crypto.randomUUID();
  localStorage.setItem(browserSubscriberStorageKey, browserSubscriberId);
  // One stream subscription per (browser profile, processor); projectId keeps it distinct.
  const subscriptionKey = `${args.projectId}:${browserSubscriberId}:${slug}`;
  let snapshot: StreamBrowserSnapshot = {
    clearVersion: 0,
    connectionStatus: "connecting",
    connectionError: undefined,
    databaseInfo: undefined,
    subscriptionStatus: "idle",
  };

  const offDatabaseChange = streamDatabase.onChange(() => {
    if (disposed) return;
    refreshDatabaseInfoSoon();
  });

  function emitSnapshot() {
    for (const listener of listeners) listener();
  }

  function refreshDatabaseInfo() {
    void streamDatabase
      .info()
      .then((databaseInfo) => {
        if (disposed) return;
        snapshot = { ...snapshot, databaseInfo };
        emitSnapshot();
      })
      .catch((error: unknown) => {
        if (disposed) return;
        console.error(
          `[stream ${args.streamPath} ${slug}] local database info refresh failed`,
          error,
        );
        snapshot = { ...snapshot, connectionError: "local database error: " + errorMessage(error) };
        emitSnapshot();
      });
  }

  function refreshDatabaseInfoSoon() {
    if (disposed || databaseInfoTimer !== undefined) return;
    databaseInfoTimer = setTimeout(() => {
      databaseInfoTimer = undefined;
      refreshDatabaseInfo();
    }, 1_000);
  }

  function notifyDatabaseChangedSoon() {
    if (disposed || databaseChangeTimer !== undefined) return;
    databaseChangeTimer = setTimeout(() => {
      databaseChangeTimer = undefined;
      streamDatabase.notifyChanged();
    }, LIVE_PROGRESS_NOTIFICATION_MS);
  }

  function onMirrorWriteError(error: unknown): never {
    if (!disposed) {
      console.error(`[stream ${args.streamPath} ${slug}] local mirror write failed`, error);
      snapshot = {
        ...snapshot,
        connectionError: `local mirror write failed: ${errorMessage(error)}`,
      };
      emitSnapshot();
    }
    throw error;
  }

  // Tear down the live connection/subscription and schedule a single reconnect. One timer and
  // one code path so a socket close and a mirror-ingest self-heal can't deadlock each other
  // (when they had separate guards, a close during the ingest backoff could leave the runtime
  // stuck disconnected). Bumping the epoch supersedes the connection we are dropping, so its
  // late "closed"/"error" callbacks are ignored and can't shorten an in-flight backoff. The
  // next connect() runs a fresh election that re-reads the persisted checkpoint, so the server
  // replays after the last applied offset.
  function scheduleReconnect(connectionError: string, delayMs: number) {
    if (disposed) return;
    connectionEpoch += 1;
    pendingIngestEvents = 0;
    stopLivenessProbe();
    stopSubscriptionElection();
    stream?.[Symbol.dispose]();
    stream = undefined;
    snapshot = { ...snapshot, connectionError, connectionStatus: "reconnecting" };
    emitSnapshot();
    if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delayMs);
  }

  function reconnectNow() {
    if (connectTimer !== undefined) {
      clearTimeout(connectTimer);
      connectTimer = undefined;
    }
    if (reconnectTimer !== undefined) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    connect();
  }

  // THE one transport-suspicion decision point: every reconnect caused by a
  // FAILURE routes through here so the "was the transport itself the problem?"
  // call is made once, not per catch block. A step that TIMED OUT rode a
  // transport that answers nothing — the post-suspend half-open socket — and
  // per-call dialing alone can't escape it (the socket map keeps handing out
  // the cached corpse; it only self-evicts on a close event that never comes).
  // Evict it so the reconnect dials fresh. A step that REJECTED got an answer
  // (a broken-session error, a server-side failure): the transport observably
  // works or already self-evicted — reconnect without collateral damage,
  // unless the caller accumulated its own suspicion (opts.evictTransport).
  function reconnectAfterError(
    step: string,
    error: unknown,
    delayMs: number,
    opts?: { evictTransport?: boolean; suspect?: BrowserStreamClient },
  ) {
    if (opts?.evictTransport || error instanceof StepTimeoutError) {
      console.warn(
        `[stream ${args.streamPath} ${slug}] evicting suspect transport (${step})`,
        error,
      );
      // Prefer the suspect connection's own identity-bound evictor (it can
      // only evict the exact socket the suspicion accumulated against); fall
      // back to the config-level, age-guarded evictor when the factory
      // couldn't bind identity or the failing step had no connection yet.
      const evict = opts?.suspect?.evictTransport ?? transport.resetTransport;
      evict?.();
    }
    scheduleReconnect(`${step}: ${errorMessage(error)}`, delayMs);
  }

  // --- The one guarded-call lane ----------------------------------------------
  // Every RPC on an established connection goes through guardedCall. The
  // dead-connection detectors are just triggers that make a call through this
  // lane — the paced liveness probe, the caller's nudge, resume events, direct
  // calls (appends, state reads), and the subscribe chain's server-touching
  // steps. One deadline, one strike ledger, one error classification, every
  // verdict routed through reconnectAfterError:
  //
  //   - A call that TIMES OUT is a strike: one slow answer is a cold or busy
  //     DO, not a dead socket. Two consecutive strikes against the same
  //     connection mean the transport is swallowing calls (the post-suspend
  //     half-open socket) — evict it and reconnect so the redial is fresh.
  //     Strikes are shared across lanes on purpose: an unanswered append and
  //     an unanswered probe are evidence against the same socket. "Consecutive"
  //     is episode-scoped, though — overlapping timeouts are ONE strike (the
  //     episode rules at the ledger's declaration below).
  //   - A session-broken REJECTION ("Peer closed WebSocket" — capnweb throws
  //     plain Errors, so the shapes are message-matched of necessity) is
  //     definitive on the first hit: the transport observably died or already
  //     self-evicted — reconnect without collateral eviction.
  //   - Anything else is an app-level failure on a working transport
  //     (validation and friends): not a connection problem.
  //
  // The error always rethrows so the caller sees its own failure — appendBatch
  // retries it, the probe waits for its next tick, one-shot reads surface it.
  const GUARDED_CALL_TIMEOUT_MS = 10_000;
  // Consecutive timed-out guarded EPISODES against the CURRENT connection.
  // Ledger invariants:
  //   1. GENERATIONS, not wall clocks, order the episode boundary: every
  //      guarded call captures `ledgerGeneration` when it starts, and a
  //      timeout is NEW evidence (a strike) only if that captured generation
  //      is still current. Recording a strike advances the generation, so
  //      every call already in flight at that instant — including one that
  //      started in the same millisecond — is the same cold episode and is
  //      absorbed. (Millisecond stamps cannot order overlapping calls; a
  //      monotonic generation can.) The generation advances exactly when a
  //      strike is recorded and when a fresh connection installs; a success
  //      resets the COUNT but not the generation (see 4).
  //   2. TWO STRIKES EVICT: strike two means a call that STARTED after strike
  //      one was recorded still got no answer — the transport is swallowing
  //      calls (the post-suspend half-open socket). reconnectAfterError
  //      evicts the suspect connection and reconnects fresh. Strikes are
  //      shared across lanes on purpose: an unanswered append and an
  //      unanswered probe are evidence against the same socket.
  //   3. PROGRESS GUARANTEE: recording strike one — and every ABSORBED
  //      timeout while a strike stands — schedules one immediate follow-up
  //      guarded probe (a cheap runtimeState read; single-flight, never a
  //      storm). The follow-up starts in the post-strike generation, so a
  //      genuinely dead socket converges in ~one guarded timeout after
  //      strike one — deterministically, without waiting for the 10s paced
  //      probe, a latched verify, or a caller's own retry — while a merely
  //      cold DO survives (the follow-up's answer resets the ledger). This
  //      is what keeps episode absorption from delaying eviction below the
  //      old per-detector two-read cadence.
  //   4. Any completed round-trip on the current connection resets the count
  //      — the socket is alive NOW, the only question the ledger asks. The
  //      generation does not advance: a call that started after the last
  //      strike and times out after the success is strike one again, exactly
  //      like the pre-consolidation detectors. A late success from a
  //      superseded connection resets nothing. LATE CREDIT: "completed
  //      round-trip" includes a timed-out call's ABANDONED promise resolving
  //      after its window — the answer still proves the socket carries calls,
  //      so every timeout leaves a reset-on-success continuation on the
  //      abandoned promise (identity-bound to its connection, like every
  //      other reset). Without it, a cold DO answering just after the 10s
  //      deadline would leave strike one standing while the follow-up probe
  //      or a caller's fresh retry times out into a false strike two. For
  //      the same reason, retry-once lanes (withDeadline, verifyDelivery)
  //      REUSE the in-flight promise for the retry instead of issuing a
  //      fresh read: the late answer then resolves the retry window itself.
  //      A late REJECTION earns no credit and takes no action — the timeout
  //      verdict already stood in for it, and session-broken classification
  //      belongs to calls the lane still owns.
  //   5. PER-CONNECTION EVIDENCE: count, generation, and the follow-up latch
  //      reset where every fresh connection is installed (connect()'s stream
  //      assignment) — a strike is evidence against one socket and must never
  //      carry over to the next, whichever path redialed (scheduleReconnect,
  //      clearLocalDatabase's reconnectNow, a direct call's connect()).
  //      Increments are already identity-bound (stream === connection), so
  //      the installation-time reset is the complete set.
  // Interleavings this must get right:
  //   - Probe read + appendBatch overlapping on a cold DO: the first timeout
  //     is strike one; the second captured the pre-strike generation →
  //     absorbed (even same-millisecond), no false eviction of a
  //     healthy-but-cold socket — it schedules the follow-up probe instead.
  //   - Three (or N) calls overlapping: still one strike — every later
  //     timeout captured the pre-strike generation.
  //   - The subscribe chain's deliberate retry-then-evict (withDeadline): the
  //     retry's guarded window opens inside the first attempt's catch, after
  //     the strike advanced the generation — so its timeout is genuinely
  //     consecutive evidence and the eviction that comment promises still
  //     happens, with no wall-clock tie-break needed.
  //   - All-lanes-in-flight after a thaw: every pre-thaw call's timeout
  //     collapses into strike one; the follow-up probe (invariant 3) is the
  //     deterministic post-strike call, so eviction lands ~one timeout later
  //     even if no lane retries and the paced probe is seconds out.
  //   - Cold DO answers at 11s: the read times out at 10s (strike one,
  //     follow-up probe scheduled). The 11s answer resolves the reused-
  //     promise retry (verifyDelivery/withDeadline) AND the late credit
  //     resets the count, so the follow-up probe's verdict — success from a
  //     now-warm DO, or even its own timeout — can no longer be strike two.
  //     A genuinely dead socket never settles the shared promise, so the
  //     retry and the follow-up probe still time out in the post-strike
  //     generation and eviction still lands ~two guarded windows after the
  //     first call started (invariant 3's progress guarantee, unchanged).
  let guardedTimeoutStrikes = 0;
  // The episode boundary (invariant 1). Monotonic per runtime; compared, never
  // interpreted — only equality with a call's captured value matters.
  let ledgerGeneration = 0;

  function isSessionBrokenError(error: unknown) {
    const message = errorMessage(error).toLowerCase();
    return message.includes("websocket") || message.includes("rpc session");
  }

  async function guardedCall<T>(
    step: string,
    connection: BrowserStreamClient,
    call: (rpc: BrowserStreamClient) => Promise<T> | T,
  ): Promise<T> {
    const startedGeneration = ledgerGeneration;
    let pending: Promise<T> | undefined;
    try {
      pending = Promise.resolve(call(connection));
      const result = await raceWithTimeout(
        pending,
        GUARDED_CALL_TIMEOUT_MS,
        `${step} timed out after ${GUARDED_CALL_TIMEOUT_MS}ms`,
      );
      // A late success from an abandoned call on a superseded connection says
      // nothing about the current one.
      if (stream === connection) guardedTimeoutStrikes = 0;
      return result;
    } catch (error) {
      if (disposed || stream !== connection) throw error;
      if (error instanceof StepTimeoutError) {
        // Late credit (ledger invariant 4): the abandoned call is still in
        // flight, and if it ever SUCCEEDS that's a completed round-trip on
        // this connection — reset the count so a cold DO answering after the
        // deadline cannot eat strike two from a later fresh read. Identity-
        // bound like every reset; a late rejection earns nothing (the
        // timeout verdict already stood in for it).
        void pending?.then(
          () => {
            if (!disposed && stream === connection) guardedTimeoutStrikes = 0;
          },
          () => {},
        );
        // Episode rule (ledger invariant 1): a timeout whose window was
        // already open when the previous strike landed captured an older
        // generation — same cold episode, not new evidence.
        if (startedGeneration === ledgerGeneration) {
          guardedTimeoutStrikes += 1;
          ledgerGeneration += 1;
          if (guardedTimeoutStrikes >= 2) {
            // reconnectAfterError evicts on StepTimeoutError.
            reconnectAfterError(step, error, 0, { suspect: connection });
          } else {
            // Invariant 3: strike one must deterministically produce the
            // next probing call — never leave convergence to the paced timer.
            scheduleStrikeFollowUpProbe(connection);
          }
        } else if (guardedTimeoutStrikes > 0) {
          // Absorbed same-episode timeout: no new evidence, but it must not
          // stall progress either — make sure one follow-up probe is running.
          scheduleStrikeFollowUpProbe(connection);
        }
      } else if (isSessionBrokenError(error)) {
        reconnectAfterError(step, error, 0, { suspect: connection });
      }
      throw error;
    }
  }

  // The ledger's progress guarantee (invariant 3): one cheap guarded read,
  // started strictly AFTER a strike advanced the generation, so its verdict is
  // decisive — success resets the ledger (the socket was merely cold), a
  // timeout is strike two (guardedCall evicts) unless the struck call's own
  // late answer already credited the ledger (invariant 4 — then it is strike
  // one again and reschedules), a session-broken
  // rejection reconnects on the spot. Single-flight: the latch holds until the
  // probe settles, so absorbed timeouts trickling in during its window cannot
  // fan out into a probe storm.
  let strikeFollowUpProbeInFlight = false;
  function scheduleStrikeFollowUpProbe(connection: BrowserStreamClient) {
    if (strikeFollowUpProbeInFlight || disposed || stream !== connection) return;
    strikeFollowUpProbeInFlight = true;
    setTimeout(() => {
      // Re-check at fire time: a success may have reset the ledger, or a
      // reconnect may have replaced the connection, between schedule and now.
      if (disposed || stream !== connection || guardedTimeoutStrikes === 0) {
        strikeFollowUpProbeInFlight = false;
        return;
      }
      void guardedCall("strike follow-up probe", connection, (rpc) =>
        timed(Promise.resolve(rpc.runtimeState())),
      )
        .catch(() => {
          // Verdicts (strike two → evict, session broken → reconnect) are the
          // guarded lane's own; the probe has nothing to add.
        })
        .finally(() => {
          strikeFollowUpProbeInFlight = false;
        });
    }, 0);
  }

  async function discardLocalMirror() {
    await streamDatabase.clearTables(tables);
    // Projection tables are shared by every browser subscription for this
    // processor slug. If the table is discarded, every checkpoint for that
    // slug is invalid too; leaving an older subscription_key row behind lets
    // readers that pick the highest checkpoint resurrect stale reduced state.
    await deleteBrowserProcessorState({ sql, processorSlug: slug });
    await streamDatabase.compact();
    snapshot = {
      ...snapshot,
      clearVersion: snapshot.clearVersion + 1,
      databaseInfo: undefined,
    };
    emitSnapshot();
    refreshDatabaseInfo();
  }

  // Record (or backfill) the incarnation the mirror is now reconciled against. A
  // stream that has not committed its `created` event yet has no incarnation to
  // record; leaving the row unrecorded means the next reconcile against a
  // now-created stream rebuilds — always safe for a cache.
  async function recordServerIncarnation(serverIncarnation: string | undefined) {
    if (serverIncarnation === undefined) return;
    await streamDatabase.writeMirrorIncarnation(slug, serverIncarnation);
  }

  // Decide whether the local mirror can be trusted against the server before subscribing.
  // The server stream's `createdAt` is its incarnation identity: it is stable for a stream's
  // lifetime and changes when the stream's storage is deleted and recreated (which re-emits
  // `created`, restarting offsets from 1) — see core-processor-state.ts for why it beats
  // core state's per-DO-restart `incarnationId`. If our recorded incarnation differs from
  // the server's, the offset comparison is meaningless — rebuild the mirror. Otherwise fall
  // back to the offset check: discard when the server has fewer committed events than we do.
  async function reconcileLocalMirrorWithServer(
    rpc: BrowserStreamClient,
  ): Promise<{ serverMaxOffset: number }> {
    // Deliberately a throwaway instance: processors memoize their checkpoint on
    // first read, so the real instance must be created after any discard below.
    const processor = args.createProcessor({
      stream: rpc,
      path: args.streamPath,
      projectId: args.projectId,
      sql,
      subscriptionKey,
    });
    const checkpoint = await processor.snapshot();
    const localMaxOffset = checkpoint.offset;
    const { coreProcessorState: rawCoreProcessorState } = await rpc.runtimeState();
    const coreProcessorState = parseBrowserCoreProcessorState(rawCoreProcessorState);
    const reconciled = { serverMaxOffset: coreProcessorState.maxOffset };
    const serverIncarnation = coreProcessorState.createdAt;
    reconciledIncarnation = serverIncarnation;
    const localIncarnation = await streamDatabase.readMirrorIncarnation(slug);
    const localSchemaVersion = args.resetOnSchemaVersionChange
      ? await streamDatabase.readMirrorSchemaVersion(slug)
      : schemaVersion;

    // A truly fresh mirror — no schema version ever recorded AND nothing
    // checkpointed — must never take the rebuild lane: "undefined ≠ current"
    // is not a schema CHANGE, and discarding would VACUUM an empty database
    // on every first open (OPFS VACUUM under a sibling connection's open
    // handles is exactly the contention that wedges the shared per-path
    // file). A fresh checkpoint with a DIFFERENT recorded version still
    // rebuilds: the slug's tables are shared across subscription keys, so an
    // older subscription may have populated them under the old schema.
    const trulyFreshMirror = localMaxOffset <= 0 && localSchemaVersion === undefined;

    if (!trulyFreshMirror && localSchemaVersion !== schemaVersion) {
      console.warn(
        `[stream ${args.streamPath} ${slug}] Local ${slug} schema version changed; rebuilding mirror.`,
        { localSchemaVersion, schemaVersion },
      );
      await discardLocalMirror();
      await streamDatabase.writeMirrorSchemaVersion(slug, schemaVersion);
      await recordServerIncarnation(serverIncarnation);
      return reconciled;
    }

    if (localMaxOffset <= 0) {
      // Fresh mirror: nothing to discard, just record which schema version and
      // incarnation we are tracking.
      if (args.resetOnSchemaVersionChange) {
        await streamDatabase.writeMirrorSchemaVersion(slug, schemaVersion);
      }
      await recordServerIncarnation(serverIncarnation);
      return reconciled;
    }

    if (localIncarnation !== serverIncarnation) {
      // Either the incarnation changed (reset/reincarnation) OR we have local events but no
      // recorded incarnation (a mirror that predates incarnation tracking). In both cases we
      // can't trust the offset comparison — a reset that caught back up to the same maxOffset
      // would otherwise be kept with stale rows — so rebuild from scratch.
      console.warn(
        `[stream ${args.streamPath} ${slug}] Cannot verify local ${slug} mirror against server incarnation (changed or unrecorded); rebuilding.`,
        { localIncarnation, serverIncarnation, localMaxOffset },
      );
      await discardLocalMirror();
      await recordServerIncarnation(serverIncarnation);
      return reconciled;
    }

    if (coreProcessorState.maxOffset < localMaxOffset) {
      console.warn(
        `[stream ${args.streamPath} ${slug}] Server has fewer events than the local mirror; discarding local ${slug} tables.`,
        { serverMaxOffset: coreProcessorState.maxOffset, localMaxOffset },
      );
      await discardLocalMirror();
    }
    // Record (or backfill) the incarnation we are now reconciled against.
    if (args.resetOnSchemaVersionChange) {
      await streamDatabase.writeMirrorSchemaVersion(slug, schemaVersion);
    }
    await recordServerIncarnation(serverIncarnation);
    return reconciled;
  }

  // A dial through a half-open transport hangs forever (no close frame ⇒
  // capnweb never rejects), so every attempt races a deadline. NOTE this
  // deadline is not redundant with the socket map's own 15s dial timeout in
  // itx-react: that one only guards a FRESH dial — a cached, already-resolved
  // corpse resolves instantly and only hangs on the first real round trip,
  // which is this deadline's job to bound. Consecutive failures escalate: the
  // transport is declared suspect after the second in a row (or immediately on
  // a timeout), evicted, and the next attempt dials fresh.
  const CONNECT_DIAL_TIMEOUT_MS = 15_000;
  let connectFailuresSinceSuccess = 0;
  // When the current connect attempt started — onResume uses it to leave a
  // young in-flight dial alone (pageshow fires on every normal load, right
  // after start() began the first dial; restarting it wastes the round trip).
  let connectStartedAt = 0;
  // The epoch of the connect attempt currently in flight, or undefined. An
  // attempt "owns" the runtime only while this matches connectionEpoch: a
  // reconnect path that bumps the epoch (scheduleReconnect) supersedes it,
  // and connect() must then start a fresh attempt — but a connect() call
  // while the CURRENT epoch's attempt is still dialing (a direct call, a
  // resume event) must not abort-and-restart it (each supersede wasted a
  // stub pull and reset the election).
  let connectPendingEpoch: number | undefined;

  function connect() {
    if (stream !== undefined || disposed) return;
    if (connectPendingEpoch === connectionEpoch) return;
    connectStartedAt = Date.now();
    const streamUrl =
      args.streamUrl === undefined
        ? undefined
        : new URL(
            resolveStreamUrl({
              projectId: args.projectId,
              streamPath: args.streamPath,
              streamUrl: args.streamUrl,
            }),
            window.location.href,
          );
    // Identity for THIS connect attempt. A late callback from a previously-redialed
    // connection compares against this and bails if it no longer matches (B1).
    connectionEpoch += 1;
    const epoch = connectionEpoch;
    connectPendingEpoch = epoch;
    const dial = transport.createStreamClient({
      projectId: args.projectId,
      streamPath: args.streamPath,
      streamUrl,
      onConnectionStatusChange(connectionStatus, connectionError) {
        // Ignore status callbacks that belong to a superseded connection: after a
        // reconnect/redial a stale connection's late "closed"/"error" could otherwise
        // clobber the new connection's state (B1).
        if (disposed || epoch !== connectionEpoch) return;
        if (connectionStatus === "closed" || connectionStatus === "error") {
          scheduleReconnect(connectionError ?? connectionStatus, 1_000);
          return;
        }
        snapshot = {
          ...snapshot,
          connectionError: connectionStatus === "connected" ? undefined : snapshot.connectionError,
          connectionStatus,
        };
        emitSnapshot();
      },
    });
    // A dial that lost its deadline (or was superseded) can still settle later:
    // dispose the orphaned connection, and swallow the late rejection so it
    // never surfaces as unhandled.
    void dial.then(
      (connection) => {
        if (disposed || epoch !== connectionEpoch) connection[Symbol.dispose]();
      },
      () => {},
    );
    void raceWithTimeout(
      dial,
      CONNECT_DIAL_TIMEOUT_MS,
      `stream client dial timed out after ${CONNECT_DIAL_TIMEOUT_MS}ms`,
    )
      .then((connection) => {
        if (connectPendingEpoch === epoch) connectPendingEpoch = undefined;
        // The superseded case is disposed by the dial handler above, exactly once.
        if (disposed || epoch !== connectionEpoch) return;
        connectFailuresSinceSuccess = 0;
        // Per-connection evidence resets. A leftover strike from the previous
        // socket must not make this connection's first slow answer look like
        // strike two — and a delivery that arrived on the previous socket must
        // not vouch for this one: verifyDelivery reads the arrival stamp as
        // "deliveries flowing", so a stale stamp would let an orphaned fresh
        // subscription skip its reconnect for up to a full probe interval.
        // Clear the real-arrival stamp and restart the baseline so the paced
        // probe's grace is measured from this connection's own install, like
        // the strike ledger (see the stamps' contract at their declaration).
        // pendingIngestEvents is per-connection evidence too — verifyDelivery
        // treats a positive backlog as proof of life, so a count stranded by a
        // path that replaced the connection without scheduleReconnect
        // (clearLocalDatabase) must never blind the new connection's orphan
        // check. The follow-up latch resets with the ledger it serves.
        guardedTimeoutStrikes = 0;
        ledgerGeneration += 1;
        strikeFollowUpProbeInFlight = false;
        pendingIngestEvents = 0;
        lastDeliveryArrivalAt = undefined;
        arrivalBaselineAt = Date.now();
        stream = connection;
        // A follower can still append / read runtimeState, so readiness is "connection
        // open", not "leader/subscribed". Unblock anyone awaiting reconnect (B2).
        resolveReadyWaiters();
        startSubscriptionElection({ connection, epoch });
      })
      .catch((error: unknown) => {
        if (connectPendingEpoch === epoch) connectPendingEpoch = undefined;
        if (disposed || epoch !== connectionEpoch) return;
        connectFailuresSinceSuccess += 1;
        const delay = Math.min(30_000, 1_000 * 2 ** Math.min(connectFailuresSinceSuccess - 1, 5));
        // A REJECTING dial usually rode a transport whose death was observed
        // (fresh dials recover by themselves), but a factory that hands back
        // stubs on a dead-but-never-closed session rejects identically forever
        // — after two consecutive failures stop giving it the benefit of the
        // doubt. (Timeouts evict on the first hit — reconnectAfterError.)
        reconnectAfterError("connect failed", error, delay, {
          evictTransport: connectFailuresSinceSuccess >= 2,
        });
      });
  }

  function startSubscriptionElection(election: { connection: BrowserStreamClient; epoch: number }) {
    snapshot = { ...snapshot, subscriptionStatus: "electing" };
    emitSnapshot();

    const followerTimeout = setTimeout(() => {
      if (!disposed && subscriptionHandle === undefined) {
        snapshot = { ...snapshot, subscriptionStatus: "follower" };
        emitSnapshot();
      }
    }, 250);

    // Both the connection object AND the epoch must still match: the connection identity
    // guards against a redial, the epoch against an in-flight election whose connect() was
    // superseded before `stream` was reassigned (B1).
    const ownsRuntime = () =>
      !disposed && stream === election.connection && election.epoch === connectionEpoch;

    writerRole = acquireWriterRole({
      lockName: streamWriterLockName({
        projectId: args.projectId,
        streamPath: args.streamPath,
        slug,
        schemaVersion,
      }),
    });
    // The leader chain calls into the server (reconcile's runtimeState, subscribe). When the
    // far leg of a proxied connection dies mid-call — e.g. the page subscribed to a
    // lazily-created agent stream and the agent machinery recreated it, killing the Stream DO
    // behind the proxy hop without a close frame reaching the browser — those calls park
    // forever and the page wedges on "connecting" with no error anywhere. Each
    // server-touching step rides the guarded lane AND follows its two-strike policy: one
    // struck timeout is retried immediately against the same connection (the underlying call
    // is still in flight, so a cold DO's late answer resolves inside the retry window
    // without duplicating work), and the retry's timeout is the lane's second strike:
    // the retry's guarded window opens after strike one was recorded, so the ledger's
    // episode rule counts it as genuinely consecutive evidence — guardedCall evicts the
    // half-open transport and reconnects, so the wedge above still converges. A rejection the lane did not already act on lands in the catch below,
    // which reconnects on a fresh socket to the live instance.
    const withDeadline = <T>(step: string, promise: Promise<T> | T): Promise<T> => {
      const attempt = () => guardedCall(step, election.connection, () => promise);
      return attempt().catch((error: unknown) => {
        if (!(error instanceof StepTimeoutError) || !ownsRuntime()) throw error;
        return attempt();
      });
    };

    void writerRole.whenWriter
      .then(async () => {
        clearTimeout(followerTimeout);
        if (!ownsRuntime()) return undefined;
        snapshot = { ...snapshot, subscriptionStatus: "leader" };
        emitSnapshot();
        const { serverMaxOffset } = await withDeadline(
          "reconcile",
          reconcileLocalMirrorWithServer(election.connection),
        );
        // Re-check after every await: a step that settles late (after this
        // election was superseded) must not write runtime-wide fields like
        // lastDeliveredOffset over the current election's values.
        if (!ownsRuntime()) return undefined;
        const processor = args.createProcessor({
          stream: election.connection,
          path: args.streamPath,
          projectId: args.projectId,
          sql,
          subscriptionKey,
        });
        // The checkpoint read goes to the shared db worker; an un-deadlined
        // hang here would park the runtime as a forever-"leader" with no
        // subscription, no probe, and no error.
        const checkpoint = await withDeadline("checkpoint read", processor.snapshot());
        if (!ownsRuntime()) return undefined;

        // Far behind the head? PULL history with paged reads before opening the
        // one-directional subscription (see the flow-control block up top). Each
        // page is fetched, applied, and checkpointed before the next is
        // requested, so the server can never outrun the mirror here — and a
        // page failure just reconnects and resumes from the checkpoint.
        let catchUpOffset = checkpoint.offset;
        let serverHead = serverMaxOffset;
        if (serverHead - catchUpOffset > CATCHUP_THRESHOLD_EVENTS) {
          console.info(
            `[stream ${args.streamPath} ${slug}] mirror is ${serverHead - catchUpOffset} events behind; pull-paging before subscribing`,
          );
          for (;;) {
            if (serverHead - catchUpOffset <= CATCHUP_THRESHOLD_EVENTS) {
              // The head we were chasing was captured before these pages
              // applied. A stream that kept appending meanwhile could be far
              // ahead of it — re-read the live head before trusting the exit,
              // or the subscription would dump the accumulated gap after all.
              const { coreProcessorState: rawHeadState } = await withDeadline(
                "catch-up head re-read",
                election.connection.runtimeState(),
              );
              if (!ownsRuntime()) return undefined;
              serverHead = parseBrowserCoreProcessorState(rawHeadState).maxOffset;
              if (serverHead - catchUpOffset <= CATCHUP_THRESHOLD_EVENTS) break;
            }
            const page = (await withDeadline(
              "catch-up page read",
              election.connection.getEvents({
                afterOffset: catchUpOffset,
                // The mirror stores ephemeral rows too (the subscription lane
                // delivers them); a default read here would skip every chunk
                // run — losing streamed text the mirror promises to keep and
                // false-firing the raw-events gap detector on each one.
                includeEphemeral: true,
                limit: CATCHUP_PAGE_LIMIT,
              }),
            )) as StreamEvent[];
            if (!ownsRuntime()) return undefined;
            if (page.length === 0) break; // server truth moved (reset?); subscribe reconciles
            deliveryArrivals += 1;
            lastDeliveryArrivalAt = Date.now();
            lastBatchEvents = page.length;
            totalDeliveredEvents += page.length;
            // Deliberately NOT deadlined, unlike the read-only steps above: a
            // deadline can only ABANDON this promise, not cancel the ingest —
            // the old processor would keep committing projection rows and its
            // checkpoint in the db worker while the timeout's fresh election
            // spun up a second processor over the same tables (browser
            // projection/checkpoint writes are non-atomic; two interleaved
            // writers can regress reduced state). A wedged db worker parking
            // this await is the known "worker death is undetected" latent —
            // the safe fix is generation-fenced worker shutdown inside
            // StreamBrowserDatabase, not a deadline here.
            await processor.ingest({ events: page, streamMaxOffset: serverHead });
            if (!ownsRuntime()) return undefined;
            catchUpOffset = page.at(-1)!.offset;
            lastDeliveredOffset = catchUpOffset;
          }
        }
        lastDeliveredOffset = catchUpOffset;
        return {
          processor,
          replayAfterOffset: catchUpOffset,
          subscriber: {
            description: "browser",
            processor: {
              announcement: announceContract(processor.contract),
            },
          },
          // The live capabilities ride as SIBLINGS of the serializable
          // descriptor — the same position the wake handshake gives them,
          // built by the same shared helper so the two hosts cannot drift.
          // Half our measured transport RTT is the one-way estimate that
          // turns observed pings into the clock-offset correction.
          ...hostRuntimeCapabilities(processor, {
            now: () => Date.now(),
            oneWayEstimateMs: () => {
              const rtt = transportRtt.stats();
              return rtt === null ? undefined : rtt.p50 / 2;
            },
          }),
          // Counters are bumped inside ingestWithSelfHeal, AFTER its
          // supersede guard: a batch delivered to a replaced election is
          // dropped and must not count as progress (it never advances
          // lastDeliveredOffset), or the liveness probe would read a dead
          // subscription's stale pushes as healthy.
          processEventBatch: (batch: { events: readonly StreamEvent[]; streamMaxOffset: number }) =>
            ingestWithSelfHeal(processor, batch, election),
        };
      })
      .then(async (ready) => {
        if (ready === undefined || !ownsRuntime()) return undefined;
        const handle = await withDeadline(
          "subscribe",
          election.connection.subscribe({
            subscriptionKey,
            processEventBatch: ready.processEventBatch,
            replayAfterOffset: ready.replayAfterOffset,
            subscriber: ready.subscriber,
            getRuntimeState: ready.getRuntimeState,
            ping: ready.ping,
          }),
        );
        return { handle, processor: ready.processor };
      })
      .then((subscribed) => {
        if (subscribed === undefined) return;
        const { handle, processor } = subscribed;
        if (!ownsRuntime()) {
          fireAndForgetUnsubscribe(handle);
          return;
        }
        subscriptionHandle = handle;
        // Assigned only once the subscription is LIVE: an election that bails
        // mid-chain must not leave metrics/appendBatch attributing samples to
        // a processor that never subscribed (Bugbot round 2).
        currentProcessor = processor;
        nudgeSkipWarned = false;
        snapshot = { ...snapshot, connectionError: undefined, connectionStatus: "subscribed" };
        emitSnapshot();
        startLivenessProbe();
        // Note: we deliberately do NOT reset ingestFailureCount here. A clean resubscribe does
        // not mean the batch that failed will now succeed, so resetting would let a poison
        // batch busy-loop at the floor delay. ingestFailureCount only resets on a successful
        // ingest (so a transient failure that then applies clears the backoff).
      })
      .catch((error: unknown) => {
        clearTimeout(followerTimeout);
        // A late rejection from a superseded election (its connection was already
        // replaced — e.g. a parked subscribe's deadline firing after a reconnect
        // landed us elsewhere) must not tear down the healthy current subscription (B1).
        if (disposed || !ownsRuntime()) return;
        console.error(`[stream ${args.streamPath} ${slug}] subscribe failed`, error);
        // Timeout verdicts (including the half-open-corpse eviction) are the
        // guarded lane's business, made inside withDeadline's retry: a
        // two-strike eviction already reconnected (so ownsRuntime() bailed
        // above), and a StepTimeoutError still reaching here means the ledger
        // never hit two — another lane's success proved the transport answers
        // mid-chain — so one strike is not evidence enough to evict. Restart
        // the election without collateral damage; non-timeout rejections the
        // lane didn't act on are app-level failures and get the same
        // no-eviction reconnect they always did.
        scheduleReconnect(`subscribe failed: ${errorMessage(error)}`, 1_000);
      });
  }

  // Batches are applied strictly one at a time (see ingestWithSelfHeal). The
  // chain is runtime-wide: batches from a superseded election no-op inside
  // their slot via the ownership re-check, so they can never block or
  // interleave with the current election's.
  let ingestChain: Promise<void> = Promise.resolve();

  // Browsers are an inbound (fire-and-forget) subscriber: the server advances its delivery
  // cursor regardless of whether our ingest succeeded and never closes the connection on an
  // ingest error. So if applying a batch throws (a transient OPFS/SQLite error, or a
  // RAISE(ABORT) from the mirror trigger: replay conflict / out-of-order insert), we must self-heal — otherwise the mirror
  // silently desyncs forever. We resubscribe from the last successfully-applied checkpoint
  // (the next election re-reads the processor's persisted offset into `replayAfterOffset`,
  // so the server replays from there), with bounded exponential backoff so repeated failures
  // don't busy-loop. A disposed runtime, or a callback from a superseded connection, stops.
  async function ingestWithSelfHeal(
    processor: BrowserHostedProcessor,
    batch: { events: readonly StreamEvent[]; streamMaxOffset: number },
    election: { connection: BrowserStreamClient },
  ): Promise<void> {
    // A batch delivered to a superseded election must not be applied: its
    // processor's queued ingests would interleave with (and can regress the
    // checkpoint of) the current election's processor on the same tables — and
    // it must not count as delivery progress either (see below).
    if (disposed || stream !== election.connection) return;
    // Live-tail safety valve (see MAX_PENDING_INGEST_EVENTS): the server pump
    // is one-directional and can outrun SQLite; queued-but-unapplied events
    // otherwise accumulate in JS memory without bound. Cutting the connection
    // discards the queue (every queued ingest bails on the superseded-election
    // guard above) and the fresh election pull-pages from the checkpoint.
    //
    // The counter is per-connection evidence (verifyDelivery reads a positive
    // backlog as proof of life), so its lifecycle must be leak-free: the
    // finally below releases exactly this batch's contribution on EVERY exit —
    // applied, valve-cut, failed, or bailed in a superseded slot — but only
    // while this batch's connection is still current. Once a fresh connection
    // installs (which zeroes the counter for its own evidence), a stale
    // batch's late settle must not subtract from the successor's backlog.
    pendingIngestEvents += batch.events.length;
    try {
      if (pendingIngestEvents > MAX_PENDING_INGEST_EVENTS) {
        console.warn(
          `[stream ${args.streamPath} ${slug}] delivery outran the local mirror (> ${MAX_PENDING_INGEST_EVENTS} events queued); reconnecting to catch up at the mirror's pace`,
        );
        // scheduleReconnect zeroes pendingIngestEvents with the connection.
        scheduleReconnect("delivery outran the local mirror", 0);
        return;
      }
      // Count the arrival HERE, for the current election only, and BEFORE the
      // (possibly slow) ingest await: the liveness probe reads a bumped counter
      // as "deliveries are flowing", so a long ingest must not look stalled,
      // while a dropped stale batch (returned above) must not look like progress.
      deliveryArrivals += 1;
      lastDeliveryArrivalAt = Date.now();
      lastBatchEvents = batch.events.length;
      totalDeliveredEvents += batch.events.length;
      // Serialize the apply and RE-CHECK ownership inside the slot. The entry
      // guard above is not enough: two rapid batches both pass it, then batch
      // A's failure schedules a reconnect while batch B already holds the next
      // slot in the processor's own chain — B would apply over the failure,
      // advancing the checkpoint PAST A's rows. The relaxed (gap-tolerant)
      // mirror trigger accepts that hole, so nothing would ever repair it; the
      // strict trigger used to fail B loudly by accident. `scheduleReconnect`
      // clears `stream` synchronously, so a re-check inside the slot sees it.
      const run = ingestChain.then(async () => {
        if (disposed || stream !== election.connection) return;
        await processor.ingest(batch);
        ingestFailureCount = 0;
        lastDeliveredOffset = Math.max(lastDeliveredOffset, batch.streamMaxOffset);
      });
      ingestChain = run.catch(() => undefined);
      try {
        await run;
      } catch (error) {
        // Only the connection that is still current self-heals; a stale callback bails.
        if (disposed || stream !== election.connection) throw error;
        ingestFailureCount += 1;
        ingestFailures += 1;
        console.error(
          `[stream ${args.streamPath} ${slug}] local mirror ingest failed (attempt ${ingestFailureCount}); resubscribing from last applied offset`,
          error,
        );
        // Drop the connection and reconnect with bounded exponential backoff (capped 30s). The
        // fresh election re-reads the persisted checkpoint, so the server replays after the last
        // applied offset. Routed through the shared scheduleReconnect so a concurrent socket
        // close can't race a second reconnect timer.
        const delay = Math.min(30_000, 250 * 2 ** Math.min(ingestFailureCount - 1, 7));
        scheduleReconnect(`mirror ingest failed: ${errorMessage(error)}`, delay);
        throw error;
      }
    } finally {
      if (stream === election.connection) {
        pendingIngestEvents = Math.max(0, pendingIngestEvents - batch.events.length);
      }
    }
  }

  function stopSubscriptionElection() {
    fireAndForgetUnsubscribe(subscriptionHandle);
    subscriptionHandle = undefined;
    writerRole?.release();
    writerRole = undefined;
    // In-flight own-append correlations belong to the dying subscription; the
    // fresh election replays, and a replayed delivery must not close a stale
    // loop with an inflated sample.
    currentProcessor?.subscriberMetrics.clearPendingAppends();
    currentProcessor = undefined;
    snapshot = { ...snapshot, subscriptionStatus: "idle" };
    if (!disposed) emitSnapshot();
  }

  // Teardown runs exactly when the session is likeliest to be dead, and a
  // dead session's unsubscribe() rejects — un-awaited, that's an
  // unhandledrejection per teardown. Same wrapper useItxSubscription's
  // dispose uses.
  function fireAndForgetUnsubscribe(handle: { unsubscribe(): void } | undefined) {
    if (handle === undefined) return;
    void Promise.resolve()
      .then(() => handle.unsubscribe())
      .catch(() => {
        // The server side of a dead subscription is already gone.
      });
  }

  // Resume is exactly when transports die (mobile suspend killed the TCP
  // connection, the radio dropped, the laptop slept) AND when the paced probe
  // has been frozen for the whole absence — so waiting for its next interval
  // costs the user 10-35 visible seconds of a stale feed. The resume contract,
  // by evidence strength:
  //   - Known-dead (the close event reached us: `stream` already cleared, or a
  //     reconnect backoff is armed): reconnect NOW, no probing, no strikes —
  //     the pre-consolidation resume behavior, unchanged.
  //   - Unknown (socket still installed): run the one delivery check
  //     immediately. A cleanly-closed session REJECTS its guarded read on the
  //     spot ("Peer closed WebSocket") and reconnects first-hit; only the
  //     half-open corpse needs the ledger's strikes, and the follow-up probe
  //     (ledger invariant 3) bounds that at two guarded windows from the
  //     resume check's start.
  // A live subscription and a settled FOLLOWER both run the check. The
  // follower matters — it has no probe (probes are the leader's,
  // post-subscribe) and nothing else would ever notice its dead connection:
  // its feed keeps updating off the leader tab's shared mirror while its own
  // appends fail, which looks exactly like a healthy page. An election in
  // flight ("electing", or "leader" before subscribe resolves) is left alone:
  // its own guarded steps already bound a dead transport, and a resume-time
  // check racing a cold DO would strike a healthy attempt.
  function onResume() {
    if (disposed || !started) return;
    if (stream === undefined || reconnectTimer !== undefined) {
      // pageshow fires on every NORMAL load too, right after start() began the
      // first dial — leave a young in-flight attempt alone instead of bumping
      // its epoch and re-dialing (one wasted round trip per page load).
      if (stream === undefined && Date.now() - connectStartedAt < 5_000) return;
      reconnectNow();
    } else if (subscriptionHandle !== undefined || snapshot.subscriptionStatus === "follower") {
      void verifyDelivery("resume check");
    }
  }
  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") onResume();
  };

  function start() {
    if (started || disposed) return;
    started = true;
    snapshot = { ...snapshot, connectionStatus: "subscribing" };
    emitSnapshot();
    refreshDatabaseInfo();
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityChange);
      window.addEventListener("online", onResume);
      window.addEventListener("pageshow", onResume);
    }
    connectTimer = setTimeout(() => {
      connectTimer = undefined;
      connect();
    }, 0);
  }

  // --- The one delivery check --------------------------------------------------
  // The paced probe, the caller's nudge, and resume events all run THIS check;
  // none of them owns its own timeout or verdict logic.
  //
  // The read itself is the transport check. A dead-but-open WebSocket (the
  // worker behind a dev proxy restarted, a Durable Object was evicted
  // mid-connection) hangs silently: the browser never gets a close frame,
  // deliveries just stop, and the UI stays "subscribed" forever — the guarded
  // lane strikes (and, on the second strike, evicts) that connection. One
  // struck timeout is retried immediately so a one-shot trigger (nudge,
  // resume) is not silently swallowed by a single slow answer; the retry
  // REUSES the in-flight read (a cold DO's late answer resolves it — see the
  // ledger's late-credit rule), and only a still-unanswered read makes the
  // retry's timeout the lane's second strike.
  //
  // The ANSWER matters for the leader: a subscription can be orphaned while
  // the socket stays perfectly healthy. If the stream was recreated underneath
  // us (incarnation changed — e.g. the browser subscribed to a lazily-created
  // empty stream and the agent machinery then created it for real), or the
  // server's maxOffset is ahead and deliveries have been SILENT for a full
  // check interval (no batch in flight, none arrived recently — a batch that
  // arrived before the check and is still ingesting is proof of life, not a
  // stall), the subscription is gone server-side — reconnect, and the
  // resubscribe replays from the persisted checkpoint. A follower holds no
  // subscription, so for it the answered read is the whole check.
  const LIVENESS_PROBE_INTERVAL_MS = 10_000;
  const DELIVERY_GRACE_MS = 2_000;
  // Single-flight latch: two overlapping verifies would burn concurrent reads
  // to answer one question (the ledger's episode rule already keeps their
  // overlapping timeouts to one strike) — but a check requested while one is
  // in flight must not be silently dropped either. A
  // probe whose guarded read is waiting out its deadline (twice, with the
  // retry) holds the latch for up to two GUARDED_CALL_TIMEOUT_MS windows, and
  // a composer-submit nudge landing in that window is exactly the caller this
  // check exists for. So the latched request is recorded and the check re-runs
  // once the in-flight one settles — collapsed to one pending re-run that keeps
  // the strictest requested semantics (a latched nudge's requireRealArrival
  // survives a later-latched probe), and a natural no-op if the settling verify
  // already evicted/reconnected (the re-run re-reads `stream` and the
  // subscription state from scratch).
  let verifyInFlight = false;
  let verifyRerun: { reason: string; requireRealArrival: boolean } | undefined;

  // `requireRealArrival` (the nudge's mode): the caller has evidence the server
  // just appended, so a server-ahead subscription with no REAL arrival since
  // its probe started is judged orphaned right after the delivery grace — the
  // artificial baseline that shields the paced probe's first interval does not
  // apply. See the arrival stamps' contract at their declaration.
  async function verifyDelivery(
    reason: string,
    opts?: { requireRealArrival?: boolean },
  ): Promise<void> {
    const requireRealArrival = opts?.requireRealArrival ?? false;
    const connection = stream;
    if (connection === undefined || disposed) return;
    if (verifyInFlight) {
      verifyRerun = {
        reason,
        requireRealArrival: requireRealArrival || (verifyRerun?.requireRealArrival ?? false),
      };
      return;
    }
    verifyInFlight = true;
    // The anchor for every silence window below (see the arrival stamps'
    // contract at their declaration): captured before the guarded read and the
    // delivery grace, so neither a slow read (10s timeout, retried once) nor
    // the grace wait shifts a window late and shrinks it. Stamps are re-read
    // at judgment time — an arrival during the read or the grace is newer than
    // this anchor and counts as liveness.
    const checkStartedAt = Date.now();
    try {
      // Every runtime-state read doubles as a transport-RTT sample (timed
      // guards against recording abandoned late resolutions itself). ONE
      // underlying RPC, shared with the retry (the withDeadline pattern +
      // ledger invariant 4's late-credit rule): the first window's timeout
      // abandons the guarded call but the RPC stays in flight, so racing the
      // retry's window over the SAME promise lets a cold DO's late answer
      // (say 11s in) resolve the retry as a success — ledger reset — instead
      // of demanding a second answer inside the post-strike window and
      // striking a merely-slow DO into eviction. A genuinely dead socket
      // never settles this promise, so the retry still times out as genuine
      // strike two and guardedCall evicts.
      const underlying = timed(Promise.resolve(connection.runtimeState()));
      const read = () => guardedCall(reason, connection, () => underlying);
      let result;
      try {
        result = await read();
      } catch (error) {
        if (disposed || stream !== connection) return;
        if (!(error instanceof StepTimeoutError)) throw error;
        result = await read();
      }
      // A parse failure is definitive (the server answered, with a shape we
      // cannot reconcile against) — it lands in the catch below and reconnects
      // on the first hit.
      const coreProcessorState = parseBrowserCoreProcessorState(result.coreProcessorState);
      if (disposed || stream !== connection) return;
      if (subscriptionHandle === undefined) return; // transport answered — all a follower needs
      if (coreProcessorState.createdAt !== reconciledIncarnation) {
        throw new Error(
          `stream incarnation changed (${reconciledIncarnation} -> ${coreProcessorState.createdAt}); subscription is orphaned`,
        );
      }
      if (coreProcessorState.maxOffset <= lastDeliveredOffset) return; // mirror is current
      // Server is ahead — give an in-flight delivery a moment, then require
      // SILENCE across the full check interval ENDING AT checkStartedAt before
      // declaring the subscription orphaned. lastDeliveredOffset lagging is
      // NOT the stall signal: a batch that arrived before this check and is
      // still ingesting (or several, queued) adds no new arrival during the
      // grace window, and reconnecting under it would abandon a healthy
      // mid-apply mirror. Arrival — the ledger's counter/stamp, bumped before
      // the possibly-slow ingest — is what proves the delivery lane is alive.
      await new Promise((resolve) => setTimeout(resolve, DELIVERY_GRACE_MS));
      if (disposed || stream !== connection) return;
      if (pendingIngestEvents > 0) return; // an arrived batch is still ingesting
      if (
        lastDeliveryArrivalAt !== undefined &&
        checkStartedAt - lastDeliveryArrivalAt <= LIVENESS_PROBE_INTERVAL_MS
      ) {
        // REAL arrival within the probe interval ending when this check began
        // — or newer (the stamp is re-read here, so an arrival during the read
        // or the grace makes this difference negative). Deliveries flowing;
        // liveness for every caller.
        return;
      }
      if (
        !requireRealArrival &&
        lastDeliveryArrivalAt === undefined &&
        checkStartedAt - arrivalBaselineAt <= LIVENESS_PROBE_INTERVAL_MS + DELIVERY_GRACE_MS
      ) {
        // Fresh, arrival-less subscription: too early for the paced probe (or
        // a resume check) to judge. The bound is interval + grace so the first
        // paced probe — which fires exactly one interval after the baseline —
        // is reliably inside it (exact semantics at the stamps' declaration).
        // A nudge (requireRealArrival) skips this grace — see above.
        return;
      }
      throw new Error(
        `server is at offset ${coreProcessorState.maxOffset} but ${
          lastDeliveryArrivalAt === undefined
            ? `no delivery has arrived since the subscription went live ${Date.now() - arrivalBaselineAt}ms ago`
            : `no delivery arrived in the ${LIVENESS_PROBE_INTERVAL_MS}ms before this check began (last arrival ${Date.now() - lastDeliveryArrivalAt}ms ago)`
        } (applied through ${lastDeliveredOffset}); subscription is orphaned`,
      );
    } catch (error) {
      if (disposed || stream !== connection) return;
      // Timeouts are entirely the guarded lane's business: a strike that has
      // not reached its verdict must not reconnect here (much less evict — the
      // ledger may have been reset by a success on another lane mid-check).
      if (error instanceof StepTimeoutError) return;
      console.warn(
        `[stream ${args.streamPath} ${slug}] ${reason} found a dead or stale subscription; reconnecting`,
        error,
      );
      reconnectAfterError(`${reason} failed`, error, 250, { suspect: connection });
    } finally {
      verifyInFlight = false;
      const rerun = verifyRerun;
      verifyRerun = undefined;
      if (rerun !== undefined && !disposed) {
        void verifyDelivery(rerun.reason, { requireRealArrival: rerun.requireRealArrival });
      }
    }
  }

  function startLivenessProbe() {
    stopLivenessProbe();
    // The subscription just went live: clear the real-arrival stamp and restart
    // the baseline so the orphan check measures silence from THIS
    // subscription's start, not from a pre-subscribe catch-up page or a
    // delivery that rode a previous socket. Checks starting within
    // interval + grace of this baseline treat an arrival-less subscription as
    // too early to judge — the first paced probe (one interval from here) is
    // always inside that window, so the second is the earliest that can
    // declare it orphaned. A nudge gets no such grace — zero real arrivals
    // plus server-ahead evidence escalates right after the delivery grace
    // (exact window semantics at the stamps' declaration).
    lastDeliveryArrivalAt = undefined;
    arrivalBaselineAt = Date.now();
    livenessTimer = setInterval(
      () => void verifyDelivery("liveness probe"),
      LIVENESS_PROBE_INTERVAL_MS,
    );
  }

  function stopLivenessProbe() {
    if (livenessTimer !== undefined) {
      clearInterval(livenessTimer);
      livenessTimer = undefined;
    }
  }

  // Once-per-state latch for the skipped-nudge warning; reset on subscribe.
  let nudgeSkipWarned = false;

  // On-demand delivery check for moments the CALLER knows the server is about
  // to (or just did) append — e.g. right after a composer submit. The paced
  // probe takes up to an interval to notice an orphaned subscription; this
  // collapses that to ~seconds exactly when a human is watching. Nudging while
  // disconnected is a no-op (reconnect is already the path that heals that
  // state).
  async function nudge(): Promise<void> {
    if (stream === undefined || subscriptionHandle === undefined) {
      // Not the writer (or not connected): we can't resubscribe, but say so —
      // a silently inert nudge made follower-side stalls undiagnosable. Once
      // per state though: a follower tab nudges on EVERY composer submit, and
      // repeating the same warning per keypress-send is noise, not signal.
      if (!nudgeSkipWarned) {
        nudgeSkipWarned = true;
        console.warn(
          `[stream ${args.streamPath} ${slug}] nudge skipped: ${stream === undefined ? "no connection" : `no subscription (status ${snapshot.subscriptionStatus})`}`,
        );
      }
      return;
    }
    // requireRealArrival: the nudge's caller-side evidence (the server is
    // about to be / was just appended to) means a server-ahead subscription
    // with zero real arrivals is orphaned NOW — it must not ride the fresh-
    // subscription grace the paced probe gets, or the fast heal this check
    // exists for degrades back to a full probe interval.
    await verifyDelivery("delivery nudge", { requireRealArrival: true });
  }

  function teardown() {
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("online", onResume);
      window.removeEventListener("pageshow", onResume);
    }
    for (const timer of [connectTimer, reconnectTimer, databaseInfoTimer, databaseChangeTimer]) {
      if (timer !== undefined) clearTimeout(timer);
    }
    connectTimer = reconnectTimer = databaseInfoTimer = databaseChangeTimer = undefined;
    stopLivenessProbe();
    stopSubscriptionElection();
    stream?.[Symbol.dispose]();
    stream = undefined;
    offDatabaseChange();
    releaseDatabase();
    args.onDispose?.();
  }

  debugRegistry.set(`${args.projectId} ${args.streamPath} ${slug}`, () => ({
    connectionStatus: snapshot.connectionStatus,
    subscriptionStatus: snapshot.subscriptionStatus,
    connectionError: snapshot.connectionError,
    lastDeliveredOffset,
    deliveryArrivals,
    lastDeliveryArrivalAt: lastDeliveryArrivalAt ?? null,
    arrivalBaselineAt,
    totalDeliveredEvents,
    lastBatchEvents,
    ingestFailures,
    pendingIngestEvents,
    connectFailuresSinceSuccess,
    guardedTimeoutStrikes,
    ledgerGeneration,
    strikeFollowUpProbeInFlight,
    reconciledIncarnation,
    started,
    disposed,
    hasConnection: stream !== undefined,
    hasSubscription: subscriptionHandle !== undefined,
    hasHostedProcessor: currentProcessor !== undefined,
    metrics: readMetrics(),
    listeners: listeners.size,
  }));

  function dispose() {
    listeners.clear();
    debugRegistry.delete(`${args.projectId} ${args.streamPath} ${slug}`);
    if (disposed) return;
    if (disposeTimer !== undefined) {
      clearTimeout(disposeTimer);
      disposeTimer = undefined;
    }
    disposed = true;
    teardown();
    // Anything awaiting a transient reconnect (B2) must stop waiting now.
    rejectReadyWaiters(new Error("stream runtime is disposed"));
  }

  // Run `call` against the live stream stub. Direct calls (appends, state
  // reads) can be the FIRST place a dead connection manifests: a follower has
  // no liveness probe, and nothing else ever clears its corpse `stream` —
  // before the guarded lane, its appendBatch retries looped through the same
  // dead stub forever (connect() no-ops while `stream` is set), which read as
  // "the feed updates but my sends fail". The lane's strikes clear the corpse
  // so the CALLER's retry finds a fresh connection; app-level failures
  // (validation and friends) pass through untouched.
  //
  // When the connection is transiently
  // reconnecting we kick a reconnect and await readiness instead of throwing —
  // only a disposed runtime (or a reconnect that never lands within the bound)
  // rejects (B2). The awaitable carries a no-op [Symbol.dispose] so callers
  // that dispose un-awaited results keep working.
  function callWhenReady<T>(call: (rpc: BrowserStreamClient) => Promise<T>): StreamRpcResult<T> {
    if (disposed) throw new Error("stream runtime is disposed");
    // Kick a reconnect only when nothing is already driving one. The old
    // unconditional reconnectNow() collapsed armed backoff timers on every
    // direct call — defeating the escalating connect backoff and the
    // poison-batch ingest pacing exactly when a user hammers retry — and
    // superseded a mid-flight dial+election per call.
    if (stream === undefined && reconnectTimer === undefined && connectTimer === undefined) {
      connect();
    }
    const ready = stream;
    if (ready !== undefined) {
      return Object.assign(guardedCall("stream call", ready, call), { [Symbol.dispose]() {} });
    }
    const promise = (async () => {
      await whenStreamReady();
      const reconnected = stream;
      if (reconnected === undefined) throw new Error("stream runtime is disposed");
      return await guardedCall("stream call", reconnected, call);
    })();
    return Object.assign(promise, { [Symbol.dispose]() {} });
  }

  const runtime: StreamBrowserStore = {
    streamDatabase,
    appendBatch(appendArgs) {
      // The itx Stream capability appends variadically; the batch arg shape is
      // kept for consumers of the store.
      //
      // Durability: every event gets an idempotency key (unless the caller set
      // one), which makes retrying safe — a batch that COMMITTED but lost its
      // ack (socket died, DO evicted/killed/overloaded mid-response) returns
      // the same committed events on retry instead of appending duplicates.
      // Combined with callWhenReady's reconnect-wait, an appendBatch caller
      // survives a stream DO eviction mid-blast with zero loss and zero dupes.
      const events = appendArgs.events.map((event) =>
        event.idempotencyKey === undefined
          ? { ...event, idempotencyKey: crypto.randomUUID() }
          : event,
      );
      const promise = (async () => {
        // Real consume-own-append measurement: t0 is when the CALLER asked
        // for the append (retries included — that wait is part of the honest
        // number); the loop closes when this tab's own subscription ingests
        // the committed offset (StreamProcessor.noteBatchIngested).
        const t0 = Date.now();
        for (let attempt = 0; ; attempt++) {
          try {
            const committed = await callWhenReady(
              (rpc) => rpc.append(...events) as Promise<StreamEvent[]>,
            );
            const maxCommittedOffset = committed.reduce(
              (max, event) => Math.max(max, event.offset),
              0,
            );
            if (maxCommittedOffset > 0) {
              currentProcessor?.subscriberMetrics.noteAppendCommitted({
                maxCommittedOffset,
                t0,
                atMs: Date.now(),
              });
            }
            return committed;
          } catch (error) {
            // Retry only transport-shaped failures (timeouts, broken
            // sessions, a reconnect that didn't land in time). An app-level
            // rejection — validation and friends — would fail identically 8
            // times; surface it immediately instead of burning ~23s of
            // backoff first.
            const transient = error instanceof StepTimeoutError || isSessionBrokenError(error);
            if (disposed || !transient || attempt >= APPEND_MAX_RETRIES) throw error;
            await new Promise((resolve) =>
              setTimeout(resolve, Math.min(5_000, 250 * 2 ** attempt)),
            );
          }
        }
      })();
      return Object.assign(promise, { [Symbol.dispose]() {} });
    },
    runtimeState() {
      return callWhenReady((rpc) => rpc.runtimeState() as Promise<StreamRuntimeState>);
    },
    debugRuntimeState() {
      return callWhenReady((rpc) =>
        timed(Promise.resolve(rpc.runtimeState() as Promise<StreamServerRuntimeState>)),
      );
    },
    metrics: readMetrics,
    noteExternalAppend({ maxCommittedOffset, t0 }) {
      if (!Number.isFinite(maxCommittedOffset) || maxCommittedOffset <= 0) return;
      currentProcessor?.subscriberMetrics.noteAppendCommitted({
        maxCommittedOffset,
        t0,
        atMs: Date.now(),
      });
    },
    getProcessorRuntimeState(args) {
      return callWhenReady(
        (rpc) => rpc.getProcessorRuntimeState(args) as Promise<ProcessorRuntimeState | null>,
      );
    },
    async clearLocalDatabase() {
      stopSubscriptionElection();
      stream?.[Symbol.dispose]();
      stream = undefined;
      await discardLocalMirror();
      reconnectNow();
    },
    nudge,
    isDisposed: () => disposed,
    getSnapshot: () => snapshot,
    getServerSnapshot: () => snapshot,
    subscribe(listener) {
      if (disposed) {
        // A subscriber landing on a disposed runtime renders a frozen view
        // that nothing will ever reconnect — never let that be silent. The
        // registry's acquire-time retain() makes this unreachable in the
        // known lanes; this is the tripwire for the ones we haven't met.
        console.error(
          `[stream ${args.streamPath} ${slug}] subscribe() on a disposed runtime — the view will be frozen until its deps change or the page reloads`,
        );
        return () => {};
      }
      if (disposeTimer !== undefined) {
        clearTimeout(disposeTimer);
        disposeTimer = undefined;
      }
      listeners.add(listener);
      start();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && !disposed) scheduleIdleDispose();
      };
    },
    [Symbol.dispose]() {
      dispose();
    },
  };

  function scheduleIdleDispose() {
    if (disposeTimer !== undefined) clearTimeout(disposeTimer);
    disposeTimer = setTimeout(() => {
      disposeTimer = undefined;
      if (listeners.size === 0) dispose();
    }, IDLE_DISPOSE_GRACE_MS);
  }

  return {
    runtime,
    refreshTransport(next) {
      transport = next;
    },
    // A re-acquire between "last listener unsubscribed" and the idle-dispose
    // timer firing means a render is about to subscribe: cancel the pending
    // dispose so the commit can't land on a corpse (React can yield between
    // the render that acquired and the effect that subscribes — Suspense and
    // lazy chunks stretch that window to seconds; a runtime disposed inside
    // it froze the view silently, the same subscribe-after-GC shape
    // stream-browser-db.ts fixed for query handles). The grace timer is
    // re-armed, not cancelled outright, so an acquire from a DISCARDED render
    // that never subscribes still lets the runtime dispose.
    retain() {
      if (disposed || listeners.size > 0) return;
      scheduleIdleDispose();
    },
  };
}

/**
 * How long an unreferenced runtime lingers before disposing. Long enough to
 * cover React yielding between a render that acquired the runtime and the
 * commit that subscribes (concurrent-mode macrotask yields, Suspense/lazy
 * chunk loads); short enough that a truly abandoned runtime releases its
 * connection and OPFS handle promptly.
 */
const IDLE_DISPOSE_GRACE_MS = 2_000;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The deadline lane's own error class, so catch blocks can tell "the far side
 * answered nothing" (transport suspect — a half-open socket swallows calls
 * forever) apart from "the far side answered with a failure" (transport fine,
 * reconnect is enough).
 */
class StepTimeoutError extends Error {}

/**
 * Promise.race against a deadline, with the loser's timer cleared when the
 * race settles — a bare setTimeout-rejection branch would otherwise fire an
 * unhandled rejection after every SUCCESSFUL call.
 */
function raceWithTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new StepTimeoutError(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function isWriteStatement(sql: string) {
  return /^\s*(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|REPLACE|PRAGMA\s+user_version)/i.test(sql);
}

function resolveStreamUrl(args: {
  projectId: string;
  streamPath: string;
  streamUrl: NonNullable<BrowserStreamConnectionConfig["streamUrl"]>;
}) {
  if (typeof args.streamUrl === "function") {
    return args.streamUrl({ projectId: args.projectId, streamPath: args.streamPath });
  }
  return args.streamUrl;
}
