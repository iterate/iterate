import { describe, expect, test } from "vitest";
import {
  readMacOsAvFoundationProcessingProvenance,
  resolveMacOsAvFoundationInputIdentity,
  type MacOsAvFoundationCommandExecutor,
} from "./macos-avfoundation-provenance.ts";

const ffmpegDeviceListing = `
[AVFoundation indev @ 0x1] AVFoundation video devices:
[AVFoundation indev @ 0x1] [0] FaceTime Camera
[AVFoundation indev @ 0x1] AVFoundation audio devices:
[AVFoundation indev @ 0x1] [0] MacBook Pro Microphone
[AVFoundation indev @ 0x1] [1] USB Measurement Microphone
[in#0 @ 0x2] Error opening input: Input/output error
`;

function probeJson(
  overrides: Partial<{
    activeMicrophoneMode: string;
    devices: { displayName: string; uniqueId: string }[];
    preferredMicrophoneMode: string;
  }> = {},
) {
  return JSON.stringify({
    activeMicrophoneMode: "wide-spectrum",
    devices: [
      {
        displayName: "MacBook Pro Microphone",
        uniqueId: "BuiltInMicrophoneDevice",
      },
      {
        displayName: "USB Measurement Microphone",
        uniqueId: "AppleUSBAudioEngine:measurement-mic",
      },
    ],
    preferredMicrophoneMode: "wide-spectrum",
    schemaVersion: 1,
    ...overrides,
  });
}

function executorForProbe(
  probe: string,
  deviceListing = ffmpegDeviceListing,
): MacOsAvFoundationCommandExecutor {
  return async (_executable, arguments_) =>
    arguments_.includes("-list_devices")
      ? {
          exitCode: 1,
          stderr: deviceListing,
          stdout: "",
        }
      : {
          exitCode: 0,
          stderr: "",
          stdout: probe,
        };
}

describe("macOS AVFoundation capture provenance", () => {
  test("joins the exact ffmpeg input index to AVFoundation's reconnect-stable unique ID", async () => {
    /*
     * ffmpeg accepts an ephemeral AVFoundation index while acceptance needs an
     * identity that survives hub replugging. Resolve through both inventories:
     * trusting either the index or a caller-supplied display label alone could
     * silently record a different microphone after the device order changes.
     */
    const resolved = await resolveMacOsAvFoundationInputIdentity({
      claim: {
        avFoundationSpecifier: ":1",
        displayName: "unresolved AVFoundation input",
        stableId: "unverified-avfoundation::1",
        verification: "unverified-index",
      },
      execute: executorForProbe(probeJson()),
      ffmpegExecutable: "/opt/homebrew/bin/ffmpeg",
    });

    expect(resolved).toEqual({
      avFoundationSpecifier: ":1",
      displayName: "USB Measurement Microphone",
      stableId: "AppleUSBAudioEngine:measurement-mic",
      verification: "host-resolved-coreaudio-uid",
    });
  });

  test("fails closed when duplicate names make an ffmpeg index impossible to join safely", async () => {
    /*
     * AVFoundation's ffmpeg listing omits unique IDs. If two capture devices
     * share a display name, guessing by DiscoverySession order would turn a
     * diagnostic convenience into false physical evidence.
     */
    await expect(
      resolveMacOsAvFoundationInputIdentity({
        claim: {
          avFoundationSpecifier: ":1",
          displayName: "unresolved AVFoundation input",
          stableId: "unverified-avfoundation::1",
          verification: "unverified-index",
        },
        execute: executorForProbe(
          probeJson({
            devices: [
              {
                displayName: "USB Measurement Microphone",
                uniqueId: "uid-a",
              },
              {
                displayName: "USB Measurement Microphone",
                uniqueId: "uid-b",
              },
            ],
          }),
        ),
        ffmpegExecutable: "/opt/homebrew/bin/ffmpeg",
      }),
    ).rejects.toThrow("not uniquely map");
  });

  test("reports Standard honestly instead of expanding it into fictional disabled DSP switches", async () => {
    /*
     * The previous model let a caller claim AGC, echo cancellation, and noise
     * suppression were all disabled even though AVFoundation exposes no such
     * three-way proof. Apple exposes the active/preferred MicrophoneMode; keep
     * exactly that fact so Standard can never masquerade as a raw capture
     * chain merely because a test adapter supplied optimistic booleans.
     */
    const provenance = await readMacOsAvFoundationProcessingProvenance({
      execute: executorForProbe(
        probeJson({
          activeMicrophoneMode: "standard",
          preferredMicrophoneMode: "wide-spectrum",
        }),
      ),
    });

    expect(provenance).toEqual({
      activeMicrophoneMode: "standard",
      preferredMicrophoneMode: "wide-spectrum",
      verification: "host-resolved-avfoundation-microphone-mode",
    });
    expect(provenance).not.toHaveProperty("automaticGainControl");
    expect(provenance).not.toHaveProperty("echoCancellation");
    expect(provenance).not.toHaveProperty("noiseSuppression");
  });
});
