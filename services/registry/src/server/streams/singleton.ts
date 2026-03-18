import type {
  EventStreamEvent,
  EventStreamSummary,
  PushSubscriptionCallbackAddedPayload,
} from "@iterate-com/registry-contract";
import {
  IterateEventType,
  PUSH_SUBSCRIPTION_CALLBACK_ADDED_TYPE,
} from "@iterate-com/registry-contract";
import { Effect, Schema, Stream } from "effect";
import {
  Event,
  EventInput,
  EventType,
  Offset,
  StreamPath,
  Version,
} from "../../../../events/effect-stream-manager/domain.ts";
import type { StreamManager as StreamManagerService } from "../../../../events/effect-stream-manager/services/stream-manager/service.ts";
import type { RegistryEnv } from "../context.ts";
import { createRegistryStreamsRuntime } from "./runtime.ts";

type StreamManager = StreamManagerService["Type"];

type StreamManagerEnv = Pick<
  RegistryEnv,
  "REGISTRY_DB_PATH" | "REGISTRY_STREAMS_WS_IDLE_DISCONNECT_MS"
>;

const toDomainPath = (path: string): StreamPath =>
  StreamPath.make(path.startsWith("/") ? path.slice(1) : path);

const encodeEvent = Schema.encodeSync(Event);

const toContractEvent = (event: Event): EventStreamEvent => {
  const encoded = encodeEvent(event);
  return {
    path: encoded.path,
    offset: encoded.offset,
    type: IterateEventType.parse(String(encoded.type)),
    payload: encoded.payload,
    version: encoded.version,
    createdAt: encoded.createdAt,
    trace: {
      traceId: encoded.trace.traceId,
      spanId: encoded.trace.spanId,
      parentSpanId: encoded.trace.parentSpanId,
    },
  };
};

const toContractStreamSummary = (stream: {
  readonly path: string;
  readonly createdAt: string;
  readonly eventCount: number;
  readonly lastEventCreatedAt: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}): EventStreamSummary => ({
  path: stream.path.startsWith("/") ? stream.path : `/${stream.path}`,
  createdAt: stream.createdAt,
  eventCount: stream.eventCount,
  lastEventCreatedAt: stream.lastEventCreatedAt,
  metadata: { ...stream.metadata },
});

type ContractEventInput = {
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly version?: string | number | undefined;
};

export interface EventOperations {
  readonly appendEvents: (input: {
    readonly path: string;
    readonly events: ReadonlyArray<ContractEventInput>;
  }) => Promise<void>;
  readonly appendSubscriptionRegistration: (input: {
    readonly path: string;
    readonly subscription: PushSubscriptionCallbackAddedPayload;
  }) => Promise<void>;
  readonly acknowledgeOffset: (input: {
    readonly path: string;
    readonly subscriptionSlug: string;
    readonly offset: string;
  }) => Promise<void>;
  readonly streamEvents: (
    input: {
      readonly path: string;
      readonly offset?: string | undefined;
      readonly live?: boolean | undefined;
    },
    signal?: AbortSignal,
  ) => AsyncGenerator<EventStreamEvent>;
  readonly firehoseEvents: (signal?: AbortSignal) => AsyncGenerator<EventStreamEvent>;
  readonly listStreams: () => Promise<Array<EventStreamSummary>>;
}

const createOperations = (manager: StreamManager): EventOperations => ({
  async appendEvents(input) {
    for (const eventInput of input.events) {
      const event = EventInput.make({
        type: EventType.make(eventInput.type),
        payload: eventInput.payload,
        ...(eventInput.version !== undefined
          ? { version: Version.make(String(eventInput.version)) }
          : {}),
      });

      await Effect.runPromise(manager.append({ path: toDomainPath(input.path), event }));
    }
  },

  async appendSubscriptionRegistration(input) {
    const event = EventInput.make({
      type: EventType.make(PUSH_SUBSCRIPTION_CALLBACK_ADDED_TYPE),
      payload: input.subscription,
    });

    await Effect.runPromise(manager.append({ path: toDomainPath(input.path), event }));
  },

  acknowledgeOffset: (input) =>
    Effect.runPromise(
      manager.ackOffset({
        path: toDomainPath(input.path),
        subscriptionSlug: input.subscriptionSlug,
        offset: Offset.make(input.offset),
      }),
    ),

  async *streamEvents(input, signal) {
    const path = toDomainPath(input.path);
    const from = input.offset !== undefined ? Offset.make(input.offset) : undefined;

    const source = input.live
      ? manager.subscribe({ path, ...(from !== undefined ? { from } : {}) })
      : manager.read({ path, ...(from !== undefined ? { from } : {}) });

    const iterator = Stream.toAsyncIterable(source.pipe(Stream.map(toContractEvent)))[
      Symbol.asyncIterator
    ]();

    const onAbort = () => {
      void iterator.return?.();
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      while (!signal?.aborted) {
        const result = await iterator.next();
        if (result.done) return;
        yield result.value;
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      await iterator.return?.();
    }
  },

  async *firehoseEvents(signal) {
    const iterator = Stream.toAsyncIterable(
      manager.subscribe({}).pipe(Stream.map(toContractEvent)),
    )[Symbol.asyncIterator]();

    const onAbort = () => {
      void iterator.return?.();
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      while (!signal?.aborted) {
        const result = await iterator.next();
        if (result.done) return;
        yield result.value;
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      await iterator.return?.();
    }
  },

  async listStreams() {
    const streams = await Effect.runPromise(manager.listStreams());
    return streams.map((stream) =>
      toContractStreamSummary({
        path: String(stream.path),
        createdAt: stream.createdAt,
        eventCount: stream.eventCount,
        lastEventCreatedAt: stream.lastEventCreatedAt,
        metadata: stream.metadata,
      }),
    );
  },
});

interface RuntimeEntry {
  promise: Promise<{ operations: EventOperations; dispose: () => Promise<void> }>;
  count: number;
}

const runtimeEntries = new Map<string, RuntimeEntry>();

const envKey = (env: StreamManagerEnv): string =>
  `${env.REGISTRY_DB_PATH}::${env.REGISTRY_STREAMS_WS_IDLE_DISCONNECT_MS}`;

const getOrCreateEntry = (env: StreamManagerEnv): RuntimeEntry => {
  const key = envKey(env);
  const existing = runtimeEntries.get(key);
  if (existing !== undefined) return existing;

  const entry: RuntimeEntry = {
    promise: createRegistryStreamsRuntime({ env }).then((result) => ({
      operations: createOperations(result.manager),
      dispose: result.dispose,
    })),
    count: 0,
  };
  runtimeEntries.set(key, entry);
  return entry;
};

const forceDispose = async (key: string, entry: RuntimeEntry): Promise<void> => {
  runtimeEntries.delete(key);
  const { dispose } = await entry.promise;
  await dispose();
};

export const getEventOperations = async (env: RegistryEnv): Promise<EventOperations> => {
  const key = envKey(env);
  const entry = getOrCreateEntry(env);
  entry.count += 1;
  try {
    const { operations } = await entry.promise;
    return operations;
  } catch (error) {
    entry.count -= 1;
    if (entry.count <= 0 && runtimeEntries.get(key) === entry) {
      runtimeEntries.delete(key);
    }
    throw error;
  }
};

export const disposeEventOperations = async (env?: RegistryEnv): Promise<void> => {
  const keys = env === undefined ? Array.from(runtimeEntries.keys()) : [envKey(env)];

  await Promise.allSettled(
    keys.map(async (key) => {
      const entry = runtimeEntries.get(key);
      if (entry === undefined) return;

      entry.count -= 1;
      if (env !== undefined && entry.count > 0) return;
      await forceDispose(key, entry);
    }),
  );
};
