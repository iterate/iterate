import type { CoreProcessorState } from "./core-processor-contract.ts";
import type { StreamEvent } from "./schemas.ts";

export type OrdinaryEventRun = {
  baseState: CoreProcessorState;
  count: number;
  lastOffset: number;
  timestampMs: number;
  availableTokens: number;
  trippedEvent?: StreamEvent;
  tokensBeforeTrip?: number;
  tokensAtTrip?: number;
};

/** Common singleton append transition with no control/replay dispatch. */
export function reduceOrdinaryEventAtTimestamp(
  state: CoreProcessorState,
  event: StreamEvent,
  timestampMs: number,
): CoreProcessorState {
  const circuitBreaker = state.circuitBreaker;
  const elapsedMs =
    circuitBreaker.lastRefillAtMs === null
      ? 0
      : Math.max(0, timestampMs - circuitBreaker.lastRefillAtMs);
  const availableTokens =
    Math.min(
      circuitBreaker.burstCapacity,
      circuitBreaker.availableTokens + elapsedMs * (circuitBreaker.refillRatePerMinute / 60_000),
    ) - 1;
  return {
    ...state,
    eventCount: state.eventCount + 1,
    maxOffset: event.offset,
    circuitBreaker: {
      ...circuitBreaker,
      availableTokens,
      lastRefillAtMs: timestampMs,
      trippedAtOffset:
        availableTokens < 0 && !state.paused && circuitBreaker.trippedAtOffset === null
          ? event.offset
          : circuitBreaker.trippedAtOffset,
    },
  };
}

export function appendOrdinaryEventToRun(
  run: OrdinaryEventRun | undefined,
  event: StreamEvent,
  state: CoreProcessorState,
  timestampMs: number,
): OrdinaryEventRun {
  if (run === undefined) {
    const circuitBreaker = state.circuitBreaker;
    const elapsedMs =
      circuitBreaker.lastRefillAtMs === null
        ? 0
        : Math.max(0, timestampMs - circuitBreaker.lastRefillAtMs);
    const tokensBeforeEvent = Math.min(
      circuitBreaker.burstCapacity,
      circuitBreaker.availableTokens + elapsedMs * (circuitBreaker.refillRatePerMinute / 60_000),
    );
    const availableTokens = tokensBeforeEvent - 1;
    const trips = availableTokens < 0 && !state.paused && circuitBreaker.trippedAtOffset === null;
    return {
      baseState: state,
      count: 1,
      lastOffset: event.offset,
      timestampMs,
      availableTokens,
      ...(trips
        ? {
            trippedEvent: event,
            tokensBeforeTrip: tokensBeforeEvent,
            tokensAtTrip: availableTokens,
          }
        : {}),
    };
  }

  const tokensBeforeEvent = run.availableTokens;
  run.availableTokens = tokensBeforeEvent - 1;
  run.count += 1;
  run.lastOffset = event.offset;
  if (
    run.trippedEvent === undefined &&
    run.availableTokens < 0 &&
    !run.baseState.paused &&
    run.baseState.circuitBreaker.trippedAtOffset === null
  ) {
    run.trippedEvent = event;
    run.tokensBeforeTrip = tokensBeforeEvent;
    run.tokensAtTrip = run.availableTokens;
  }
  return run;
}

type FoldedOrdinaryEventRun = {
  state: CoreProcessorState;
  tripped?: {
    event: StreamEvent;
    previousState: CoreProcessorState;
    state: CoreProcessorState;
  };
};

export function foldOrdinaryEventRun(run: OrdinaryEventRun): FoldedOrdinaryEventRun {
  const baseState = run.baseState;
  const baseCircuitBreaker = baseState.circuitBreaker;
  const trippedAtOffset = run.trippedEvent?.offset ?? baseCircuitBreaker.trippedAtOffset;
  const state: CoreProcessorState = {
    ...baseState,
    eventCount: baseState.eventCount + run.count,
    maxOffset: run.lastOffset,
    circuitBreaker: {
      ...baseCircuitBreaker,
      availableTokens: run.availableTokens,
      lastRefillAtMs: run.timestampMs,
      trippedAtOffset,
    },
  };

  const trippedEvent = run.trippedEvent;
  if (trippedEvent === undefined) return { state };

  const eventsBeforeTrip = trippedEvent.offset - baseState.maxOffset - 1;
  const previousState =
    eventsBeforeTrip === 0
      ? baseState
      : {
          ...baseState,
          eventCount: baseState.eventCount + eventsBeforeTrip,
          maxOffset: trippedEvent.offset - 1,
          circuitBreaker: {
            ...baseCircuitBreaker,
            availableTokens: run.tokensBeforeTrip!,
            lastRefillAtMs: run.timestampMs,
          },
        };
  const trippedState: CoreProcessorState = {
    ...baseState,
    eventCount: baseState.eventCount + eventsBeforeTrip + 1,
    maxOffset: trippedEvent.offset,
    circuitBreaker: {
      ...baseCircuitBreaker,
      availableTokens: run.tokensAtTrip!,
      lastRefillAtMs: run.timestampMs,
      trippedAtOffset: trippedEvent.offset,
    },
  };
  return {
    state,
    tripped: { event: trippedEvent, previousState, state: trippedState },
  };
}
