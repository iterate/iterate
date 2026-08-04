export interface AecFixtureCliOptions {
  captunToken?: string;
  deviceHost?: string;
  directLanHost?: string;
  directLanPort?: number;
  gateway: string;
  tunnelName?: string;
}

/**
 * Parses only the transport-shaped part of the physical AEC command.
 *
 * Public tunnel access and LAN attribution are mandatory by default. A run
 * without either would still make sound, but its evidence could neither show
 * who was allowed to reach the fixture nor separate network damage from DSP
 * damage. Direct LAN is kept as an explicit diagnostic selection.
 */
export function parseAecFixtureCliOptions(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): AecFixtureCliOptions {
  let deviceHost = environment.ITERATE_KIT_DEVICE_HOST?.trim() || undefined;
  let directLanHost: string | undefined;
  let directLanPort: number | undefined;
  let gateway = environment.CAPTUN_GATEWAY?.trim() || "https://tunnels.iterate.com";
  let tunnelName = environment.CAPTUN_TUNNEL_NAME?.trim() || undefined;

  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1]?.trim();
    if (!flag || !value) throw new Error(`${flag ?? "Transport option"} requires a value.`);
    if (flag === "--device-host") deviceHost = value;
    else if (flag === "--direct-lan-host") directLanHost = value;
    else if (flag === "--direct-lan-port") directLanPort = parsePort(value);
    else if (flag === "--gateway") gateway = value;
    else if (flag === "--tunnel-name") tunnelName = value;
    else throw new Error(`Unknown AEC fixture transport option ${flag}.`);
  }

  validateOrigin(gateway);
  validateHost(deviceHost, "--device-host");
  validateHost(directLanHost, "--direct-lan-host");
  if (directLanPort !== undefined && !directLanHost) {
    throw new Error("--direct-lan-port requires --direct-lan-host.");
  }
  if (directLanHost && tunnelName) {
    throw new Error("--direct-lan-host cannot be combined with --tunnel-name.");
  }

  const captunToken = environment.CAPTUN_TOKEN?.trim() || undefined;
  if (!directLanHost && !captunToken) {
    throw new Error("CAPTUN_TOKEN is required unless --direct-lan-host is selected.");
  }
  if (!directLanHost && !deviceHost) {
    throw new Error(
      "--device-host or ITERATE_KIT_DEVICE_HOST is required for tunneled network attribution.",
    );
  }

  return {
    captunToken,
    deviceHost,
    directLanHost,
    directLanPort,
    gateway,
    tunnelName,
  };
}

function parsePort(value: string) {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("--direct-lan-port must be an integer from 1 through 65535.");
  }
  return port;
}

function validateOrigin(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("The Captun gateway must be an HTTP(S) origin.");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("The Captun gateway must be an HTTP(S) origin without credentials or a path.");
  }
}

function validateHost(value: string | undefined, flag: string) {
  if (!value) return;
  if (/[:/]\//u.test(value) || /[/?#]/u.test(value) || /\s/u.test(value)) {
    throw new Error(`${flag} must be an IP address or DNS hostname without a scheme or path.`);
  }
}
