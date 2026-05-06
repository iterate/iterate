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
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
} from "@iterate-com/shared/streams/helpers";
import type { StreamDurableObject } from "@iterate-com/shared/streams/stream-durable-object";
import type { ExecuteCodemodeFunctionCallInput } from "@iterate-com/shared/stream-processors/codemode/implementation";

type StreamCapabilityEnv = {
  STREAM: DurableObjectNamespace<StreamDurableObject>;
};

export type StreamAppendPolicy =
  | { mode: "none" }
  | { mode: "stream" }
  | { mode: "children" }
  | { mode: "any" }
  | { mode: "pattern"; pattern: string };

export type StreamCapabilityProps = {
  appendMetadata?: Record<string, unknown>;
  appendPolicy?: StreamAppendPolicy;
  projectId: string;
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

/**
 * Capability-based stream access for OS2 code that needs to read or append
 * project-owned events. The only ambient authority is the `STREAM` namespace
 * binding; callers receive a narrowed Cloudflare WorkerEntrypoint binding with
 * props such as `projectId` and optional `streamPath`.
 *
 * This is an example of Cloudflare Workers capability-based security: instead
 * of passing a global Events URL/client around, OS2 passes a capability whose
 * props determine what the holder can do. In future, read and write policy for
 * streams will be expressed in these props.
 */
export class StreamCapability extends WorkerEntrypoint<StreamCapabilityEnv, StreamCapabilityProps> {
  async executeCodemodeFunctionCall(input: ExecuteCodemodeFunctionCallInput) {
    const [request] = input.args;
    const options =
      request != null && typeof request === "object" ? (request as Record<string, unknown>) : {};
    switch (input.functionPath.join(".")) {
      case "append":
        return await this.append(options as StreamAppendInput);
      case "read":
        return await this.read(options as StreamReadInput);
      case "getState":
        return await this.getState(options as StreamPathInput);
      case "listChildren":
        return await this.listChildren(options as StreamListChildrenInput);
      default:
        throw new Error(`StreamCapability does not implement ${input.functionPath.join(".")}`);
    }
  }

  async append(input: StreamAppendInput): Promise<Event> {
    const path = this.resolveProjectPath(input);
    this.assertMayAppend(path);
    debugCodemodeDepth("streamCapability.append.start", {
      eventType: input.event.type,
      path,
      projectId: this.ctx.props.projectId,
    });

    const event = await appendProjectStreamEvent({
      streamNamespace: this.env.STREAM,
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
    debugCodemodeDepth("streamCapability.append.done", {
      eventOffset: event.offset,
      eventType: event.type,
      path,
      projectId: this.ctx.props.projectId,
    });
    return event;
  }

  async read(input: StreamReadInput = {}): Promise<Event[]> {
    return await readProjectStreamEvents({
      streamNamespace: this.env.STREAM,
      path: this.resolveProjectPath(input),
      projectId: this.ctx.props.projectId,
      afterOffset: input.afterOffset,
      beforeOffset: input.beforeOffset ?? "end",
    });
  }

  async stream(input: StreamEventsInput = {}): Promise<Response> {
    debugCodemodeDepth("streamCapability.stream.start", {
      afterOffset: input.afterOffset,
      beforeOffset: input.beforeOffset,
      path: this.resolveProjectPath(input),
      projectId: this.ctx.props.projectId,
    });
    const events = streamProjectStreamEvents({
      streamNamespace: this.env.STREAM,
      path: this.resolveProjectPath(input),
      projectId: this.ctx.props.projectId,
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
    return await getProjectStreamState({
      streamNamespace: this.env.STREAM,
      path: this.resolveProjectPath(input),
      projectId: this.ctx.props.projectId,
    });
  }

  async listChildren(input: StreamListChildrenInput = {}) {
    const path = this.resolveProjectPath(input);
    const events = await readProjectStreamEvents({
      streamNamespace: this.env.STREAM,
      path,
      projectId: this.ctx.props.projectId,
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

    throw new Error(`Project stream append policy rejected append to ${path}.`);
  }
}

export type StreamCapabilityBinding = (options: {
  props: StreamCapabilityProps;
}) => StreamCapability;

export function getStreamCapability(input: {
  exports: Record<string, unknown> | undefined;
  props: StreamCapabilityProps;
}) {
  const binding = input.exports?.StreamCapability;
  if (typeof binding !== "function") {
    throw new Error("StreamCapability export is not available.");
  }

  return (binding as StreamCapabilityBinding)({ props: input.props });
}

export function resolveProjectStreamPath(pathInput: string): StreamPath {
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

    return resolveProjectStreamPath(input.basePath);
  }

  const trimmedPath = input.pathInput.trim();
  if (!trimmedPath) {
    throw new Error("Stream path is required.");
  }

  if (trimmedPath.startsWith("/")) {
    return resolveProjectStreamPath(trimmedPath);
  }

  if (input.basePath == null) {
    return resolveProjectStreamPath(trimmedPath);
  }

  const basePath = resolveProjectStreamPath(input.basePath);
  const relativePath = trimmedPath.replace(/^\.\//, "").replace(/^\/+/, "");
  return StreamPath.parse(basePath === "/" ? `/${relativePath}` : `${basePath}/${relativePath}`);
}

function canAppend(input: { path: StreamPath; policy: StreamAppendPolicy; streamPath?: string }) {
  switch (input.policy.mode) {
    case "none":
      return false;
    case "stream":
      return input.streamPath != null && input.path === resolveProjectStreamPath(input.streamPath);
    case "children": {
      if (input.streamPath == null) return false;
      const streamPath = resolveProjectStreamPath(input.streamPath);
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

async function getInitializedProjectStreamStub(args: {
  streamNamespace: DurableObjectNamespace<StreamDurableObject>;
  projectId: string;
  path: StreamPath;
}) {
  return await getInitializedStreamStub({
    namespace: args.streamNamespace as unknown as StreamDurableObjectNamespace,
    projectId: args.projectId,
    path: args.path,
  });
}

async function appendProjectStreamEvent(args: {
  streamNamespace: DurableObjectNamespace<StreamDurableObject>;
  projectId: string;
  path: StreamPath;
  event: EventInput;
}) {
  const stub = await getInitializedProjectStreamStub(args);
  return await stub.append(args.event);
}

async function readProjectStreamEvents(args: {
  streamNamespace: DurableObjectNamespace<StreamDurableObject>;
  projectId: string;
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
  streamNamespace: DurableObjectNamespace<StreamDurableObject>;
  projectId: string;
  path: StreamPath;
}) {
  const stub = await getInitializedProjectStreamStub(args);
  return await stub.getState();
}

async function* streamProjectStreamEvents(args: {
  streamNamespace: DurableObjectNamespace<StreamDurableObject>;
  projectId: string;
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
