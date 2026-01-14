/**
 * DEV_TUNNEL logic:
 * - "0", "false", or empty → disabled
 * - "1" or "true" → use ${stage}-${appName}.dev.iterate.com
 * - any other string → use that string directly as ${DEV_TUNNEL}.dev.iterate.com
 */
export function getTunnelConfig(appName: string, stage: string | undefined) {
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
