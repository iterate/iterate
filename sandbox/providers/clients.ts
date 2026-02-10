import { createTRPCClient, httpLink, type TRPCClient } from "@trpc/client";
import type { AnyRouter } from "@trpc/server";
import { createClient as createPidnapClient, type Client as PidnapClient } from "pidnap/client";
import type { Sandbox } from "./types.ts";

const PIDNAP_PORT = 9876;
const DAEMON_PORT = 3000;

/**
 * Build a pidnap client for sandboxes that expose pidnap on port 9876.
 * Uses the sandbox fetcher so it works across all providers (Docker, Daytona, etc.).
 * Caller is responsible for using this only on sandboxes that actually run pidnap.
 */
export async function getPidnapClientForSandbox(sandbox: Sandbox): Promise<PidnapClient> {
  const [baseUrl, fetcher] = await Promise.all([
    sandbox.getBaseUrl({ port: PIDNAP_PORT }),
    sandbox.getFetcher({ port: PIDNAP_PORT }),
  ]);
  return createPidnapClient({
    url: `${baseUrl}/rpc`,
    fetch: (request) => fetcher(request),
  });
}

/**
 * Build a daemon tRPC client for sandboxes that expose daemon-backend on port 3000.
 * Caller is responsible for using this only on sandboxes that actually run daemon-backend.
 */
export async function getDaemonClientForSandbox<TRouter extends AnyRouter = AnyRouter>(
  sandbox: Sandbox,
): Promise<TRPCClient<TRouter>> {
  const baseUrl = await sandbox.getBaseUrl({ port: DAEMON_PORT });
  const client = createTRPCClient<AnyRouter>({
    links: [httpLink({ url: `${baseUrl}/api/trpc` })],
  });
  return client as unknown as TRPCClient<TRouter>;
}
