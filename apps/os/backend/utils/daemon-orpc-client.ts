import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { SandboxFetcher } from "@iterate-com/sandbox/providers/types";
import type { AppRouter } from "../../../daemon/server/orpc/app-router.ts";

/**
 * Default per-request timeout (90 s). Chosen to stay well under the outbox
 * consumer's 120 s visibility timeout so that a hanging fetch fails and records
 * a result _before_ pgmq re-surfaces the message.
 */
const DEFAULT_TIMEOUT_MS = 90_000;

export function createDaemonClient(params: {
  baseUrl: string;
  fetcher?: SandboxFetcher;
  /** Per-request timeout in ms. Defaults to 90 s. */
  timeoutMs?: number;
}): RouterClient<AppRouter> {
  const baseFetch = (params.fetcher ?? globalThis.fetch) as typeof globalThis.fetch;
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const fetchWithTimeout: typeof globalThis.fetch = (input, init) => {
    const externalSignal = init?.signal;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    // Combine with any signal the caller already provided
    const signal = externalSignal
      ? AbortSignal.any([externalSignal, timeoutSignal])
      : timeoutSignal;
    return baseFetch(input, { ...init, signal });
  };

  const link = new RPCLink({
    url: `${params.baseUrl}/api/orpc`,
    fetch: fetchWithTimeout,
  });
  return createORPCClient(link);
}
