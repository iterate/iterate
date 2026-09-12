import { z } from "zod";
import { ITX_PRINCIPAL_HEADER } from "../principal.ts";

const Principal = z.object({ actor: z.string().min(1), email: z.string().optional() });

/** Project ingress strips public identity headers and stamps the verified caller.
 * This guard runs locally in the config worker, before it proxies an app. */
export const auth = {
  require(request: Request): Response | null {
    const url = new URL(request.url);
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      const origin = request.headers.get("origin");
      if (origin && origin !== url.origin)
        return new Response("Cross-site request refused", { status: 403 });
    }
    const principal = request.headers.get(ITX_PRINCIPAL_HEADER);
    if (principal) {
      Principal.parse(JSON.parse(principal)); // Platform-owned stamp; malformed means a defect.
      return null;
    }
    if (!["GET", "HEAD"].includes(request.method))
      return new Response("Sign in first", { status: 401 });
    return new Response(null, {
      status: 302,
      headers: {
        Location: `/.auth/login?next=${encodeURIComponent(url.pathname + url.search)}`,
        "Cache-Control": "no-store",
      },
    });
  },
};
