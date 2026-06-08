import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { withStreamConnectionFromWorkers } from "@iterate-com/streams/workers/connect";
import { createStreamSubscription } from "@iterate-com/streams/subscription";
import {
  type Event,
  type EventInput,
  type StreamCursor,
  StreamPath,
} from "@iterate-com/shared/streams/types";
import type { ExecuteCodemodeFunctionCallInput } from "@iterate-com/shared/stream-processors/codemode/implementation";
import {
  getStreamDurableObjectName,
  getInitializedStreamStub,
  toLegacyEvent,
  toNewAfterOffset,
  type StreamDurableObjectNamespace,
  type StreamDurableObject,
} from "~/domains/streams/new-stream-runtime.ts";

type StreamsCapabilityEnv = {
  STREAM: DurableObjectNamespace<StreamDurableObject>;
};

export type StreamAppendPolicy =
  | { mode: "none" }
  | { mode: "stream" }
  | { mode: "children" }
  | { mode: "any" }
  | { mode: "pattern"; pattern: string };

export type StreamsCapabilityProps = {
  appendMetadata?: Record<string, unknown>;
  appendPolicy?: StreamAppendPolicy;
  projectId?: string;
  streamPath?: string;
};

type StreamPathInput = {
  streamPath?: string;
};

type StreamSelectorInput = {
  namespace?: string;
  path: string;
};

type StreamAppendInput = StreamPathInput & {
  event: EventInput;
};

type StreamAppendBatchInput = StreamPathInput & {
  events: EventInput[];
};

type StreamReadInput = StreamPathInput & {
  afterOffset?: StreamCursor;
  beforeOffset?: StreamCursor;
};

type StreamEventsInput = StreamPathInput & {
  afterOffset?: StreamCursor;
  beforeOffset?: StreamCursor;
};

type StreamListChildrenInput = StreamPathInput;
type StreamHandleClient = Pick<
  StreamHandle,
  "append" | "appendBatch" | "create" | "getState" | "listChildren" | "read" | "stream"
>;
type StreamsCapabilityClient = Pick<
  StreamsCapability,
  | "append"
  | "appendBatch"
  | "create"
  | "get"
  | "getState"
  | "list"
  | "listChildren"
  | "read"
  | "stream"
>;

/**
 * Capability-based stream access for OS code that needs to read or append
 * namespace-owned events. The only ambient authority is the `STREAM` namespace
 * binding; callers receive a narrowed Cloudflare WorkerEntrypoint binding with
 * props such as `projectId` and optional `streamPath`.
 *
 * This is an example of Cloudflare Workers capability-based security: instead
 * of passing a global Events URL/client around, OS passes a capability whose
 * props determine what the holder can do. In future, read and write policy for
 * streams will be expressed in these props.
 */
export class StreamsCapability extends WorkerEntrypoint<
  StreamsCapabilityEnv,
  StreamsCapabilityProps
> {
  async executeCodemodeFunctionCall(input: ExecuteCodemodeFunctionCallInput) {
    if (input.functionPath.length !== 1 || input.functionPath[0] !== "get") {
      throw new Error(
        `StreamsCapability codemode access requires ctx.streams.get(...), received ${input.functionPath.join(".")}`,
      );
    }

    const [request] = input.args;
    return this.get(readStreamSelectorInput(request));
  }

  get(input: StreamSelectorInput): StreamHandleClient {
    const namespace = this.resolveNamespace(input.namespace);
    const path = resolveCapabilityStreamPath({
      basePath: this.ctx.props.streamPath,
      pathInput: input.path,
    });

    return new StreamHandle({
      appendMetadata: this.ctx.props.appendMetadata,
      appendPolicy: this.ctx.props.appendPolicy,
      durableObjectNamespace: this.env.STREAM,
      namespace,
      path,
      streamPath: this.ctx.props.streamPath,
    });
  }

  async append(input: StreamAppendInput): Promise<Event> {
    const path = this.resolveNamespacePath(input);
    this.assertMayAppend(path);

    const event = await appendNamespaceStreamEvent({
      durableObjectNamespace: this.env.STREAM,
      path,
      namespace: this.requireProjectNamespace(),
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
    const path = this.resolveNamespacePath(input);
    this.assertMayAppend(path);
    return await appendNamespaceStreamEventBatch({
      durableObjectNamespace: this.env.STREAM,
      path,
      namespace: this.requireProjectNamespace(),
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
    return await getNamespaceStreamState({
      durableObjectNamespace: this.env.STREAM,
      path: this.resolveNamespacePath(input),
      namespace: this.requireProjectNamespace(),
    });
  }

  async list() {
    const paths = await listNamespaceStreamPaths({
      durableObjectNamespace: this.env.STREAM,
      namespace: this.requireProjectNamespace(),
    });
    return paths.map((path) => ({
      name: `${this.requireProjectNamespace()}:${path}`,
      namespace: this.requireProjectNamespace(),
      streamPath: StreamPath.parse(path),
      createdAt: new Date(0).toISOString(),
      lastWokenAt: new Date(0).toISOString(),
    }));
  }

  async read(input: StreamReadInput = {}): Promise<Event[]> {
    return await readNamespaceStreamEvents({
      durableObjectNamespace: this.env.STREAM,
      path: this.resolveNamespacePath(input),
      namespace: this.requireProjectNamespace(),
      afterOffset: input.afterOffset,
      beforeOffset: input.beforeOffset ?? "end",
    });
  }

  async stream(input: StreamEventsInput = {}): Promise<Response> {
    const path = this.resolveNamespacePath(input);
    const events =
      input.beforeOffset != null && input.beforeOffset !== "end"
        ? streamNamespaceStreamEvents({
            durableObjectNamespace: this.env.STREAM,
            path,
            namespace: this.requireProjectNamespace(),
            afterOffset: input.afterOffset,
            beforeOffset: input.beforeOffset,
          })
        : liveNamespaceStreamEvents({
            durableObjectNamespace: this.env.STREAM,
            path,
            namespace: this.requireProjectNamespace(),
            afterOffset: input.afterOffset,
          });

    return new Response(eventsToNdjsonStream(events), {
      headers: {
        "content-type": "application/x-ndjson",
        "cache-control": "no-cache",
      },
    });
  }

  async getState(input: StreamPathInput = {}) {
    return await getNamespaceStreamState({
      durableObjectNamespace: this.env.STREAM,
      path: this.resolveNamespacePath(input),
      namespace: this.requireProjectNamespace(),
    });
  }

  async listChildren(input: StreamListChildrenInput = {}) {
    const path = this.resolveNamespacePath(input);
    const state = await getNamespaceStreamState({
      durableObjectNamespace: this.env.STREAM,
      path,
      namespace: this.requireProjectNamespace(),
    });
    return state.childPaths
      .map((childPath) => ({
        path: StreamPath.parse(childPath),
        createdAt: new Date(0).toISOString(),
      }))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  private resolveNamespacePath(input: StreamPathInput): StreamPath {
    return resolveCapabilityStreamPath({
      basePath: this.ctx.props.streamPath,
      pathInput: input.streamPath,
    });
  }

  private resolveNamespace(namespaceInput: string | undefined) {
    const projectId = this.ctx.props.projectId;
    if (projectId != null) {
      if (namespaceInput != null && namespaceInput !== projectId) {
        throw new Error("Project-scoped streams capability cannot cross namespaces.");
      }

      return projectId;
    }

    const namespace = namespaceInput?.trim();
    if (!namespace) {
      throw new Error("Stream namespace is required.");
    }

    return namespace;
  }

  private requireProjectNamespace() {
    return this.resolveNamespace(undefined);
  }

  private assertMayAppend(path: StreamPath) {
    const policy: StreamAppendPolicy =
      this.ctx.props.appendPolicy ??
      (this.ctx.props.streamPath ? { mode: "stream" } : { mode: "any" });
    if (canAppend({ path, policy, streamPath: this.ctx.props.streamPath })) {
      return;
    }

    throw new Error(`Stream append policy rejected append to ${path}.`);
  }
}

class StreamHandle extends RpcTarget {
  readonly #appendMetadata: Record<string, unknown> | undefined;
  readonly #appendPolicy: StreamAppendPolicy | undefined;
  readonly #durableObjectNamespace: DurableObjectNamespace<StreamDurableObject>;
  readonly #namespace: string;
  readonly #path: StreamPath;
  readonly #streamPath: string | undefined;

  constructor(input: {
    appendMetadata?: Record<string, unknown>;
    appendPolicy?: StreamAppendPolicy;
    durableObjectNamespace: DurableObjectNamespace<StreamDurableObject>;
    namespace: string;
    path: StreamPath;
    streamPath?: string;
  }) {
    super();
    this.#appendMetadata = input.appendMetadata;
    this.#appendPolicy = input.appendPolicy;
    this.#durableObjectNamespace = input.durableObjectNamespace;
    this.#namespace = input.namespace;
    this.#path = input.path;
    this.#streamPath = input.streamPath;
  }

  async append(input: Omit<StreamAppendInput, "streamPath">): Promise<Event> {
    this.assertMayAppend();
    return await appendNamespaceStreamEvent({
      durableObjectNamespace: this.#durableObjectNamespace,
      path: this.#path,
      namespace: this.#namespace,
      event: {
        ...input.event,
        metadata: {
          ...(input.event.metadata ?? {}),
          ...(this.#appendMetadata ?? {}),
        },
      } as EventInput,
    });
  }

  async appendBatch(input: Omit<StreamAppendBatchInput, "streamPath">): Promise<Event[]> {
    this.assertMayAppend();
    return await appendNamespaceStreamEventBatch({
      durableObjectNamespace: this.#durableObjectNamespace,
      path: this.#path,
      namespace: this.#namespace,
      events: input.events.map(
        (event) =>
          ({
            ...event,
            metadata: {
              ...(event.metadata ?? {}),
              ...(this.#appendMetadata ?? {}),
            },
          }) as EventInput,
      ),
    });
  }

  async create() {
    return await this.getState();
  }

  async read(input: Omit<StreamReadInput, "streamPath"> = {}): Promise<Event[]> {
    return await readNamespaceStreamEvents({
      durableObjectNamespace: this.#durableObjectNamespace,
      path: this.#path,
      namespace: this.#namespace,
      afterOffset: input.afterOffset,
      beforeOffset: input.beforeOffset ?? "end",
    });
  }

  async stream(input: Omit<StreamEventsInput, "streamPath"> = {}): Promise<Response> {
    const events =
      input.beforeOffset != null && input.beforeOffset !== "end"
        ? streamNamespaceStreamEvents({
            durableObjectNamespace: this.#durableObjectNamespace,
            path: this.#path,
            namespace: this.#namespace,
            afterOffset: input.afterOffset,
            beforeOffset: input.beforeOffset,
          })
        : liveNamespaceStreamEvents({
            durableObjectNamespace: this.#durableObjectNamespace,
            path: this.#path,
            namespace: this.#namespace,
            afterOffset: input.afterOffset,
          });

    return new Response(eventsToNdjsonStream(events), {
      headers: {
        "content-type": "application/x-ndjson",
        "cache-control": "no-cache",
      },
    });
  }

  async getState() {
    return await getNamespaceStreamState({
      durableObjectNamespace: this.#durableObjectNamespace,
      path: this.#path,
      namespace: this.#namespace,
    });
  }

  async listChildren() {
    const state = await this.getState();
    return state.childPaths
      .map((childPath) => ({
        path: StreamPath.parse(childPath),
        createdAt: new Date(0).toISOString(),
      }))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  private assertMayAppend() {
    const policy =
      this.#appendPolicy ?? (this.#streamPath ? { mode: "stream" as const } : { mode: "any" });
    if (canAppend({ path: this.#path, policy, streamPath: this.#streamPath })) {
      return;
    }

    throw new Error(`Stream append policy rejected append to ${this.#path}.`);
  }
}

export function getStreamsCapability(input: {
  exports: Pick<Cloudflare.Exports, "StreamsCapability"> | undefined;
  props: StreamsCapabilityProps;
}): StreamsCapabilityClient {
  if (!input.exports) {
    throw new Error("StreamsCapability export is not available.");
  }

  // Keep this as the only narrowing point for StreamsCapability loopback use.
  // `input.exports` is still Cloudflare.Exports, so export-name drift is caught
  // at this property access. Assigning Cloudflare's full RPC loopback stub type
  // directly to a local function currently makes TypeScript expand the whole
  // Worker export graph and fail with TS2589. The public surface we need here is
  // intentionally smaller than the full Fetcher/RPC stub: construct the
  // capability with props, then call its stream methods.
  const streamsCapability = input.exports.StreamsCapability as unknown as (options: {
    props: StreamsCapabilityProps;
  }) => StreamsCapabilityClient;

  return streamsCapability({ props: input.props });
}

export function resolveStreamPath(pathInput: string): StreamPath {
  const trimmedPath = pathInput.trim();
  if (!trimmedPath) {
    throw new Error("Stream path is required.");
  }

  const path = trimmedPath.startsWith("/") ? trimmedPath : `/${trimmedPath}`;
  return StreamPath.parse(path);
}

function resolveCapabilityStreamPath(input: { basePath?: string; pathInput?: string }): StreamPath {
  if (input.pathInput == null) {
    if (input.basePath == null) {
      throw new Error("Stream path is required.");
    }

    return resolveStreamPath(input.basePath);
  }

  const trimmedPath = input.pathInput.trim();
  if (!trimmedPath) {
    throw new Error("Stream path is required.");
  }

  if (trimmedPath.startsWith("/")) {
    return resolveStreamPath(trimmedPath);
  }

  if (input.basePath == null) {
    return resolveStreamPath(trimmedPath);
  }

  return resolveRelativeStreamPath({
    basePath: resolveStreamPath(input.basePath),
    pathInput: trimmedPath,
  });
}

function resolveRelativeStreamPath(input: { basePath: StreamPath; pathInput: string }): StreamPath {
  const segments = input.basePath.split("/").filter(Boolean);
  for (const segment of input.pathInput.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) {
        throw new Error(
          `Stream path "${input.pathInput}" escapes the stream root (resolved from "${input.basePath}").`,
        );
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  return StreamPath.parse(`/${segments.join("/")}`);
}

function readStreamSelectorInput(value: unknown): StreamSelectorInput {
  if (value == null || typeof value !== "object") {
    throw new Error("Stream selector must be an object.");
  }

  const input = value as Record<string, unknown>;
  if (typeof input.path !== "string") {
    throw new Error("Stream selector requires a string path.");
  }
  if (input.namespace != null && typeof input.namespace !== "string") {
    throw new Error("Stream selector namespace must be a string.");
  }

  return {
    path: input.path,
    ...(typeof input.namespace === "string" ? { namespace: input.namespace } : {}),
  };
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

async function getInitializedNamespaceStreamStub(args: {
  durableObjectNamespace: DurableObjectNamespace<StreamDurableObject>;
  namespace: string;
  path: StreamPath;
}) {
  return await getInitializedStreamStub({
    durableObjectNamespace: args.durableObjectNamespace as unknown as StreamDurableObjectNamespace,
    namespace: args.namespace,
    path: args.path,
  });
}

async function appendNamespaceStreamEvent(args: {
  durableObjectNamespace: DurableObjectNamespace<StreamDurableObject>;
  namespace: string;
  path: StreamPath;
  event: EventInput;
}) {
  const stub = await getInitializedNamespaceStreamStub(args);
  return await stub.append(args.event);
}

async function appendNamespaceStreamEventBatch(args: {
  durableObjectNamespace: DurableObjectNamespace<StreamDurableObject>;
  namespace: string;
  path: StreamPath;
  events: EventInput[];
}) {
  const stub = await getInitializedNamespaceStreamStub(args);
  return await stub.appendBatch(args.events);
}

async function readNamespaceStreamEvents(args: {
  durableObjectNamespace: DurableObjectNamespace<StreamDurableObject>;
  namespace: string;
  path: StreamPath;
  afterOffset?: StreamCursor;
  beforeOffset?: StreamCursor;
}) {
  const stub = await getInitializedNamespaceStreamStub(args);
  return await stub.history({
    after: args.afterOffset,
    before: args.beforeOffset ?? "end",
  });
}

async function getNamespaceStreamState(args: {
  durableObjectNamespace: DurableObjectNamespace<StreamDurableObject>;
  namespace: string;
  path: StreamPath;
}) {
  const stub = await getInitializedNamespaceStreamStub(args);
  return await stub.getState();
}

async function listNamespaceStreamPaths(args: {
  durableObjectNamespace: DurableObjectNamespace<StreamDurableObject>;
  namespace: string;
}) {
  const visited = new Set<string>();
  const paths: StreamPath[] = [];

  async function visit(path: StreamPath) {
    if (visited.has(path)) return;
    visited.add(path);
    paths.push(path);
    const state = await getNamespaceStreamState({
      durableObjectNamespace: args.durableObjectNamespace,
      namespace: args.namespace,
      path,
    });
    for (const childPath of state.childPaths) {
      await visit(StreamPath.parse(childPath));
    }
  }

  await visit(StreamPath.parse("/"));
  return paths;
}

async function* streamNamespaceStreamEvents(args: {
  durableObjectNamespace: DurableObjectNamespace<StreamDurableObject>;
  namespace: string;
  path: StreamPath;
  afterOffset?: StreamCursor;
  beforeOffset?: StreamCursor;
}) {
  const stub = await getInitializedNamespaceStreamStub(args);
  const stream = await stub.stream({
    after: args.afterOffset,
    before: args.beforeOffset,
  });
  yield* decodeStreamEventLines(stream);
}

async function* liveNamespaceStreamEvents(args: {
  durableObjectNamespace: DurableObjectNamespace<StreamDurableObject>;
  namespace: string;
  path: StreamPath;
  afterOffset?: StreamCursor;
}) {
  const streamStub = (
    args.durableObjectNamespace as unknown as StreamDurableObjectNamespace
  ).getByName(
    getStreamDurableObjectName({
      namespace: args.namespace,
      path: args.path,
    }),
  );
  using connection = await withStreamConnectionFromWorkers({
    url: "https://stream.local/",
    fetch: (request) => fetchDurableObjectWebSocket(streamStub, request),
  });
  let handle: { unsubscribe(): void } | undefined;
  await using subscription = createStreamSubscription({
    onDispose: () => handle?.unsubscribe(),
  });
  handle = await connection.stream.subscribe({
    processEventBatch: subscription.processEventBatch,
    replayAfterOffset: toNewAfterOffset(args.afterOffset),
  });

  for await (const batch of subscription) {
    for (const event of batch.events) {
      yield toLegacyEvent(event, args.path);
    }
  }
}

function fetchDurableObjectWebSocket(
  stub: DurableObjectStub<StreamDurableObject>,
  request: Request,
) {
  const url = new URL(request.url);
  if (url.protocol === "wss:") url.protocol = "https:";
  if (url.protocol === "ws:") url.protocol = "http:";
  return stub.fetch(
    new Request(url, {
      headers: new Headers(request.headers),
      method: request.method,
    }),
  );
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
