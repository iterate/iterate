import {
  DEFAULT_STREAM_PROJECT_ID,
  streamRpcPath,
  withStreamConnectionFromBrowser,
} from "./stream-rpc.ts";
import {
  asBrowserStreamClient,
  type BrowserStreamClient,
  type BrowserStreamClientFactory,
} from "~/domains/streams/engine/browser/stream-browser-store.ts";

export const createCapnwebStreamClient: BrowserStreamClientFactory = async (
  args,
): Promise<BrowserStreamClient> => {
  const connection = await withStreamConnectionFromBrowser({
    url:
      args.streamUrl ??
      streamRpcPath({
        path: args.streamPath,
        projectId: args.projectId === DEFAULT_STREAM_PROJECT_ID ? undefined : args.projectId,
      }),
    onConnectionStatusChange: args.onConnectionStatusChange,
  });

  return asBrowserStreamClient(connection.stream, () => connection[Symbol.dispose]());
};
