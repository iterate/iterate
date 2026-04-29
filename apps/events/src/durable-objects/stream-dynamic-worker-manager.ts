import {
  type Event,
  type EventInput,
  type StreamCursor,
  type StreamPath,
} from "@iterate-com/events-contract";
import { createDynamicWorkerManager } from "./dynamic-processor.ts";

/**
 * Wires the experimental dynamic-worker processor runtime to one Stream
 * durable object instance.
 *
 * This module deliberately keeps Cloudflare Dynamic Workers details out of
 * `stream.ts`. The stream core should only care that dynamic workers can read
 * history, subscribe to live events, and append back to the same stream.
 *
 * First-party references:
 * - Dynamic Workers overview: https://developers.cloudflare.com/dynamic-workers/
 * - RPC lifecycle / targets: https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/
 */
export function createStreamDynamicWorkerManager(args: {
  append: (event: EventInput) => Event;
  ctx: DurableObjectState;
  env: Env;
  getPath: () => StreamPath;
  getProjectSlug: () => string;
  history: (args?: { after?: StreamCursor; before?: StreamCursor }) => Event[];
  stream: (args?: { after?: StreamCursor; before?: StreamCursor }) => ReadableStream<Uint8Array>;
}) {
  return createDynamicWorkerManager({
    append: args.append,
    history: args.history,
    stream: args.stream,
    createLoopbackBinding: ({ exportName }) => {
      if (exportName !== "DynamicWorkerEgressGateway") {
        throw new Error(`Unsupported loopback binding export: ${exportName}`);
      }

      return args.env.DYNAMIC_WORKER_EGRESS_GATEWAY as unknown as Fetcher;
    },
    getPath: args.getPath,
    getProjectSlug: args.getProjectSlug,
    loader: args.env.LOADER,
    waitUntil: (promise) => args.ctx.waitUntil(promise),
  });
}
