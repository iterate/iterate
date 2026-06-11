import type { FetchCallable } from "@iterate-com/shared/callable/types.ts";
import { normalizeIngressHost } from "./host-headers.ts";
import type { ExactHostIngressRule } from "./types.ts";

type ProjectCustomHostnameRow = {
  id: string;
  custom_hostname: string | null;
};

export async function getProjectCustomHostnameIngressRule(input: {
  appHostname?: string | null;
  db: D1Database;
  host: string;
}): Promise<ExactHostIngressRule | null> {
  const host = normalizeIngressHost(input.host);
  const appHostname = input.appHostname ? normalizeIngressHost(input.appHostname) : null;
  if (appHostname !== null && host === appHostname) return null;

  const row = await input.db
    .prepare(
      `SELECT id, custom_hostname
       FROM projects
       WHERE custom_hostname IS NOT NULL
         AND custom_hostname != ''
         AND (custom_hostname = ? OR ? LIKE '%.' || custom_hostname)
       ORDER BY length(custom_hostname) DESC
       LIMIT 1`,
    )
    .bind(host, host)
    .first<ProjectCustomHostnameRow>();

  if (!row?.custom_hostname) return null;
  if (!isCustomHostnameIngressHost({ customHostname: row.custom_hostname, host })) return null;

  const callable = {
    type: "fetch",
    via: {
      type: "loopback-binding",
      bindingType: "service",
      exportName: "ProjectIngressEntrypoint",
      props: { projectId: row.id },
    },
  } satisfies FetchCallable;

  return {
    id: `custom-hostname:${row.id}:${host}`,
    host,
    projectId: row.id,
    priority: 50,
    notes: "Project custom hostname",
    callable,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

export function isCustomHostnameIngressHost(input: { customHostname: string; host: string }) {
  const host = normalizeIngressHost(input.host);
  const customHostname = normalizeIngressHost(input.customHostname);

  if (host === customHostname) return true;
  if (!host.endsWith(`.${customHostname}`)) return false;

  const prefix = host.slice(0, host.length - customHostname.length - 1);
  return prefix !== "" && !prefix.includes(".");
}
