export interface DeviceE2eCliOptions {
  exitAfterRemoteProof: boolean;
  flash: boolean;
  flashArgs: string[];
  gateway: string;
  grokPlaybackOnly: boolean;
  mountTimeoutMs: number;
  playbackEndurance: boolean;
  remoteHoldMs: number;
  tonePlaybackOnly: boolean;
  toneDurationMs: number;
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
  options: Pick<DeviceE2eCliOptions, "playbackEndurance" | "tonePlaybackOnly" | "voice">,
) {
  return options.voice && !options.tonePlaybackOnly && !options.playbackEndurance;
}

type Environment = Readonly<Record<string, string | undefined>>;
const maximumRemoteHoldMs = 10 * 60_000;

export function parseDeviceE2eCliOptions(
  args: readonly string[],
  environment: Environment,
): DeviceE2eCliOptions {
  const flashArgs: string[] = [];
  let exitAfterRemoteProof = false;
  let flash = true;
  let grokPlaybackOnly = false;
  let mountTimeoutMs = 90_000;
  let playbackEndurance = false;
  let remoteHoldMs = 500;
  let tonePlaybackOnly = false;
  let toneDurationMs = 3_000;
  let tunnelName = environment.CAPTUN_TUNNEL_NAME?.trim() || undefined;
  let voice = false;
  let sawVoice = false;
  let sawMountTimeout = false;
  let sawRemoteHold = false;
  let sawToneDuration = false;
  let sawTunnelName = false;

  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]!;
    if (option === "--no-flash") {
      if (!flash) throw new Error("Option --no-flash was provided more than once.");
      flash = false;
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
      if (tonePlaybackOnly) {
        throw new Error("Option --tone-playback-only was provided more than once.");
      }
      tonePlaybackOnly = true;
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
    if (option === "--tone-duration-ms") {
      if (sawToneDuration) {
        throw new Error("Option --tone-duration-ms was provided more than once.");
      }
      toneDurationMs = parseBoundedInteger(
        takeValue(args, ++index, option),
        "tone duration",
        1_000,
        maximumRemoteHoldMs,
      );
      if (toneDurationMs % 20 !== 0) {
        throw new Error("The tone duration must contain whole 20 ms PCM frames.");
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
    Number(tonePlaybackOnly) +
    Number(playbackEndurance);
  if (selectedVoiceProofCount > 1) {
    throw new Error(
      "Choose exactly one voice proof: --voice, --grok-playback-only, " +
        "--tone-playback-only, or --playback-endurance.",
    );
  }
  if (sawToneDuration && !tonePlaybackOnly) {
    throw new Error("--tone-duration-ms requires --tone-playback-only.");
  }

  return {
    exitAfterRemoteProof,
    flash,
    flashArgs,
    gateway: normalizeGateway(environment.CAPTUN_GATEWAY?.trim() || "https://tunnels.iterate.com"),
    grokPlaybackOnly,
    mountTimeoutMs,
    playbackEndurance,
    remoteHoldMs,
    tonePlaybackOnly,
    toneDurationMs,
    tunnelName,
    voice,
  };
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
