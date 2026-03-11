import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { RouterClient } from "@orpc/server";
import type { AppRouter } from "../../../daemon/server/orpc/app-router.ts";

/**
 * Create a typed oRPC client for a machine's daemon, proxied through the
 * existing machine-proxy route which handles session auth + access checks.
 *
 * Route: /org/:org/proj/:project/:machine/proxy/3000/api/orpc
 */
export function createDaemonProxyClient(params: {
  orgSlug: string;
  projectSlug: string;
  machineId: string;
}): RouterClient<AppRouter> {
  const base = `/org/${params.orgSlug}/proj/${params.projectSlug}/${params.machineId}/proxy/3000`;
  return createORPCClient(
    new RPCLink({
      url: `${import.meta.env.VITE_PUBLIC_URL}${base}/api/orpc`,
    }),
  );
}

/**
 * Create a TanStack Query-integrated oRPC client for a daemon, providing
 * `.queryOptions()` on every procedure for use with useQuery/useSuspenseQuery.
 */
export function createDaemonQueryUtils(client: RouterClient<AppRouter>) {
  return createTanstackQueryUtils(client);
}
