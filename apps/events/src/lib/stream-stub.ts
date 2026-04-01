import { type StreamPath } from "@iterate-com/events-contract";

export async function getInitializedStreamStub(env: Env, path: StreamPath) {
  const streamStub = env.STREAM.getByName(path);
  await streamStub.initialize({ path });
  return streamStub;
}
