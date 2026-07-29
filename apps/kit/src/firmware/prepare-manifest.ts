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
  const builds = baseManifest.builds.map((build) => ({
    ...build,
    parts: build.parts.map((part) => ({
      ...part,
      path: new URL(part.path, manifestUrl).href,
    })),
  }));

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
