import type { Context } from "@orpc/server";
import type { FetchHandleResult, FetchHandlerInterceptorOptions } from "@orpc/server/fetch";

/**
 * Command-line HTTP clients whose terminal output benefits from indentation,
 * e.g. `curl/8.7.1`, `HTTPie/3.2.2`, `Wget/1.24.5`.
 */
const CLI_CLIENT_USER_AGENT = /\b(curl|httpie|wget)\b/i;

/**
 * Pretty-print JSON responses for curl ergonomics, but only when the request
 * actually comes from a command-line client. The OpenAPI handler at `/api` is
 * also the browser dashboard's transport (`~/orpc/client.ts` points
 * `OpenAPILink` at it), and those responses should stream through untouched
 * instead of being buffered, re-serialized, and inflated with whitespace.
 * Leaves SSE (`text/event-stream`) and non-JSON responses untouched.
 */
export async function prettyJsonInterceptor(
  options: FetchHandlerInterceptorOptions<Context> & {
    next(): Promise<FetchHandleResult>;
  },
): Promise<FetchHandleResult> {
  const userAgent = options.request.headers.get("user-agent") ?? "";
  if (!CLI_CLIENT_USER_AGENT.test(userAgent)) return options.next();

  const result = await options.next();
  const type = result.response?.headers.get("content-type");
  if (!result.matched || result.response.body === null || !type?.includes("json")) return result;
  return {
    ...result,
    response: new Response(JSON.stringify(await result.response.json(), null, 2), result.response),
  };
}
