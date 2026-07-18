import {
  isItxTransportError,
  releaseItxSubscription,
  reportTransportSuspicion,
  watchItxSubscription,
  type ItxLiveSubscriptionHandle,
} from "iterate/client";
import { createLiveStateStore } from "iterate/live-state";

import type { LiveStateRpc, LiveUpdate, Stream } from "../../../../itx-api.generated.ts";

/** The full server runtime debug view (connections, subscriptions, throughput). */
export type StreamServerRuntimeState = Awaited<ReturnType<Stream["runtimeState"]>>;

/**
 * The narrow capability this source needs. Keeping it structural lets callers
 * hand over a generated stream live-state stub without coupling this browser
 * lifecycle to the rest of the Stream RPC surface.
 */
export type StreamRuntimeLiveConnection = Pick<LiveStateRpc<StreamServerRuntimeState>, "subscribe">;

export type StreamRuntimeLiveStatus = "connecting" | "live" | "error";

/** Stable useSyncExternalStore snapshot for the stream runtime debug view. */
export type StreamRuntimeLiveSnapshot = Readonly<{
  value: StreamServerRuntimeState | undefined;
  status: StreamRuntimeLiveStatus;
  error?: string;
  /** A fresh snapshot is in flight while the previously rendered value remains available. */
  refreshing: boolean;
}>;

/**
 * Framework-free, observer-owned stream runtime live state.
 *
 * The first local observer opens the server subscription and the last one
 * closes it. Connection changes, explicit refreshes, revision gaps, and a dead
 * subscription all re-subscribe without clearing the last good value. The
 * fresh subscription's initial full snapshot is the resynchronisation point.
 */
export type StreamRuntimeLiveSource = Disposable & {
  subscribe(listener: () => void): () => void;
  getSnapshot(): StreamRuntimeLiveSnapshot;
  refresh(): void;
  /** Replace the transport generation for the same logical stream. */
  setConnection(connection: StreamRuntimeLiveConnection | undefined): void;
  dispose(): void;
};

type ActiveSubscription = {
  connection: StreamRuntimeLiveConnection;
  stale: boolean;
  established: boolean;
  receivedSnapshot: boolean;
  establishmentTimer?: ReturnType<typeof setTimeout>;
  handle?: ItxLiveSubscriptionHandle;
  stopWatchdog?: () => void;
};

/** Keep this recovery contract aligned with `useItxSubscription`. */
const SUBSCRIBE_RETRY_MS = 10_000;
const SUBSCRIBE_TIMEOUT_MS = 15_000;

export type StreamRuntimeLiveSourceOptions = {
  /**
   * Report a possibly half-open shared transport to its owner. The verifier,
   * not this source, decides whether the socket should be retired.
   */
  reportTransportSuspicion?: () => void;
};

function sameSnapshot(left: StreamRuntimeLiveSnapshot, right: StreamRuntimeLiveSnapshot): boolean {
  return (
    left.value === right.value &&
    left.status === right.status &&
    left.error === right.error &&
    left.refreshing === right.refreshing
  );
}

export function createStreamRuntimeLiveSource(
  initialConnection?: StreamRuntimeLiveConnection,
  options: StreamRuntimeLiveSourceOptions = {},
): StreamRuntimeLiveSource {
  const liveState = createLiveStateStore<StreamServerRuntimeState>();
  const listeners = new Set<() => void>();
  let connection = initialConnection;
  let active: ActiveSubscription | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let snapshot: StreamRuntimeLiveSnapshot = {
    value: undefined,
    status: "connecting",
    refreshing: false,
  };

  const publish = (next: StreamRuntimeLiveSnapshot) => {
    if (sameSnapshot(snapshot, next)) return;
    snapshot = next;
    for (const listener of [...listeners]) listener();
  };

  const connecting = (refreshing: boolean) => {
    publish({
      value: liveState.getState(),
      status: "connecting",
      refreshing,
    });
  };

  const release = (subscription: ActiveSubscription) => {
    if (subscription.stale) return;
    subscription.stale = true;
    if (subscription.establishmentTimer !== undefined) {
      clearTimeout(subscription.establishmentTimer);
      subscription.establishmentTimer = undefined;
    }
    subscription.stopWatchdog?.();
    subscription.stopWatchdog = undefined;
    if (subscription.handle !== undefined) {
      releaseItxSubscription(subscription.handle);
      subscription.handle = undefined;
    }
  };

  const stopActive = () => {
    if (active === undefined) return;
    const previous = active;
    active = undefined;
    release(previous);
  };

  const stopRetry = () => {
    if (retryTimer === undefined) return;
    clearTimeout(retryTimer);
    retryTimer = undefined;
  };

  const scheduleRetry = () => {
    if (disposed || listeners.size === 0 || connection === undefined || retryTimer !== undefined) {
      return;
    }
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      start();
    }, SUBSCRIBE_RETRY_MS);
  };

  const fail = (
    subscription: ActiveSubscription,
    error: unknown,
    failureOptions: { retry: boolean },
  ) => {
    if (disposed || subscription.stale || active !== subscription) return;
    active = undefined;
    release(subscription);
    publish({
      value: liveState.getState(),
      status: "error",
      error: error instanceof Error ? error.message : String(error),
      refreshing: false,
    });
    if (failureOptions.retry) scheduleRetry();
  };

  let start: () => void;

  const restart = (subscription: ActiveSubscription) => {
    if (disposed || subscription.stale || active !== subscription) return;
    stopActive();
    start();
  };

  start = () => {
    if (disposed || listeners.size === 0 || connection === undefined) return;

    stopRetry();
    stopActive();
    connecting(liveState.getState() !== undefined);

    const subscription: ActiveSubscription = {
      connection,
      stale: false,
      established: false,
      receivedSnapshot: false,
    };
    active = subscription;

    const onUpdate = (update: LiveUpdate<StreamServerRuntimeState>) => {
      if (disposed || subscription.stale || active !== subscription) return;

      let revisionGap = false;
      liveState.apply(update, () => {
        revisionGap = true;
      });
      if (revisionGap) {
        restart(subscription);
        return;
      }

      if (update.type === "snapshot") subscription.receivedSnapshot = true;
      publish({
        value: liveState.getState(),
        status: subscription.established ? "live" : "connecting",
        refreshing: update.type === "snapshot" ? false : snapshot.refreshing,
      });
    };

    let pendingHandle: Promise<ItxLiveSubscriptionHandle>;
    try {
      pendingHandle = Promise.resolve(subscription.connection.subscribe(onUpdate));
    } catch (error) {
      fail(subscription, error, { retry: isItxTransportError(error) });
      return;
    }

    subscription.establishmentTimer = setTimeout(() => {
      if (disposed || subscription.stale || active !== subscription) return;
      (options.reportTransportSuspicion ?? reportTransportSuspicion)();
      fail(
        subscription,
        new Error(`itx subscription did not establish within ${SUBSCRIBE_TIMEOUT_MS}ms`),
        { retry: true },
      );
    }, SUBSCRIBE_TIMEOUT_MS);

    void pendingHandle.then(
      (handle) => {
        if (disposed || subscription.stale || active !== subscription) {
          releaseItxSubscription(handle);
          return;
        }

        if (subscription.establishmentTimer !== undefined) {
          clearTimeout(subscription.establishmentTimer);
          subscription.establishmentTimer = undefined;
        }
        subscription.handle = handle;
        subscription.established = true;
        subscription.stopWatchdog = watchItxSubscription(
          () => handle.ping(),
          () => restart(subscription),
        );
        publish({
          value: liveState.getState(),
          status: "live",
          refreshing: subscription.receivedSnapshot ? false : snapshot.refreshing,
        });
      },
      (error) => fail(subscription, error, { retry: isItxTransportError(error) }),
    );
  };

  const source: StreamRuntimeLiveSource = {
    subscribe(listener) {
      if (disposed) return () => {};
      const wasUnobserved = listeners.size === 0;
      listeners.add(listener);
      if (wasUnobserved) start();

      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        listeners.delete(listener);
        if (listeners.size !== 0) return;
        stopRetry();
        stopActive();
        connecting(false);
      };
    },
    getSnapshot: () => snapshot,
    refresh() {
      if (disposed) return;
      stopRetry();
      stopActive();
      if (listeners.size > 0 && connection !== undefined) start();
      else connecting(false);
    },
    setConnection(nextConnection) {
      if (disposed || connection === nextConnection) return;
      connection = nextConnection;
      stopRetry();
      stopActive();
      if (listeners.size > 0 && connection !== undefined) start();
      else connecting(listeners.size > 0 && liveState.getState() !== undefined);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      stopRetry();
      stopActive();
      connection = undefined;
      snapshot = {
        value: liveState.getState(),
        status: "connecting",
        refreshing: false,
      };
    },
    [Symbol.dispose]() {
      source.dispose();
    },
  };

  return source;
}
