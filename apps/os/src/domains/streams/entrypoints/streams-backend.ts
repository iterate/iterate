import { WorkerEntrypoint } from "cloudflare:workers";
import {
  type Event,
  type EventInput,
  type StreamCursor,
  StreamPath,
} from "@iterate-com/shared/streams/types";
import type { StreamEvent, StreamEventInput } from "~/domains/streams/engine/shared/event.ts";
import { createStreamSubscription } from "~/domains/streams/engine/subscription.ts";
import type { StreamRpc, StreamSubscriptionHandle } from "~/domains/streams/engine/types.ts";
import { ItxError } from "~/itx/errors.ts";
import {
  getStreamDurableObjectName,
  getInitializedStreamStub,
  withStreamPath,
  toAfterOffset,
  type StreamDurableObjectNamespace,
  type StreamDurableObject,
} from "~/domains/streams/stream-runtime.ts";

type StreamsBackendEnv = {
  STREAM: DurableObjectNamespace<StreamDurableObject>;
};

export type StreamAppendPolicy =
  | { mode: "none" }
  | { mode: "stream" }
  | { mode: "children" }
  | { mode: "any" }
  | { mode: "pattern"; pattern: string };

export type StreamsBackendProps = {
  appendMetadata?: Record<string, unknown>;
  appendPolicy?: StreamAppendPolicy;
  projectId: string | null;
  streamPath?: string;
};

export type StreamPathInput = {
  streamPath?: string;
};

export type StreamAppendInput = StreamPathInput & {
  event: StreamEventInput;
};

export type StreamAppendBatchInput = StreamPathInput & {
  events: StreamEventInput[];
};

export type StreamReadInput = StreamPathInput & {
  afterOffset?: StreamCursor;
  beforeOffset?: StreamCursor;
};

type StreamEventsInput = StreamPathInput & {
  afterOffset?: StreamCursor;
  beforeOffset?: StreamCursor;
};

export type StreamGetEventInput = StreamPathInput & Parameters<StreamRpc["getEvent"]>[0];
export type StreamGetEventsInput = StreamPathInput &
  NonNullable<Parameters<StreamRpc["getEvents"]>[0]>;
export type StreamWaitForEventInput = StreamPathInput & Parameters<StreamRpc["waitForEvent"]>[0];
export type StreamSubscribeInput = StreamPathInput & Parameters<StreamRpc["subscribe"]>[0];
export type StreamSubscribeBatch = Parameters<StreamSubscribeInput["processEventBatch"]>[0];
export type StreamReduceInput = StreamPathInput & Parameters<StreamRpc["reduce"]>[0];
export type StreamGetProcessorRuntimeStateInput = StreamPathInput &
  Parameters<StreamRpc["getProcessorRuntimeState"]>[0];

export type StreamListChildrenInput = StreamPathInput;
type StreamsBackendClient = Pick<
  StreamsBackend,
  | "append"
  | "appendBatch"
  | "create"
  | "getEvent"
  | "getEvents"
  | "getProcessorRuntimeState"
  | "getState"
  | "kill"
  | "listChildren"
  | "read"
  | "reduce"
  | "reset"
  | "runtimeState"
  | "stream"
  | "subscribe"
  | "waitForEvent"
>;

/**
 * Capability-based stream access for OS code that needs to read or append
 * project-owned events. The only ambient authority is the `STREAM` Durable Object namespace
 * binding; callers receive a narrowed Cloudflare WorkerEntrypoint binding with
 * props such as `projectId` and optional `streamPath`.
 *
 * This is an example of Cloudflare Workers capability-based security: instead
 * of passing a global Events URL/client around, OS passes a capability whose
 * props determine what the holder can do. In future, read and write policy for
 * streams will be expressed in these props.
 */
export class StreamsBackend extends WorkerEntrypoint<StreamsBackendEnv, StreamsBackendProps> {
  async append(input: StreamAppendInput): Promise<Event> {
    const path = this.resolveProjectPath(input);
    this.assertMayAppend(path);

    const event = await appendProjectStreamEvent({
      durableObjectNamespace: this.env.STREAM,
      path,
      projectId: this.ctx.props.projectId,
      event: {
        ...input.event,
        metadata: {
          ...(input.event.metadata ?? {}),
          ...(this.ctx.props.appendMetadata ?? {}),
        },
      } as EventInput,
    });
    return event;
  }

  async appendBatch(input: StreamAppendBatchInput): Promise<Event[]> {
    const path = this.resolveProjectPath(input);
    this.assertMayAppend(path);
    return await appendProjectStreamEventBatch({
      durableObjectNamespace: this.env.STREAM,
      path,
      projectId: this.ctx.props.projectId,
      events: input.events.map(
        (event) =>
          ({
            ...event,
            metadata: {
              ...(event.metadata ?? {}),
              ...(this.ctx.props.appendMetadata ?? {}),
            },
          }) as EventInput,
      ),
    });
  }

  async create(input: StreamPathInput) {
    return await getProjectStreamState({
      durableObjectNamespace: this.env.STREAM,
      path: this.resolveProjectPath(input),
      projectId: this.ctx.props.projectId,
    });
  }

  async read(input: StreamReadInput = {}): Promise<Event[]> {
    return await readProjectStreamEvents({
      durableObjectNamespace: this.env.STREAM,
      path: this.resolveProjectPath(input),
      projectId: this.ctx.props.projectId,
      afterOffset: input.afterOffset,
      beforeOffset: input.beforeOffset ?? "end",
    });
  }

  async getEvent(input: StreamGetEventInput): Promise<StreamEvent | undefined> {
    return await projectStreamRpc({
      durableObjectNamespace: this.env.STREAM,
      path: this.resolveProjectPath(input),
      projectId: this.ctx.props.projectId,
    }).getEvent(input);
  }

  async getEvents(input: StreamGetEventsInput = {}): Promise<StreamEvent[]> {
    return await projectStreamRpc({
      durableObjectNamespace: this.env.STREAM,
      path: this.resolveProjectPath(input),
      projectId: this.ctx.props.projectId,
    }).getEvents({
      afterOffset: input.afterOffset,
      beforeOffset: input.beforeOffset,
      limit: input.limit,
    });
  }

  async stream(input: StreamEventsInput = {}): Promise<Response> {
    const path = this.resolveProjectPath(input);
    const events =
      input.beforeOffset != null && input.beforeOffset !== "end"
        ? streamProjectStreamEvents({
            durableObjectNamespace: this.env.STREAM,
            path,
            projectId: this.ctx.props.projectId,
            afterOffset: input.afterOffset,
            beforeOffset: input.beforeOffset,
          })
        : liveProjectStreamEvents({
            durableObjectNamespace: this.env.STREAM,
            path,
            projectId: this.ctx.props.projectId,
            afterOffset: input.afterOffset,
          });

    return new Response(eventsToNdjsonStream(events), {
      headers: {
        "content-type": "application/x-ndjson",
        "cache-control": "no-cache",
      },
    });
  }

  /**
   * Exact public Stream DO RPC subscribe shape, with this backend only
   * resolving project/path and retaining the callback across the boundary.
   */
  async subscribe(input: StreamSubscribeInput): Promise<{ unsubscribe(): void }> {
    const path = this.resolveProjectPath(input);
    const streamStub = (this.env.STREAM as unknown as StreamDurableObjectNamespace).getByName(
      getStreamDurableObjectName({ projectId: this.ctx.props.projectId, path }),
    ) as unknown as StreamRpc;

    // RPC param stubs are implicitly disposed when this call completes; the
    // wrapper below outlives it, so retain the callback with dup() (no-op
    // for plain in-process functions) and release it on unsubscribe.
    const onEventBatch = input.processEventBatch;
    const callback = (onEventBatch as { dup?(): typeof onEventBatch }).dup?.() ?? onEventBatch;
    let released = false;
    const releaseCallback = () => {
      if (released) return;
      released = true;
      (callback as Partial<Disposable>)[Symbol.dispose]?.();
    };

    // Replay batches can arrive while subscribe() is still in flight — if the
    // callback breaks during that window, tear down as soon as the handle
    // exists rather than leaking deliveries to a dead stub.
    let handle: StreamSubscriptionHandle | undefined;
    let callbackBroken = false;
    const teardown = () => {
      callbackBroken = true;
      handle?.unsubscribe();
      releaseCallback();
    };
    handle = await streamStub.subscribe({
      events: input.events,
      processEventBatch: (batch) => {
        void Promise.resolve()
          .then(() => callback(batch))
          .catch(teardown);
      },
      replayAfterOffset: input.replayAfterOffset,
      eventTypes: input.eventTypes,
      subscriber: input.subscriber,
    });
    if (callbackBroken) handle.unsubscribe();
    const settled = handle;
    return {
      unsubscribe: () => {
        settled.unsubscribe();
        releaseCallback();
      },
    };
  }

  async waitForEvent(input: StreamWaitForEventInput): Promise<StreamEvent> {
    const path = this.resolveProjectPath(input);
    const streamStub = (this.env.STREAM as unknown as StreamDurableObjectNamespace).getByName(
      getStreamDurableObjectName({ projectId: this.ctx.props.projectId, path }),
    ) as unknown as StreamRpc;

    return await streamStub.waitForEvent({
      afterOffset: input.afterOffset,
      eventTypes: input.eventTypes,
      timeoutMs: input.timeoutMs,
      predicate: input.predicate,
    });
  }

  async getState(input: StreamPathInput = {}) {
    return await getProjectStreamState({
      durableObjectNamespace: this.env.STREAM,
      path: this.resolveProjectPath(input),
      projectId: this.ctx.props.projectId,
    });
  }

  async listChildren(input: StreamListChildrenInput = {}) {
    const path = this.resolveProjectPath(input);
    const state = await getProjectStreamState({
      durableObjectNamespace: this.env.STREAM,
      path,
      projectId: this.ctx.props.projectId,
    });
    return state.childPaths
      .map((childPath) => ({
        path: StreamPath.parse(childPath),
        createdAt: new Date(0).toISOString(),
      }))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async runtimeState(input: StreamPathInput = {}) {
    return await projectStreamRpc({
      durableObjectNamespace: this.env.STREAM,
      projectId: this.ctx.props.projectId,
      path: this.resolveProjectPath(input),
    }).runtimeState();
  }

  async getProcessorRuntimeState(input: StreamGetProcessorRuntimeStateInput) {
    return await projectStreamRpc({
      durableObjectNamespace: this.env.STREAM,
      projectId: this.ctx.props.projectId,
      path: this.resolveProjectPath(input),
    }).getProcessorRuntimeState({
      subscriptionKey: input.subscriptionKey,
    });
  }

  async reduce(input: StreamReduceInput) {
    return await projectStreamRpc({
      durableObjectNamespace: this.env.STREAM,
      projectId: this.ctx.props.projectId,
      path: this.resolveProjectPath(input),
    }).reduce({
      event: input.event,
      coreProcessorState: input.coreProcessorState,
    });
  }

  async kill(input: StreamPathInput = {}) {
    return await projectStreamRpc({
      durableObjectNamespace: this.env.STREAM,
      projectId: this.ctx.props.projectId,
      path: this.resolveProjectPath(input),
    }).kill();
  }

  async reset(input: StreamPathInput = {}) {
    return await projectStreamRpc({
      durableObjectNamespace: this.env.STREAM,
      projectId: this.ctx.props.projectId,
      path: this.resolveProjectPath(input),
    }).reset();
  }

  private resolveProjectPath(input: StreamPathInput): StreamPath {
    return resolveCapabilityStreamPath({
      basePath: this.ctx.props.streamPath,
      pathInput: input.streamPath,
    });
  }

  private assertMayAppend(path: StreamPath) {
    const policy: StreamAppendPolicy =
      this.ctx.props.appendPolicy ??
      (this.ctx.props.streamPath ? { mode: "stream" } : { mode: "any" });
    if (canAppend({ path, policy, streamPath: this.ctx.props.streamPath })) {
      return;
    }

    // FORBIDDEN, not NOT_FOUND: the caller already holds this capability, so
    // the stream's existence is not a secret — only the append right is.
    throw new ItxError({
      code: "FORBIDDEN",
      details: { path, policyMode: policy.mode },
      message: `Stream append policy rejected append to ${path}.`,
    });
  }
}

export function getStreamsBackend(input: {
  exports: Pick<Cloudflare.Exports, "StreamsBackend"> | undefined;
  props: StreamsBackendProps;
}): StreamsBackendClient {
  if (!input.exports) {
    throw new Error("StreamsBackend export is not available.");
  }

  // Keep this as the only narrowing point for StreamsBackend loopback use.
  // `input.exports` is still Cloudflare.Exports, so export-name drift is caught
  // at this property access. Assigning Cloudflare's full RPC loopback stub type
  // directly to a local function currently makes TypeScript expand the whole
  // Worker export graph and fail with TS2589. The public surface we need here is
  // intentionally smaller than the full Fetcher/RPC stub: construct the
  // capability with props, then call its stream methods.
  const streamsCapability = input.exports.StreamsBackend as unknown as (options: {
    props: StreamsBackendProps;
  }) => StreamsBackendClient;

  return streamsCapability({ props: input.props });
}

export function resolveStreamPath(pathInput: string): StreamPath {
  const trimmedPath = pathInput.trim();
  if (!trimmedPath) {
    throw new ItxError({ code: "BAD_REQUEST", message: "Stream path is required." });
  }

  const path = trimmedPath.startsWith("/") ? trimmedPath : `/${trimmedPath}`;
  return StreamPath.parse(path);
}

function resolveCapabilityStreamPath(input: { basePath?: string; pathInput?: string }): StreamPath {
  if (input.pathInput == null) {
    if (input.basePath == null) {
      throw new ItxError({ code: "BAD_REQUEST", message: "Stream path is required." });
    }

    return resolveStreamPath(input.basePath);
  }

  const trimmedPath = input.pathInput.trim();
  if (!trimmedPath) {
    throw new ItxError({ code: "BAD_REQUEST", message: "Stream path is required." });
  }

  if (trimmedPath.startsWith("/")) {
    return resolveStreamPath(trimmedPath);
  }

  if (input.basePath == null) {
    return resolveStreamPath(trimmedPath);
  }

  const basePath = resolveStreamPath(input.basePath);
  const relativePath = trimmedPath.replace(/^\.\//, "").replace(/^\/+/, "");
  return StreamPath.parse(basePath === "/" ? `/${relativePath}` : `${basePath}/${relativePath}`);
}

function canAppend(input: { path: StreamPath; policy: StreamAppendPolicy; streamPath?: string }) {
  switch (input.policy.mode) {
    case "none":
      return false;
    case "stream":
      return input.streamPath != null && input.path === resolveStreamPath(input.streamPath);
    case "children": {
      if (input.streamPath == null) return false;
      const streamPath = resolveStreamPath(input.streamPath);
      return input.path === streamPath || input.path.startsWith(`${streamPath}/`);
    }
    case "any":
      return true;
    case "pattern":
      return globMatchesPath(input.policy.pattern, input.path);
  }
}

function globMatchesPath(pattern: string, path: string) {
  const source = pattern
    .split("**")
    .map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, "\\$&").replace(/\*/g, "[^/]*"))
    .join(".*");
  return new RegExp(`^${source}$`).test(path);
}

async function getInitializedProjectStreamStub(args: {
  durableObjectNamespace: DurableObjectNamespace<StreamDurableObject>;
  projectId: string | null;
  path: StreamPath;
}) {
  return await getInitializedStreamStub({
    durableObjectNamespace: args.durableObjectNamespace as unknown as StreamDurableObjectNamespace,
    projectId: args.projectId,
    path: args.path,
  });
}

function projectStreamRpc(args: {
  durableObjectNamespace: DurableObjectNamespace<StreamDurableObject>;
  projectId: string | null;
  path: StreamPath;
}) {
  return (args.durableObjectNamespace as unknown as StreamDurableObjectNamespace).getByName(
    getStreamDurableObjectName({ projectId: args.projectId, path: args.path }),
  ) as unknown as StreamRpc;
}

async function appendProjectStreamEvent(args: {
  durableObjectNamespace: DurableObjectNamespace<StreamDurableObject>;
  projectId: string | null;
  path: StreamPath;
  event: EventInput;
}) {
  const stub = await getInitializedProjectStreamStub(args);
  return await stub.append(args.event);
}

async function appendProjectStreamEventBatch(args: {
  durableObjectNamespace: DurableObjectNamespace<StreamDurableObject>;
  projectId: string | null;
  path: StreamPath;
  events: EventInput[];
}) {
  const stub = await getInitializedProjectStreamStub(args);
  return await stub.appendBatch(args.events);
}

async function readProjectStreamEvents(args: {
  durableObjectNamespace: DurableObjectNamespace<StreamDurableObject>;
  projectId: string | null;
  path: StreamPath;
  afterOffset?: StreamCursor;
  beforeOffset?: StreamCursor;
}) {
  const stub = await getInitializedProjectStreamStub(args);
  return await stub.history({
    after: args.afterOffset,
    before: args.beforeOffset ?? "end",
  });
}

async function getProjectStreamState(args: {
  durableObjectNamespace: DurableObjectNamespace<StreamDurableObject>;
  projectId: string | null;
  path: StreamPath;
}) {
  const stub = await getInitializedProjectStreamStub(args);
  return await stub.getState();
}

async function* streamProjectStreamEvents(args: {
  durableObjectNamespace: DurableObjectNamespace<StreamDurableObject>;
  projectId: string | null;
  path: StreamPath;
  afterOffset?: StreamCursor;
  beforeOffset?: StreamCursor;
}) {
  const stub = await getInitializedProjectStreamStub(args);
  const stream = await stub.stream({
    after: args.afterOffset,
    before: args.beforeOffset,
  });
  yield* decodeStreamEventLines(stream);
}

async function* liveProjectStreamEvents(args: {
  durableObjectNamespace: DurableObjectNamespace<StreamDurableObject>;
  projectId: string | null;
  path: StreamPath;
  afterOffset?: StreamCursor;
}) {
  const streamStub = (
    args.durableObjectNamespace as unknown as StreamDurableObjectNamespace
  ).getByName(
    getStreamDurableObjectName({
      projectId: args.projectId,
      path: args.path,
    }),
  ) as unknown as StreamRpc;
  let handle: { unsubscribe(): void } | undefined;
  await using subscription = createStreamSubscription({
    onDispose: () => handle?.unsubscribe(),
  });
  handle = await streamStub.subscribe({
    processEventBatch: subscription.processEventBatch,
    replayAfterOffset: toAfterOffset(args.afterOffset),
    subscriber: { description: "streams-backend" },
  });

  for await (const batch of subscription) {
    for (const event of batch.events) {
      yield withStreamPath(event, args.path);
    }
  }
}

function eventsToNdjsonStream(events: AsyncIterable<Event>) {
  let iterator: AsyncIterator<Event> | undefined;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      iterator = events[Symbol.asyncIterator]();
      try {
        while (true) {
          const result = await iterator.next();
          if (result.done) break;
          controller.enqueue(encoder.encode(`${JSON.stringify(result.value)}\n`));
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator?.return?.();
    },
  });
}

async function* decodeStreamEventLines(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      while (true) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) break;
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.trim()) yield JSON.parse(line) as Event;
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) yield JSON.parse(buffer) as Event;
  } finally {
    reader.releaseLock();
  }
}
