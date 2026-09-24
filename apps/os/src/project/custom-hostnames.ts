// src/project/custom-hostnames.ts — A PROJECT'S OWN HOSTNAMES: `www.example.com` served as the
// project's apex, exactly as `<project>.<hostname>` is. Three parts, one file:
//   the rule        which hostnames a project may add at all (`customHostnameProblem`, pure)
//   Cloudflare      the Cloudflare for SaaS custom hostname on the deployment's SaaS zone
//                   (`CustomHostnameProvider`): created with an HTTP DV certificate, so it turns
//                   active by itself once the owner CNAMEs the hostname to `cname.<zone>`
//   the routing     the control plane's hostname table (catalog.ts `project_hostnames`), claimed and
//                   released by the project processor (processor.ts), read by the edge
//                   (control-plane/edge.ts `projectHostOf`)
// The facts are the project's own, on its root log (contract.ts `project/hostname-*`).

import type { AppConfig } from "../app-config.ts";
import type { CustomHostnameObservation } from "./contract.ts";

/** A DNS name of two labels or more: lowercase letters, digits and inner hyphens (an IDN's `xn--`
 *  label included), each label at most 63. */
const HOSTNAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Why a project may not add `hostname`, or null when it may. Pure: the deployment's own zones
 *  (`customHostnames.reservedZones` — its platform origins, project hosts and static custom apexes)
 *  and everything under them are the deployment's, never a project's. */
export function customHostnameProblem(
  hostname: string,
  reservedZones: readonly string[],
): string | null {
  if (!HOSTNAME.test(hostname))
    return `'${hostname}' is not a hostname (letters, digits and hyphens, at least two labels, like www.example.com).`;
  const reserved = reservedZones.find((zone) => hostname === zone || hostname.endsWith(`.${zone}`));
  return reserved
    ? `'${hostname}' is under ${reserved}, which this deployment serves itself.`
    : null;
}

/** What the project processor needs of Cloudflare, each idempotent: find-or-create (and so re-read)
 *  a custom hostname, and delete one (none is done already). */
export type CustomHostnameProvider = {
  provision(hostname: string): Promise<CustomHostnameObservation>;
  remove(hostname: string): Promise<void>;
};

/** A custom hostname as Cloudflare's API answers it (the fields read here). */
type CloudflareCustomHostname = {
  id: string;
  hostname: string;
  status: string;
  ssl?: {
    status?: string;
    validation_errors?: { message?: string }[];
  };
  verification_errors?: string[];
};

/** The provider over Cloudflare's API with the deployment's token — null when the deployment has no
 *  `customHostnames` block or no token (a hostname is then refused, never half-provisioned). */
export function cloudflareCustomHostnameProvider(
  config: Pick<AppConfig, "customHostnames" | "cloudflareApiToken">,
  fetcher: typeof fetch = (input, init) => fetch(input, init),
): CustomHostnameProvider | null {
  const token = config.cloudflareApiToken.exposeSecret();
  if (!config.customHostnames || !token) return null;
  const { zone } = config.customHostnames;
  const cloudflare = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetcher(`https://api.cloudflare.com/client/v4${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    });
    const body = (await response.json()) as {
      success: boolean;
      result: T;
      errors?: { message: string }[];
    };
    if (!body.success)
      throw new Error(
        `Cloudflare ${init?.method || "GET"} ${path.split("?")[0]}: ${body.errors?.map((error) => error.message).join("; ") || response.status}`,
      );
    return body.result;
  };
  let zoneId: Promise<string> | undefined;
  const zoneIdOf = () =>
    (zoneId ||= cloudflare<{ id: string }[]>(`/zones?name=${encodeURIComponent(zone)}`).then(
      ([found]) => {
        if (!found) throw new Error(`the SaaS zone ${zone} is not visible to the token`);
        return found.id;
      },
      (error: unknown) => {
        zoneId = undefined;
        throw error;
      },
    ));
  const find = async (hostname: string) =>
    (
      await cloudflare<CloudflareCustomHostname[]>(
        `/zones/${await zoneIdOf()}/custom_hostnames?hostname=${encodeURIComponent(hostname)}`,
      )
    ).find((entry) => entry.hostname === hostname && entry.status !== "deleted") ?? null;
  const observation = (entry: CloudflareCustomHostname): CustomHostnameObservation => ({
    status: entry.status,
    sslStatus: entry.ssl?.status || "unknown",
    records: [{ type: "CNAME", name: entry.hostname, value: `cname.${zone}` }],
    errors: [
      ...(entry.verification_errors || []),
      ...(entry.ssl?.validation_errors || []).flatMap((error) =>
        error.message ? [error.message] : [],
      ),
    ],
  });
  return {
    async provision(hostname) {
      const existing = await find(hostname);
      if (existing) return observation(existing);
      return observation(
        await cloudflare<CloudflareCustomHostname>(`/zones/${await zoneIdOf()}/custom_hostnames`, {
          method: "POST",
          body: JSON.stringify({
            hostname,
            ssl: { method: "http", type: "dv", settings: { min_tls_version: "1.2" } },
          }),
        }),
      );
    },
    async remove(hostname) {
      const existing = await find(hostname);
      if (existing)
        await cloudflare(`/zones/${await zoneIdOf()}/custom_hostnames/${existing.id}`, {
          method: "DELETE",
        });
    },
  };
}
