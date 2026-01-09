/**
 * Persistent Stream Reducer for Durable Streams
 *
 * A React hook that consumes a durable-streams SSE endpoint, persists events
 * to localStorage, and resumes from the last known offset on page reload.
 *
 * Compatible with any server implementing the durable-streams protocol:
 * https://github.com/durable-streams/durable-streams
 *
 * ## Suspense Integration
 *
 * This hook integrates with React Suspense. It throws a promise during:
 * - Initial replay of persisted events from localStorage
 * - Catch-up phase while waiting for server's `up-to-date` signal
 *
 * Once ready, the component renders with full state. Wrap usage in <Suspense>:
 *
 * ```tsx
 * <Suspense fallback={<Spinner />}>
 *   <Chat agentId="123" />
 * </Suspense>
 * ```
 *
 * ## Batched Replay
 *
 * Replaying thousands of events synchronously would block the main thread.
 * This hook processes persisted events in batches, yielding to the browser
 * between batches via `scheduler.yield()` (with `setTimeout` fallback).
 * Configure batch size with `replayBatchSize` (default: 100).
 *
 * ## Key Concepts
 *
 * 1. OFFSET-BASED RESUMPTION
 *    Durable streams use opaque offset strings. Store the last offset and
 *    pass it on reconnection to resume exactly where you left off.
 *
 * 2. EVENT FILTERING
 *    Some events (streaming chunks) are useful live but wasteful to persist.
 *    `shouldPersist` controls what gets stored without affecting live updates.
 *
 * 3. MULTI-TAB COORDINATION
 *    Uses broadcast-channel for cross-tab sync. One tab becomes leader and
 *    maintains the SSE connection; others receive state via BroadcastChannel.
 */

import { useReducer, useEffect, useRef, useState, useCallback } from "react";
import { BroadcastChannel, createLeaderElection, type LeaderElector } from "broadcast-channel";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface StreamEvent {
  type: string;
  [key: string]: unknown;
}

export interface PersistentStreamConfig<TState, TEvent extends StreamEvent> {
  /** SSE endpoint URL. Pass null to disable. */
  url: string | null;

  /** Reducer: (state, event) => newState */
  reducer: (state: TState, event: TEvent) => TState;

  /** Initial state before any events */
  initialState: TState;

  /** Storage key prefix for localStorage */
  storageKey: string;

  /**
   * Filter for persistence. Return true to store, false to skip.
   * All events still go through the reducer for live updates.
   * @default () => true
   */
  shouldPersist?: (event: TEvent) => boolean;

  /**
   * Events to process per batch during replay.
   * Lower = more responsive UI, higher = faster total replay.
   * @default 100
   */
  replayBatchSize?: number;

  /** Called when stream catches up to live */
  onCaughtUp?: () => void;

  /** Called when server signals data is stale */
  onMustRefetch?: () => void;

  /**
   * Whether to use Suspense integration.
   * When true, the hook throws a promise during loading.
   * @default true
   */
  suspense?: boolean;
}

export interface PersistentStreamResult<TState> {
  /** Current reduced state */
  state: TState;

  /** True while receiving streaming events (e.g., LLM tokens) */
  isStreaming: boolean;

  /** True if this tab owns the SSE connection */
  isLeader: boolean;

  /** Clear persisted data and reset */
  reset: () => void;

  /** Current offset (for debugging) */
  offset: string;
}

interface BroadcastMessage<TEvent> {
  type: "event" | "offset" | "streaming" | "ready";
  event?: TEvent;
  offset?: string;
  streaming?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Suspense cache
// ─────────────────────────────────────────────────────────────────────────────

type SuspenseStatus = "pending" | "resolved" | "rejected";

interface SuspenseResource<T> {
  read(): T;
}

const suspenseCache = new Map<string, SuspenseResource<void>>();

function createSuspenseResource(_key: string, promise: Promise<void>): SuspenseResource<void> {
  let status: SuspenseStatus = "pending";
  let error: unknown;

  const suspender = promise.then(
    () => {
      status = "resolved";
    },
    (e) => {
      status = "rejected";
      error = e;
    },
  );

  return {
    read() {
      if (status === "pending") throw suspender;
      if (status === "rejected") throw error;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Storage
// ─────────────────────────────────────────────────────────────────────────────

const storage = {
  getEvents<E>(key: string): E[] {
    try {
      const raw = localStorage.getItem(`${key}:events`);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  },

  getOffset(key: string): string {
    return localStorage.getItem(`${key}:offset`) ?? "-1";
  },

  appendEvent<E>(key: string, event: E): void {
    const events = this.getEvents<E>(key);
    events.push(event);
    localStorage.setItem(`${key}:events`, JSON.stringify(events));
  },

  setOffset(key: string, offset: string): void {
    localStorage.setItem(`${key}:offset`, offset);
  },

  clear(key: string): void {
    localStorage.removeItem(`${key}:events`);
    localStorage.removeItem(`${key}:offset`);
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Batched replay
// ─────────────────────────────────────────────────────────────────────────────

async function yieldToMain(): Promise<void> {
  if (
    "scheduler" in globalThis &&
    "yield" in (globalThis as unknown as { scheduler?: { yield?: unknown } }).scheduler!
  ) {
    return (
      globalThis as unknown as { scheduler: { yield: () => Promise<void> } }
    ).scheduler.yield();
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function replayEventsInBatches<TState, TEvent>(
  events: TEvent[],
  reducer: (state: TState, event: TEvent) => TState,
  initialState: TState,
  batchSize: number,
): Promise<TState> {
  let state = initialState;

  for (let i = 0; i < events.length; i += batchSize) {
    const batch = events.slice(i, i + batchSize);
    for (const event of batch) {
      state = reducer(state, event);
    }
    if (i + batchSize < events.length) {
      await yieldToMain();
    }
  }

  return state;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────────────────────

export function usePersistentStream<TState, TEvent extends StreamEvent>({
  url,
  reducer,
  initialState,
  storageKey,
  shouldPersist = () => true,
  replayBatchSize = 100,
  onCaughtUp,
  onMustRefetch,
  suspense = true,
}: PersistentStreamConfig<TState, TEvent>): PersistentStreamResult<TState> {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [phase, setPhase] = useState<"idle" | "replaying" | "catching-up" | "ready">("idle");
  const [isStreaming, setIsStreaming] = useState(false);
  const [isLeader, setIsLeader] = useState(false);
  const [offset, setOffset] = useState("-1");

  // Refs for values that shouldn't trigger effect re-runs
  const offsetRef = useRef("-1");
  const shouldPersistRef = useRef(shouldPersist);
  const onCaughtUpRef = useRef(onCaughtUp);
  const onMustRefetchRef = useRef(onMustRefetch);
  const readyResolverRef = useRef<(() => void) | null>(null);

  // Keep refs in sync without triggering effects
  shouldPersistRef.current = shouldPersist;
  onCaughtUpRef.current = onCaughtUp;
  onMustRefetchRef.current = onMustRefetch;

  const suspenseKey = `${storageKey}:${url}`;

  // Create suspense resource (only runs once per key)
  if (suspense && url && !suspenseCache.has(suspenseKey)) {
    const readyPromise = new Promise<void>((resolve) => {
      readyResolverRef.current = resolve;
    });
    suspenseCache.set(suspenseKey, createSuspenseResource(suspenseKey, readyPromise));
  }

  // Single effect for replay + SSE - only re-runs when url/storageKey changes
  useEffect(() => {
    if (!url) {
      setPhase("ready");
      return;
    }

    let cancelled = false;
    let eventSource: EventSource | null = null;
    let channel: BroadcastChannel<BroadcastMessage<TEvent>> | null = null;
    let elector: LeaderElector | null = null;

    const startSSE = () => {
      if (cancelled) return;

      channel = new BroadcastChannel<BroadcastMessage<TEvent>>(`durable-stream:${storageKey}`);

      channel.onmessage = (msg) => {
        if (cancelled) return;
        switch (msg.type) {
          case "event":
            if (msg.event) {
              dispatch(msg.event);
              // Followers also persist events to stay in sync with leader
              if (shouldPersistRef.current(msg.event)) {
                storage.appendEvent(storageKey, msg.event);
              }
            }
            break;
          case "offset":
            if (msg.offset) {
              offsetRef.current = msg.offset;
              setOffset(msg.offset);
              // Followers also persist offset to stay in sync
              storage.setOffset(storageKey, msg.offset);
            }
            break;
          case "streaming":
            if (msg.streaming !== undefined) setIsStreaming(msg.streaming);
            break;
          case "ready":
            setPhase("ready");
            readyResolverRef.current?.();
            break;
        }
      };

      elector = createLeaderElection(channel);

      elector.awaitLeadership().then(() => {
        if (cancelled) return;
        setIsLeader(true);

        const streamUrl = new URL(url, window.location.origin);
        streamUrl.searchParams.set("offset", offsetRef.current);
        streamUrl.searchParams.set("live", "sse");

        eventSource = new EventSource(streamUrl.toString());

        const handleEvent = (evt: MessageEvent, isControlEvent = false) => {
          if (cancelled) return;
          try {
            const data = JSON.parse(evt.data);

            const newOffset = evt.lastEventId || data.headers?.offset;
            if (newOffset) {
              offsetRef.current = newOffset;
              storage.setOffset(storageKey, newOffset);
              setOffset(newOffset);
              channel?.postMessage({ type: "offset", offset: newOffset });
            }

            if (isControlEvent || data.headers?.control) {
              const controlType = isControlEvent
                ? data.upToDate
                  ? "up-to-date"
                  : data.streamNextOffset
                    ? "offset-update"
                    : null
                : data.headers.control;

              switch (controlType) {
                case "up-to-date":
                  setPhase("ready");
                  readyResolverRef.current?.();
                  channel?.postMessage({ type: "ready" });
                  onCaughtUpRef.current?.();
                  break;
                case "must-refetch":
                  storage.clear(storageKey);
                  suspenseCache.delete(suspenseKey);
                  onMustRefetchRef.current?.();
                  break;
                case "offset-update":
                  if (data.streamNextOffset) {
                    offsetRef.current = data.streamNextOffset;
                    storage.setOffset(storageKey, data.streamNextOffset);
                    setOffset(data.streamNextOffset);
                    channel?.postMessage({ type: "offset", offset: data.streamNextOffset });
                  }
                  break;
              }
              if (isControlEvent) return;
              if (data.headers?.control) return;
            }

            const events: TEvent[] = Array.isArray(data) ? data : [data];

            for (const event of events) {
              if (!event.type) continue;

              dispatch(event);
              channel?.postMessage({ type: "event", event });

              if (shouldPersistRef.current(event)) {
                storage.appendEvent(storageKey, event);
              }

              if (event.type === "message_start") {
                setIsStreaming(true);
                channel?.postMessage({ type: "streaming", streaming: true });
              } else if (
                event.type === "message_complete" ||
                event.type === "message_end" ||
                event.type === "agent_end"
              ) {
                setIsStreaming(false);
                channel?.postMessage({ type: "streaming", streaming: false });
              }
            }
          } catch (e) {
            console.error("[durable-stream] Parse error:", e);
          }
        };

        eventSource.onmessage = (evt) => handleEvent(evt);
        eventSource.addEventListener("control", (evt) => handleEvent(evt as MessageEvent, true));
        eventSource.addEventListener("data", (evt) => handleEvent(evt as MessageEvent));
      });
    };

    // Start replay
    setPhase("replaying");

    const events = storage.getEvents<TEvent>(storageKey);
    offsetRef.current = storage.getOffset(storageKey);
    setOffset(offsetRef.current);

    if (events.length === 0) {
      setPhase("catching-up");
      startSSE();
    } else {
      replayEventsInBatches(events, reducer, initialState, replayBatchSize).then(() => {
        if (cancelled) return;
        for (const event of events) {
          dispatch(event);
        }
        setPhase("catching-up");
        startSSE();
      });
    }

    return () => {
      cancelled = true;
      eventSource?.close();
      elector?.die();
      channel?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Intentionally minimal deps to avoid infinite loops. reducer/initialState/replayBatchSize are stable.
  }, [url, storageKey]);

  // Throw for Suspense if enabled and not ready
  if (suspense && url && phase !== "ready" && phase !== "idle") {
    suspenseCache.get(suspenseKey)?.read();
  }

  const reset = useCallback(() => {
    storage.clear(storageKey);
    suspenseCache.delete(suspenseKey);
    window.location.reload();
  }, [storageKey, suspenseKey]);

  return { state, isStreaming, isLeader, reset, offset };
}

// ─────────────────────────────────────────────────────────────────────────────
// Filters
// ─────────────────────────────────────────────────────────────────────────────

export function excludeChunks(event: StreamEvent): boolean {
  return event.type !== "message_updated" && event.type !== "message_chunk";
}

export function onlyTypes(...types: string[]) {
  const set = new Set(types);
  return (event: StreamEvent): boolean => set.has(event.type);
}

export function excludeTypes(...types: string[]) {
  const set = new Set(types);
  return (event: StreamEvent): boolean => !set.has(event.type);
}
