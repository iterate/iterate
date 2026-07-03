import { createAuthContractClient, type AuthContractClient } from "@iterate-com/auth-contract";
import type { AppConfig } from "~/config.ts";

// Deliberately NOT Pick<RequestContext, "config">: request-context.ts carries
// TanStack Start `Register` module augmentations that poison the program of
// standalone consumers of the auth import graph (streams-example-app).
export function createAuthWorkerServiceClient(
  context: { config: AppConfig },
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
