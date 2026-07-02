import {
  DEFAULT_STREAM_PROJECT_ID,
  streamRpcPath,
  withStreamConnectionFromBrowser,
} from "./stream-rpc.ts";
import {
  asBrowserStreamClient,
  type BrowserStreamClient,
  type BrowserStreamClientFactory,
} from "~/domains/streams/client-libraries/browser/stream-browser-store.ts";
import type { Stream } from "~/types.ts";

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

  // The capnweb stub satisfies the next `Stream` capability structurally; the
  // stub's pipelined return types just need collapsing back to plain promises.
  return asBrowserStreamClient(connection.stream as unknown as Stream, () =>
    connection[Symbol.dispose](),
  );
};
