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

import type { RpcPromise, RpcStub } from "capnweb";
import type { StreamEvent, StreamEventInput } from "../shared/event.ts";
import { createProcessorRunner } from "../processor-runner.ts";
import type { Processor } from "../processor.ts";
import type { StreamCoreProcessorState, StreamRpc } from "../types.ts";
import { createStreamSubscription, type StreamSubscription } from "../subscription.ts";
import {
  withStreamConnectionFromBrowser,
  streamRpcPath,
  type StreamBrowserConnectionStatus,
} from "./connect.ts";
import { acquireWriterRole, streamWriterLockName, type WriterRole } from "./stream-leader.ts";
import {
  StreamBrowserDatabase,
  type SqlClient,
  type StreamDatabaseInfo,
} from "./stream-browser-db.ts";

// Stream DOs are named `${namespace}:${path}`; the browser namespace is "default".
const STREAM_NAMESPACE = "default";
const LIVE_PROGRESS_NOTIFICATION_MS = 16;

export type StreamBrowserSnapshot = {
  connectionStatus: StreamBrowserConnectionStatus | "reconnecting" | "subscribing" | "subscribed";
  subscriptionStatus: "idle" | "electing" | "leader" | "follower";
  clearVersion: number;
  connectionError: string | undefined;
  databaseInfo: StreamDatabaseInfo | undefined;
};

/** What a view tells the runtime about the processor it wants hosted. */
export type BrowserProcessorConfig = {
  // Heterogeneous processors; the runner re-infers the contract per call, so the
  // contract type is intentionally erased here.
  processor: Processor<any, { sql: SqlClient }>;
  /** Bumped into the writer-lock name so a schema migration lets a fresh tab take over. */
  schemaVersion: number;
  /** Tables this processor owns, cleared together when the local mirror is discarded. */
  tables: string[];
  /** Durable resume cursor + reduced state, read back from this processor's own tables. */
  loadCheckpoint(sql: SqlClient): Promise<{ state: unknown; offset: number } | undefined>;
};

export type StreamRuntimeState = {
  coreProcessorState: StreamCoreProcessorState;
  runtime: {
    connections: Record<string, unknown>;
  };
};

export type StreamBrowserStore = Disposable & {
  readonly streamDatabase: StreamBrowserDatabase;
  appendBatch(args: { events: StreamEventInput[] }): RpcPromise<StreamEvent[]>;
  runtimeState(): RpcPromise<StreamRuntimeState>;
  clearLocalDatabase(): Promise<void>;
  kill(): RpcPromise<void>;
  reset(): RpcPromise<void>;
  getSnapshot(): StreamBrowserSnapshot;
  getServerSnapshot(): StreamBrowserSnapshot;
  subscribe(listener: () => void): () => void;
};

// --- Registries: one runtime per (path, slug), one DB per path -------------------------
// The runtime registry leans on the store's own listener lifecycle as its refcount (it
// self-removes on dispose); the DB registry counts the runtimes holding it.

const databaseRegistry = new Map<string, { db: StreamBrowserDatabase; refs: number }>();

function acquireDatabase(streamPath: string) {
  const key = streamPath;
  let entry = databaseRegistry.get(key);
  if (entry === undefined) {
    entry = { db: new StreamBrowserDatabase(STREAM_NAMESPACE, streamPath), refs: 0 };
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
  args: { streamPath: string } & BrowserProcessorConfig,
): StreamBrowserStore {
  const slug = args.processor.contract.slug;
  const key = `${args.streamPath} ${slug}`;
  const existing = runtimeRegistry.get(key);
  if (existing !== undefined) return existing;
  const runtime = createStreamRuntime({ ...args, onDispose: () => runtimeRegistry.delete(key) });
  runtimeRegistry.set(key, runtime);
  return runtime;
}

function createStreamRuntime(
  args: { streamPath: string; onDispose?: () => void } & BrowserProcessorConfig,
): StreamBrowserStore {
  const { processor, schemaVersion, tables, loadCheckpoint } = args;
  const slug = processor.contract.slug;
  const { db: streamDatabase, release: releaseDatabase } = acquireDatabase(args.streamPath);

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
  let subscription: StreamSubscription | undefined;
  let processing: AsyncDisposable | undefined;
  let writerRole: WriterRole | undefined;
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let databaseInfoTimer: ReturnType<typeof setTimeout> | undefined;
  let databaseChangeTimer: ReturnType<typeof setTimeout> | undefined;
  let disposeTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let started = false;
  const browserSubscriberStorageKey = "stream-browser-subscriber-id";
  const browserSubscriberId =
    localStorage.getItem(browserSubscriberStorageKey) ?? crypto.randomUUID();
  localStorage.setItem(browserSubscriberStorageKey, browserSubscriberId);
  // One stream subscription per (browser profile, processor); namespace keeps it distinct.
  const subscriptionKey = `${STREAM_NAMESPACE}:${browserSubscriberId}:${slug}`;
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

  function reconnectAfter(connectionError: string) {
    if (disposed || reconnectTimer !== undefined) return;
    snapshot = { ...snapshot, connectionError, connectionStatus: "reconnecting" };
    emitSnapshot();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, 1_000);
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
    await streamDatabase.compact();
    snapshot = {
      ...snapshot,
      clearVersion: snapshot.clearVersion + 1,
      databaseInfo: undefined,
    };
    emitSnapshot();
    refreshDatabaseInfo();
  }

  // Discard the local mirror when the server has fewer committed events than we do — a
  // reset/rewind makes our stored suffix impossible.
  async function reconcileLocalMirrorWithServer(rpc: RpcStub<StreamRpc>) {
    const checkpoint = await loadCheckpoint(sql);
    const localMaxOffset = checkpoint?.offset ?? -1;
    if (localMaxOffset < 0) return;
    const { coreProcessorState } = await rpc.runtimeState();
    if (coreProcessorState.maxOffset >= localMaxOffset) return;
    console.warn(
      `[stream ${args.streamPath}] Server has fewer events than the local mirror; discarding local ${slug} tables.`,
      { serverMaxOffset: coreProcessorState.maxOffset, localMaxOffset },
    );
    await discardLocalMirror();
  }

  function connect() {
    if (stream !== undefined || disposed) return;
    const streamUrl = new URL(streamRpcPath(args.streamPath), window.location.href);

    void withStreamConnectionFromBrowser({
      url: streamUrl,
      onConnectionStatusChange(connectionStatus, connectionError) {
        if (disposed) return;
        if (connectionStatus === "closed" || connectionStatus === "error") {
          stopSubscriptionElection();
          subscriptionHandle = undefined;
          stream = undefined;
          reconnectAfter(connectionError ?? connectionStatus);
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
        if (disposed) {
          connection[Symbol.dispose]();
          return;
        }
        stream = connection;
        startSubscriptionElection({ connection });
      })
      .catch((error: unknown) => {
        if (disposed) return;
        reconnectAfter(`connect failed: ${errorMessage(error)}`);
      });
  }

  function startSubscriptionElection(election: {
    connection: Awaited<ReturnType<typeof withStreamConnectionFromBrowser>>;
  }) {
    snapshot = { ...snapshot, subscriptionStatus: "electing" };
    emitSnapshot();

    const followerTimeout = setTimeout(() => {
      if (!disposed && subscriptionHandle === undefined) {
        snapshot = { ...snapshot, subscriptionStatus: "follower" };
        emitSnapshot();
      }
    }, 250);

    writerRole = acquireWriterRole({
      lockName: streamWriterLockName({
        namespace: STREAM_NAMESPACE,
        streamPath: args.streamPath,
        slug,
        schemaVersion,
      }),
    });
    void writerRole.whenWriter
      .then(async () => {
        clearTimeout(followerTimeout);
        if (disposed || stream !== election.connection) return undefined;
        snapshot = { ...snapshot, subscriptionStatus: "leader" };
        emitSnapshot();
        await reconcileLocalMirrorWithServer(election.connection.stream);
        const checkpoint = await loadCheckpoint(sql);
        const processorRunner = createProcessorRunner({
          processor,
          deps: { sql },
          storage: { load: () => checkpoint, save: () => {} },
          stream: election.connection.stream,
        });
        const streamSubscription = createStreamSubscription({ subscriptionKey });
        subscription = streamSubscription;
        processing = processorRunner.run({ subscription: streamSubscription });
        return { replayAfterOffset: checkpoint?.offset ?? 0, sink: streamSubscription.sink };
      })
      .then((ready) => {
        if (ready === undefined || disposed || stream !== election.connection) return undefined;
        return election.connection.stream.subscribe({
          subscriptionKey,
          sink: ready.sink,
          replayAfterOffset: ready.replayAfterOffset,
        });
      })
      .then((handle) => {
        if (handle === undefined) return;
        if (disposed) {
          handle.unsubscribe();
          return;
        }
        subscriptionHandle = handle;
        snapshot = { ...snapshot, connectionError: undefined, connectionStatus: "subscribed" };
        emitSnapshot();
      })
      .catch((error: unknown) => {
        clearTimeout(followerTimeout);
        if (disposed) return;
        console.error(`[stream ${args.streamPath}] subscribe failed`, error);
        stopSubscriptionElection();
        stream?.[Symbol.dispose]();
        stream = undefined;
        reconnectAfter(`subscribe failed: ${errorMessage(error)}`);
      });
  }

  function stopSubscriptionElection() {
    subscriptionHandle?.unsubscribe();
    subscriptionHandle = undefined;
    void processing?.[Symbol.asyncDispose]();
    processing = undefined;
    void subscription?.[Symbol.asyncDispose]();
    subscription = undefined;
    writerRole?.release();
    writerRole = undefined;
    snapshot = { ...snapshot, subscriptionStatus: "idle" };
    if (!disposed) emitSnapshot();
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

  function teardown() {
    for (const timer of [connectTimer, reconnectTimer, databaseInfoTimer, databaseChangeTimer]) {
      if (timer !== undefined) clearTimeout(timer);
    }
    connectTimer = reconnectTimer = databaseInfoTimer = databaseChangeTimer = undefined;
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
  }

  return {
    streamDatabase,
    appendBatch(appendArgs) {
      reconnectNow();
      if (stream === undefined) throw new Error("stream connection is disposed");
      return stream.stream.appendBatch(appendArgs);
    },
    runtimeState() {
      reconnectNow();
      if (stream === undefined) throw new Error("stream connection is disposed");
      return stream.stream.runtimeState();
    },
    async clearLocalDatabase() {
      stopSubscriptionElection();
      stream?.[Symbol.dispose]();
      stream = undefined;
      await discardLocalMirror();
      reconnectNow();
    },
    kill() {
      reconnectNow();
      if (stream === undefined) throw new Error("stream connection is disposed");
      return stream.stream.kill();
    },
    reset() {
      reconnectNow();
      if (stream === undefined) throw new Error("stream connection is disposed");
      return stream.stream.reset();
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
