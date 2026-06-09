import type { Client } from "sqlfu";
import { getIngressRouteByHost } from "~/db/queries/.generated/index.ts";
import { normalizeIngressHost, parseIngressCallable } from "~/ingress/host-routing.ts";
import { getProjectPlatformHostIngressRule } from "~/ingress/project-platform-host-routing.ts";
import { getProjectCustomHostnameIngressRule } from "~/ingress/project-custom-hostname-routing.ts";
import type { ExactHostIngressRule } from "~/ingress/types.ts";

/**
 * Resolve the ingress rule for a request host, in priority order:
 *
 * 1. an explicit ingress route row in D1 (operator-managed),
 * 2. a project platform host (`<slug>.iterate.app` and friends),
 * 3. a project custom hostname.
 *
 * Returns null for the dashboard host itself, which falls through to the
 * regular TanStack Start app in worker.ts.
 */
export async function lookupIngressRule(input: {
  appHostname: string | null;
  db: Client;
  doCatalog: D1Database;
  host: string;
  projectHostnameBases: string[];
}): Promise<ExactHostIngressRule | null> {
  const row = await getIngressRouteByHost(input.db, { host: normalizeIngressHost(input.host) });
  if (row) return ingressRouteRowToRule(row);

  const platformRule = await getProjectPlatformHostIngressRule({
    appHostname: input.appHostname,
    bases: input.projectHostnameBases,
    db: input.doCatalog,
    host: input.host,
  });
  if (platformRule) return platformRule;

  return await getProjectCustomHostnameIngressRule({
    appHostname: input.appHostname,
    db: input.doCatalog,
    host: input.host,
  });
}

function ingressRouteRowToRule(row: {
  id: string;
  host: string;
  project_id?: string | null;
  priority: number;
  notes?: string | null;
  callable_json: string;
  created_at: string;
  updated_at: string;
}): ExactHostIngressRule {
  return {
    id: row.id,
    host: row.host,
    projectId: row.project_id ?? null,
    priority: row.priority,
    notes: row.notes ?? null,
    callable: parseIngressCallable(row.callable_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
