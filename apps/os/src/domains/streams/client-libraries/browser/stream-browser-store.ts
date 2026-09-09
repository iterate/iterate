// One event mirror per stream and tab. A Web Lock elects the tab that downloads;
// all tabs query the same OPFS database. Feed interpretation lives on the server.
import {
  EventConsumptionMetrics,
  LatencyRing,
  type EventConsumptionMetricsReport,
  type LatencyStats,
  type StreamConnectionHandle,
  type StreamEvent,
  type StreamEventBatch,
  type StreamEventInput,
} from "iterate/processors";
import { isStreamUnavailableError } from "../../stream-unavailable.ts";
import { catchUpAvailableHistory, catchUpToLiveReplayBoundary } from "./catch-up-page.ts";
import { acquireDatabase } from "./stream-database-registry.ts";
import { openStreamEventMirror } from "./stream-event-mirror.ts";
import { acquireWriterRole, type WriterRole } from "./stream-writer.ts";
import {
  browserStreamSubscriberUserUpdate,
  type BrowserStreamSubscriberUser,
} from "./browser-subscriber.ts";
import type { StreamBrowserDatabase, StreamDatabaseInfo } from "./stream-browser-db.ts";
import type {
  BrowserStreamClient,
  BrowserStreamClientFactory,
  StreamBrowserConnectionStatus,
} from "./stream-transport.ts";
import {
  errorMessage,
  isStreamSessionBrokenError,
  raceWithTimeout,
  StepTimeoutError,
} from "./stream-runtime-utils.ts";

const MAX_REPLAY_GAP = 2_000;
const MAX_QUEUED_EVENTS = 20_000;
const MAX_RECONNECT_ATTEMPTS = 8;
const IDLE_DISPOSE_MS = 2_000;

export type StreamBrowserSnapshot = {
  connectionStatus:
    | StreamBrowserConnectionStatus
    | "reconnecting"
    | "opening-event-callback"
    | "receiving-events";
  databaseRole: "idle" | "electing" | "writer" | "reader";
  clearVersion: number;
  connectionError: string | undefined;
  databaseInfo: StreamDatabaseInfo | undefined;
};
export type StreamRuntimeState = { coreProcessorState: unknown };
export type BrowserStreamMetrics = {
  transportRttMs: LatencyStats | null;
  eventConsumption: EventConsumptionMetricsReport | undefined;
};
export type StreamRpcResult<T> = Promise<T> & Disposable;
export type StreamBrowserStore = Disposable & {
  readonly streamDatabase: StreamBrowserDatabase;
  appendBatch(args: { events: StreamEventInput[] }): StreamRpcResult<StreamEvent[]>;
  runtimeState(): StreamRpcResult<StreamRuntimeState>;
  metrics(): BrowserStreamMetrics;
  noteExternalAppend(args: { maxCommittedOffset: number; t0: number }): void;
  clearLocalDatabase(): Promise<void>;
  nudge(): Promise<void>;
  setSubscriberUser(user: BrowserStreamSubscriberUser | undefined): void;
  getSnapshot(): StreamBrowserSnapshot;
  getServerSnapshot(): StreamBrowserSnapshot;
  subscribe(listener: () => void): () => void;
  isDisposed(): boolean;
};

type StreamMirrorOptions = {
  projectId?: string;
  streamPath: string;
  createStreamClient: BrowserStreamClientFactory;
  resetTransport?: () => void;
  subscriberUser?: BrowserStreamSubscriberUser;
  streamUrl?: string | URL | ((args: { projectId: string; streamPath: string }) => string | URL);
};

type RegisteredMirror = {
  store: StreamBrowserStore;
  retain(options: StreamMirrorOptions): void;
};
const mirrors = new Map<string, RegisteredMirror>();
const debug = new Map<string, () => Record<string, unknown>>();
Object.assign(globalThis, {
  __streamRuntimeDebug: () => Object.fromEntries([...debug].map(([key, read]) => [key, read()])),
});

/** Reuses a tab's mirror; all durable projection and reducer state belongs to the server. */
export function acquireStreamRuntime(options: StreamMirrorOptions): StreamBrowserStore {
  const projectId = options.projectId ?? "default";
  const key = `${projectId} ${options.streamPath}`;
  const existing = mirrors.get(key);
  if (existing) {
    existing.retain(options);
    return existing.store;
  }
  const mirror = createStreamMirror({ ...options, projectId }, () => {
    mirrors.delete(key);
    debug.delete(key);
  });
  mirrors.set(key, mirror);
  return mirror.store;
}

class StreamSyncDisconnected extends Error {}

function canReconnect(error: unknown) {
  const message = errorMessage(error);
  return (
    // These are the source's explicit replay-admission rejections. Re-read the
    // head and resume with pages instead of retrying the same rejected open.
    /^stream ID changed(?: during catch-up(?: page read)?)? \(.+ -> .+\)$/.test(message) ||
    /^replay gap \d+ exceeds maxReplayOffsetGap \d+$/.test(message) ||
    error instanceof StreamSyncDisconnected ||
    error instanceof StepTimeoutError ||
    isStreamSessionBrokenError(error) ||
    isStreamUnavailableError(error)
  );
}

function createStreamMirror(
  initialOptions: StreamMirrorOptions & { projectId: string },
  onDispose: () => void,
): RegisteredMirror {
  let options = initialOptions;
  const { projectId, streamPath } = options;
  const { db: streamDatabase, release: releaseDatabase } = acquireDatabase(projectId, streamPath);
  const listeners = new Set<() => void>();
  const eventMetrics = new EventConsumptionMetrics(Date.now());
  const transportRtt = new LatencyRing();
  let disposed = false;
  let started = false;
  let writer: WriterRole | undefined;
  type SyncSession = {
    client: BrowserStreamClient;
    abort: AbortController;
    handle?: StreamConnectionHandle;
  };
  let active: SyncSession | undefined;
  let synchronizationAbort: AbortController | undefined;
  let syncTask = Promise.resolve();
  let cacheReset = Promise.resolve();
  let healthySince = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let infoTimer: ReturnType<typeof setTimeout> | undefined;
  let lastDeliveredOffset = 0;
  let totalDeliveredEvents = 0;
  let pendingIngestEvents = 0;
  let snapshot: StreamBrowserSnapshot = {
    connectionStatus: "connecting",
    databaseRole: "idle",
    clearVersion: 0,
    connectionError: undefined,
    databaseInfo: undefined,
  };

  function publish(change: Partial<StreamBrowserSnapshot>) {
    if (disposed) return;
    snapshot = { ...snapshot, ...change };
    for (const listener of listeners) listener();
  }

  const offDatabaseChange = streamDatabase.onChange((change) => {
    if (change.kind === "clear" || change.kind === "reset") {
      publish({ clearVersion: snapshot.clearVersion + 1 });
    }
    if (change.kind === "reset") {
      synchronizationAbort?.abort(new StreamSyncDisconnected("local cache reset"));
      if (!started) start();
    }
    if (disposed || infoTimer) return;
    infoTimer = setTimeout(() => {
      infoTimer = undefined;
      void streamDatabase.info().then(
        (databaseInfo) => publish({ databaseInfo }),
        (error: unknown) => publish({ connectionError: errorMessage(error) }),
      );
    }, 250);
  });

  async function call<T>(client: BrowserStreamClient, request: () => PromiseLike<T>): Promise<T> {
    const startedAt = Date.now();
    try {
      const result = await raceWithTimeout(
        Promise.resolve(request()),
        10_000,
        "stream RPC timed out",
      );
      transportRtt.record(Date.now() - startedAt, Date.now());
      return result;
    } catch (error) {
      if (error instanceof StepTimeoutError || isStreamSessionBrokenError(error)) {
        // The shared socket keeper decides whether to retire its transport.
        (client.reportTransportSuspicion ?? options.resetTransport)?.();
      }
      throw error;
    }
  }

  async function openClient(abort?: AbortController) {
    const streamUrl =
      typeof options.streamUrl === "function"
        ? options.streamUrl({ projectId, streamPath })
        : options.streamUrl;
    const opening = options.createStreamClient({
      projectId,
      streamPath,
      ...(streamUrl && { streamUrl }),
      onConnectionStatusChange: (status, error) => {
        if (status === "closed" || status === "error") {
          abort?.abort(new StreamSyncDisconnected(error ?? "stream transport closed"));
        }
      },
    });
    try {
      return await raceWithTimeout(opening, 10_000, "stream connection timed out");
    } catch (error) {
      // A timed-out open may resolve later. It must not leak a socket/stub.
      void opening.then(
        (client) => client[Symbol.dispose](),
        () => undefined,
      );
      if (error instanceof StepTimeoutError) options.resetTransport?.();
      throw error;
    }
  }

  async function synchronize(role: WriterRole) {
    const abort = new AbortController();
    synchronizationAbort = abort;
    const client = await openClient(abort);
    if (disposed || writer !== role || abort.signal.aborted) {
      client[Symbol.dispose]();
      return;
    }
    const session: SyncSession = { client, abort };
    active = session;
    const isCurrent = () =>
      !disposed && writer === role && active === session && !abort.signal.aborted;
    const ended = new Promise<unknown>((resolve) => {
      abort.signal.addEventListener("abort", () => resolve(abort.signal.reason), { once: true });
      if (abort.signal.aborted) resolve(abort.signal.reason);
    });
    let ingest = Promise.resolve();
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    try {
      const head = await call(client, () =>
        client.getEventPage({ afterOffset: Number.MAX_SAFE_INTEGER, limit: 1 }),
      );
      if (!isCurrent()) return;
      const mirror = await openStreamEventMirror(streamDatabase, head);
      if (!isCurrent()) return;
      if (mirror.reset) streamDatabase.notifyChanged({ kind: "clear" });
      lastDeliveredOffset = mirror.throughOffset;
      const apply = async (batch: StreamEventBatch) => {
        if (!isCurrent()) return;
        const ingestStartedAtMs = Date.now();
        await mirror.ingest(batch);
        if (!isCurrent()) return;
        lastDeliveredOffset = mirror.throughOffset;
        totalDeliveredEvents += batch.events.length;
        eventMetrics.noteBatchIngested({
          ingestedThroughOffset: mirror.throughOffset,
          ingestedOffsets: batch.events.map((event) => event.offset),
          ingestStartedAtMs,
          atMs: Date.now(),
        });
        streamDatabase.notifyChanged({
          kind: "append",
          minOffset: batch.scannedAfterOffset,
          maxOffset: mirror.throughOffset,
        });
      };
      const caughtUp = await catchUpToLiveReplayBoundary({
        afterOffset: mirror.throughOffset,
        throughOffset: head.streamMaxOffset,
        pageLimit: 500,
        maxReplayOffsetGap: MAX_REPLAY_GAP,
        expectedStreamId: head.streamId,
        shouldContinue: isCurrent,
        catchUp: ({ afterOffset, throughOffset, pageLimit }) =>
          catchUpAvailableHistory({
            afterOffset,
            throughOffset,
            pageLimit,
            expectedStreamId: head.streamId,
            shouldContinue: isCurrent,
            read: (input) =>
              call(client, () => client.getEventPage({ ...input, includeEphemeral: false })),
            ingest: (batch) =>
              apply({
                ...batch,
                events: [...batch.events],
                projectId,
                path: streamPath,
                streamId: head.streamId,
                streamMaxOffset: batch.scannedThroughOffset,
                state: null,
              }),
          }),
        readLatestOffset: async () => {
          const next = await call(client, () =>
            client.getEventPage({ afterOffset: Number.MAX_SAFE_INTEGER, limit: 1 }),
          );
          return { streamId: next.streamId, maxOffset: next.streamMaxOffset };
        },
      });
      if (!caughtUp || !isCurrent()) return;
      publish({ connectionStatus: "opening-event-callback" });
      await call(client, () =>
        client
          .openConnection({
            connectionKey: `browser-event-sync:${crypto.randomUUID()}`,
            expectedStreamId: head.streamId,
            replayAfterOffset: caughtUp.replayAfterOffset,
            maxReplayOffsetGap: MAX_REPLAY_GAP,
            openedBy: {
              description: "browser",
              ...(options.subscriberUser && { user: options.subscriberUser }),
            },
            state: false,
            filter: { jsonataCondition: "$not($exists(ephemeral))" },
            processEventBatch: (batch) => {
              if (!isCurrent()) return;
              pendingIngestEvents += batch.events.length;
              if (pendingIngestEvents > MAX_QUEUED_EVENTS) {
                abort.abort(
                  new StreamSyncDisconnected(
                    "event delivery exceeded the local cache capacity; resuming with paged reads",
                  ),
                );
                return;
              }
              const work = ingest.then(() => apply(batch));
              ingest = work
                .catch((error: unknown) => {
                  abort.abort(error);
                })
                .finally(() => {
                  pendingIngestEvents -= batch.events.length;
                });
              role.holdUntil(ingest);
              return ingest;
            },
          })
          .then((handle) => {
            // RPC resolution may arrive after our deadline or disposal.
            if (isCurrent()) session.handle = handle;
            else closeHandle(handle);
          }),
      );
      if (!isCurrent()) return;
      healthySince = Date.now();
      publish({ connectionStatus: "receiving-events", connectionError: undefined });
      let checking = false;
      heartbeat = setInterval(() => {
        if (checking || !isCurrent()) return;
        checking = true;
        void checkConnection()
          .catch((error: unknown) => abort.abort(error))
          .finally(() => {
            checking = false;
          });
      }, 5_000);
      throw await ended;
    } finally {
      clearInterval(heartbeat);
      abort.abort(new StreamSyncDisconnected("stream synchronization stopped"));
      await ingest;
      pendingIngestEvents = 0;
      eventMetrics.clearPendingAppends();
      if (session.handle) closeHandle(session.handle);
      client[Symbol.dispose]();
      if (active === session) active = undefined;
    }
  }

  function closeHandle(handle: StreamConnectionHandle) {
    void Promise.resolve()
      .then(() => handle.close())
      .catch((error: unknown) => {
        if (!canReconnect(error)) console.error("stream event connection close failed", error);
      })
      .finally(() => handle[Symbol.dispose]());
  }

  async function checkConnection() {
    const session = active;
    if (!session?.handle || session.abort.signal.aborted) return;
    const connected = await call(session.client, () => Promise.resolve(session.handle!.ping()));
    if (!connected) throw new StreamSyncDisconnected("stream event connection no longer exists");
  }

  function start() {
    if (started || disposed) return;
    started = true;
    publish({ databaseRole: "reader", connectionStatus: "connecting", connectionError: undefined });
    const role = acquireWriterRole({
      lockName: `stream-event-sync:${streamDatabase.databasePath}`,
    });
    writer = role;
    syncTask = role.whenWriter
      .then(async () => {
        if (disposed || writer !== role) return;
        publish({ databaseRole: "writer" });
        for (let attempt = 0; !disposed && writer === role; attempt++) {
          try {
            healthySince = 0;
            const work = synchronize(role);
            role.holdUntil(work);
            await work;
            if (!disposed && writer === role)
              throw (
                synchronizationAbort?.signal.reason ??
                new StreamSyncDisconnected("sync interrupted")
              );
            return;
          } catch (error) {
            if (disposed || writer !== role) return;
            if (healthySince > 0 && Date.now() - healthySince >= 30_000) attempt = 0;
            if (!canReconnect(error) || attempt >= MAX_RECONNECT_ATTEMPTS) {
              publish({ connectionStatus: "error", connectionError: errorMessage(error) });
              console.error("stream event synchronization stopped", {
                projectId,
                streamPath,
                error,
              });
              role.release();
              writer = undefined;
              started = false;
              return;
            }
            publish({ connectionStatus: "reconnecting", connectionError: errorMessage(error) });
            await new Promise((resolve) =>
              setTimeout(resolve, Math.min(5_000, 250 * 2 ** attempt)),
            );
          }
        }
      })
      .catch((error: unknown) => {
        if (disposed || writer !== role) return;
        publish({ connectionStatus: "error", connectionError: errorMessage(error) });
        console.error("stream writer election failed", { projectId, streamPath, error });
        role.release();
        writer = undefined;
        started = false;
      });
  }

  async function withClient<T>(
    request: (client: BrowserStreamClient) => PromiseLike<T>,
  ): Promise<T> {
    if (disposed) throw new Error("stream event mirror is disposed");
    const borrowed = active && !active.abort.signal.aborted ? active.client : undefined;
    const client = borrowed ?? (await openClient());
    try {
      return await call(client, () => request(client));
    } finally {
      if (!borrowed) client[Symbol.dispose]();
    }
  }

  function idleDispose() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (listeners.size === 0) store[Symbol.dispose]();
    }, IDLE_DISPOSE_MS);
  }

  const store: StreamBrowserStore = {
    streamDatabase,
    appendBatch({ events: input }) {
      const events = input.map((event) => ({
        ...event,
        idempotencyKey: event.idempotencyKey ?? crypto.randomUUID(),
      }));
      const t0 = Date.now();
      const result = (async () => {
        for (let attempt = 0; ; attempt++) {
          try {
            const committed = await withClient((client) => client.append(...events));
            eventMetrics.noteAppendCommitted({
              maxCommittedOffset: Math.max(0, ...committed.map((event) => event.offset)),
              t0,
              atMs: Date.now(),
            });
            return committed;
          } catch (error) {
            if (disposed || !canReconnect(error) || attempt >= MAX_RECONNECT_ATTEMPTS) throw error;
            active?.abort.abort(error);
            await new Promise((resolve) =>
              setTimeout(resolve, Math.min(5_000, 250 * 2 ** attempt)),
            );
          }
        }
      })();
      return Object.assign(result, { [Symbol.dispose]() {} });
    },
    runtimeState: () =>
      Object.assign(
        withClient((client) => client.runtimeState()),
        { [Symbol.dispose]() {} },
      ),
    metrics: () => ({
      transportRttMs: transportRtt.stats(),
      eventConsumption: active?.handle ? eventMetrics.report() : undefined,
    }),
    noteExternalAppend: ({ maxCommittedOffset, t0 }) =>
      eventMetrics.noteAppendCommitted({ maxCommittedOffset, t0, atMs: Date.now() }),
    async clearLocalDatabase() {
      cacheReset = cacheReset.then(() =>
        streamDatabase.batch(
          [
            { sql: `DELETE FROM events` },
            { sql: `DELETE FROM event_type_counts` },
            {
              sql: `UPDATE stream_sync SET through_offset = 0, owner = ?`,
              params: [crypto.randomUUID()],
            },
          ],
          { transaction: true },
        ),
      );
      await cacheReset;
      streamDatabase.notifyChanged({ kind: "reset" });
    },
    async nudge() {
      if (!started) {
        start();
        return;
      }
      try {
        await checkConnection();
      } catch (error) {
        active?.abort.abort(error);
      }
    },
    setSubscriberUser(user) {
      const update = browserStreamSubscriberUserUpdate({
        current: options.subscriberUser,
        next: user,
        started,
      });
      options = { ...options, subscriberUser: update.user };
      if (update.reconnect)
        synchronizationAbort?.abort(new StreamSyncDisconnected("browser identity changed"));
    },
    getSnapshot: () => snapshot,
    getServerSnapshot: () => snapshot,
    subscribe(listener) {
      if (disposed) throw new Error("cannot subscribe to a disposed stream mirror");
      clearTimeout(idleTimer);
      listeners.add(listener);
      start();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) idleDispose();
      };
    },
    isDisposed: () => disposed,
    [Symbol.dispose]() {
      if (disposed) return;
      disposed = true;
      clearTimeout(idleTimer);
      clearTimeout(infoTimer);
      offDatabaseChange();
      listeners.clear();
      synchronizationAbort?.abort(new StreamSyncDisconnected("stream mirror disposed"));
      writer?.release();
      writer = undefined;
      void Promise.allSettled([syncTask, cacheReset]).then(releaseDatabase);
      onDispose();
    },
  };
  debug.set(`${projectId} ${streamPath}`, () => ({
    ...snapshot,
    lastDeliveredOffset,
    totalDeliveredEvents,
    pendingIngestEvents,
    hasConnection: !!active,
    hasEventConnection: !!active?.handle,
    started,
    disposed,
  }));
  idleDispose();
  return {
    store,
    retain(next) {
      store.setSubscriberUser(next.subscriberUser);
      if (next.createStreamClient !== options.createStreamClient) {
        synchronizationAbort?.abort(new StreamSyncDisconnected("stream transport source changed"));
      }
      options = { ...next, projectId };
      idleDispose();
    },
  };
}
