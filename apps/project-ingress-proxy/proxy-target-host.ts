export type ParsedProxyTargetHost = {
  upstreamHost: "localhost";
  upstreamPort: number;
  upstreamHostHeader: string;
  upstreamOrigin: string;
};

const DEFAULT_PROXY_TARGET_PORT = 3000;
const MAX_PORT = 65_535;
const LOCAL_TARGET_HOSTS = new Set(["localhost", "127.0.0.1"]);

function parsePort(portValue: string): number | null {
  if (!/^\d+$/.test(portValue)) return null;
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) return null;
  return port;
}

function parseExplicitLocalHostPort(value: string): number | null {
  const separator = value.lastIndexOf(":");
  if (separator === -1) return null;

  const host = value.slice(0, separator).trim().toLowerCase();
  const portRaw = value.slice(separator + 1).trim();
  if (!LOCAL_TARGET_HOSTS.has(host)) return null;
  return parsePort(portRaw);
}

export function parseProxyTargetHost(value: string): ParsedProxyTargetHost | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  let upstreamPort = DEFAULT_PROXY_TARGET_PORT;
  let hostSuffix = trimmed;

  const separatorIndex = trimmed.indexOf("__");
  if (separatorIndex > 0) {
    const parsedPort = parsePort(trimmed.slice(0, separatorIndex));
    if (!parsedPort) return null;
    hostSuffix = trimmed.slice(separatorIndex + 2);
    if (hostSuffix.length === 0) return null;
    upstreamPort = parsedPort;
  } else {
    const hasColon = trimmed.includes(":");
    if (hasColon) {
      const explicitPort = parseExplicitLocalHostPort(trimmed);
      if (!explicitPort) return null;
      upstreamPort = explicitPort;
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
