import { z } from "zod";
import type { DeviceConfiguration } from "./config-image.ts";
import { encodeDeviceConfiguration } from "./config-image.ts";
import {
  firmwareManifestPath,
  type FirmwareDevice,
  type EspWebToolsFirmwareRelease,
} from "./catalog.ts";

const Manifest = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  new_install_prompt_erase: z.boolean().optional(),
  new_install_improv_wait_time: z.number().optional(),
  builds: z
    .array(
      z.object({
        chipFamily: z.string().min(1),
        serialType: z.enum(["cdc", "uart"]).optional(),
        parts: z
          .array(
            z.object({
              path: z.string().min(1),
              offset: z.number().int().nonnegative(),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
});

export interface PreparedInstallManifest {
  manifestUrl: string;
  dispose: () => void;
}

export interface InstallManifestTemplate {
  prepare: (configuration: DeviceConfiguration) => PreparedInstallManifest;
}

// ESP Web Tools does not expose a flash-finished event to its host button.
// Keep activated manifests alive for the document lifetime so changing routes
// or fields cannot revoke bytes while its dialog is reading them.
const pageLifetimeObjectUrls = new Set<string>();
let pageHideCleanupRegistered = false;

function registerPageLifetimeObjectUrl(value: string) {
  pageLifetimeObjectUrls.add(value);
  if (pageHideCleanupRegistered) return;
  pageHideCleanupRegistered = true;
  window.addEventListener(
    "pagehide",
    () => {
      for (const objectUrl of pageLifetimeObjectUrls) URL.revokeObjectURL(objectUrl);
      pageLifetimeObjectUrls.clear();
      pageHideCleanupRegistered = false;
    },
    { once: true },
  );
}

function createDisposableObjectUrl(blob: Blob) {
  const value = URL.createObjectURL(blob);
  registerPageLifetimeObjectUrl(value);
  return {
    value,
    dispose: () => {
      if (!pageLifetimeObjectUrls.delete(value)) return;
      URL.revokeObjectURL(value);
    },
  };
}

export async function loadInstallManifestTemplate(input: {
  device: FirmwareDevice;
  release: EspWebToolsFirmwareRelease;
}): Promise<InstallManifestTemplate> {
  const chipFamily = input.device.installMethod.chipFamily;
  const manifestPath = firmwareManifestPath(input.device.id, input.release.version);
  const manifestUrl = new URL(manifestPath, window.location.href);
  const response = await fetch(manifestUrl);
  if (!response.ok) {
    throw new Error(`Firmware manifest returned HTTP ${response.status}.`);
  }
  const baseManifest = Manifest.parse(await response.json());
  const builds = baseManifest.builds.map((build) => ({
    ...build,
    parts: build.parts.map((part) => ({
      ...part,
      path: new URL(part.path, manifestUrl).href,
    })),
  }));
  validateManifest(input.device.name, chipFamily, input.release, baseManifest, builds, manifestUrl);

  return {
    prepare: (configuration) => {
      const configurationImage = encodeDeviceConfiguration(
        configuration,
        input.release.artifact.configurationPartition.size,
      );
      const configurationObjectUrl = createDisposableObjectUrl(
        new Blob([configurationImage], { type: "application/octet-stream" }),
      );

      try {
        const configuredManifest = {
          ...baseManifest,
          builds: builds.map((build) => ({
            ...build,
            parts: [
              ...build.parts,
              {
                path: configurationObjectUrl.value,
                offset: input.release.artifact.configurationPartition.offset,
              },
            ],
          })),
        };
        const configuredManifestObjectUrl = createDisposableObjectUrl(
          new Blob([JSON.stringify(configuredManifest)], { type: "application/json" }),
        );

        return {
          manifestUrl: configuredManifestObjectUrl.value,
          dispose: () => {
            configuredManifestObjectUrl.dispose();
            configurationObjectUrl.dispose();
          },
        };
      } catch (error) {
        configurationObjectUrl.dispose();
        throw error;
      }
    },
  };
}

/** Check the generated manifest against the release that selected it. */
function validateManifest(
  deviceName: string,
  chipFamily: string,
  release: EspWebToolsFirmwareRelease,
  manifest: z.infer<typeof Manifest>,
  builds: {
    chipFamily: string;
    serialType?: "cdc" | "uart";
    parts: { path: string; offset: number }[];
  }[],
  manifestUrl: URL,
): void {
  if (manifest.name !== deviceName) {
    throw new Error(
      `Firmware manifest is for ${JSON.stringify(manifest.name)}, not ${deviceName}.`,
    );
  }
  if (manifest.version !== release.version) {
    throw new Error(
      `Firmware manifest is version ${JSON.stringify(manifest.version)}, not ${release.version}.`,
    );
  }
  const configuration = release.artifact.configurationPartition;
  if (
    !Number.isSafeInteger(configuration.offset) ||
    configuration.offset < 0 ||
    !Number.isSafeInteger(configuration.size) ||
    configuration.size <= 0
  ) {
    throw new Error("Firmware release has an invalid configuration partition.");
  }
  const configurationEnd = configuration.offset + configuration.size;
  if (!Number.isSafeInteger(configurationEnd)) {
    throw new Error("Firmware release configuration partition exceeds safe flash offsets.");
  }
  const manifestDirectory = new URL("./", manifestUrl);
  const expectedParts = release.artifact.parts.map((part) => ({
    fileName: part.fileName,
    offset: part.offset,
  }));
  for (const build of builds) {
    if (build.chipFamily !== chipFamily) {
      throw new Error(`Firmware manifest chip ${build.chipFamily} does not match ${chipFamily}.`);
    }
    if (
      build.parts.length !== expectedParts.length ||
      build.parts.some((part, index) => {
        const expected = expectedParts[index];
        if (!expected || part.offset !== expected.offset) return true;
        const partUrl = new URL(part.path);
        const fileName = partUrl.pathname.slice(partUrl.pathname.lastIndexOf("/") + 1);
        const encodedExpectedFileName = encodeURIComponent(expected.fileName);
        return (
          partUrl.origin !== manifestDirectory.origin ||
          partUrl.pathname.slice(0, partUrl.pathname.lastIndexOf("/") + 1) !==
            manifestDirectory.pathname ||
          fileName.length !== encodedExpectedFileName.length + 65 ||
          fileName[64] !== "-" ||
          !/^[a-f0-9]{64}$/.test(fileName.slice(0, 64)) ||
          fileName.slice(65) !== encodedExpectedFileName
        );
      })
    ) {
      throw new Error("Firmware manifest parts do not match the selected release.");
    }
    if (
      build.parts.some(
        (part) => part.offset >= configuration.offset && part.offset < configurationEnd,
      )
    ) {
      throw new Error("Firmware manifest places a binary inside the configuration partition.");
    }
  }
}
