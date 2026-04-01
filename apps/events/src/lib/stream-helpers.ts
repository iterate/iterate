import { env as workerEnv } from "cloudflare:workers";
import type { StreamPath } from "@iterate-com/events-contract";

export class StreamOffsetPreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StreamOffsetPreconditionError";
  }
}

export function getStreamStub(path: StreamPath) {
  return workerEnv.STREAM.getByName(path);
}

/**
 * Returns a stream stub that is guaranteed to have been initialized. All
 * stateful DO methods (append, history, stream, getState) assume initialization
 * has already happened; calling them without going through this helper will
 * throw from the `state` getter inside the durable object.
 */
export async function getInitializedStreamStub({ path }: { path: StreamPath }) {
  const streamStub = getStreamStub(path);
  await streamStub.initialize({ path });
  return streamStub;
}
