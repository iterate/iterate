import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeviceConfiguration } from "./config-image.ts";
import type { EspWebToolsFirmwareRelease, FirmwareDevice } from "./catalog.ts";
import { loadInstallManifestTemplate } from "./prepare-manifest.ts";

const device: FirmwareDevice = {
  id: "test-device",
  name: "Test device",
  description: "Test ESP32-S3",
  installMethod: { kind: "esp-web-tools", chipFamily: "ESP32-S3" },
  releases: [],
};

const release: EspWebToolsFirmwareRelease = {
  version: "1.0.0",
  artifact: {
    kind: "esp-web-tools",
    configurationPartition: { offset: 0x9000, size: 512 },
    parts: [],
  },
};

const configuration: DeviceConfiguration = {
  schemaVersion: 1,
  wifi: { ssid: "studio", password: "secret" },
  iterate: {
    baseUrl: "https://os.iterate.com",
    projectSlug: "voice-lab",
    projectApiKey: "itxk_test",
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadInstallManifestTemplate", () => {
  it("fetches firmware once and creates configuration blobs only when activated", async () => {
    const nativeFetch = globalThis.fetch;
    const fetchManifest = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          name: device.name,
          version: release.version,
          builds: [
            {
              chipFamily: "ESP32-S3",
              parts: [{ path: "./firmware.bin", offset: 0 }],
            },
          ],
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchManifest);
    vi.stubGlobal("window", {
      location: { href: "https://k.iterate.com/setup" },
      addEventListener: vi.fn(),
    });

    const template = await loadInstallManifestTemplate({ device, release });

    expect(fetchManifest).toHaveBeenCalledOnce();
    const first = template.prepare(configuration);
    const second = template.prepare({
      ...configuration,
      wifi: { ...configuration.wifi, password: "new-secret" },
    });

    expect(fetchManifest).toHaveBeenCalledOnce();
    expect(first.manifestUrl).not.toBe(second.manifestUrl);

    const manifest = (await (await nativeFetch(first.manifestUrl)).json()) as {
      builds: Array<{ parts: Array<{ path: string; offset: number }> }>;
    };
    expect(manifest.builds[0]?.parts).toEqual([
      {
        path: "https://k.iterate.com/firmware/test-device/1.0.0/firmware.bin",
        offset: 0,
      },
      {
        path: expect.stringMatching(/^blob:/),
        offset: release.artifact.configurationPartition.offset,
      },
    ]);

    first.dispose();
    second.dispose();
  });
});
