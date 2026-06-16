import {
  DEFAULT_STREAM_PROJECT_ID,
  streamRpcPath,
  withStreamConnectionFromBrowser,
} from "./stream-rpc.ts";
import type {
  BrowserStreamClient,
  BrowserStreamClientFactory,
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

  return {
    append: (appendArgs) => connection.stream.append(appendArgs),
    appendBatch: (appendArgs) => connection.stream.appendBatch(appendArgs),
    runtimeState: () => connection.stream.runtimeState(),
    getProcessorRuntimeState: (runtimeStateArgs) =>
      connection.stream.getProcessorRuntimeState(runtimeStateArgs),
    subscribe: (subscribeArgs) => connection.stream.subscribe(subscribeArgs),
    kill: () => connection.stream.kill(),
    reset: () => connection.stream.reset(),
    [Symbol.dispose]() {
      connection[Symbol.dispose]();
    },
  };
};
