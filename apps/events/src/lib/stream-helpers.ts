import { env as workerEnv } from "cloudflare:workers";
import {
  getInitializedStreamStub as getSharedInitializedStreamStub,
  getStreamDurableObjectName,
  getStreamStub as getSharedStreamStub,
  StreamOffsetPreconditionError,
  type StreamDurableObjectInitInput,
} from "@iterate-com/shared/streams/helpers";

export { getStreamDurableObjectName, StreamOffsetPreconditionError };

export function getStreamStub(args: StreamDurableObjectInitInput) {
  return getSharedStreamStub({
    durableObjectNamespace: workerEnv.STREAM as never,
    ...args,
  });
}

/**
 * Returns a stream stub that is guaranteed to have been initialized. All
 * stateful DO methods (append, history, stream, getState) assume initialization
 * has already happened; calling them without going through this helper will
 * throw from the `state` getter inside the durable object.
 */
export async function getInitializedStreamStub(args: StreamDurableObjectInitInput) {
  return await getSharedInitializedStreamStub({
    durableObjectNamespace: workerEnv.STREAM as never,
    ...args,
  });
}
