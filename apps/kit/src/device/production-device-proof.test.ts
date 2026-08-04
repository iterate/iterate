import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import type { DeviceConfiguration } from "../firmware/config-image.ts";
import {
  buildProductionDeviceProofPlan,
  parseProductionDeviceProofCliOptions,
} from "./production-device-proof.ts";

const packageDirectory = "/repo/apps/kit";
const currentStickRoute = { ITERATE_KIT_PORT: "/dev/cu.usbmodem11301" } as const;
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
  test("requires the current Stick port instead of trusting a stale hub enumeration", () => {
    /*
     * The former no-argument default was /dev/cu.usbmodem11201. After one hub
     * move that path belonged to the denylisted Waveshare, so even reading the
     * Stick configuration would have reset the wrong physical board. A stable
     * MAC remains the identity, but the destructive outer proof must receive
     * a freshly resolved path for this transaction.
     */
    expect(() => parseProductionDeviceProofCliOptions([], {}, packageDirectory)).toThrow(
      "--port or ITERATE_KIT_PORT",
    );

    const options = parseProductionDeviceProofCliOptions(
      ["--port", "/dev/cu.usbmodem11301"],
      {},
      packageDirectory,
    );

    expect(options).toMatchObject({
      buildDirectory: "/repo/apps/kit/firmware/targets/m5sticks3/build",
      deviceHost: "192.168.0.21",
      deviceId: "m5sticks3",
      deviceMac: "70:04:1D:D5:45:88",
      port: "/dev/cu.usbmodem11301",
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
      scenario: "conversation",
      turns: 1,
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

  test("forwards a bounded multi-turn conversation through the device-backed production proof", () => {
    const options = parseProductionDeviceProofCliOptions(
      ["--turns", "3"],
      currentStickRoute,
      packageDirectory,
    );

    const plan = buildProductionDeviceProofPlan(options, configuration);

    expect(options.turns).toBe(3);
    expect(plan.grokProofArgs).toContain("--turns");
    expect(plan.grokProofArgs.at(plan.grokProofArgs.indexOf("--turns") + 1)).toBe("3");
  });

  test("forwards the count-to-one-hundred physical scenario", () => {
    const options = parseProductionDeviceProofCliOptions(
      ["--count-to-100"],
      currentStickRoute,
      packageDirectory,
    );

    const plan = buildProductionDeviceProofPlan(options, configuration);

    expect(options.scenario).toBe("count-to-100");
    expect(plan.grokProofArgs).toContain("--count-to-100");
  });

  test("the Stick proof consumes count scenarios at both independent evidence seams", async () => {
    /*
     * A production run accepted --count-to-100, returned passed:true, and had
     * perfectly healthy transport, but the Stick proof never read the parsed
     * scenario. It ran its default sprite-tool sentence instead. Parser tests
     * could only prove that the flag reached the inner CLI; this architecture
     * boundary prevents that CLI from accepting the flag unless its runtime
     * explicitly selects the count plan, assesses provider and Mac-microphone
     * ledgers independently, and retains the result in the manifest.
     */
    const source = await readFile(
      new URL("../../scripts/prove-production-m5sticks3-grok.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("productionSpokenCountPlan(options.scenario)");
    expect(source).toContain("assessOverlappingSpokenCountEvidence({");
    expect(source).toContain("spokenCount: spokenCountEvidence ?? null");
  });

  test.each([
    "--count-100-to-200",
    "--count-200-to-300",
    "--count-300-to-400-interrupted",
  ] as const)(
    "forwards the later physical spoken-count scenario %s without translation",
    (flag) => {
      /*
       * The outer flash/provision runner must launch the exact same proof mode
       * as the inner production harness. Losing this flag would produce a
       * healthy short conversation while falsely labelling it an endurance
       * gate in the surrounding device provenance.
       */
      const options = parseProductionDeviceProofCliOptions(
        [flag],
        currentStickRoute,
        packageDirectory,
      );

      const plan = buildProductionDeviceProofPlan(options, configuration);

      expect(plan.grokProofArgs).toContain(flag);
    },
  );

  test("keeps the HAVPE slug on media routes while using its identifier-safe capability mount", () => {
    /*
     * The PCM header and retained stream use the stable catalog slug, but OS
     * capability members follow JavaScript identifier grammar. Treating these
     * as the same string authenticated the physical board and then rejected
     * its production mount, so the proof plan must preserve both spellings.
     */
    const options = parseProductionDeviceProofCliOptions(
      [
        "--device-id",
        "home-assistant-voice-preview-edition",
        "--port",
        "/dev/cu.usbmodem11101",
        "--device-host",
        "192.168.1.159",
        "--worker-host",
        "kit--kit-havpe-voice-e2e-20260802.iterate.app",
        "--project-id",
        "prj_havpe_voice",
      ],
      {},
      packageDirectory,
    );

    const plan = buildProductionDeviceProofPlan(options, configuration);

    expect(plan.provenance.routes).toEqual({
      capabilityMountPath: ["kit", "homeAssistantVoicePreviewEdition"],
      pcmUrl: "https://kit--kit-havpe-voice-e2e-20260802.iterate.app/pcm",
      providerEventStreamPath: "/devices/home-assistant-voice-preview-edition",
    });
  });
});
