import {
  type CircuitBreakerState,
  StreamPausedError,
  StreamPausedEvent,
  StreamResumedEvent,
} from "@iterate-com/events-contract";
import { defineBuiltinProcessor } from "./define-processor.ts";

/**
 * Rate-limiting circuit breaker for event streams.
 *
 * Tracks the last 100 event timestamps in state. When all 100 fall within a
 * single second, it auto-appends a "stream/paused" event, which causes
 * `beforeAppend` to reject all subsequent writes (except "stream/resumed").
 *
 * This prevents runaway producers from flooding a stream while still allowing
 * an operator to resume manually.
 */
export const circuitBreakerProcessor = defineBuiltinProcessor<CircuitBreakerState>(() => ({
  slug: "circuit-breaker",
  initialState: {
    paused: false,
    pauseReason: null,
    pausedAt: null,
    recentEventTimestamps: [],
  },

  beforeAppend({ event, state }) {
    if (!state.paused) return;
    if (event.type === "https://events.iterate.com/events/stream/resumed") return;
    throw new StreamPausedError();
  },

  reduce({ event, state }) {
    const pausedEvent = StreamPausedEvent.safeParse(event);
    if (pausedEvent.success) {
      return {
        paused: true,
        pauseReason: pausedEvent.data.payload.reason,
        pausedAt: event.createdAt,
        recentEventTimestamps: [event.createdAt],
      };
    }

    if (StreamResumedEvent.safeParse(event).success) {
      return {
        paused: false,
        pauseReason: null,
        pausedAt: null,
        recentEventTimestamps: [event.createdAt],
      };
    }

    return {
      ...state,
      recentEventTimestamps: [...state.recentEventTimestamps, event.createdAt].slice(-100),
    };
  },

  async afterAppend({ append, state }) {
    if (state.paused || state.recentEventTimestamps.length < 100) return;

    const first = Date.parse(state.recentEventTimestamps[0]);
    const last = Date.parse(state.recentEventTimestamps[state.recentEventTimestamps.length - 1]);
    if (last - first >= 1_000) return;

    append({
      type: "https://events.iterate.com/events/stream/paused",
      payload: { reason: "circuit breaker tripped: 100 events in under 1 second" },
    });
  },
}));
