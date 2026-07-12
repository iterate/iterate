import { describe, expect, it } from "vitest";
import { CoreProcessorContract, type CoreProcessorState } from "./core-processor-contract.ts";
import {
  appendOrdinaryEventToRun,
  foldOrdinaryEventRun,
  reduceOrdinaryEventAtTimestamp,
  type OrdinaryEventRun,
} from "./stream-ordinary-event-run.ts";
import type { StreamEvent } from "./schemas.ts";

type BreakerCase = {
  name: string;
  count: number;
  timestampMs: number;
  paused?: boolean;
  availableTokens: number;
  lastRefillAtMs: number | null;
  burstCapacity: number;
  refillRatePerMinute: number;
  trippedAtOffset?: number | null;
};

const cases: BreakerCase[] = [
  {
    name: "ample budget",
    count: 40,
    timestampMs: 2_000,
    availableTokens: 50,
    lastRefillAtMs: 1_000,
    burstCapacity: 100,
    refillRatePerMinute: 60,
  },
  {
    name: "trip in the middle",
    count: 5,
    timestampMs: 2_000,
    availableTokens: 3,
    lastRefillAtMs: null,
    burstCapacity: 3,
    refillRatePerMinute: 1,
  },
  {
    name: "fractional budget trips on the first event",
    count: 2,
    timestampMs: 1_500,
    availableTokens: 0,
    lastRefillAtMs: 1_000,
    burstCapacity: 10,
    refillRatePerMinute: 60,
  },
  {
    name: "paused stream keeps burning without tripping",
    count: 3,
    timestampMs: 2_000,
    paused: true,
    availableTokens: 0,
    lastRefillAtMs: null,
    burstCapacity: 10,
    refillRatePerMinute: 1,
  },
  {
    name: "existing trip offset is preserved",
    count: 3,
    timestampMs: 2_000,
    availableTokens: -5,
    lastRefillAtMs: 1_000,
    burstCapacity: 10,
    refillRatePerMinute: 1,
    trippedAtOffset: 20,
  },
  {
    name: "clock moving backward does not refill",
    count: 4,
    timestampMs: 500,
    availableTokens: 2,
    lastRefillAtMs: 1_000,
    burstCapacity: 10,
    refillRatePerMinute: 6_000,
  },
  {
    name: "first event caps an overfull bucket",
    count: 2,
    timestampMs: 2_000,
    availableTokens: 100,
    lastRefillAtMs: 1_000,
    burstCapacity: 10,
    refillRatePerMinute: 60,
  },
];

describe("ordinary event run folding", () => {
  it.each(cases)("matches singleton reduction: $name", (input) => {
    const baseState = stateFor(input);
    const event = eventAt(baseState.maxOffset + 1, input.timestampMs);

    expect(reduceOrdinaryEventAtTimestamp(baseState, event, input.timestampMs)).toEqual(
      referenceFold(baseState, [event], input.timestampMs).state,
    );
  });

  it.each(cases)("matches event-by-event reduction: $name", (input) => {
    const baseState = stateFor(input);
    const events = Array.from({ length: input.count }, (_, index) =>
      eventAt(baseState.maxOffset + index + 1, input.timestampMs),
    );
    let run: OrdinaryEventRun | undefined;
    for (const event of events) {
      run = appendOrdinaryEventToRun(run, event, baseState, input.timestampMs);
    }

    expect(foldOrdinaryEventRun(run!)).toEqual(referenceFold(baseState, events, input.timestampMs));
  });
});

function stateFor(input: BreakerCase): CoreProcessorState {
  return CoreProcessorContract.stateSchema.parse({
    eventCount: 17,
    maxOffset: 23,
    paused: input.paused ?? false,
    circuitBreaker: {
      availableTokens: input.availableTokens,
      lastRefillAtMs: input.lastRefillAtMs,
      burstCapacity: input.burstCapacity,
      refillRatePerMinute: input.refillRatePerMinute,
      trippedAtOffset: input.trippedAtOffset ?? null,
    },
  });
}

function eventAt(offset: number, timestampMs: number): StreamEvent {
  return {
    type: "events.iterate.test/ordinary-run",
    offset,
    createdAt: new Date(timestampMs).toISOString(),
    path: "/ordinary-run",
  };
}

function referenceFold(
  initialState: CoreProcessorState,
  events: StreamEvent[],
  timestampMs: number,
) {
  let state = initialState;
  let tripped:
    | { event: StreamEvent; previousState: CoreProcessorState; state: CoreProcessorState }
    | undefined;
  for (const event of events) {
    const previousState = state;
    const breaker = state.circuitBreaker;
    const elapsedMs =
      breaker.lastRefillAtMs === null ? 0 : Math.max(0, timestampMs - breaker.lastRefillAtMs);
    const availableTokens =
      Math.min(
        breaker.burstCapacity,
        breaker.availableTokens + elapsedMs * (breaker.refillRatePerMinute / 60_000),
      ) - 1;
    state = {
      ...state,
      eventCount: state.eventCount + 1,
      maxOffset: event.offset,
      circuitBreaker: {
        ...breaker,
        availableTokens,
        lastRefillAtMs: timestampMs,
        trippedAtOffset:
          availableTokens < 0 && !state.paused && breaker.trippedAtOffset === null
            ? event.offset
            : breaker.trippedAtOffset,
      },
    };
    if (
      tripped === undefined &&
      state.circuitBreaker.trippedAtOffset === event.offset &&
      previousState.circuitBreaker.trippedAtOffset !== event.offset
    ) {
      tripped = { event, previousState, state };
    }
  }
  return { state, ...(tripped === undefined ? {} : { tripped }) };
}
