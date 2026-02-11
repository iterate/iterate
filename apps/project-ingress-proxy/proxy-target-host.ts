export type ParsedProxyTargetHost = {
  upstreamHost: "localhost";
  upstreamPort: number;
  upstreamHostHeader: string;
  upstreamOrigin: string;
};

const DEFAULT_PROXY_TARGET_PORT = 3000;
const MAX_PORT = 65_535;

export function parseProxyTargetHost(value: string): ParsedProxyTargetHost | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  let upstreamPort = DEFAULT_PROXY_TARGET_PORT;
  let hostSuffix = trimmed;

  const separatorIndex = trimmed.indexOf("__");
  if (separatorIndex > 0) {
    const portPrefix = trimmed.slice(0, separatorIndex);
    if (/^\d+$/.test(portPrefix)) {
      hostSuffix = trimmed.slice(separatorIndex + 2);
      if (hostSuffix.length === 0) return null;
      upstreamPort = Number(portPrefix);
    }
  }

  if (hostSuffix.length === 0) return null;
  if (!Number.isInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > MAX_PORT) {
    return null;
  }

  const upstreamHostHeader = `localhost:${upstreamPort}`;

  return {
    upstreamHost: "localhost",
    upstreamPort,
    upstreamHostHeader,
    upstreamOrigin: `http://${upstreamHostHeader}`,
  };
}
