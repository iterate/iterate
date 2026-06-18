import type { StreamEvent, StreamEventInput } from "@iterate-com/shared/streams/stream-event";
import type { Event, EventInput, StreamCursor } from "@iterate-com/shared/streams/types";
import { StreamPath, StreamState } from "@iterate-com/shared/streams/types";
import { formatDurableObjectName } from "../durable-object-names.ts";
import type { StreamRpc } from "~/domains/streams/engine/types.ts";
import type { Stream } from "~/domains/streams/engine/workers/durable-objects/stream.ts";

export type StreamDurableObject = Stream;
export type StreamDurableObjectNamespace = DurableObjectNamespace<Stream>;

export type StreamDurableObjectName = {
  projectId: string | null;
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

export function getStreamDurableObjectName(input: StreamDurableObjectName) {
  return formatDurableObjectName({ path: input.path, projectId: input.projectId });
}

export function getStreamRpcStub(input: {
  durableObjectNamespace: StreamDurableObjectNamespace;
  projectId: string | null;
  path: StreamPath;
}): StreamRpc {
  return input.durableObjectNamespace.getByName(
    getStreamDurableObjectName({ projectId: input.projectId, path: input.path }),
  ) as unknown as StreamRpc;
}

export async function getInitializedStreamStub(input: {
  durableObjectNamespace: StreamDurableObjectNamespace;
  projectId: string | null;
  path: StreamPath;
}): Promise<InitializedStreamStub> {
  const path = input.path;
  const stub = getStreamRpcStub(input);

  return {
    async append(event) {
      return withStreamPath(
        await stub.append({
          event: toStreamEventInput(event),
        }),
        path,
      );
    },
    async appendBatch(events) {
      return (
        await stub.appendBatch({
          events: events.map((event) => toStreamEventInput(event)),
        })
      ).map((event) => withStreamPath(event, path));
    },
    async getState() {
      return toStreamState(await stub.runtimeState());
    },
    async history(query = {}) {
      const events = await stub.getEvents({
        afterOffset: toAfterOffset(query.after),
        beforeOffset: toBeforeOffset(query.before),
      });
      return events.map((event) => withStreamPath(event, path));
    },
    async stream(query = {}) {
      const events = await stub.getEvents({
        afterOffset: toAfterOffset(query.after),
        beforeOffset: toBeforeOffset(query.before),
      });
      return eventsToNdjsonStream(events.map((event) => withStreamPath(event, path)));
    },
  };
}

/**
 * Project the Stream Durable Object's core reduced state onto the public
 * {@link StreamState} contract. Parsed (not cast) so the contract and this
 * projection can never silently drift apart — a past version fabricated a
 * "legacy" processors payload behind `as` casts that the schema rejected at
 * runtime, which broke every stream navigation UI.
 *
 * This is THE projection: `getState()` and the `state` carried on every
 * subscription batch both go through it, so subscribe-state and
 * getState-state are the same shape by construction.
 */
export function coreStateToStreamState(
  core: Awaited<ReturnType<StreamRpc["runtimeState"]>>["coreProcessorState"],
): StreamState {
  return StreamState.parse({
    projectId: core.projectId,
    path: core.path,
    eventCount: core.eventCount,
    childPaths: core.childPaths,
    metadata: core.metadata,
  });
}

export function toStreamState(
  runtimeState: Awaited<ReturnType<StreamRpc["runtimeState"]>>,
): StreamState {
  return coreStateToStreamState(runtimeState.coreProcessorState);
}

export function withStreamPath(event: StreamEvent, streamPath: StreamPath): Event {
  return {
    ...event,
    streamPath,
  } as Event;
}

export function toStreamEventInput(event: EventInput): StreamEventInput {
  const { offset, ...rest } = event as EventInput & { offset?: number };
  return {
    ...rest,
    ...(offset == null ? {} : { offset }),
  } as StreamEventInput;
}

export function toAfterOffset(cursor: StreamCursor | undefined): number | undefined {
  if (cursor == null || cursor === "start") return 0;
  if (cursor === "end") return Number.MAX_SAFE_INTEGER;
  return cursor;
}

function toBeforeOffset(cursor: StreamCursor | undefined): number | null | undefined {
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
