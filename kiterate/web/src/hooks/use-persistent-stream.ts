/**
 * Simple Persistent Stream Hook
 *
 * Subscribes to an SSE endpoint, persists events to localStorage,
 * and resumes from the last known offset on reload.
 *
 * No multi-tab coordination - each tab manages its own connection.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from "react";

const MAX_STORED_EVENTS = 1000;
const TRIM_TO_EVENTS = 500;

interface StorageHelpers {
  getEvents<E>(key: string): E[];
  getOffset(key: string): string;
  appendEvent<E>(key: string, event: E): void;
  setOffset(key: string, offset: string): void;
  clear(key: string): void;
}

const storage: StorageHelpers = {
  getEvents<E>(key: string): E[] {
    try {
      const raw = localStorage.getItem(`${key}:events`);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  },

  getOffset(key: string): string {
    try {
      return localStorage.getItem(`${key}:offset`) ?? "-1";
    } catch {
      return "-1";
    }
  },

  appendEvent<E>(key: string, event: E): void {
    try {
      let events = this.getEvents<E>(key);
      events.push(event);

      if (events.length > MAX_STORED_EVENTS) {
        events = events.slice(-TRIM_TO_EVENTS);
      }

      localStorage.setItem(`${key}:events`, JSON.stringify(events));
    } catch (e) {
      if (e instanceof DOMException && e.name === "QuotaExceededError") {
        try {
          const events = this.getEvents<E>(key);
          const trimmed = events.slice(-TRIM_TO_EVENTS);
          trimmed.push(event);
          localStorage.setItem(`${key}:events`, JSON.stringify(trimmed));
        } catch {
          this.clear(key);
        }
      }
    }
  },

  setOffset(key: string, offset: string): void {
    try {
      localStorage.setItem(`${key}:offset`, offset);
    } catch {
      // Ignore quota errors for offset
    }
  },

  clear(key: string): void {
    try {
      localStorage.removeItem(`${key}:events`);
      localStorage.removeItem(`${key}:offset`);
    } catch {
      // Ignore errors during cleanup
    }
  },
};

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
}

export interface PersistentStreamResult<TState> {
  /** Current reduced state */
  state: TState;

  /** True while receiving streaming events */
  isStreaming: boolean;

  /** True when connected and caught up */
  isReady: boolean;

  /** Clear persisted data and reset */
  reset: () => void;

  /** Current offset (for debugging) */
  offset: string;
}

// Batch init action for replaying stored events
const BATCH_INIT_TYPE = "__PERSISTENT_STREAM_BATCH_INIT__";

interface BatchInitAction<TState> {
  type: typeof BATCH_INIT_TYPE;
  state: TState;
}

function wrapReducer<TState, TEvent extends StreamEvent>(
  reducer: (state: TState, event: TEvent) => TState,
) {
  return (state: TState, action: TEvent | BatchInitAction<TState>): TState => {
    if (action.type === BATCH_INIT_TYPE) {
      return (action as BatchInitAction<TState>).state;
    }
    return reducer(state, action as TEvent);
  };
}

export function usePersistentStream<TState, TEvent extends StreamEvent>({
  url,
  reducer,
  initialState,
  storageKey,
  shouldPersist = () => true,
}: PersistentStreamConfig<TState, TEvent>): PersistentStreamResult<TState> {
  const wrappedReducer = wrapReducer(reducer);
  const [state, dispatch] = useReducer(wrappedReducer, initialState);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [offset, setOffset] = useState("-1");

  const offsetRef = useRef("-1");
  const shouldPersistRef = useRef(shouldPersist);
  shouldPersistRef.current = shouldPersist;

  useEffect(() => {
    if (!url) {
      setIsReady(true);
      return;
    }

    let cancelled = false;
    let eventSource: EventSource | null = null;

    // Replay stored events
    const storedEvents = storage.getEvents<TEvent>(storageKey);
    const storedOffset = storage.getOffset(storageKey);
    offsetRef.current = storedOffset;
    setOffset(storedOffset);

    if (storedEvents.length > 0) {
      // Replay all stored events through reducer
      let replayedState = initialState;
      for (const event of storedEvents) {
        replayedState = reducer(replayedState, event);
      }
      dispatch({ type: BATCH_INIT_TYPE, state: replayedState });
    }

    // Connect to SSE
    const streamUrl = new URL(url, window.location.origin);
    streamUrl.searchParams.set("offset", offsetRef.current);

    eventSource = new EventSource(streamUrl.toString());

    eventSource.addEventListener("event", (evt) => {
      if (cancelled) return;

      try {
        const data = JSON.parse((evt as MessageEvent).data);

        // Update offset from event ID or data
        const newOffset = (evt as MessageEvent).lastEventId || data.offset;
        if (newOffset) {
          offsetRef.current = newOffset;
          storage.setOffset(storageKey, newOffset);
          setOffset(newOffset);
        }

        // The data wrapper contains the actual event
        const event = data.data ?? data;
        if (!event || typeof event !== "object") return;

        // Dispatch to reducer
        dispatch(event as TEvent);

        // Persist if filter allows
        if (shouldPersistRef.current(event as TEvent)) {
          storage.appendEvent(storageKey, event);
        }

        // Track streaming state based on event types
        if (event.type === "message_start") {
          setIsStreaming(true);
        } else if (
          event.type === "message_end" ||
          event.type === "agent_end" ||
          event.type === "turn_end"
        ) {
          setIsStreaming(false);
        }
      } catch {
        // Ignore parse errors
      }
    });

    eventSource.onopen = () => {
      if (!cancelled) {
        setIsReady(true);
      }
    };

    eventSource.onerror = () => {
      if (!cancelled) {
        setIsReady(false);
      }
    };

    return () => {
      cancelled = true;
      eventSource?.close();
    };
  }, [url, storageKey, reducer, initialState]);

  const reset = useCallback(() => {
    storage.clear(storageKey);
    window.location.reload();
  }, [storageKey]);

  return { state, isStreaming, isReady, reset, offset };
}

// Filter helpers
export function excludeTypes(...types: string[]) {
  const set = new Set(types);
  return (event: StreamEvent): boolean => !set.has(event.type);
}

export function onlyTypes(...types: string[]) {
  const set = new Set(types);
  return (event: StreamEvent): boolean => set.has(event.type);
}
