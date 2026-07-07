import type { ProjectDirectoryRecord } from "./project-directory.ts";

function hostnameKey(hostname: string) {
  return `hostname:${hostname}`;
}

/** Exact custom-hostname registration, without app-subdomain fallback. */
export async function readProjectHostnameRegistration(
  directory: KVNamespace,
  hostname: string,
): Promise<ProjectDirectoryRecord | null> {
  return await directory
    .get<ProjectDirectoryRecord>(hostnameKey(hostname), "json")
    .catch(() => null);
}

export async function listProjectHostnameRegistrationsUnder(
  directory: KVNamespace,
  hostname: string,
  { limit = 1000 }: { limit?: number } = {},
): Promise<Array<{ hostname: string; record: ProjectDirectoryRecord }>> {
  const records: Array<{ hostname: string; record: ProjectDirectoryRecord }> = [];
  const suffix = `.${hostname}`;
  let cursor: string | undefined;
  while (records.length < limit) {
    const page = await directory.list({ prefix: "hostname:", cursor });
    const childHostnames = page.keys
      .map((key) => key.name.slice("hostname:".length))
      .filter((candidate) => candidate.endsWith(suffix))
      .slice(0, limit - records.length);
    const values = await Promise.all(
      childHostnames.map((childHostname) =>
        directory
          .get<ProjectDirectoryRecord>(hostnameKey(childHostname), "json")
          .then((record) => (record ? { hostname: childHostname, record } : null))
          .catch(() => null),
      ),
    );
    for (const value of values) {
      if (value) records.push(value);
    }
    if (page.list_complete) break;
    cursor = page.cursor;
  }
  return records;
}

/**
 * Custom-domain routing projection. The parent-domain key is enough for ingress:
 * `garple.com` resolves exact, and `counter.garple.com` falls back to it with
 * `appSlug: "counter"`.
 */
export async function primeProjectHostname(
  directory: KVNamespace,
  hostname: string,
  record: ProjectDirectoryRecord,
): Promise<void> {
  await directory.put(hostnameKey(hostname), JSON.stringify(record));
}

export async function deleteProjectHostname(
  directory: KVNamespace,
  hostname: string,
): Promise<void> {
  await directory.delete(hostnameKey(hostname));
}

/**
 * Custom-hostname resolution: `bla.com` set as a project's custom hostname
 * serves the project worker; `someapp.bla.com` serves it with that app
 * selected. Registrations live under `hostname:<host>` KV keys written by
 * custom-hostname provisioning, global to the apps/os deployment.
 */
export async function readProjectByHostname(
  directory: KVNamespace,
  host: string,
): Promise<{ record: ProjectDirectoryRecord; appSlug: string | null } | null> {
  const exact = await directory
    .get<ProjectDirectoryRecord>(hostnameKey(host), "json")
    .catch(() => null);
  if (exact) return { record: exact, appSlug: null };

  const dotIndex = host.indexOf(".");
  if (dotIndex <= 0) return null;
  const appSlug = host.slice(0, dotIndex);
  const parent = host.slice(dotIndex + 1);
  const parentRecord = await directory
    .get<ProjectDirectoryRecord>(hostnameKey(parent), "json")
    .catch(() => null);
  if (parentRecord) return { record: parentRecord, appSlug };

  return null;
}
