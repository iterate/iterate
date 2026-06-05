import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import { toWebSocketUrl, waitForOpen } from "../connection.ts";
import type { StreamProcessorRunnerRpc } from "../types.ts";

export type StreamProcessorRunnerConnection = AsyncDisposable & {
  rpc: RpcStub<StreamProcessorRunnerRpc>;
};

/** Connects to a stream processor runner from Node.js. Used by end-to-end fixtures. */
export async function connectStreamProcessorRunner(args: {
  url: string | URL;
  headers?: HeadersInit;
}): Promise<StreamProcessorRunnerConnection> {
  const webSocket = new WebSocket(toWebSocketUrl(args.url), {
    // @ts-expect-error Node supports WebSocket headers; DOM lib typings do not.
    headers: args.headers,
  });
  await waitForOpen(webSocket);
  const rpc = newWebSocketRpcSession<StreamProcessorRunnerRpc>(webSocket);
  return {
    rpc,
    async [Symbol.asyncDispose]() {
      rpc[Symbol.dispose]();
      if (webSocket.readyState === WebSocket.CLOSED) return;
      await new Promise<void>((resolve) => {
        webSocket.addEventListener("close", () => resolve(), { once: true });
        webSocket.close();
      });
    },
  };
}
