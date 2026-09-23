import { createRouter, type LocationRewrite } from "@tanstack/react-router";
import { createIsomorphicFn } from "@tanstack/react-start";
import { issuerRequestNonce } from "./issuer-request-context.server.ts";
import { routeTree } from "./routeTree.gen.ts";

const cspNonce = createIsomorphicFn()
  .server(() => issuerRequestNonce())
  .client(() => undefined);

/** The consent page's query is the OAuth authorization request, and it must stay byte for byte
 *  what the client sent: repeated `resource` keys, `+` in `state`, a quoted value. The router's
 *  search parser decodes values (JSON included) and re-encodes them, then replaces a URL that
 *  differs from that encoding. So the router sees the raw query as one opaque `authorization`
 *  value, and the browser keeps the original URL. */
const rawAuthorizationQuery: LocationRewrite = {
  input: ({ url }) => {
    if (url.pathname !== "/oauth2/auth" || !url.search) return undefined;
    const internal = new URL(url);
    internal.search = new URLSearchParams({ authorization: url.search }).toString();
    return internal;
  },
  output: ({ url }) => {
    if (url.pathname !== "/oauth2/auth") return undefined;
    const external = new URL(url);
    external.search = url.searchParams.get("authorization") ?? "";
    return external;
  },
};

export function getRouter() {
  return createRouter({
    routeTree,
    defaultPreload: "intent",
    rewrite: rawAuthorizationQuery,
    ssr: { nonce: cspNonce() },
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
