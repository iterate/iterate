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
        parts: z.array(
          z.object({
            path: z.string().min(1),
            offset: z.number().int().nonnegative(),
          }),
        ),
      }),
    )
    .min(1),
});

export interface PreparedInstallManifest {
  manifestUrl: string;
  dispose: () => void;
}

function createDisposableObjectUrl(blob: Blob) {
  const value = URL.createObjectURL(blob);
  return {
    value,
    dispose: () => URL.revokeObjectURL(value),
  };
}

export async function prepareInstallManifest(input: {
  device: FirmwareDevice;
  release: EspWebToolsFirmwareRelease;
  configuration: DeviceConfiguration;
}): Promise<PreparedInstallManifest> {
  if (input.device.installMethod.kind !== "esp-web-tools") {
    throw new Error(`${input.device.name} is not configured for ESP Web Tools.`);
  }
  const manifestPath = firmwareManifestPath(input.device.id, input.release.version);
  const manifestUrl = new URL(manifestPath, window.location.href);
  const response = await fetch(manifestUrl);
  if (!response.ok) {
    throw new Error(`Firmware manifest returned HTTP ${response.status}.`);
  }
  const baseManifest = Manifest.parse(await response.json());
  const configurationImage = encodeDeviceConfiguration(
    input.configuration,
    input.release.artifact.configurationPartition.size,
  );
  const configurationObjectUrl = createDisposableObjectUrl(
    new Blob([configurationImage], { type: "application/octet-stream" }),
  );

  try {
    const configuredManifest = {
      ...baseManifest,
      builds: baseManifest.builds.map((build) => ({
        ...build,
        parts: [
          ...build.parts.map((part) => ({
            ...part,
            path: new URL(part.path, manifestUrl).href,
          })),
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
}
