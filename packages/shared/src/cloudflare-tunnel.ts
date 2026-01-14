import path from "node:path";
import baseCloudflareTunnel from "vite-plugin-cloudflare-tunnel";

/**
 * DEV_TUNNEL: "0"/"false"/empty = disabled, "1"/"true" = auto, other = custom subdomain
 * Auto mode uses STAGE, falling back to dev-${ITERATE_USER} for non-alchemy apps (e.g. daemon)
 */
function getTunnelConfig(appName: string) {
  const devTunnel = process.env.DEV_TUNNEL;
  if (!devTunnel || devTunnel === "0" || devTunnel === "false") return null;

  const stage =
    process.env.STAGE ?? (process.env.ITERATE_USER ? `dev-${process.env.ITERATE_USER}` : null);
  if ((devTunnel === "1" || devTunnel === "true") && !stage) return null;

  const subdomain = devTunnel === "1" || devTunnel === "true" ? `${appName}-${stage}` : devTunnel;

  return { hostname: `${subdomain}.dev.iterate.com`, tunnelName: subdomain };
}

/** Cloudflare tunnel plugin. Pass import.meta.dirname to resolve app name. */
export function cloudflareTunnel(dirname: string): any {
  const config = getTunnelConfig(path.basename(dirname));

  return baseCloudflareTunnel({
    enabled: !!config,
    hostname: config?.hostname ?? "",
    tunnelName: config?.tunnelName ?? "",
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    cleanup: { autoCleanup: false },
  });
}

/** Get tunnel hostname if enabled, for VITE_PUBLIC_URL */
export function getTunnelHostname(dirname: string) {
  return getTunnelConfig(path.basename(dirname))?.hostname ?? null;
}
