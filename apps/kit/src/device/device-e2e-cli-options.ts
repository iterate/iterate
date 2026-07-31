export interface DeviceE2eCliOptions {
  controlChurnHz?: number;
  deterministicPlayback: "prbs31" | "tone" | undefined;
  deviceClockedStartupFrames?: number;
  directLanHost?: string;
  directLanPort?: number;
  downlinkDeliveryMode: "device-clocked" | "host-paced";
  exitAfterRemoteProof: boolean;
  flash: boolean;
  flashArgs: string[];
  gateway: string;
  grokPlaybackOnly: boolean;
  mountTimeoutMs: number;
  networkDeviceHost?: string;
  playbackDurationMs: number;
  playbackEndurance: boolean;
  playbackRecoveryProof: boolean;
  physicalVoiceTurns?: number;
  remoteHoldMs: number;
  remoteInterruptionProof: boolean;
  remoteVoiceTurns?: number;
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
  let controlChurnHz: number | undefined;
  let exitAfterRemoteProof = false;
  let flash = true;
  let grokPlaybackOnly = false;
  let mountTimeoutMs = 90_000;
  let networkDeviceHost = environment.ITERATE_KIT_NETWORK_DEVICE_HOST?.trim()
    ? normalizeHost(environment.ITERATE_KIT_NETWORK_DEVICE_HOST, "network device host")
    : undefined;
  let deterministicPlayback: DeviceE2eCliOptions["deterministicPlayback"];
  let deviceClockedStartupFrames: number | undefined;
  let directLanHost = environment.ITERATE_KIT_DIRECT_LAN_HOST?.trim() || undefined;
  let directLanPort = environment.ITERATE_KIT_DIRECT_LAN_PORT
    ? parseTcpPort(environment.ITERATE_KIT_DIRECT_LAN_PORT)
    : undefined;
  let downlinkDeliveryMode: DeviceE2eCliOptions["downlinkDeliveryMode"] = "host-paced";
  let playbackDurationMs = 3_000;
  let playbackEndurance = false;
  let playbackRecoveryProof = false;
  let physicalVoiceTurns: number | undefined;
  let remoteHoldMs = 500;
  let remoteInterruptionProof = false;
  let remoteVoiceTurns: number | undefined;
  let tunnelName = environment.CAPTUN_TUNNEL_NAME?.trim() || undefined;
  let voice = false;
  let sawVoice = false;
  let sawControlChurnHz = false;
  let sawMountTimeout = false;
  let sawNetworkDeviceHost = false;
  let sawPhysicalVoiceTurns = false;
  let sawRemoteHold = false;
  let sawRemoteVoiceTurns = false;
  let sawToneDuration = false;
  let sawTunnelName = false;
  let sawDirectLanHost = false;
  let sawDirectLanPort = false;
  let sawDownlinkDeliveryMode = false;
  let sawDeviceClockedStartupFrames = false;

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
      directLanHost = normalizeHost(takeValue(args, ++index, option), "direct LAN host");
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
    if (option === "--device-clocked-downlink") {
      if (sawDownlinkDeliveryMode) {
        throw new Error("Option --device-clocked-downlink was provided more than once.");
      }
      downlinkDeliveryMode = "device-clocked";
      sawDownlinkDeliveryMode = true;
      continue;
    }
    if (option === "--device-clocked-startup-frames") {
      if (sawDeviceClockedStartupFrames) {
        throw new Error("Option --device-clocked-startup-frames was provided more than once.");
      }
      /*
       * This is intentionally bounded by the existing eight-frame media
       * budget. It is an experiment in when a generation becomes playable,
       * not a second knob that can quietly retain more old conversation.
       */
      deviceClockedStartupFrames = parseBoundedInteger(
        takeValue(args, ++index, option),
        "device-clocked startup frames",
        1,
        8,
      );
      sawDeviceClockedStartupFrames = true;
      continue;
    }
    if (option === "--control-churn-hz") {
      if (sawControlChurnHz) {
        throw new Error("Option --control-churn-hz was provided more than once.");
      }
      controlChurnHz = parseControlChurnHz(takeValue(args, ++index, option));
      sawControlChurnHz = true;
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
    if (option === "--physical-voice-turns") {
      if (sawPhysicalVoiceTurns) {
        throw new Error("Option --physical-voice-turns was provided more than once.");
      }
      physicalVoiceTurns = parseBoundedInteger(
        takeValue(args, ++index, option),
        "physical voice turns",
        1,
        20,
      );
      voice = true;
      sawPhysicalVoiceTurns = true;
      continue;
    }
    if (option === "--remote-voice-turns") {
      if (sawRemoteVoiceTurns) {
        throw new Error("Option --remote-voice-turns was provided more than once.");
      }
      remoteVoiceTurns = parseBoundedInteger(
        takeValue(args, ++index, option),
        "remote voice turns",
        1,
        20,
      );
      voice = true;
      sawRemoteVoiceTurns = true;
      continue;
    }
    if (option === "--remote-interruption-proof") {
      if (remoteInterruptionProof) {
        throw new Error("Option --remote-interruption-proof was provided more than once.");
      }
      remoteInterruptionProof = true;
      voice = true;
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
    if (option === "--network-device-host") {
      if (sawNetworkDeviceHost) {
        throw new Error("Option --network-device-host was provided more than once.");
      }
      networkDeviceHost = normalizeHost(takeValue(args, ++index, option), "network device host");
      sawNetworkDeviceHost = true;
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
    Number(sawPhysicalVoiceTurns) +
    Number(sawRemoteVoiceTurns) +
    Number(remoteInterruptionProof) +
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
  if (
    (remoteVoiceTurns !== undefined || remoteInterruptionProof) &&
    !directLanHost &&
    !networkDeviceHost
  ) {
    throw new Error(
      "A tunneled remote conversation or interruption proof requires " +
        "--network-device-host for network attribution.",
    );
  }
  if (deviceClockedStartupFrames !== undefined && downlinkDeliveryMode !== "device-clocked") {
    throw new Error("--device-clocked-startup-frames requires --device-clocked-downlink.");
  }
  if (controlChurnHz !== undefined && !deterministicPlayback) {
    throw new Error("--control-churn-hz requires deterministic playback.");
  }

  return {
    controlChurnHz,
    deterministicPlayback,
    deviceClockedStartupFrames,
    directLanHost,
    directLanPort,
    downlinkDeliveryMode,
    exitAfterRemoteProof,
    flash,
    flashArgs,
    gateway: normalizeGateway(environment.CAPTUN_GATEWAY?.trim() || "https://tunnels.iterate.com"),
    grokPlaybackOnly,
    mountTimeoutMs,
    networkDeviceHost,
    playbackDurationMs,
    playbackEndurance,
    playbackRecoveryProof,
    physicalVoiceTurns,
    remoteHoldMs,
    remoteInterruptionProof,
    remoteVoiceTurns,
    tunnelName,
    voice,
  };
}

function parseControlChurnHz(value: string) {
  const frequency = Number(value);
  if (!Number.isSafeInteger(frequency) || frequency < 1 || frequency > 100) {
    throw new Error("The control churn frequency must be an integer from 1 through 100 hertz.");
  }
  return frequency;
}

function parseTcpPort(value: string) {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("The direct LAN TCP port must be an integer from 1 through 65535.");
  }
  return port;
}

function normalizeHost(value: string, label: string) {
  const candidate = value.trim();
  if (
    !candidate ||
    candidate.includes("://") ||
    candidate.includes("/") ||
    candidate.includes(":")
  ) {
    throw new Error(`The ${label} must be a hostname or IPv4 address without a scheme or port.`);
  }
  let url: URL;
  try {
    url = new URL(`http://${candidate}`);
  } catch {
    throw new Error(`The ${label} must be a valid hostname or IPv4 address.`);
  }
  if (!url.hostname || url.port || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`The ${label} must be a hostname or IPv4 address without a path.`);
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
