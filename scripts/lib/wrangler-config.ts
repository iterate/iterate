/**
 * The one observability posture every Iterate worker deploys with: full
 * sampling, persistent logs and traces. Shared by every app's Worker config.
 */
export const OBSERVABILITY = {
  enabled: true,
  head_sampling_rate: 1,
  logs: { enabled: true, head_sampling_rate: 1, persist: true, invocation_logs: true },
  traces: { enabled: true, persist: true, head_sampling_rate: 1 },
};

/** The registrable domain of a URL or hostname — its last two labels (`os.iterate.com` ⇒ `iterate.com`;
 *  a workers.dev origin ⇒ `<subdomain>.workers.dev`, the account's own). The zone a hostname routes
 *  on: the start apps' routes and the OS platform's wrangler config and ensure-resources. */
export function registrableDomainOf(urlOrHostname: string) {
  const hostname = urlOrHostname.includes("://") ? new URL(urlOrHostname).hostname : urlOrHostname;
  const labels = hostname.split(".");
  return labels.slice(hostname.endsWith(".workers.dev") ? -3 : -2).join(".");
}
