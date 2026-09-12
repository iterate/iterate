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
    target: "test-device",
    configurationPartition: { offset: 0x9000, size: 512 },
    parts: [
      {
        buildPath: "firmware.bin",
        fileName: "firmware.bin",
        offset: 0,
      },
    ],
  },
};

const artifactHash = "a".repeat(64);

const configuration: DeviceConfiguration = {
  schemaVersion: 1,
  wifi: { ssid: "studio", password: "secret123" },
  iterate: {
    baseUrl: "https://os.iterate.com",
    projectId: "prj_voice_lab",
    projectApiKey: "itxk_test",
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadInstallManifestTemplate", () => {
  it("fetches firmware once and creates configuration blobs only when activated", async () => {
    const nativeFetch = globalThis.fetch;
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL");
    const fetchManifest = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          name: device.name,
          version: release.version,
          builds: [
            {
              chipFamily: "ESP32-S3",
              parts: [{ path: `./${artifactHash}-firmware.bin`, offset: 0 }],
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
        path: `https://k.iterate.com/firmware/test-device/1.0.0/${artifactHash}-firmware.bin`,
        offset: 0,
      },
      {
        path: expect.stringMatching(/^blob:/),
        offset: release.artifact.configurationPartition.offset,
      },
    ]);

    const configurationPart = manifest.builds[0]?.parts[1];
    expect(configurationPart?.path).toMatch(/^blob:/);
    expect(
      new Uint8Array(await (await nativeFetch(configurationPart!.path)).arrayBuffer()),
    ).toHaveLength(release.artifact.configurationPartition.size);
    expect(revokeObjectUrl).not.toHaveBeenCalled();

    first.dispose();
    expect(revokeObjectUrl).toHaveBeenCalledTimes(2);
    second.dispose();
    expect(revokeObjectUrl).toHaveBeenCalledTimes(4);
  });

  it("rejects a manifest for another chip or release", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            name: device.name,
            version: release.version,
            builds: [
              {
                chipFamily: "ESP32-C3",
                parts: [{ path: `./${artifactHash}-firmware.bin`, offset: 0 }],
              },
            ],
          }),
        ),
      ),
    );
    vi.stubGlobal("window", {
      location: { href: "https://k.iterate.com/setup" },
      addEventListener: vi.fn(),
    });

    await expect(loadInstallManifestTemplate({ device, release })).rejects.toThrow(
      "does not match ESP32-S3",
    );
  });

  it("refuses a release whose binary would overwrite its configuration partition", async () => {
    const overlappingRelease: EspWebToolsFirmwareRelease = {
      ...release,
      artifact: {
        ...release.artifact,
        parts: [{ ...release.artifact.parts[0]!, offset: 0x9000 }],
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            name: device.name,
            version: release.version,
            builds: [
              {
                chipFamily: "ESP32-S3",
                parts: [{ path: `./${artifactHash}-firmware.bin`, offset: 0x9000 }],
              },
            ],
          }),
        ),
      ),
    );
    vi.stubGlobal("window", {
      location: { href: "https://k.iterate.com/setup" },
      addEventListener: vi.fn(),
    });

    await expect(
      loadInstallManifestTemplate({ device, release: overlappingRelease }),
    ).rejects.toThrow("inside the configuration partition");
  });
});
