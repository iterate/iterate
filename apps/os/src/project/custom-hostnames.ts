// src/project/custom-hostnames.ts — A PROJECT'S OWN HOSTNAMES: `iterate.example.com` serves the
// project's apex and `<app>.iterate.example.com` its apps, exactly as `<project>.<hostname>` and
// `<app>--<project>.<hostname>` do. Three parts, one file:
//   the rule        which hostnames a project may add (`customHostnameProblem`) and the DNS records
//                   its owner adds (`customHostnameRecords`), both pure
//   Cloudflare      a WILDCARD Cloudflare for SaaS custom hostname on the deployment's SaaS zone
//                   (`cloudflareCustomHostnameProvider`); its certificate covers `*.<hostname>`, which
//                   takes TXT validation — delegated once by the owner's `_acme-challenge` CNAME
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
 *  (`customHostnames.reservedZones` — its platform origins, project hosts and SaaS zone) and
 *  everything under them are the deployment's, never a project's. */
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

/** The CNAMEs the owner adds, once: the hostname and every name under it to the SaaS zone's
 *  fallback origin, and `_acme-challenge` delegated to Cloudflare (Delegated DCV), which validates
 *  the wildcard certificate and every renewal. Pure. */
export function customHostnameRecords(
  hostname: string,
  config: Pick<NonNullable<AppConfig["customHostnames"]>, "zone" | "dcvDelegationUuid">,
): CustomHostnameObservation["records"] {
  return [
    { name: hostname, value: `cname.${config.zone}` },
    { name: `*.${hostname}`, value: `cname.${config.zone}` },
    {
      name: `_acme-challenge.${hostname}`,
      value: `${hostname}.${config.dcvDelegationUuid}.dcv.cloudflare.com`,
    },
  ];
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
  ssl?: { status?: string };
};

/** The provider over Cloudflare's API with the deployment's token — null when the deployment has no
 *  `customHostnames` block or no token (a hostname is then refused, never half-provisioned). */
export function cloudflareCustomHostnameProvider(
  config: Pick<AppConfig, "customHostnames" | "cloudflareApiToken">,
  fetcher: typeof fetch = (input, init) => fetch(input, init),
): CustomHostnameProvider | null {
  const token = config.cloudflareApiToken.exposeSecret();
  const saas = config.customHostnames;
  if (!saas || !token) return null;
  const cloudflare = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetcher(
      `https://api.cloudflare.com/client/v4/zones/${saas.zoneId}/custom_hostnames${path}`,
      {
        ...init,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      },
    );
    const body = (await response.json()) as {
      success: boolean;
      result: T;
      errors?: { message: string }[];
    };
    if (!body.success)
      throw new Error(
        `Cloudflare: ${body.errors?.map((error) => error.message).join("; ") || response.status}`,
      );
    return body.result;
  };
  const find = async (hostname: string) =>
    (
      await cloudflare<CloudflareCustomHostname[]>(`?hostname=${encodeURIComponent(hostname)}`)
    ).find((entry) => entry.hostname === hostname && entry.status !== "deleted");
  return {
    async provision(hostname) {
      const create = () =>
        cloudflare<CloudflareCustomHostname>("", {
          method: "POST",
          body: JSON.stringify({
            hostname,
            ssl: {
              method: "txt",
              type: "dv",
              wildcard: true,
              settings: { min_tls_version: "1.2" },
            },
          }),
        });
      // a create that lost a race to another (a duplicate) finds the winner's
      const entry =
        (await find(hostname)) ??
        (await create().catch(async (error: unknown) => {
          const winner = await find(hostname);
          if (!winner) throw error;
          return winner;
        }));
      return {
        status: entry.status,
        sslStatus: entry.ssl?.status || "unknown",
        records: customHostnameRecords(hostname, saas),
      };
    },
    async remove(hostname) {
      const entry = await find(hostname);
      if (entry) await cloudflare(`/${entry.id}`, { method: "DELETE" });
    },
  };
}
