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
// hosts the processor over a fresh subscription, mirroring StreamProcessorRunner.

import type { RpcStub } from "capnweb";
import type { StreamEvent, StreamEventInput } from "../shared/event.ts";
import type { ProcessorStream } from "../types.ts";
import type { StreamProcessorSnapshot } from "../stream-processor.ts";
import type { StreamCoreProcessorState, StreamRpc } from "../types.ts";
import {
  DEFAULT_STREAM_NAMESPACE,
  withStreamConnectionFromBrowser,
  streamRpcPath,
  type StreamBrowserConnectionStatus,
} from "./connect.ts";
import { deleteBrowserProcessorState } from "./processor-state-storage.ts";
import { acquireWriterRole, streamWriterLockName, type WriterRole } from "./stream-leader.ts";
import {
  StreamBrowserDatabase,
  type SqlClient,
  type StreamDatabaseInfo,
} from "./stream-browser-db.ts";

const LIVE_PROGRESS_NOTIFICATION_MS = 16;

/**
 * The slice of `StreamProcessor` the browser runtime drives: read the
 * checkpoint to pick the replay cursor, then feed delivered batches into
 * `ingest`. Structural so views construct whatever processor class they like.
 */
type BrowserHostedProcessor = {
  snapshot(): Promise<StreamProcessorSnapshot<unknown>>;
  ingest(args: { events: readonly StreamEvent[]; streamMaxOffset: number }): Promise<void>;
};

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
  /** Tables this processor owns, cleared together when the local mirror is discarded. */
  tables: string[];
  /** Create the concrete processor once the browser runtime has a stream connection. */
  createProcessor(args: {
    stream: ProcessorStream;
    sql: SqlClient;
    subscriptionKey: string;
  }): BrowserHostedProcessor;
};

export type BrowserStreamConnectionConfig = {
  namespace?: string;
  streamUrl?: string | URL | ((args: { namespace: string; streamPath: string }) => string | URL);
};

export type StreamRuntimeState = {
  coreProcessorState: StreamCoreProcessorState;
  runtime: {
    connections: Record<string, unknown>;
  };
};

/**
 * What `appendBatch`/`runtimeState` return. When the connection is ready this is the genuine
 * capnweb `RpcPromise` (lazy + disposable). When the connection is transiently reconnecting
 * the call awaits readiness first and returns a plain awaitable that still carries a no-op
 * `[Symbol.dispose]`, so callers that dispose un-awaited results keep working either way.
 */
export type StreamRpcResult<T> = Promise<T> & Disposable;

export type StreamBrowserStore = Disposable & {
  readonly streamDatabase: StreamBrowserDatabase;
  appendBatch(args: { events: StreamEventInput[] }): StreamRpcResult<StreamEvent[]>;
  runtimeState(): StreamRpcResult<StreamRuntimeState>;
  clearLocalDatabase(): Promise<void>;
  kill(): Promise<void>;
  reset(): Promise<void>;
  getSnapshot(): StreamBrowserSnapshot;
  getServerSnapshot(): StreamBrowserSnapshot;
  subscribe(listener: () => void): () => void;
};

// --- Registries: one runtime per (path, slug), one DB per path -------------------------
// The runtime registry leans on the store's own listener lifecycle as its refcount (it
// self-removes on dispose); the DB registry counts the runtimes holding it.

const databaseRegistry = new Map<string, { db: StreamBrowserDatabase; refs: number }>();

function acquireDatabase(namespace: string, streamPath: string) {
  const key = `${namespace}\0${streamPath}`;
  let entry = databaseRegistry.get(key);
  if (entry === undefined) {
    entry = { db: new StreamBrowserDatabase(namespace, streamPath), refs: 0 };
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

const runtimeRegistry = new Map<string, StreamBrowserStore>();

/** Get (or lazily create) the shared runtime for one (path, processor). */
export function acquireStreamRuntime(
  args: { streamPath: string } & BrowserProcessorConfig & BrowserStreamConnectionConfig,
): StreamBrowserStore {
  const namespace = args.namespace ?? DEFAULT_STREAM_NAMESPACE;
  const slug = args.slug;
  const key = `${namespace} ${args.streamPath} ${slug}`;
  const existing = runtimeRegistry.get(key);
  if (existing !== undefined) return existing;
  const runtime = createStreamRuntime({
    ...args,
    namespace,
    onDispose: () => runtimeRegistry.delete(key),
  });
  runtimeRegistry.set(key, runtime);
  return runtime;
}

function createStreamRuntime(
  args: {
    namespace: string;
    streamPath: string;
    onDispose?: () => void;
  } & BrowserProcessorConfig &
    BrowserStreamConnectionConfig,
): StreamBrowserStore {
  const { schemaVersion, tables } = args;
  const slug = args.slug;
  const { db: streamDatabase, release: releaseDatabase } = acquireDatabase(
    args.namespace,
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
  let stream: Awaited<ReturnType<typeof withStreamConnectionFromBrowser>> | undefined;
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
        reject(new Error("timed out waiting for stream connection to reconnect"));
      }, timeoutMs);
      readyWaiters.push(waiter);
    });
  }
  const browserSubscriberStorageKey = "stream-browser-subscriber-id";
  const browserSubscriberId =
    localStorage.getItem(browserSubscriberStorageKey) ?? crypto.randomUUID();
  localStorage.setItem(browserSubscriberStorageKey, browserSubscriberId);
  // One stream subscription per (browser profile, processor); namespace keeps it distinct.
  const subscriptionKey = `${args.namespace}:${browserSubscriberId}:${slug}`;
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
        console.error(`[stream ${args.streamPath}] local database info refresh failed`, error);
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
      console.error(`[stream ${args.streamPath}] local mirror write failed`, error);
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

  async function discardLocalMirror() {
    await streamDatabase.clearTables(tables);
    await deleteBrowserProcessorState({ sql, processorSlug: slug, subscriptionKey });
    await streamDatabase.compact();
    snapshot = {
      ...snapshot,
      clearVersion: snapshot.clearVersion + 1,
      databaseInfo: undefined,
    };
    emitSnapshot();
    refreshDatabaseInfo();
  }

  // Decide whether the local mirror can be trusted against the server before subscribing.
  // The server stream's `createdAt` is its incarnation identity: it is stable for a stream's
  // lifetime and changes when the stream is reset()/reincarnated (which deletes storage and
  // re-emits `created`, restarting offsets from 1). If our recorded incarnation differs from
  // the server's, the offset comparison is meaningless — rebuild the mirror. Otherwise fall
  // back to the offset check: discard when the server has fewer committed events than we do.
  async function reconcileLocalMirrorWithServer(rpc: RpcStub<StreamRpc>) {
    // Deliberately a throwaway instance: processors memoize their checkpoint on
    // first read, so the real instance must be created after any discard below.
    const processor = args.createProcessor({ stream: rpc, sql, subscriptionKey });
    const checkpoint = await processor.snapshot();
    const localMaxOffset = checkpoint.offset;
    const { coreProcessorState } = await rpc.runtimeState();
    const serverIncarnation = coreProcessorState.createdAt;
    const localIncarnation = await streamDatabase.readMirrorIncarnation();

    if (localMaxOffset <= 0) {
      // Fresh mirror: nothing to discard, just record which incarnation we are tracking.
      await streamDatabase.writeMirrorIncarnation(serverIncarnation);
      return;
    }

    if (localIncarnation !== serverIncarnation) {
      // Either the incarnation changed (reset/reincarnation) OR we have local events but no
      // recorded incarnation (a mirror that predates incarnation tracking). In both cases we
      // can't trust the offset comparison — a reset that caught back up to the same maxOffset
      // would otherwise be kept with stale rows — so rebuild from scratch.
      console.warn(
        `[stream ${args.streamPath}] Cannot verify local ${slug} mirror against server incarnation (changed or unrecorded); rebuilding.`,
        { localIncarnation, serverIncarnation, localMaxOffset },
      );
      await discardLocalMirror();
      await streamDatabase.writeMirrorIncarnation(serverIncarnation);
      return;
    }

    if (coreProcessorState.maxOffset < localMaxOffset) {
      console.warn(
        `[stream ${args.streamPath}] Server has fewer events than the local mirror; discarding local ${slug} tables.`,
        { serverMaxOffset: coreProcessorState.maxOffset, localMaxOffset },
      );
      await discardLocalMirror();
    }
    // Record (or backfill) the incarnation we are now reconciled against.
    await streamDatabase.writeMirrorIncarnation(serverIncarnation);
  }

  function connect() {
    if (stream !== undefined || disposed) return;
    const streamUrl = new URL(resolveStreamUrl(args), window.location.href);
    // Identity for THIS connect attempt. A late callback from a previously-redialed
    // connection compares against this and bails if it no longer matches (B1).
    connectionEpoch += 1;
    const epoch = connectionEpoch;

    void withStreamConnectionFromBrowser({
      url: streamUrl,
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
    })
      .then((connection) => {
        if (disposed || epoch !== connectionEpoch) {
          connection[Symbol.dispose]();
          return;
        }
        stream = connection;
        // A follower can still append / read runtimeState, so readiness is "connection
        // open", not "leader/subscribed". Unblock anyone awaiting reconnect (B2).
        resolveReadyWaiters();
        startSubscriptionElection({ connection, epoch });
      })
      .catch((error: unknown) => {
        if (disposed || epoch !== connectionEpoch) return;
        scheduleReconnect(`connect failed: ${errorMessage(error)}`, 1_000);
      });
  }

  function startSubscriptionElection(election: {
    connection: Awaited<ReturnType<typeof withStreamConnectionFromBrowser>>;
    epoch: number;
  }) {
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
        namespace: args.namespace,
        streamPath: args.streamPath,
        slug,
        schemaVersion,
      }),
    });
    void writerRole.whenWriter
      .then(async () => {
        clearTimeout(followerTimeout);
        if (!ownsRuntime()) return undefined;
        snapshot = { ...snapshot, subscriptionStatus: "leader" };
        emitSnapshot();
        await reconcileLocalMirrorWithServer(election.connection.stream);
        const processor = args.createProcessor({
          stream: election.connection.stream,
          sql,
          subscriptionKey,
        });
        const checkpoint = await processor.snapshot();
        return {
          replayAfterOffset: checkpoint.offset,
          processEventBatch: (batch: { events: readonly StreamEvent[]; streamMaxOffset: number }) =>
            ingestWithSelfHeal(processor, batch, election),
        };
      })
      .then((ready) => {
        if (ready === undefined || !ownsRuntime()) return undefined;
        return election.connection.stream.subscribe({
          subscriptionKey,
          processEventBatch: ready.processEventBatch,
          replayAfterOffset: ready.replayAfterOffset,
          subscriber: { description: "browser" },
        });
      })
      .then((handle) => {
        if (handle === undefined) return;
        if (!ownsRuntime()) {
          handle.unsubscribe();
          return;
        }
        subscriptionHandle = handle;
        snapshot = { ...snapshot, connectionError: undefined, connectionStatus: "subscribed" };
        emitSnapshot();
        startLivenessProbe(election.connection);
        // Note: we deliberately do NOT reset ingestFailureCount here. A clean resubscribe does
        // not mean the batch that failed will now succeed, so resetting would let a poison
        // batch busy-loop at the floor delay. ingestFailureCount only resets on a successful
        // ingest (so a transient failure that then applies clears the backoff).
      })
      .catch((error: unknown) => {
        clearTimeout(followerTimeout);
        if (disposed) return;
        console.error(`[stream ${args.streamPath}] subscribe failed`, error);
        scheduleReconnect(`subscribe failed: ${errorMessage(error)}`, 1_000);
      });
  }

  // Browsers are an inbound (fire-and-forget) subscriber: the server advances its delivery
  // cursor regardless of whether our ingest succeeded and never closes the connection on an
  // ingest error. So if applying a batch throws (a transient OPFS/SQLite error, or the
  // continuity RAISE(ABORT) in browser-raw-events), we must self-heal — otherwise the mirror
  // silently desyncs forever. We resubscribe from the last successfully-applied checkpoint
  // (the next election re-reads the processor's persisted offset into `replayAfterOffset`,
  // so the server replays from there), with bounded exponential backoff so repeated failures
  // don't busy-loop. A disposed runtime, or a callback from a superseded connection, stops.
  async function ingestWithSelfHeal(
    processor: BrowserHostedProcessor,
    batch: { events: readonly StreamEvent[]; streamMaxOffset: number },
    election: { connection: Awaited<ReturnType<typeof withStreamConnectionFromBrowser>> },
  ): Promise<void> {
    try {
      await processor.ingest(batch);
      ingestFailureCount = 0;
    } catch (error) {
      // Only the connection that is still current self-heals; a stale callback bails.
      if (disposed || stream !== election.connection) throw error;
      ingestFailureCount += 1;
      console.error(
        `[stream ${args.streamPath}] local mirror ingest failed (attempt ${ingestFailureCount}); resubscribing from last applied offset`,
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
  }

  function stopSubscriptionElection() {
    subscriptionHandle?.unsubscribe();
    subscriptionHandle = undefined;
    writerRole?.release();
    writerRole = undefined;
    snapshot = { ...snapshot, subscriptionStatus: "idle" };
    if (!disposed) emitSnapshot();
  }

  async function runControlAndReconnect(control: "kill" | "reset") {
    reconnectNow();
    if (stream === undefined) throw new Error("stream connection is disposed");
    const controlledStream = stream;
    try {
      await controlledStream.stream[control]();
    } finally {
      if (stream === controlledStream) {
        scheduleReconnect(`stream ${control} requested`, 1_000);
      }
    }
  }

  function start() {
    if (started || disposed) return;
    started = true;
    snapshot = { ...snapshot, connectionStatus: "subscribing" };
    emitSnapshot();
    refreshDatabaseInfo();
    connectTimer = setTimeout(() => {
      connectTimer = undefined;
      connect();
    }, 0);
  }

  // A dead-but-open WebSocket (the worker behind a dev proxy restarted, a
  // Durable Object was evicted mid-connection) hangs silently: the browser
  // never gets a close frame, deliveries just stop, and the UI stays
  // "subscribed" forever. Probe the live connection with a cheap RPC; a
  // probe that cannot answer within the deadline means the socket is dead —
  // reconnect, and the resubscribe replays from the persisted checkpoint.
  const LIVENESS_PROBE_INTERVAL_MS = 10_000;
  const LIVENESS_PROBE_TIMEOUT_MS = 5_000;

  function startLivenessProbe(connection: NonNullable<typeof stream>) {
    stopLivenessProbe();
    livenessTimer = setInterval(() => {
      void (async () => {
        try {
          await Promise.race([
            Promise.resolve(connection.stream.runtimeState()).then(() => undefined),
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error("liveness probe timed out")),
                LIVENESS_PROBE_TIMEOUT_MS,
              ),
            ),
          ]);
        } catch (error) {
          if (disposed || stream !== connection) return;
          stopLivenessProbe();
          console.warn(
            `[stream ${args.streamPath}] connection failed its liveness probe; reconnecting`,
            error,
          );
          scheduleReconnect(`liveness probe failed: ${errorMessage(error)}`, 250);
        }
      })();
    }, LIVENESS_PROBE_INTERVAL_MS);
  }

  function stopLivenessProbe() {
    if (livenessTimer !== undefined) {
      clearInterval(livenessTimer);
      livenessTimer = undefined;
    }
  }

  function teardown() {
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

  function dispose() {
    listeners.clear();
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

  // Run `call` against the live stream stub. When the connection is ready this returns the
  // genuine capnweb RpcPromise (lazy + disposable). When it is transiently reconnecting we
  // kick a reconnect and await readiness instead of throwing — only a disposed runtime (or a
  // reconnect that never lands within the bound) rejects (B2). The wrapped awaitable carries
  // a no-op [Symbol.dispose] so callers that dispose un-awaited results keep working.
  function callWhenReady<T>(call: (rpc: RpcStub<StreamRpc>) => Promise<T>): StreamRpcResult<T> {
    if (disposed) throw new Error("stream runtime is disposed");
    reconnectNow();
    const ready = stream;
    if (ready !== undefined) return call(ready.stream) as StreamRpcResult<T>;
    const promise = (async () => {
      await whenStreamReady();
      const reconnected = stream;
      if (reconnected === undefined) throw new Error("stream runtime is disposed");
      return await call(reconnected.stream);
    })();
    return Object.assign(promise, { [Symbol.dispose]() {} });
  }

  return {
    streamDatabase,
    appendBatch(appendArgs) {
      return callWhenReady((rpc) => rpc.appendBatch(appendArgs) as Promise<StreamEvent[]>);
    },
    runtimeState() {
      return callWhenReady((rpc) => rpc.runtimeState() as Promise<StreamRuntimeState>);
    },
    async clearLocalDatabase() {
      stopSubscriptionElection();
      stream?.[Symbol.dispose]();
      stream = undefined;
      await discardLocalMirror();
      reconnectNow();
    },
    kill() {
      return runControlAndReconnect("kill");
    },
    reset() {
      return runControlAndReconnect("reset");
    },
    getSnapshot: () => snapshot,
    getServerSnapshot: () => snapshot,
    subscribe(listener) {
      if (disposeTimer !== undefined) {
        clearTimeout(disposeTimer);
        disposeTimer = undefined;
      }
      listeners.add(listener);
      start();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && !disposed) {
          disposeTimer = setTimeout(() => {
            disposeTimer = undefined;
            if (listeners.size === 0) dispose();
          }, 0);
        }
      };
    },
    [Symbol.dispose]() {
      dispose();
    },
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isWriteStatement(sql: string) {
  return /^\s*(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|REPLACE|PRAGMA\s+user_version)/i.test(sql);
}

function resolveStreamUrl(args: {
  namespace: string;
  streamPath: string;
  streamUrl?: BrowserStreamConnectionConfig["streamUrl"];
}) {
  if (typeof args.streamUrl === "function") {
    return args.streamUrl({ namespace: args.namespace, streamPath: args.streamPath });
  }
  return (
    args.streamUrl ??
    streamRpcPath({
      path: args.streamPath,
      namespace: args.namespace === DEFAULT_STREAM_NAMESPACE ? undefined : args.namespace,
    })
  );
}
