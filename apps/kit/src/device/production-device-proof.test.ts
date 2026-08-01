import { describe, expect, test } from "vitest";
import type { DeviceConfiguration } from "../firmware/config-image.ts";
import {
  buildProductionDeviceProofPlan,
  parseProductionDeviceProofCliOptions,
} from "./production-device-proof.ts";

const packageDirectory = "/repo/apps/kit";
const configuration: DeviceConfiguration = {
  schemaVersion: 1,
  iterate: {
    baseUrl: "https://os.iterate.com",
    pcmBaseUrl: "https://old-worker.example",
    projectApiKey: "itxk_must_not_enter_the_plan",
    projectId: "prj_from_device",
  },
  wifi: {
    password: "wifi_password_must_not_enter_the_plan",
    ssid: "voice-lab",
  },
};

describe("unattended production device proof", () => {
  test("preserves the reviewed no-argument Stick route", () => {
    const options = parseProductionDeviceProofCliOptions([], {}, packageDirectory);

    expect(options).toMatchObject({
      buildDirectory: "/repo/apps/kit/firmware/targets/m5sticks3/build",
      deviceHost: "192.168.0.21",
      deviceId: "m5sticks3",
      deviceMac: "70:04:1D:D5:45:88",
      port: "/dev/cu.usbmodem11201",
      projectSlug: "kit-stick-vertical-proof",
      workerHost: "kit--kit-stick-vertical-proof.iterate.app",
    });
  });

  test("selects a catalogued StackChan and its current physical route explicitly", () => {
    const options = parseProductionDeviceProofCliOptions(
      [
        "--device-id",
        "stackchan",
        "--device-mac",
        "68:ee:8f:d8:53:20",
        "--port",
        "/dev/cu.usbmodem11101",
        "--build-directory",
        "firmware/targets/stackchan/build",
        "--device-host",
        "192.168.0.31",
        "--worker-host",
        "stackchan--voice-lab.iterate.app",
        "--project-id",
        "prj_stackchan_voice",
        "--project-slug",
        "stackchan-voice-lab",
        "--flash-firmware",
        "--install-userspace",
      ],
      {},
      packageDirectory,
    );

    expect(options).toEqual({
      buildDirectory: "/repo/apps/kit/firmware/targets/stackchan/build",
      deviceHost: "192.168.0.31",
      deviceId: "stackchan",
      deviceMac: "68:EE:8F:D8:53:20",
      flashFirmware: true,
      installUserspace: true,
      mode: "grok",
      outputDirectory: "/repo/apps/kit/evidence/stackchan-production-grok-from-device",
      port: "/dev/cu.usbmodem11101",
      projectId: "prj_stackchan_voice",
      projectSlug: "stackchan-voice-lab",
      workerHost: "stackchan--voice-lab.iterate.app",
    });
  });

  test("rejects a target that is not in the firmware catalog", () => {
    expect(() =>
      parseProductionDeviceProofCliOptions(
        ["--device-id", "lookalike-stick"],
        {},
        packageDirectory,
      ),
    ).toThrow("firmware catalog");
  });

  test("routes generic flashing and Grok proof without retaining either secret", () => {
    const options = parseProductionDeviceProofCliOptions(
      [
        "--device-id",
        "stackchan",
        "--device-mac",
        "68:EE:8F:D8:53:20",
        "--port",
        "/dev/cu.usbmodem11101",
        "--device-host",
        "192.168.0.31",
        "--worker-host",
        "stackchan--voice-lab.iterate.app",
        "--project-id",
        "prj_stackchan_voice",
        "--project-slug",
        "stackchan-voice-lab",
      ],
      {},
      packageDirectory,
    );

    const plan = buildProductionDeviceProofPlan(options, configuration);

    expect(plan.flashArgs).toEqual([
      "--device",
      "stackchan",
      "--port",
      "/dev/cu.usbmodem11101",
      "--wifi-ssid",
      "voice-lab",
      "--project-id",
      "prj_stackchan_voice",
      "--base-url",
      "https://os.iterate.com",
      "--pcm-base-url",
      "https://stackchan--voice-lab.iterate.app",
      "--build-directory",
      "/repo/apps/kit/firmware/targets/stackchan/build",
    ]);
    expect(plan.grokProofArgs).toEqual([
      "--device-id",
      "stackchan",
      "--device-host",
      "192.168.0.31",
      "--worker-host",
      "stackchan--voice-lab.iterate.app",
      "--project-id",
      "prj_stackchan_voice",
      "--project-slug",
      "stackchan-voice-lab",
      "--output-directory",
      "/repo/apps/kit/evidence/stackchan-production-grok-from-device",
      "--remote-ptt",
    ]);
    expect(plan.provenance).toEqual({
      device: {
        buildDirectory: "/repo/apps/kit/firmware/targets/stackchan/build",
        currentPort: "/dev/cu.usbmodem11101",
        host: "192.168.0.31",
        id: "stackchan",
        name: "StackChan",
        stableUsbSerial: "68:EE:8F:D8:53:20",
      },
      project: {
        baseUrl: "https://os.iterate.com",
        id: "prj_stackchan_voice",
        slug: "stackchan-voice-lab",
        workerHost: "stackchan--voice-lab.iterate.app",
      },
      routes: {
        capabilityMountPath: ["kit", "stackchan"],
        pcmUrl: "https://stackchan--voice-lab.iterate.app/pcm",
        providerEventStreamPath: "/devices/stackchan",
      },
      schemaVersion: 1,
    });
    expect(JSON.stringify(plan)).not.toContain("itxk_must_not_enter_the_plan");
    expect(JSON.stringify(plan)).not.toContain("wifi_password_must_not_enter_the_plan");
  });
});
