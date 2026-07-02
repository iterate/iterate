import { streamRpcPath, withStreamConnectionFromBrowser } from "./stream-rpc.ts";

/**
 * One-shot playground operator verb against the `/api/streams` endpoint.
 *
 * The next-engine browser mirror has no `kill()`/`reset()` (they are not part
 * of the public `Stream` capability), so the sidebar buttons dial their own
 * short-lived connection to the playground RPC target instead. Both verbs
 * `ctx.abort()` the Durable Object mid-call, so a rejected RPC is the expected
 * success shape — the caller follows up with `streamStore.nudge()` so the
 * mirror notices the new incarnation and reconciles quickly.
 */
export async function runStreamControl(args: {
  path: string;
  projectId?: string;
  verb: "kill" | "reset";
}): Promise<void> {
  const connection = await withStreamConnectionFromBrowser({
    url: streamRpcPath({ path: args.path, projectId: args.projectId }),
  });
  try {
    await connection.stream[args.verb]();
  } catch {
    // ctx.abort() tears down in-flight RPC; the durable effect already landed.
  } finally {
    connection[Symbol.dispose]();
  }
}
