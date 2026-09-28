import { expect, test, vi } from "vitest";
import { firmwareManifest } from "../../scripts/firmware-release.ts";
import { DEFAULT_DEVICE_ID, findFirmwareDevice } from "./catalog.ts";
import type { DeviceConfiguration } from "./config-image.ts";
import { loadFirmwareManifest, prepareInstall } from "./prepare-manifest.ts";

const release = { deviceId: "test-device", version: "000001-2026-01-01-abcdef0" };
const releaseManifest = {
  name: "Test device",
  version: release.version,
  builds: [
    {
      chipFamily: "ESP32-S3",
      parts: [
        { path: "./bootloader.bin", offset: 0 },
        { path: "./iterate-kit-test.bin", offset: 0x10000 },
      ],
    },
  ],
  configurationPartition: { offset: 0x9000, size: 0x1000 },
};
const configuration: DeviceConfiguration = {
  wifi: { ssid: "studio", password: "secret123" },
  iterate: {
    baseUrl: "https://os.iterate.com",
    projectId: "prj_voice_lab",
    projectApiKey: "itxk_test",
  },
  statusVoice: "greensleeves",
};

test("loadFirmwareManifest: fetches from Kit's origin and makes the part paths absolute", async () => {
  stubKitPage();
  const fetchManifest = serving(releaseManifest);

  const manifest = await loadFirmwareManifest(release, fetchManifest);

  expect(fetchManifest).toHaveBeenCalledExactlyOnceWith(
    new URL("https://k.iterate.com/firmware/test-device/000001-2026-01-01-abcdef0/manifest.json"),
  );
  expect(manifest).toEqual({
    version: release.version,
    builds: [
      {
        chipFamily: "ESP32-S3",
        parts: [
          {
            path: "https://k.iterate.com/firmware/test-device/000001-2026-01-01-abcdef0/bootloader.bin",
            offset: 0,
          },
          {
            path: "https://k.iterate.com/firmware/test-device/000001-2026-01-01-abcdef0/iterate-kit-test.bin",
            offset: 0x10000,
          },
        ],
      },
    ],
    configurationPartition: { offset: 0x9000, size: 0x1000 },
  });
});

test.for([
  {
    name: "another version",
    manifest: { ...releaseManifest, version: "000002-2026-01-02-abcdef1" },
    error:
      'Firmware manifest is version "000002-2026-01-02-abcdef1", not 000001-2026-01-01-abcdef0.',
  },
  ...["../other/bootloader.bin", "./sub/bootloader.bin", "https://example.com/bootloader.bin"].map(
    (path) => ({
      name: `a part at ${path}`,
      manifest: withPart({ path, offset: 0 }),
      error: `Firmware manifest part ${path} is not beside the manifest.`,
    }),
  ),
  {
    name: "a part inside the configuration partition",
    manifest: withPart({ path: "./bootloader.bin", offset: 0x9800 }),
    error: "Firmware manifest places a binary inside the configuration partition.",
  },
  {
    name: "no configuration partition",
    manifest: { ...releaseManifest, configurationPartition: undefined },
    error: /configurationPartition/,
  },
])("loadFirmwareManifest: refuses a manifest with $name", async ({ manifest, error }) => {
  stubKitPage();

  await expect(loadFirmwareManifest(release, serving(manifest))).rejects.toThrow(error);
});

test("loadFirmwareManifest: refuses a manifest Kit could not serve", async () => {
  stubKitPage();
  const notFound = vi.fn<typeof fetch>(async () => new Response("Not found.", { status: 404 }));

  await expect(loadFirmwareManifest(release, notFound)).rejects.toThrow(
    "Firmware manifest returned HTTP 404.",
  );
});

// the builder's output is the contract this module reads
test("loadFirmwareManifest: loads what apps/kit/scripts/firmware-release.ts publishes", async () => {
  stubKitPage();
  const device = findFirmwareDevice(DEFAULT_DEVICE_ID)!;
  const version = "002574-2026-09-23-b2a4558";
  const files = [
    "bootloader.bin",
    "partition-table.bin",
    "iterate-kit-havpe.bin",
    "ota_data_initial.bin",
    "srmodels.bin",
  ];
  const published = firmwareManifest({
    device,
    version,
    chip: "esp32s3",
    parts: [0, 0x8000, 0x10000, 0x511000, 0xa20000].map((offset, index) => ({
      file: files[index]!,
      offset,
    })),
    configurationPartition: { offset: 0x510000, size: 0x1000 },
  });

  const manifest = await loadFirmwareManifest({ deviceId: device.id, version }, serving(published));

  expect(manifest).toMatchObject({
    version,
    builds: [
      {
        chipFamily: "ESP32-S3",
        parts: files.map((file) => ({
          path: `https://k.iterate.com/firmware/${device.id}/${version}/${file}`,
        })),
      },
    ],
    configurationPartition: { offset: 0x510000, size: 0x1000 },
  });
});

test("prepareInstall: adds the install's configuration image under the device's name, until disposed", async () => {
  stubKitPage();
  const nativeFetch = globalThis.fetch;
  const manifest = await loadFirmwareManifest(release, serving(releaseManifest));

  const install = prepareInstall(
    manifest,
    { id: "test-device", target: "test", name: "Renamed device", description: "", startCall: "" },
    configuration,
  );

  expect(install).toMatchObject({
    manifest: {
      name: "Renamed device",
      version: release.version,
      builds: [
        {
          chipFamily: "ESP32-S3",
          parts: [
            ...manifest.builds[0]!.parts,
            { path: expect.stringMatching(/^blob:/), offset: 0x9000 },
          ],
        },
      ],
    },
  });
  const imageUrl = install.manifest.builds[0]!.parts[2]!.path;
  const image = await (await nativeFetch(imageUrl)).arrayBuffer();
  expect(new TextDecoder().decode(image.slice(0, 8))).toBe("ITERKIT1");
  expect(image).toMatchObject({ byteLength: 0x1000 });

  install[Symbol.dispose]();
  await expect(nativeFetch(imageUrl)).rejects.toThrow();
});

/** The page the loader runs on; the Kit vitest config unstubs it after each test. */
function stubKitPage() {
  vi.stubGlobal("window", {
    location: { href: "https://k.iterate.com/devices/test-device/firmware/latest" },
  });
}

function serving(manifest: unknown) {
  return vi.fn<typeof fetch>(async () => Response.json(manifest));
}

function withPart(part: { path: string; offset: number }) {
  return { ...releaseManifest, builds: [{ chipFamily: "ESP32-S3", parts: [part] }] };
}
