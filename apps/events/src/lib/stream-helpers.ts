import type { StreamPath } from "@iterate-com/events-contract";
import { getParentPath } from "~/lib/utils.ts";

export class StreamAppendInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StreamAppendInputError";
  }
}

export class StreamOffsetPreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StreamOffsetPreconditionError";
  }
}

export function getStreamStub(env: Env, path: StreamPath) {
  return env.STREAM.getByName(path);
}

export async function getInitializedStreamStub(env: Env, path: StreamPath) {
  const streamStub = getStreamStub(env, path);
  await streamStub.initialize({ path });
  return streamStub;
}

export function getParentStreamBinding(env: Env, path: StreamPath) {
  const parentPath = getParentPath(path);
  if (parentPath == null) {
    return null;
  }

  return {
    parentPath,
    streamStub: getStreamStub(env, parentPath),
  };
}
