import type { Stream } from "@iterate-com/streams/workers/durable-objects/stream";
import type {
  StreamEvent as NewStreamEvent,
  StreamEventInput as NewStreamEventInput,
} from "@iterate-com/streams/shared/event";
import type { StreamRpc } from "@iterate-com/streams/types";
import {
  DEFAULT_CIRCUIT_BREAKER_BURST_CAPACITY,
  DEFAULT_CIRCUIT_BREAKER_REFILL_RATE_PER_MINUTE,
} from "@iterate-com/streams/processors/circuit-breaker/contract";
import type {
  Event,
  EventInput,
  StreamState,
  StreamCursor,
} from "@iterate-com/shared/streams/types";
import { StreamPath } from "@iterate-com/shared/streams/types";

export type StreamDurableObject = Stream;
export type StreamDurableObjectNamespace = DurableObjectNamespace<Stream>;

export type StreamDurableObjectStructuredName = {
  namespace: string;
  path: StreamPath;
};

export type InitializedStreamStub = {
  append(input: EventInput): Promise<Event>;
  appendBatch(input: EventInput[]): Promise<Event[]>;
  getState(): Promise<StreamState>;
  history(input?: { after?: StreamCursor; before?: StreamCursor }): Promise<Event[]>;
  stream(input?: {
    after?: StreamCursor;
    before?: StreamCursor;
  }): Promise<ReadableStream<Uint8Array>>;
};

export function getStreamDurableObjectName(input: StreamDurableObjectStructuredName) {
  return `${input.namespace}:${input.path}`;
}

export async function getInitializedStreamStub(input: {
  durableObjectNamespace: StreamDurableObjectNamespace;
  namespace: string;
  path: StreamPath;
}): Promise<InitializedStreamStub> {
  const path = input.path;
  const stub = input.durableObjectNamespace.getByName(
    getStreamDurableObjectName({ namespace: input.namespace, path }),
  ) as unknown as StreamRpc;

  return {
    async append(event) {
      return toLegacyEvent(
        await stub.append({
          event: toNewEventInput(event),
        }),
        path,
      );
    },
    async appendBatch(events) {
      return (
        await stub.appendBatch({
          events: events.map((event) => toNewEventInput(event)),
        })
      ).map((event) => toLegacyEvent(event, path));
    },
    async getState() {
      return toLegacyStreamState(await stub.runtimeState());
    },
    async history(query = {}) {
      const events = await stub.getEvents({
        afterOffset: toNewAfterOffset(query.after),
        beforeOffset: toNewBeforeOffset(query.before),
      });
      return events.map((event) => toLegacyEvent(event, path));
    },
    async stream(query = {}) {
      const events = await stub.getEvents({
        afterOffset: toNewAfterOffset(query.after),
        beforeOffset: toNewBeforeOffset(query.before),
      });
      return eventsToNdjsonStream(events.map((event) => toLegacyEvent(event, path)));
    },
  };
}

function toLegacyStreamState(
  runtimeState: Awaited<ReturnType<StreamRpc["runtimeState"]>>,
): StreamState {
  const core = runtimeState.coreProcessorState;
  return {
    namespace: core.namespace,
    path: StreamPath.parse(core.path),
    eventCount: core.eventCount,
    childPaths: core.childPaths.map((childPath: string) => StreamPath.parse(childPath)),
    descendantPaths: core.descendantPaths.map((descendantPath: string) =>
      StreamPath.parse(descendantPath),
    ),
    metadata: core.metadata as StreamState["metadata"],
    processors: {
      "circuit-breaker": {
        paused: core.paused,
        pauseReason: core.pauseReason,
        pausedAt: null,
        config: {
          burstCapacity: DEFAULT_CIRCUIT_BREAKER_BURST_CAPACITY,
          refillRatePerMinute: DEFAULT_CIRCUIT_BREAKER_REFILL_RATE_PER_MINUTE,
        },
        availableTokens: DEFAULT_CIRCUIT_BREAKER_BURST_CAPACITY,
        lastRefillAtMs: null,
      },
      "external-subscriber": {
        subscribersBySlug: Object.fromEntries(
          Object.entries(core.subscriptionsByKey).map(([key]) => [
            key,
            {
              slug: key,
              type: "callable",
              callable: {},
            },
          ]),
        ) as StreamState["processors"]["external-subscriber"]["subscribersBySlug"],
      },
    },
  };
}

export function toLegacyEvent(event: NewStreamEvent, streamPath: StreamPath): Event {
  return {
    ...event,
    streamPath,
  } as Event;
}

export function toNewEventInput(event: EventInput): NewStreamEventInput {
  const { offset, ...rest } = event as EventInput & { offset?: number };
  return {
    ...rest,
    ...(offset == null ? {} : { offset }),
  } as NewStreamEventInput;
}

export function toNewAfterOffset(cursor: StreamCursor | undefined): number | undefined {
  if (cursor == null || cursor === "start") return 0;
  if (cursor === "end") return Number.MAX_SAFE_INTEGER;
  return cursor;
}

function toNewBeforeOffset(cursor: StreamCursor | undefined): number | null | undefined {
  if (cursor == null || cursor === "end") return null;
  if (cursor === "start") return 1;
  return cursor;
}

function eventsToNdjsonStream(events: Event[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const event of events) {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      }
      controller.close();
    },
  });
}
