import { createAuthContractClient, type AuthContractClient } from "@iterate-com/auth-contract";
import type { RequestContext } from "~/request-context.ts";

export function createAuthWorkerServiceClient(
  context: Pick<RequestContext, "config">,
  opts: { asUserId?: string } = {},
): AuthContractClient {
  const config = context.config.iterateAuth;
  const serviceToken = config?.serviceToken?.exposeSecret();
  if (!config?.issuer || !serviceToken) {
    throw new Error("Auth worker service token is not configured.");
  }

  const authBaseUrl = new URL(config.issuer).origin.replace(/\/+$/, "");
  return createAuthContractClient({
    baseUrl: authBaseUrl,
    serviceToken,
    asUserId: opts.asUserId,
  });
}
