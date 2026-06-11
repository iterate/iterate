import { getProjectPlatformHostIngressRule } from "~/ingress/project-platform-host-routing.ts";
import { getProjectCustomHostnameIngressRule } from "~/ingress/project-custom-hostname-routing.ts";
import { getItxCapabilityHostIngressRule } from "~/itx/http.ts";
import type { ExactHostIngressRule } from "~/ingress/types.ts";

/**
 * Resolve the ingress rule for a request host. If the host isn't the dashboard
 * itself, it is one of (in priority order):
 *
 * 1. an itx capability host (`{cap}--{project}.{base}` — itx/http.ts),
 * 2. a project platform host (`<slug>.{base}` / `<projectId>.{base}`),
 * 3. a project custom hostname.
 *
 * All three resolve against the `projects` table in D1. Returns null for the
 * dashboard host (and anything else unrecognized), which falls through to the
 * regular TanStack Start app in worker.ts.
 */
export async function lookupIngressRule(input: {
  appHostname: string | null;
  db: D1Database;
  host: string;
  projectHostnameBases: string[];
}): Promise<ExactHostIngressRule | null> {
  const { appHostname, db, host, projectHostnameBases: bases } = input;
  return (
    (await getItxCapabilityHostIngressRule({ bases, db, host })) ??
    (await getProjectPlatformHostIngressRule({ appHostname, bases, db, host })) ??
    (await getProjectCustomHostnameIngressRule({ appHostname, db, host }))
  );
}
