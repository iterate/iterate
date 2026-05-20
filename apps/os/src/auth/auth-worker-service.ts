import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import {
  AS_USER_HEADER,
  SERVICE_TOKEN_HEADER,
  type AuthContractClient,
} from "@iterate-com/auth-contract";
import type { AppContext } from "~/context.ts";

export function createAuthWorkerServiceClient(
  context: Pick<AppContext, "config">,
  opts: { asUserId?: string } = {},
): AuthContractClient {
  const config = context.config.iterateAuth;
  const serviceToken = config?.serviceToken?.exposeSecret();
  if (!config?.issuer || !serviceToken) {
    throw new Error("Auth worker service token is not configured.");
  }

  const authBaseUrl = new URL(config.issuer).origin.replace(/\/+$/, "");
  return createORPCClient(
    new RPCLink({
      url: `${authBaseUrl}/api/orpc/`,
      fetch: (request: URL | Request, init?: RequestInit) => {
        const headers = new Headers(request instanceof Request ? request.headers : init?.headers);
        headers.set(SERVICE_TOKEN_HEADER, serviceToken);
        if (opts.asUserId) {
          headers.set(AS_USER_HEADER, opts.asUserId);
        }
        return fetch(request, { ...init, headers });
      },
    }),
  ) as AuthContractClient;
}
