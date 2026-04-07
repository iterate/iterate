import { env as workerEnv } from "cloudflare:workers";
import type { ProjectSlug, StreamPath } from "@iterate-com/events-contract";

export class StreamOffsetPreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StreamOffsetPreconditionError";
  }
}

// Durable Object names define global identity. Keep this explicit and stable
// rather than relying on object key order in JSON.stringify():
// https://developers.cloudflare.com/durable-objects/api/namespace/
export function getStreamDurableObjectName(args: { projectSlug: ProjectSlug; path: StreamPath }) {
  return `${args.projectSlug}::${args.path}`;
}

export function getStreamStub(args: { projectSlug: ProjectSlug; path: StreamPath }) {
  return workerEnv.STREAM.getByName(getStreamDurableObjectName(args));
}

/**
 * Returns a stream stub that is guaranteed to have been initialized. All
 * stateful DO methods (append, history, stream, getState) assume initialization
 * has already happened; calling them without going through this helper will
 * throw from the `state` getter inside the durable object.
 */
export async function getInitializedStreamStub(args: {
  projectSlug: ProjectSlug;
  path: StreamPath;
}) {
  const streamStub = getStreamStub(args);
  await streamStub.initialize(args);
  return streamStub;
}
