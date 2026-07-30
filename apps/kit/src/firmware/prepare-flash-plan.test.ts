import { describe, expect, it, vi } from "vitest";
import type { DeviceConfiguration } from "./config-image.ts";
import type { EspSerialFirmwareRelease, FirmwareDevice } from "./catalog.ts";
import { prepareFirmwareFlashPlan } from "./prepare-flash-plan.ts";

const device: FirmwareDevice = {
  id: "test-device",
  name: "Test device",
  description: "Test ESP32-S3",
  installMethod: { kind: "esp-serial", chipFamily: "ESP32-S3" },
  releases: [],
};

const release: EspSerialFirmwareRelease = {
  version: "1.0.0",
  artifact: {
    kind: "esp-serial",
    configurationPartition: { offset: 0x9000, size: 512 },
    parts: [
      {
        sourceUrl: "https://firmware.example/app.bin",
        fileName: "app.bin",
        offset: 0x10_000,
        sha256: "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
      },
    ],
  },
};

const configuration: DeviceConfiguration = {
  schemaVersion: 1,
  wifi: { ssid: "studio", password: "secret" },
  iterate: {
    baseUrl: "https://os.iterate.com",
    projectId: "prj_voice_lab",
    projectApiKey: "itxk_test",
  },
};

describe("prepareFirmwareFlashPlan", () => {
  it("produces the same verified multi-offset byte plan for every transport", async () => {
    const loadPart = vi.fn().mockResolvedValue(Uint8Array.of(1, 2, 3, 4));

    const plan = await prepareFirmwareFlashPlan({
      configuration,
      device,
      loadPart,
      release,
    });

    expect(loadPart).toHaveBeenCalledOnce();
    expect(plan.chipFamily).toBe("ESP32-S3");
    expect(plan.eraseAll).toBe(true);
    expect(plan.parts).toHaveLength(2);
    expect(plan.parts[0]).toEqual({
      address: 0x10_000,
      data: Uint8Array.of(1, 2, 3, 4),
      label: "app.bin",
    });
    expect(plan.parts[1]).toMatchObject({
      address: 0x9000,
      label: "iterate-kit/v1 configuration",
    });
    expect(new TextDecoder().decode(plan.parts[1]!.data.slice(0, 8))).toBe("ITERKIT1");
  });

  it("rejects artifact bytes that do not match the reviewed catalog digest", async () => {
    await expect(
      prepareFirmwareFlashPlan({
        configuration,
        device,
        loadPart: async () => Uint8Array.of(4, 3, 2, 1),
        release,
      }),
    ).rejects.toThrow("app.bin SHA-256 mismatch");
  });

  it("rejects an ESP artifact attached to a non-serial install method", async () => {
    await expect(
      prepareFirmwareFlashPlan({
        configuration,
        device: { ...device, installMethod: { kind: "uf2-download" } },
        loadPart: async () => Uint8Array.of(1, 2, 3, 4),
        release,
      }),
    ).rejects.toThrow("not configured for browser or CLI serial flashing");
  });
});
