import { env as workerEnv } from "cloudflare:workers";
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

function getStreamStub(path: StreamPath) {
  return workerEnv.STREAM.getByName(path);
}

export async function getInitializedStreamStub({ path }: { path: StreamPath }) {
  const streamStub = getStreamStub(path);
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
    streamStub: env.STREAM.getByName(parentPath),
  };
}
