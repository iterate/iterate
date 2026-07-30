import { describe, expect, test } from "vitest";
import { deviceE2eUsesGrokProvider, parseDeviceE2eCliOptions } from "./device-e2e-cli-options.ts";

describe("device E2E CLI options", () => {
  test("defaults to the Iterate gateway and preserves flash CLI arguments", () => {
    expect(
      parseDeviceE2eCliOptions(
        [
          "--port",
          "/dev/cu.usbmodem101",
          "--wifi-ssid",
          "studio",
          "--build-directory",
          "firmware/build",
        ],
        {},
      ),
    ).toEqual({
      exitAfterRemoteProof: false,
      flash: true,
      flashArgs: [
        "--port",
        "/dev/cu.usbmodem101",
        "--wifi-ssid",
        "studio",
        "--build-directory",
        "firmware/build",
      ],
      gateway: "https://tunnels.iterate.com",
      grokPlaybackOnly: false,
      mountTimeoutMs: 90_000,
      playbackEndurance: false,
      remoteHoldMs: 500,
      tonePlaybackOnly: false,
      toneDurationMs: 3_000,
      tunnelName: undefined,
      voice: false,
    });
  });

  test("enables the PCM lane with a deterministic provider without requiring Grok", () => {
    expect(
      parseDeviceE2eCliOptions(
        ["--tone-playback-only", "--tone-duration-ms", "60000", "--port", "/dev/cu.usbmodem101"],
        {},
      ),
    ).toMatchObject({
      flashArgs: ["--port", "/dev/cu.usbmodem101"],
      tonePlaybackOnly: true,
      toneDurationMs: 60_000,
      voice: true,
    });
  });

  test("selects the graduated playback endurance proof without forwarding it to the flasher", () => {
    /*
     * Endurance is a complete proof mode, not a duration modifier for the
     * single-tone smoke test. Giving it its own parsed bit lets the real E2E
     * entrypoint construct the stricter target adapter while still enabling
     * the independent PCM transport shared by every voice proof.
     */
    expect(
      parseDeviceE2eCliOptions(["--playback-endurance", "--port", "/dev/cu.usbmodem101"], {}),
    ).toMatchObject({
      flashArgs: ["--port", "/dev/cu.usbmodem101"],
      playbackEndurance: true,
      voice: true,
    });
  });

  test("does not make deterministic endurance depend on a Grok credential", () => {
    /*
     * Playback endurance shares the device's voice transport shape but owns a
     * deterministic acoustic challenge. Accidentally keying provider setup
     * from the broad `voice` bit makes the real command fail for XAI_API_KEY
     * before it can report a missing device acceptance operation.
     */
    const endurance = parseDeviceE2eCliOptions(["--playback-endurance"], {});
    const grok = parseDeviceE2eCliOptions(["--grok-playback-only"], {});

    expect(deviceE2eUsesGrokProvider(endurance)).toBe(false);
    expect(deviceE2eUsesGrokProvider(grok)).toBe(true);
  });

  test("rejects ambiguous requests for more than one voice proof", () => {
    expect(() =>
      parseDeviceE2eCliOptions(["--tone-playback-only", "--grok-playback-only"], {}),
    ).toThrow("Choose exactly one voice proof");
    expect(() => parseDeviceE2eCliOptions(["--voice", "--tone-playback-only"], {})).toThrow(
      "Choose exactly one voice proof",
    );
    expect(() => parseDeviceE2eCliOptions(["--grok-playback-only", "--voice"], {})).toThrow(
      "Choose exactly one voice proof",
    );
    expect(() =>
      parseDeviceE2eCliOptions(["--playback-endurance", "--tone-playback-only"], {}),
    ).toThrow("Choose exactly one voice proof");
    expect(() => parseDeviceE2eCliOptions(["--playback-endurance", "--voice"], {})).toThrow(
      "Choose exactly one voice proof",
    );
  });

  test("extracts harness options without forwarding them to the flasher", () => {
    expect(
      parseDeviceE2eCliOptions(
        [
          "--no-flash",
          "--exit-after-remote-proof",
          "--grok-playback-only",
          "--mount-timeout-ms",
          "120000",
          "--remote-hold-ms",
          "250",
          "--tunnel-name",
          "stick-e2e",
          "--port",
          "/dev/cu.usbmodem101",
        ],
        { CAPTUN_GATEWAY: "https://gateway.invalid" },
      ),
    ).toEqual({
      exitAfterRemoteProof: true,
      flash: false,
      flashArgs: ["--port", "/dev/cu.usbmodem101"],
      gateway: "https://gateway.invalid",
      grokPlaybackOnly: true,
      mountTimeoutMs: 120_000,
      playbackEndurance: false,
      remoteHoldMs: 250,
      tonePlaybackOnly: false,
      toneDurationMs: 3_000,
      tunnelName: "stick-e2e",
      voice: true,
    });
  });

  test("reserves the base URL for the live tunnel and rejects nonsensical timing", () => {
    expect(() => parseDeviceE2eCliOptions(["--base-url", "https://wrong.invalid"], {})).toThrow(
      "--base-url is supplied by the live tunnel",
    );
    expect(() => parseDeviceE2eCliOptions(["--mount-timeout-ms", "0"], {})).toThrow(
      "mount timeout",
    );
    expect(() => parseDeviceE2eCliOptions(["--remote-hold-ms", "forever"], {})).toThrow(
      "remote hold",
    );
    expect(() =>
      parseDeviceE2eCliOptions(["--tone-playback-only", "--tone-duration-ms", "1001"], {}),
    ).toThrow("whole 20 ms PCM frames");
    expect(() => parseDeviceE2eCliOptions(["--tone-duration-ms", "2000"], {})).toThrow(
      "--tone-duration-ms requires --tone-playback-only",
    );
  });

  test("allows a long push-to-talk hold for continuous-streaming endurance proofs", () => {
    expect(parseDeviceE2eCliOptions(["--remote-hold-ms", "60000"], {})).toMatchObject({
      remoteHoldMs: 60_000,
    });
  });
});
