// Start's global middleware for the issuer's server functions. The Worker (issuer-pages.ts) admits
// only the issuer's pages and server functions into Start, and only same-origin POSTs (TanStack
// Start 1.167 has no CSRF middleware of its own); this decides which server-function calls Start
// may act on.

import { createMiddleware, createStart } from "@tanstack/react-start";
import { z } from "zod";
import { issuerRequestContext } from "./issuer-request-context.server.ts";
import { issuerServerFunctions } from "./issuer.functions.ts";

const MAX_PAYLOAD_BYTES = 1_000_000;

/** Only the issuer's own server functions are served, with a bounded payload. Start answers an
 *  unknown ID, and a payload it cannot decode, with a 500 — the caller's mistake, not ours: an
 *  unknown ID is a 404, and a request whose input never decoded (no function middleware ran) a 400. */
const issuerServerFunctionRequests = createMiddleware().server(
  async ({ request, pathname, next }) => {
    if (!pathname.startsWith("/_serverFn/")) return next();
    if (!issuerServerFunctions.some((serverFunction) => serverFunction.url === pathname))
      return new Response("Not found", { status: 404 });
    const tooLarge = new Response("Payload too large", { status: 413 });
    // a GET's payload is its query; a POST's is its body: refused on its Content-Length, and
    // measured as read (the header may be missing or understated), never read past the cap
    if ((new URL(request.url).searchParams.get("payload") || "").length > MAX_PAYLOAD_BYTES)
      return tooLarge;
    if (Number(request.headers.get("content-length")) > MAX_PAYLOAD_BYTES) return tooLarge;
    const body = request.body && request.clone().body;
    if (body) {
      const reader = body.getReader();
      for (let read = 0; ; ) {
        const chunk = await reader.read();
        if (chunk.done) break;
        read += chunk.value.byteLength;
        if (read > MAX_PAYLOAD_BYTES) {
          await reader.cancel();
          return tooLarge;
        }
      }
    }
    const result = await next();
    if (!issuerRequestContext().serverFunctionInputDecoded && result.response.status >= 500)
      return new Response("Invalid server-function payload", { status: 400 });
    return result;
  },
);

/** Plain data: strings, numbers, booleans, null, undefined, arrays and plain objects of them. */
const PlainData: z.ZodType = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.undefined(),
    z.array(PlainData),
    z.record(z.string(), PlainData),
  ]),
);

/** A server function's input is plain data. Start decodes more than that (promises, maps, streams)
 *  before any validator runs; each function's own `inputValidator` then parses the shape. */
const plainDataInput = createMiddleware({ type: "function" }).server(({ data, next }) => {
  issuerRequestContext().serverFunctionInputDecoded = true;
  if (!PlainData.safeParse(data).success)
    throw new Response("Server functions take plain data", { status: 400 });
  return next();
});

export const startInstance = createStart(() => ({
  requestMiddleware: [issuerServerFunctionRequests],
  functionMiddleware: [plainDataInput],
}));
