import { mapEventIterator } from "@orpc/client";
import type { StandardHandlerOptions, StandardHandlerPlugin } from "@orpc/server/standard";
import { isAsyncIteratorObject, overlayProxy } from "@orpc/shared";
import { resolveRequestId, type SharedRequestLogger } from "../../request-logging.ts";

export interface EvlogHandlerContext {
  log: SharedRequestLogger;
  rawRequest?: Request;
}

function toRequestLogError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isAbortedRequestError(signal: AbortSignal | undefined, error: unknown) {
  return signal?.aborted === true && signal.reason === error;
}

function setOrpcRequestLogContext(options: {
  context: EvlogHandlerContext;
  path: readonly string[];
}) {
  const procedurePath = options.path.join(".");
  const requestId = options.context.rawRequest
    ? resolveRequestId(options.context.rawRequest)
    : undefined;
  const logRequestId = options.context.log.getContext().requestId;

  options.context.log.set({
    ...(requestId !== undefined && requestId !== logRequestId ? { requestId } : {}),
    rpc: options.context.rawRequest
      ? {
          url: options.context.rawRequest.url,
          procedurePath,
        }
      : {
          procedurePath,
        },
  });
}

export class EvlogHandlerPlugin<T extends EvlogHandlerContext> implements StandardHandlerPlugin<T> {
  init(options: StandardHandlerOptions<T>): void {
    options.interceptors ??= [];
    options.clientInterceptors ??= [];

    options.interceptors.unshift(async ({ next, context, request }) => {
      try {
        return await next();
      } catch (error) {
        if (!isAbortedRequestError(request.signal, error)) {
          context.log.error(toRequestLogError(error));
        }
        throw error;
      }
    });

    options.clientInterceptors.unshift(async (interceptorOptions) => {
      setOrpcRequestLogContext({
        context: interceptorOptions.context,
        path: interceptorOptions.path,
      });

      const output = await interceptorOptions.next();
      if (!isAsyncIteratorObject(output)) {
        return output;
      }

      // @orpc/shared's overlayProxy returns a Proxy-like overlay that keeps the
      // original async iterator object's public surface while replacing the
      // iterator behavior with mapEventIterator(...). We use it here so callers
      // still see the same streamed oRPC response object, but errors raised
      // while consuming that stream are logged with the request/procedure
      // context above. Without the overlay, we would either lose non-iterator
      // members from the original output or have to manually mirror whatever
      // shape oRPC returns.
      //
      // This is not a Workers RPC/Cap'n Web capability proxy; it is an oRPC
      // client-side stream wrapper. The nearby Cap'n Web code uses the same
      // JavaScript Proxy mechanism for capability ergonomics, documented here:
      // - Workers RPC docs: https://developers.cloudflare.com/workers/runtime-apis/rpc/
      // - Cap'n Web README: https://github.com/cloudflare/capnweb
      return overlayProxy(
        output,
        mapEventIterator(output, {
          value: (value) => value,
          error: async (error) => {
            if (!isAbortedRequestError(interceptorOptions.signal, error)) {
              interceptorOptions.context.log.error(toRequestLogError(error));
            }
            return error;
          },
        }),
      );
    });
  }
}
