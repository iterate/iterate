import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import type { api } from "./contract.ts";

export interface CreateClientOptions {
  /** Full URL to the pidnap RPC endpoint (must include `/rpc` prefix). */
  url?: string;
  /** Custom fetch implementation (e.g. sandbox fetcher for reaching containers). */
  fetch?: (request: Request) => Promise<Response>;
}

/**
 * Create a pidnap RPC client.
 *
 * @param urlOrOptions URL string or options object. URL must include the `/rpc` prefix
 *            since the server mounts all routes under that path (see cli.ts).
 *            Defaults to `http://localhost:9876/rpc`.
 */
export function createClient(
  urlOrOptions?: string | CreateClientOptions,
): ContractRouterClient<typeof api> {
  const processEnv = typeof process === "undefined" ? undefined : process.env;
  const opts = typeof urlOrOptions === "string" ? { url: urlOrOptions } : urlOrOptions;
  const url = opts?.url ?? processEnv?.PIDNAP_RPC_URL ?? "http://localhost:9876/rpc";
  const authToken = processEnv?.PIDNAP_AUTH_TOKEN;
  const headers = authToken ? { Authorization: `Bearer ${authToken}` } : undefined;
  const link = new RPCLink({ url, headers, ...(opts?.fetch ? { fetch: opts.fetch } : {}) });
  return createORPCClient(link);
}

export type Client = ReturnType<typeof createClient>;
