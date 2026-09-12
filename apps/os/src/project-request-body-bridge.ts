import { disposeIgnoredRpcResult } from "iterate/sdk/capnweb";

/**
 * Keep project-ingress input alive through a response that streams it back.
 *
 * The dynamic-worker fetch boundary transfers and locks its Request body even
 * when a project handler returns without reading it. Piping the inbound body
 * into a bridge keeps the original stream owned by ingress. The response body
 * below keeps the outer response proxy open until the pump finishes, or
 * explicitly aborts an unread body before that proxy completes.
 */
export function bridgeProjectRequestBody(request: Request): {
  body: ReadableStream<Uint8Array> | null;
  finish(response: Response): Promise<Response>;
} {
  const requestBody = request.body;
  if (!requestBody) return { body: null, finish: async (response) => response };

  const abort = new AbortController();
  const cancellation = new DOMException(
    "Project response did not read its request body.",
    "AbortError",
  );
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  let pumpResult: { ok: true } | { error: unknown; ok: false } | undefined;
  const pump = requestBody
    .pipeTo(stream.writable, { signal: abort.signal })
    .then(
      () => ({ ok: true }) as const,
      (error) => ({ error, ok: false }) as const,
    )
    .then((result) => {
      pumpResult = result;
      return result;
    });
  let finishPromise: Promise<void> | undefined;

  const finish = async () => {
    finishPromise ||= (async () => {
      if (!pumpResult) abort.abort(cancellation);
      const result = await pump;
      if (!result.ok && result.error !== cancellation) throw result.error;
    })();
    await finishPromise;
  };

  return {
    body: stream.readable,
    async finish(response) {
      const responseBody = response.body;
      if (!responseBody || response.webSocket) {
        await finish();
        return response;
      }
      const reader = responseBody.getReader();
      const body = new ReadableStream<Uint8Array>({
        async cancel() {
          const cleanup = finish();
          try {
            await reader.cancel(cancellation);
          } finally {
            await cleanup;
          }
        },
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) {
              await finish();
              controller.close();
            } else {
              controller.enqueue(next.value);
            }
          } catch (error) {
            try {
              await finish();
            } catch (finishError) {
              controller.error(finishError);
              return;
            }
            controller.error(error);
          }
        },
      });
      const wrapped = new Response(body, response);
      if (Symbol.dispose in response) {
        Object.defineProperty(wrapped, Symbol.dispose, {
          value: () => disposeIgnoredRpcResult(response),
        });
      }
      return wrapped;
    },
  };
}
