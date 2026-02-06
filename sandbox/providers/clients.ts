import { createTRPCClient, httpLink, type TRPCClient } from "@trpc/client";
import type { AnyRouter } from "@trpc/server";
import { createClient as createPidnapClient, type Client as PidnapClient } from "pidnap/client";
import type { Sandbox } from "./types.ts";

const PIDNAP_PORT = 9876;
const DAEMON_PORT = 3000;

/**
 * Build a pidnap client for sandboxes that expose pidnap on port 9876.
 * Caller is responsible for using this only on sandboxes that actually run pidnap.
 */
export async function getPidnapClientForSandbox(sandbox: Sandbox): Promise<PidnapClient> {
  const previewUrl = await sandbox.getPreviewUrl({ port: PIDNAP_PORT });
  return createPidnapClient(`${previewUrl}/rpc`);
}

/**
 * Build a daemon tRPC client for sandboxes that expose daemon-backend on port 3000.
 * Caller is responsible for using this only on sandboxes that actually run daemon-backend.
 */
export async function getDaemonClientForSandbox<TRouter extends AnyRouter = AnyRouter>(
  sandbox: Sandbox,
): Promise<TRPCClient<TRouter>> {
  const previewUrl = await sandbox.getPreviewUrl({ port: DAEMON_PORT });
  const client = createTRPCClient<AnyRouter>({
    links: [httpLink({ url: `${previewUrl}/api/trpc` })],
  });
  return client as unknown as TRPCClient<TRouter>;
}
