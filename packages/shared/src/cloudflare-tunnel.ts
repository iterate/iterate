import path from "node:path";
import baseCloudflareTunnel from "vite-plugin-cloudflare-tunnel";

/**
 * DEV_TUNNEL logic:
 * - "0", "false", or empty → disabled
 * - "1" or "true" → use ${stage}-${appName}.dev.iterate.com
 * - any other string → use that string directly as ${DEV_TUNNEL}.dev.iterate.com
 */
function getTunnelConfig(appName: string, stage: string | undefined) {
  const devTunnel = process.env.DEV_TUNNEL;
  if (!devTunnel || devTunnel === "0" || devTunnel === "false") {
    return null;
  }
  if (devTunnel === "1" || devTunnel === "true") {
    if (!stage) return null;
    return {
      hostname: `${stage}-${appName}.dev.iterate.com`,
      tunnelName: `${stage}-${appName}`,
    };
  }
  // Custom hostname: use DEV_TUNNEL value directly
  return {
    hostname: `${devTunnel}.dev.iterate.com`,
    tunnelName: devTunnel,
  };
}

/**
 * Cloudflare tunnel plugin with automatic config from env vars.
 * Pass import.meta.dirname to correctly resolve the app name.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function cloudflareTunnel(dirname: string): any {
  const appName = path.basename(dirname);
  const stage =
    process.env.STAGE ?? (process.env.ITERATE_USER ? `dev-${process.env.ITERATE_USER}` : undefined);
  const tunnelConfig = getTunnelConfig(appName, stage);

  return baseCloudflareTunnel({
    enabled: !!tunnelConfig,
    hostname: tunnelConfig?.hostname ?? "",
    tunnelName: tunnelConfig?.tunnelName ?? "",
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    cleanup: { autoCleanup: false },
  });
}

/** Get tunnel hostname if enabled, for setting VITE_PUBLIC_URL */
export function getTunnelHostname(dirname: string) {
  const appName = path.basename(dirname);
  const stage =
    process.env.STAGE ?? (process.env.ITERATE_USER ? `dev-${process.env.ITERATE_USER}` : undefined);
  const config = getTunnelConfig(appName, stage);
  return config?.hostname ?? null;
}
