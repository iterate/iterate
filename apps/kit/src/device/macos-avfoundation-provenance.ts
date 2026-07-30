import { execFile } from "node:child_process";
import type {
  MacOsCaptureInputIdentity,
  MacOsCaptureProcessingProvenance,
  MacOsMicrophoneMode,
} from "./macos-pcm16-capture.ts";

interface MacOsAvFoundationProbe {
  activeMicrophoneMode: MacOsMicrophoneMode;
  devices: {
    displayName: string;
    uniqueId: string;
  }[];
  preferredMicrophoneMode: MacOsMicrophoneMode;
  schemaVersion: 1;
}

export interface MacOsAvFoundationCommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export type MacOsAvFoundationCommandExecutor = (
  executable: string,
  arguments_: readonly string[],
) => Promise<MacOsAvFoundationCommandResult>;

const defaultSwiftExecutable = "/usr/bin/swift";
const commandTimeoutMs = 5_000;
const maximumCommandOutputBytes = 64 * 1_024;
const supportedMicrophoneModes = new Set<MacOsMicrophoneMode>([
  "standard",
  "wide-spectrum",
  "voice-isolation",
  "unknown",
]);

/*
 * This helper asks AVFoundation for facts that ffmpeg's device listing omits:
 * the reconnect-stable uniqueID and the system's actual microphone mode.
 * Keep it as a constant argument to `swift -e`; no shell parses it and no
 * caller-controlled value is interpolated into source code.
 */
const avFoundationProbeSource = String.raw`
import AVFoundation
import Foundation

struct AudioDevice: Codable {
  let displayName: String
  let uniqueId: String
}

struct Probe: Codable {
  let activeMicrophoneMode: String
  let devices: [AudioDevice]
  let preferredMicrophoneMode: String
  let schemaVersion: Int
}

@available(macOS 14.0, *)
func microphoneModeName(_ mode: AVCaptureDevice.MicrophoneMode) -> String {
  switch mode {
  case .standard:
    return "standard"
  case .wideSpectrum:
    return "wide-spectrum"
  case .voiceIsolation:
    return "voice-isolation"
  @unknown default:
    return "unknown"
  }
}

let discovery = AVCaptureDevice.DiscoverySession(
  deviceTypes: [.microphone],
  mediaType: .audio,
  position: .unspecified
)
let devices = discovery.devices.map {
  AudioDevice(displayName: $0.localizedName, uniqueId: $0.uniqueID)
}
var activeMicrophoneMode = "unknown"
var preferredMicrophoneMode = "unknown"
if #available(macOS 14.0, *) {
  activeMicrophoneMode = microphoneModeName(AVCaptureDevice.activeMicrophoneMode)
  preferredMicrophoneMode = microphoneModeName(AVCaptureDevice.preferredMicrophoneMode)
}
let encoded = try JSONEncoder().encode(
  Probe(
    activeMicrophoneMode: activeMicrophoneMode,
    devices: devices,
    preferredMicrophoneMode: preferredMicrophoneMode,
    schemaVersion: 1
  )
)
FileHandle.standardOutput.write(encoded)
`;

/**
 * Resolves the concrete ffmpeg audio selector to AVFoundation's stable ID.
 *
 * ffmpeg publishes only an index and display name. AVFoundation publishes a
 * stable uniqueID but doesn't promise its DiscoverySession order is identical
 * to ffmpeg's private enumeration. Joining on a unique display name is the
 * only fact both surfaces expose; ambiguity therefore fails rather than
 * falling back to an order-based guess.
 */
export async function resolveMacOsAvFoundationInputIdentity(options: {
  claim: Readonly<MacOsCaptureInputIdentity>;
  execute?: MacOsAvFoundationCommandExecutor;
  ffmpegExecutable: string;
  swiftExecutable?: string;
}): Promise<MacOsCaptureInputIdentity> {
  const execute = options.execute ?? executeMacOsProvenanceCommand;
  const listed = await execute(options.ffmpegExecutable, [
    "-hide_banner",
    "-f",
    "avfoundation",
    "-list_devices",
    "true",
    "-i",
    "",
  ]);
  const listedDevices = parseFfmpegAvFoundationAudioDevices(`${listed.stdout}\n${listed.stderr}`);
  const selectedIndex = parseAudioDeviceIndex(options.claim.avFoundationSpecifier);
  const selected = listedDevices.find((device) => device.index === selectedIndex);
  if (!selected) {
    throw new Error(
      `The requested AVFoundation audio input index ${selectedIndex} was not present in ` +
        "ffmpeg's current device inventory.",
    );
  }

  const probe = await readMacOsAvFoundationProbe({
    execute,
    swiftExecutable: options.swiftExecutable,
  });
  const matches = probe.devices.filter((device) => device.displayName === selected.displayName);
  if (matches.length !== 1) {
    throw new Error(
      `The ffmpeg input ${selectedIndex} (${selected.displayName}) did not uniquely map to ` +
        `an AVFoundation unique ID; observed ${matches.length} matches.`,
    );
  }
  const matched = matches[0]!;
  return {
    avFoundationSpecifier: options.claim.avFoundationSpecifier,
    displayName: matched.displayName,
    stableId: matched.uniqueId,
    verification: "host-resolved-coreaudio-uid",
  };
}

/**
 * Reads exactly the microphone processing state AVFoundation makes public.
 *
 * In particular, this does not infer three fictional on/off switches for AGC,
 * echo cancellation, and noise suppression. Apple's Standard and Voice
 * Isolation modes are processed; Wide Spectrum is the documented mode that
 * minimizes processing. Acceptance can require the latter without claiming
 * knowledge AVFoundation does not expose.
 */
export async function readMacOsAvFoundationProcessingProvenance(
  options: {
    execute?: MacOsAvFoundationCommandExecutor;
    swiftExecutable?: string;
  } = {},
): Promise<MacOsCaptureProcessingProvenance> {
  const probe = await readMacOsAvFoundationProbe(options);
  return {
    activeMicrophoneMode: probe.activeMicrophoneMode,
    preferredMicrophoneMode: probe.preferredMicrophoneMode,
    verification: "host-resolved-avfoundation-microphone-mode",
  };
}

async function readMacOsAvFoundationProbe(options: {
  execute?: MacOsAvFoundationCommandExecutor;
  swiftExecutable?: string;
}) {
  const execute = options.execute ?? executeMacOsProvenanceCommand;
  const result = await execute(options.swiftExecutable ?? defaultSwiftExecutable, [
    "-e",
    avFoundationProbeSource,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(
      `Unable to inspect AVFoundation capture provenance (exit ${result.exitCode}).` +
        diagnosticSuffix(result.stderr),
    );
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(result.stdout);
  } catch {
    throw new Error("The AVFoundation provenance probe did not return valid JSON.");
  }
  assertMacOsAvFoundationProbe(decoded);
  return decoded;
}

function parseFfmpegAvFoundationAudioDevices(output: string) {
  const devices: { displayName: string; index: number }[] = [];
  let readingAudioDevices = false;
  for (const line of output.split(/\r?\n/)) {
    if (line.includes("AVFoundation audio devices:")) {
      readingAudioDevices = true;
      continue;
    }
    if (!readingAudioDevices) continue;
    if (line.includes("AVFoundation ") && line.includes(" devices:")) break;
    const match = line.match(/\]\s+\[(\d+)\]\s+(.+?)\s*$/);
    if (!match) continue;
    devices.push({
      displayName: match[2]!,
      index: Number(match[1]),
    });
  }
  if (devices.length === 0) {
    throw new Error("ffmpeg did not report any AVFoundation audio inputs.");
  }
  return devices;
}

function parseAudioDeviceIndex(specifier: string) {
  const separator = specifier.lastIndexOf(":");
  const selector = separator < 0 ? "" : specifier.slice(separator + 1);
  if (!/^\d+$/.test(selector)) {
    throw new Error(
      `The AVFoundation input ${JSON.stringify(specifier)} does not contain a numeric audio ` +
        "device index that can be resolved to a stable identity.",
    );
  }
  const index = Number(selector);
  if (!Number.isSafeInteger(index)) {
    throw new Error("The AVFoundation audio device index is outside the safe integer range.");
  }
  return index;
}

function assertMacOsAvFoundationProbe(value: unknown): asserts value is MacOsAvFoundationProbe {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("The AVFoundation provenance probe schema is invalid.");
  }
  if (
    typeof value.activeMicrophoneMode !== "string" ||
    !supportedMicrophoneModes.has(value.activeMicrophoneMode as MacOsMicrophoneMode) ||
    typeof value.preferredMicrophoneMode !== "string" ||
    !supportedMicrophoneModes.has(value.preferredMicrophoneMode as MacOsMicrophoneMode)
  ) {
    throw new Error("The AVFoundation provenance probe returned an invalid microphone mode.");
  }
  if (!Array.isArray(value.devices)) {
    throw new Error("The AVFoundation provenance probe did not return an audio-device inventory.");
  }
  for (const device of value.devices) {
    if (
      !isRecord(device) ||
      typeof device.displayName !== "string" ||
      !device.displayName.trim() ||
      typeof device.uniqueId !== "string" ||
      !device.uniqueId.trim()
    ) {
      throw new Error("The AVFoundation provenance probe returned an invalid audio device.");
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function diagnosticSuffix(stderr: string) {
  const diagnostic = stderr.trim();
  return diagnostic ? ` ${diagnostic.slice(0, 4_096)}` : "";
}

export const executeMacOsProvenanceCommand: MacOsAvFoundationCommandExecutor = (
  executable,
  arguments_,
) =>
  new Promise((resolve, reject) => {
    execFile(
      executable,
      [...arguments_],
      {
        encoding: "utf8",
        maxBuffer: maximumCommandOutputBytes,
        timeout: commandTimeoutMs,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({
            exitCode: 0,
            stderr,
            stdout,
          });
          return;
        }
        /*
         * ffmpeg deliberately exits nonzero after `-list_devices true`; its
         * stderr is still the successful inventory. Transport failures,
         * timeouts, and missing executables have no numeric child exit and
         * remain hard probe failures.
         */
        if (typeof error.code === "number") {
          resolve({
            exitCode: error.code,
            stderr,
            stdout,
          });
          return;
        }
        reject(new Error(`Unable to execute capture-provenance probe: ${error.message}`));
      },
    );
  });
