import { WorkerEntrypoint } from "cloudflare:workers";
import {
  type ChildStreamCreatedEvent,
  type Event,
  type EventInput,
  STREAM_CHILD_STREAM_CREATED_TYPE,
  STREAM_FIRST_INITIALIZED_TYPE,
  type StreamCursor,
  StreamPath,
} from "@iterate-com/shared/streams/types";
import {
  listD1ObjectCatalogRecordsByIndex,
  type D1ObjectCatalogRecord,
} from "@iterate-com/shared/durable-object-utils/mixins/with-d1-object-catalog";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
} from "@iterate-com/shared/streams/helpers";
import type {
  StreamDurableObject,
  StreamDurableObjectStructuredName,
} from "@iterate-com/shared/streams/stream-durable-object";
import type { ExecuteCodemodeFunctionCallInput } from "@iterate-com/shared/stream-processors/codemode/implementation";

type StreamsCapabilityEnv = {
  DO_CATALOG?: D1Database;
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
  namespace: string;
  streamPath?: string;
};

type StreamPathInput = {
  streamPath?: string;
};

type StreamAppendInput = StreamPathInput & {
  event: EventInput;
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
type StreamCatalogRecord = D1ObjectCatalogRecord<StreamDurableObjectStructuredName>;

/**
 * Capability-based stream access for OS2 code that needs to read or append
 * namespace-owned events. The only ambient authority is the `STREAM` namespace
 * binding; callers receive a narrowed Cloudflare WorkerEntrypoint binding with
 * props such as `namespace` and optional `streamPath`.
 *
 * This is an example of Cloudflare Workers capability-based security: instead
 * of passing a global Events URL/client around, OS2 passes a capability whose
 * props determine what the holder can do. In future, read and write policy for
 * streams will be expressed in these props.
 */
export class StreamsCapability extends WorkerEntrypoint<
  StreamsCapabilityEnv,
  StreamsCapabilityProps
> {
  async executeCodemodeFunctionCall(input: ExecuteCodemodeFunctionCallInput) {
    const [request] = input.args;
    const options =
      request != null && typeof request === "object" ? (request as Record<string, unknown>) : {};
    switch (input.functionPath.join(".")) {
      case "append":
        return await this.append(options as StreamAppendInput);
      case "create":
        return await this.create(options as StreamPathInput);
      case "list":
        return await this.list();
      case "read":
        return await this.read(options as StreamReadInput);
      case "getState":
        return await this.getState(options as StreamPathInput);
      case "listChildren":
        return await this.listChildren(options as StreamListChildrenInput);
      default:
        throw new Error(`StreamsCapability does not implement ${input.functionPath.join(".")}`);
    }
  }

  async append(input: StreamAppendInput): Promise<Event> {
    const path = this.resolveNamespacePath(input);
    this.assertMayAppend(path);
    debugCodemodeDepth("streamCapability.append.start", {
      eventType: input.event.type,
      path,
      namespace: this.ctx.props.namespace,
    });

    const event = await appendNamespaceStreamEvent({
      durableObjectNamespace: this.env.STREAM,
      path,
      namespace: this.ctx.props.namespace,
      event: {
        ...input.event,
        metadata: {
          ...(input.event.metadata ?? {}),
          ...(this.ctx.props.appendMetadata ?? {}),
        },
      } as EventInput,
    });
    debugCodemodeDepth("streamCapability.append.done", {
      eventOffset: event.offset,
      eventType: event.type,
      path,
      namespace: this.ctx.props.namespace,
    });
    return event;
  }

  async create(input: StreamPathInput) {
    return await getNamespaceStreamState({
      durableObjectNamespace: this.env.STREAM,
      path: this.resolveNamespacePath(input),
      namespace: this.ctx.props.namespace,
    });
  }

  async list() {
    if (!this.env.DO_CATALOG) {
      throw new Error("DO_CATALOG binding is required to list streams.");
    }

    const records = await listD1ObjectCatalogRecordsByIndex<StreamDurableObjectStructuredName>(
      this.env.DO_CATALOG,
      {
        className: "StreamDurableObject",
        indexName: "namespace",
        indexValue: this.ctx.props.namespace,
      },
    );

    return records.map((record) => toStreamCatalogRecord(record));
  }

  async read(input: StreamReadInput = {}): Promise<Event[]> {
    return await readNamespaceStreamEvents({
      durableObjectNamespace: this.env.STREAM,
      path: this.resolveNamespacePath(input),
      namespace: this.ctx.props.namespace,
      afterOffset: input.afterOffset,
      beforeOffset: input.beforeOffset ?? "end",
    });
  }

  async stream(input: StreamEventsInput = {}): Promise<Response> {
    debugCodemodeDepth("streamCapability.stream.start", {
      afterOffset: input.afterOffset,
      beforeOffset: input.beforeOffset,
      path: this.resolveNamespacePath(input),
      namespace: this.ctx.props.namespace,
    });
    const events = streamNamespaceStreamEvents({
      durableObjectNamespace: this.env.STREAM,
      path: this.resolveNamespacePath(input),
      namespace: this.ctx.props.namespace,
      afterOffset: input.afterOffset,
      beforeOffset: input.beforeOffset,
    });

    return new Response(
      new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          for await (const event of events) {
            controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          }
          controller.close();
        },
      }),
      {
        headers: {
          "content-type": "application/x-ndjson",
          "cache-control": "no-cache",
        },
      },
    );
  }

  async getState(input: StreamPathInput = {}) {
    return await getNamespaceStreamState({
      durableObjectNamespace: this.env.STREAM,
      path: this.resolveNamespacePath(input),
      namespace: this.ctx.props.namespace,
    });
  }

  async listChildren(input: StreamListChildrenInput = {}) {
    const path = this.resolveNamespacePath(input);
    const events = await readNamespaceStreamEvents({
      durableObjectNamespace: this.env.STREAM,
      path,
      namespace: this.ctx.props.namespace,
    });
    const discovered: Record<StreamPath, string> = {};

    for (const event of events) {
      if (event.type === STREAM_CHILD_STREAM_CREATED_TYPE) {
        discovered[(event as ChildStreamCreatedEvent).payload.childPath] = event.createdAt;
      } else if (event.type === STREAM_FIRST_INITIALIZED_TYPE) {
        discovered[path] = event.createdAt;
      }
    }

    return Object.entries(discovered)
      .map(([path, createdAt]) => ({ path: path as StreamPath, createdAt }))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  private resolveNamespacePath(input: StreamPathInput): StreamPath {
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

    throw new Error(`Stream append policy rejected append to ${path}.`);
  }
}

export type StreamsCapabilityBinding = (options: {
  props: StreamsCapabilityProps;
}) => StreamsCapability;

export function getStreamsCapability(input: {
  exports: Record<string, unknown> | undefined;
  props: StreamsCapabilityProps;
}) {
  const binding = input.exports?.StreamsCapability;
  if (typeof binding !== "function") {
    throw new Error("StreamsCapability export is not available.");
  }

  return (binding as StreamsCapabilityBinding)({ props: input.props });
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

function debugCodemodeDepth(message: string, payload: Record<string, unknown>) {
  console.log("[DEBUG-cm-depth]", JSON.stringify({ message, ...payload }));
}

function toStreamCatalogRecord(record: StreamCatalogRecord) {
  return {
    name: record.name,
    namespace: record.structuredName.namespace,
    streamPath: StreamPath.parse(record.structuredName.path),
    createdAt: record.createdAt,
    lastWokenAt: record.lastWokenAt,
  };
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
