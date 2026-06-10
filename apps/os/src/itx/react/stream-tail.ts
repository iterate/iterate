// The subscription multiplexer: ONE server-side subscription per stream path,
// fanned out to every component that tails it. Everything rides the tab's
// shared itx WebSocket, so this layer is what keeps "N stream views" from
// meaning "N subscriptions": entries are refcounted, late mounters replay the
// buffer, teardown lingers briefly to absorb remount churn, and a dropped
// socket re-subscribes from the last seen offset once the client reconnects.
//
// Filtering is deliberately NOT here (decided in the plan): views filter
// client-side, so raw mode is the same data and the kernel API stays minimal.
//
// Shaped for useSyncExternalStore: subscribe/getSnapshot per (project, path).

import type { Event as StreamLegacyEvent } from "@iterate-com/shared/streams/types";
import type { ItxBrowserClient } from "./connection.ts";
import { isItxAccessError } from "./errors.ts";

export type StreamTailStatus = "connecting" | "live" | "error";

export type StreamTailSnapshot = {
  events: readonly StreamLegacyEvent[];
  status: StreamTailStatus;
  error?: string;
};

export type StreamTailStore = {
  subscribe(listener: () => void): () => void;
  getSnapshot(): StreamTailSnapshot;
  /** Start (or join) the shared subscription; the return value releases it. */
  retain(): () => void;
};

const MAX_BUFFERED_EVENTS = 500;
const RELEASE_LINGER_MS = 5_000;
const RETRY_INITIAL_MS = 1_000;
const RETRY_MAX_MS = 15_000;
const LIVENESS_INTERVAL_MS = 30_000;

const EMPTY_SNAPSHOT: StreamTailSnapshot = { events: [], status: "connecting" };

type TailEntry = {
  snapshot: StreamTailSnapshot;
  listeners: Set<() => void>;
  refCount: number;
  lastOffset: number | undefined;
  /** Guards against stale async work after teardown/restart. */
  generation: number;
  unsubscribeRemote: (() => void) | null;
  releaseTimer: ReturnType<typeof setTimeout> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  retryDelayMs: number;
  livenessTimer: ReturnType<typeof setTimeout> | null;
  stopStatusWatch: (() => void) | null;
  needsRestart: boolean;
};

const managers = new WeakMap<ItxBrowserClient, Map<string, TailEntry>>();

export function acquireStreamTailStore(
  client: ItxBrowserClient,
  project: string,
  streamPath: string,
): StreamTailStore {
  const entries = managers.get(client) ?? new Map<string, TailEntry>();
  managers.set(client, entries);
  const key = `${project}\0${streamPath}`;

  function entry(): TailEntry {
    let current = entries.get(key);
    if (!current) {
      current = {
        snapshot: EMPTY_SNAPSHOT,
        listeners: new Set(),
        refCount: 0,
        lastOffset: undefined,
        generation: 0,
        unsubscribeRemote: null,
        releaseTimer: null,
        retryTimer: null,
        retryDelayMs: RETRY_INITIAL_MS,
        livenessTimer: null,
        stopStatusWatch: null,
        needsRestart: false,
      };
      entries.set(key, current);
    }
    return current;
  }

  function emit(current: TailEntry, next: Partial<StreamTailSnapshot>) {
    current.snapshot = { ...current.snapshot, ...next };
    for (const listener of current.listeners) listener();
  }

  function appendEvents(current: TailEntry, incoming: StreamLegacyEvent[]) {
    // Restarts re-replay from the last seen offset; offsets dedupe.
    const fresh = incoming.filter(
      (event) => current.lastOffset === undefined || event.offset > current.lastOffset,
    );
    if (fresh.length === 0) return;
    current.lastOffset = fresh[fresh.length - 1]!.offset;
    const events = [...current.snapshot.events, ...fresh].slice(-MAX_BUFFERED_EVENTS);
    emit(current, { events, status: "live" });
  }

  async function start(current: TailEntry) {
    const generation = ++current.generation;
    current.needsRestart = false;
    emit(current, { status: "connecting", error: undefined });
    try {
      const itx = await client.project(project);
      const stream = itx.streams.get(streamPath);
      // Subscribing from "start" replays the whole history before going
      // live, so one call covers both the catch-up and the tail.
      const subscription = await stream.subscribe(
        (batch) => {
          if (generation !== current.generation) return;
          appendEvents(current, batch.events);
        },
        { afterOffset: current.lastOffset ?? "start" },
      );
      if (generation !== current.generation) {
        void Promise.resolve(subscription.unsubscribe()).catch(() => {});
        return;
      }
      // The remote may already be dead when we tear down (DO eviction killed
      // it) — a rejected unsubscribe is expected there, never unhandled.
      current.unsubscribeRemote = () =>
        void Promise.resolve(subscription.unsubscribe()).catch(() => {});
      current.retryDelayMs = RETRY_INITIAL_MS;
      emit(current, { status: "live" });
      scheduleLivenessProbe(current);
    } catch (error) {
      if (generation !== current.generation) return;
      current.needsRestart = true;
      emit(current, {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
      // A failed start with a healthy socket produces no status transition,
      // so the reconnect watcher alone would leave the tail stuck on
      // "error" — retry with capped backoff while anyone is still retained.
      // Access failures are the exception: retrying cannot authorize us.
      if (!isItxAccessError(error)) scheduleRetry(current);
    }
  }

  function scheduleRetry(current: TailEntry) {
    if (current.refCount === 0 || current.retryTimer !== null) return;
    const delay = current.retryDelayMs;
    current.retryDelayMs = Math.min(current.retryDelayMs * 2, RETRY_MAX_MS);
    current.retryTimer = setTimeout(() => {
      current.retryTimer = null;
      if (current.refCount > 0 && current.unsubscribeRemote === null) {
        void start(current);
      }
    }, delay);
  }

  function stop(current: TailEntry) {
    current.generation += 1;
    if (current.retryTimer !== null) {
      clearTimeout(current.retryTimer);
      current.retryTimer = null;
    }
    if (current.livenessTimer !== null) {
      clearTimeout(current.livenessTimer);
      current.livenessTimer = null;
    }
    current.unsubscribeRemote?.();
    current.unsubscribeRemote = null;
  }

  /**
   * The blind spot this covers: the Stream DO can die (eviction is routine on
   * Cloudflare) or tear the subscription down server-side while the tab's
   * socket stays healthy — no status transition fires, so without a probe the
   * tail reports "live" forever while events silently stop. Every interval,
   * compare the server's event count against the last offset we received
   * (offsets are dense: the DO appends at maxOffset + 1, so eventCount IS the
   * highest offset). Restart only if the server is ahead AND nothing arrived
   * during the probe roundtrip — on a busy stream deliveries advance
   * lastOffset constantly, so in-flight batches never read as a stall.
   */
  function scheduleLivenessProbe(current: TailEntry) {
    if (current.livenessTimer !== null) return;
    const generation = current.generation;
    current.livenessTimer = setTimeout(() => {
      current.livenessTimer = null;
      if (generation !== current.generation || current.unsubscribeRemote === null) return;
      const seenBeforeProbe = current.lastOffset ?? 0;
      void (async () => {
        const itx = await client.project(project);
        const state = await itx.streams.get(streamPath).getState();
        if (generation !== current.generation || current.unsubscribeRemote === null) return;
        const stalled =
          state.eventCount > seenBeforeProbe && (current.lastOffset ?? 0) === seenBeforeProbe;
        if (stalled) {
          stop(current);
          void start(current);
          return;
        }
        scheduleLivenessProbe(current);
      })().catch(() => {
        // Probe failures are connectivity noise — the status watcher owns
        // socket health. Keep probing as long as the tail is live.
        if (generation === current.generation && current.unsubscribeRemote !== null) {
          scheduleLivenessProbe(current);
        }
      });
    }, LIVENESS_INTERVAL_MS);
  }

  function watchReconnect(current: TailEntry) {
    // A socket drop kills the server-side subscription. The client reconnects
    // on its own; when it reports "connected" again, restart from lastOffset.
    let wasConnected = client.getStatus() === "connected";
    current.stopStatusWatch = client.subscribeStatus(() => {
      const connected = client.getStatus() === "connected";
      if (connected && (!wasConnected || current.needsRestart) && current.refCount > 0) {
        stop(current);
        void start(current);
      }
      if (!connected && wasConnected) {
        // The remote subscription died with the socket — drop the stale
        // disposer so a later retain() knows there is nothing live to join.
        current.needsRestart = true;
        current.unsubscribeRemote = null;
      }
      wasConnected = connected;
    });
  }

  return {
    subscribe(listener: () => void) {
      const current = entry();
      current.listeners.add(listener);
      return () => current.listeners.delete(listener);
    },
    getSnapshot() {
      return entries.get(key)?.snapshot ?? EMPTY_SNAPSHOT;
    },
    retain() {
      const current = entry();
      if (current.releaseTimer !== null) {
        clearTimeout(current.releaseTimer);
        current.releaseTimer = null;
      }
      current.refCount += 1;
      // Start when there is no live remote subscription to join: first
      // consumer, or rejoining after the socket (and its subscription) died
      // without a reconnect transition to trigger the watcher.
      if (current.unsubscribeRemote === null && (current.refCount === 1 || current.needsRestart)) {
        void start(current);
      }
      if (current.stopStatusWatch === null) {
        watchReconnect(current);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        current.refCount -= 1;
        if (current.refCount > 0) return;
        // Linger so an immediate remount (navigation) rejoins the live
        // subscription instead of tearing it down and starting over.
        current.releaseTimer = setTimeout(() => {
          if (current.refCount > 0) return;
          stop(current);
          current.stopStatusWatch?.();
          current.stopStatusWatch = null;
          entries.delete(key);
        }, RELEASE_LINGER_MS);
      };
    },
  };
}
