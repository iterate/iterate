import { disposeIgnoredRpcResult } from "iterate/sdk/capnweb";

/**
 * A voice processor facet is hosted by its conversation Stream Durable
 * Object. Restart that parent, rather than a same-shaped standalone dynamic
 * worker ref: the latter is a different object and leaves the hosted facet
 * warm on its old bundle.
 */
export async function restartStreamHostedVoiceFacet(
  itx: { streams: { get(path: string): { kill(): Promise<void> } } },
  streamPath: string,
): Promise<void> {
  const stream = itx.streams.get(streamPath);
  try {
    /* The parent aborts its own RPC with this reason when it receives kill. */
    try {
      await stream.kill();
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("kill requested")) throw error;
    }
  } finally {
    disposeIgnoredRpcResult(stream);
  }
}
