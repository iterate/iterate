import { z } from "zod";
import type { DeviceConfiguration } from "./config-image.ts";
import { encodeDeviceConfiguration } from "./config-image.ts";
import { firmwareManifestPath, type FirmwareDevice } from "./catalog.ts";

/**
 * Loads a firmware release's `manifest.json` through Kit's own origin (firmware-proxy.ts) and checks
 * it before anything can flash it: the version is the one asked for, every part is a file beside the
 * manifest on this origin, and no part starts inside the configuration partition, which
 * `prepareInstall` fills. Part paths come back absolute, so `flash` needs no base URL to resolve
 * them against.
 *
 * The manifest is a standard esp-web-tools manifest (https://esphome.github.io/esp-web-tools/) plus
 * `configurationPartition`, as apps/kit/scripts/firmware-release.ts `firmwareManifest` writes it.
 */
export async function loadFirmwareManifest(
  release: { deviceId: string; version: string },
  fetchImpl: typeof fetch,
) {
  const manifestUrl = new URL(
    firmwareManifestPath(release.deviceId, release.version),
    window.location.href,
  );
  const response = await fetchImpl(manifestUrl);
  if (!response.ok) throw new Error(`Firmware manifest returned HTTP ${response.status}.`);
  const manifest = ReleaseManifest.parse(await response.json());
  if (manifest.version !== release.version) {
    throw new Error(
      `Firmware manifest is version ${JSON.stringify(manifest.version)}, not ${release.version}.`,
    );
  }
  const directory = new URL("./", manifestUrl).href;
  const { offset, size } = manifest.configurationPartition;
  const builds = manifest.builds.map((build) => ({
    chipFamily: build.chipFamily,
    parts: build.parts.map((part) => {
      const url = new URL(part.path, manifestUrl);
      if (new URL("./", url).href !== directory) {
        throw new Error(`Firmware manifest part ${part.path} is not beside the manifest.`);
      }
      if (part.offset >= offset && part.offset < offset + size) {
        throw new Error("Firmware manifest places a binary inside the configuration partition.");
      }
      return { path: url.href, offset: part.offset };
    }),
  }));
  return {
    version: manifest.version,
    builds,
    configurationPartition: manifest.configurationPartition,
  };
}

/** A checked release manifest, as `loadFirmwareManifest` returns it. */
export type FirmwareManifest = Awaited<ReturnType<typeof loadFirmwareManifest>>;

/**
 * What esp-web-tools' `flash` writes (flash-device.ts): the release's parts plus this install's
 * `ITERKIT1` configuration image at `configurationPartition`, under the device's current name. The
 * image is a blob URL, which `flash` downloads like any other part; disposing revokes it, once
 * flashing has finished with it.
 */
export function prepareInstall(
  manifest: FirmwareManifest,
  device: FirmwareDevice,
  configuration: DeviceConfiguration,
) {
  const configurationImage = URL.createObjectURL(
    new Blob([encodeDeviceConfiguration(configuration, manifest.configurationPartition.size)], {
      type: "application/octet-stream",
    }),
  );
  return {
    manifest: {
      name: device.name,
      version: manifest.version,
      builds: manifest.builds.map((build) => ({
        ...build,
        parts: [
          ...build.parts,
          { path: configurationImage, offset: manifest.configurationPartition.offset },
        ],
      })),
    },
    [Symbol.dispose]: () => URL.revokeObjectURL(configurationImage),
  };
}

const ReleaseManifest = z.object({
  version: z.string().min(1),
  builds: z
    .array(
      z.object({
        chipFamily: z.string().min(1),
        parts: z
          .array(z.object({ path: z.string().min(1), offset: z.number().int().nonnegative() }))
          .min(1),
      }),
    )
    .min(1),
  configurationPartition: z.object({
    offset: z.number().int().nonnegative(),
    size: z.number().int().positive(),
  }),
});
