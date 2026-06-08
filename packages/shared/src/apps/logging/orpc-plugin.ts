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
