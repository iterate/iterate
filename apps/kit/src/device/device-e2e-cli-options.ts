export interface DeviceE2eCliOptions {
  deterministicPlayback: "prbs31" | "tone" | undefined;
  directLanHost?: string;
  directLanPort?: number;
  exitAfterRemoteProof: boolean;
  flash: boolean;
  flashArgs: string[];
  gateway: string;
  grokPlaybackOnly: boolean;
  mountTimeoutMs: number;
  playbackDurationMs: number;
  playbackEndurance: boolean;
  playbackRecoveryProof: boolean;
  remoteHoldMs: number;
  tunnelName?: string;
  voice: boolean;
}

/**
 * Selects the only proof modes that require an external Grok connection.
 *
 * `voice` also means “bring up the independent PCM lane”, so it is deliberately
 * too broad for secret validation: deterministic tone and endurance modes must
 * remain runnable without a provider account.
 */
export function deviceE2eUsesGrokProvider(
  options: Pick<DeviceE2eCliOptions, "deterministicPlayback" | "playbackEndurance" | "voice">,
) {
  return options.voice && !options.deterministicPlayback && !options.playbackEndurance;
}

const maximumRemoteHoldMs = 10 * 60_000;

export function parseDeviceE2eCliOptions(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): DeviceE2eCliOptions {
  const flashArgs: string[] = [];
  let exitAfterRemoteProof = false;
  let flash = true;
  let grokPlaybackOnly = false;
  let mountTimeoutMs = 90_000;
  let deterministicPlayback: DeviceE2eCliOptions["deterministicPlayback"];
  let directLanHost = environment.ITERATE_KIT_DIRECT_LAN_HOST?.trim() || undefined;
  let directLanPort = environment.ITERATE_KIT_DIRECT_LAN_PORT
    ? parseTcpPort(environment.ITERATE_KIT_DIRECT_LAN_PORT)
    : undefined;
  let playbackDurationMs = 3_000;
  let playbackEndurance = false;
  let playbackRecoveryProof = false;
  let remoteHoldMs = 500;
  let tunnelName = environment.CAPTUN_TUNNEL_NAME?.trim() || undefined;
  let voice = false;
  let sawVoice = false;
  let sawMountTimeout = false;
  let sawRemoteHold = false;
  let sawToneDuration = false;
  let sawTunnelName = false;
  let sawDirectLanHost = false;
  let sawDirectLanPort = false;

  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]!;
    if (option === "--no-flash") {
      if (!flash) throw new Error("Option --no-flash was provided more than once.");
      flash = false;
      continue;
    }
    if (option === "--direct-lan-host") {
      if (sawDirectLanHost) {
        throw new Error("Option --direct-lan-host was provided more than once.");
      }
      directLanHost = normalizeDirectLanHost(takeValue(args, ++index, option));
      sawDirectLanHost = true;
      continue;
    }
    if (option === "--direct-lan-port") {
      if (sawDirectLanPort) {
        throw new Error("Option --direct-lan-port was provided more than once.");
      }
      directLanPort = parseTcpPort(takeValue(args, ++index, option));
      sawDirectLanPort = true;
      continue;
    }
    if (option === "--exit-after-remote-proof") {
      if (exitAfterRemoteProof) {
        throw new Error("Option --exit-after-remote-proof was provided more than once.");
      }
      exitAfterRemoteProof = true;
      continue;
    }
    if (option === "--voice") {
      if (sawVoice) throw new Error("Option --voice was provided more than once.");
      voice = true;
      sawVoice = true;
      continue;
    }
    if (option === "--grok-playback-only") {
      if (grokPlaybackOnly) {
        throw new Error("Option --grok-playback-only was provided more than once.");
      }
      grokPlaybackOnly = true;
      voice = true;
      continue;
    }
    if (option === "--tone-playback-only") {
      if (deterministicPlayback) {
        throw new Error("Option --tone-playback-only was provided more than once.");
      }
      deterministicPlayback = "tone";
      voice = true;
      continue;
    }
    if (option === "--prbs31-playback-only") {
      if (deterministicPlayback) {
        throw new Error("Choose only one deterministic playback source.");
      }
      deterministicPlayback = "prbs31";
      voice = true;
      continue;
    }
    if (option === "--playback-endurance") {
      if (playbackEndurance) {
        throw new Error("Option --playback-endurance was provided more than once.");
      }
      playbackEndurance = true;
      voice = true;
      continue;
    }
    if (option === "--playback-recovery-proof") {
      if (playbackRecoveryProof) {
        throw new Error("Option --playback-recovery-proof was provided more than once.");
      }
      playbackRecoveryProof = true;
      continue;
    }
    if (option === "--tone-duration-ms" || option === "--playback-duration-ms") {
      if (sawToneDuration) {
        throw new Error("A deterministic playback duration was provided more than once.");
      }
      playbackDurationMs = parseBoundedInteger(
        takeValue(args, ++index, option),
        "deterministic playback duration",
        1_000,
        maximumRemoteHoldMs,
      );
      if (playbackDurationMs % 20 !== 0) {
        throw new Error("The playback duration must contain whole 20 ms PCM frames.");
      }
      sawToneDuration = true;
      continue;
    }
    if (option === "--base-url") {
      throw new Error("--base-url is supplied by the live tunnel.");
    }
    if (option === "--dry-run") {
      throw new Error(
        "--dry-run cannot establish the device connection; use firmware:flash directly.",
      );
    }
    if (option === "--mount-timeout-ms") {
      if (sawMountTimeout) {
        throw new Error("Option --mount-timeout-ms was provided more than once.");
      }
      mountTimeoutMs = parseBoundedInteger(
        takeValue(args, ++index, option),
        "mount timeout",
        1_000,
        300_000,
      );
      sawMountTimeout = true;
      continue;
    }
    if (option === "--remote-hold-ms") {
      if (sawRemoteHold) {
        throw new Error("Option --remote-hold-ms was provided more than once.");
      }
      remoteHoldMs = parseBoundedInteger(
        takeValue(args, ++index, option),
        "remote hold",
        1,
        maximumRemoteHoldMs,
      );
      sawRemoteHold = true;
      continue;
    }
    if (option === "--tunnel-name") {
      if (sawTunnelName) {
        throw new Error("Option --tunnel-name was provided more than once.");
      }
      tunnelName = takeValue(args, ++index, option).trim();
      if (!tunnelName) {
        throw new Error("Tunnel name must not be empty.");
      }
      sawTunnelName = true;
      continue;
    }
    flashArgs.push(option);
  }

  const selectedVoiceProofCount =
    Number(sawVoice) +
    Number(grokPlaybackOnly) +
    Number(deterministicPlayback !== undefined) +
    Number(playbackEndurance);
  if (selectedVoiceProofCount > 1) {
    throw new Error(
      "Choose exactly one voice proof: --voice, --grok-playback-only, " +
        "--tone-playback-only, --prbs31-playback-only, or --playback-endurance.",
    );
  }
  if (sawToneDuration && !deterministicPlayback) {
    throw new Error("A playback duration requires deterministic playback.");
  }
  if (playbackRecoveryProof && deterministicPlayback !== "tone") {
    /*
     * Recovery is a diagnostic interpretation of the same deterministic
     * provider/device path, not a sixth voice mode. Requiring an exact source
     * keeps content+drop conservation provable and prevents this flag from
     * becoming a generic way to relax Grok or endurance results.
     */
    throw new Error("A playback recovery proof requires deterministic tone playback.");
  }
  if (directLanHost && tunnelName) {
    throw new Error("--direct-lan-host cannot be combined with --tunnel-name.");
  }
  if (directLanPort !== undefined && !directLanHost) {
    throw new Error("--direct-lan-port requires --direct-lan-host.");
  }

  return {
    deterministicPlayback,
    directLanHost,
    directLanPort,
    exitAfterRemoteProof,
    flash,
    flashArgs,
    gateway: normalizeGateway(environment.CAPTUN_GATEWAY?.trim() || "https://tunnels.iterate.com"),
    grokPlaybackOnly,
    mountTimeoutMs,
    playbackDurationMs,
    playbackEndurance,
    playbackRecoveryProof,
    remoteHoldMs,
    tunnelName,
    voice,
  };
}

function parseTcpPort(value: string) {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("The direct LAN TCP port must be an integer from 1 through 65535.");
  }
  return port;
}

function normalizeDirectLanHost(value: string) {
  const candidate = value.trim();
  if (
    !candidate ||
    candidate.includes("://") ||
    candidate.includes("/") ||
    candidate.includes(":")
  ) {
    throw new Error(
      "The direct LAN host must be a hostname or IPv4 address without a scheme or port.",
    );
  }
  let url: URL;
  try {
    url = new URL(`http://${candidate}`);
  } catch {
    throw new Error("The direct LAN host must be a valid hostname or IPv4 address.");
  }
  if (!url.hostname || url.port || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("The direct LAN host must be a hostname or IPv4 address without a path.");
  }
  return url.hostname;
}

function takeValue(args: readonly string[], index: number, option: string) {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Option ${option} requires a value.`);
  }
  return value;
}

function parseBoundedInteger(value: string, label: string, minimum: number, maximum: number) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `The ${label} must be an integer from ${minimum} through ${maximum} milliseconds.`,
    );
  }
  return parsed;
}

function normalizeGateway(value: string) {
  const url = new URL(value);
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "The Captun gateway must be an HTTP(S) origin without credentials, path, query, or fragment.",
    );
  }
  return url.origin;
}
