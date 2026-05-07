/// <reference types="@cloudflare/workers-types" />

import { deriveDurableObjectNameFromStructuredName } from "../durable-object-utils/mixins/with-lifecycle-hooks.ts";
import type { StreamDurableObject } from "./stream-durable-object.ts";
import type {
  DestroyStreamResult,
  Event,
  EventInput,
  StreamCursor,
  StreamPath,
  StreamState,
} from "./types.ts";

export class StreamOffsetPreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StreamOffsetPreconditionError";
  }
}

export type StreamDurableObjectInitInput = {
  namespace: string;
  path: StreamPath;
};

export type StreamDurableObjectName = {
  namespace: string;
  path: string;
};

export type StreamDurableObjectStub = {
  initialize(params: { name: string }): Promise<unknown>;
  append(event: EventInput): Promise<Event>;
  destroy(args?: { destroyChildren?: boolean }): Promise<DestroyStreamResult>;
  history(args?: { after?: StreamCursor; before?: StreamCursor }): Promise<Event[]>;
  historyIfInitialized(args?: { after?: StreamCursor; before?: StreamCursor }): Promise<Event[]>;
  stream(args?: {
    after?: StreamCursor;
    before?: StreamCursor;
  }): Promise<ReadableStream<Uint8Array>>;
  getState(): Promise<StreamState>;
};

export type StreamDurableObjectNamespace = Omit<
  DurableObjectNamespace<StreamDurableObject>,
  "get" | "getByName"
> & {
  get(
    id: DurableObjectId,
    options?: DurableObjectNamespaceGetDurableObjectOptions,
  ): StreamDurableObjectStub;
  getByName(
    name: string,
    options?: DurableObjectNamespaceGetDurableObjectOptions,
  ): StreamDurableObjectStub;
};

export function getStreamDurableObjectName(args: StreamDurableObjectInitInput) {
  return deriveDurableObjectNameFromStructuredName({
    structuredName: {
      namespace: args.namespace,
      path: args.path,
    },
  });
}

export function getStreamStub(
  args: StreamDurableObjectInitInput & {
    durableObjectNamespace: StreamDurableObjectNamespace;
  },
) {
  return getStreamStubByName({
    namespace: args.durableObjectNamespace,
    name: getStreamDurableObjectName(args),
  });
}

export async function getInitializedStreamStub(
  args: StreamDurableObjectInitInput & {
    durableObjectNamespace: StreamDurableObjectNamespace;
  },
) {
  const name = getStreamDurableObjectName(args);
  const stream = getStreamStubByName({
    namespace: args.durableObjectNamespace,
    name,
  });
  await stream.initialize({
    name,
  });
  return stream;
}

function getStreamStubByName(args: { namespace: StreamDurableObjectNamespace; name: string }) {
  return args.namespace.get(args.namespace.idFromName(args.name));
}
