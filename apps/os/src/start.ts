// Start's global middleware for the issuer's server functions. The Worker (issuer-pages.ts) admits
// only the issuer's pages and server functions into Start, and only same-origin POSTs (TanStack
// Start 1.167 has no CSRF middleware of its own); this decides which server-function calls Start
// may act on.

import { createMiddleware, createStart } from "@tanstack/react-start";
import { z } from "zod";
import { issuerRequestContext } from "./issuer-request-context.server.ts";
import { issuerServerFunctions } from "./issuer.functions.ts";

/** Only the issuer's own server functions are served, with a bounded payload. Start answers an
 *  unknown ID, and a payload it cannot decode, with a 500 — the caller's mistake, not ours: an
 *  unknown ID is a 404, and a request whose input never decoded (no function middleware ran) a 400. */
const issuerServerFunctionRequests = createMiddleware().server(
  async ({ request, pathname, next }) => {
    if (!pathname.startsWith("/_serverFn/")) return next();
    if (!issuerServerFunctions.some((serverFunction) => serverFunction.url === pathname))
      return new Response("Not found", { status: 404 });
    // a GET's payload is its query; a POST's is its body, measured as read (Content-Length may be
    // missing or understated)
    const payload =
      request.method === "POST"
        ? await request.clone().text()
        : new URL(request.url).searchParams.get("payload") || "";
    if (payload.length > 1_000_000) return new Response("Payload too large", { status: 413 });
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
