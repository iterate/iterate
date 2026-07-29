export const DEFAULT_DEVICE_ID = "home-assistant-voice-preview-edition";
export const DEFAULT_FIRMWARE_VERSION = "latest";

export type EspChipFamily =
  | "ESP32"
  | "ESP32-C2"
  | "ESP32-C3"
  | "ESP32-C5"
  | "ESP32-C6"
  | "ESP32-C61"
  | "ESP32-H2"
  | "ESP32-P4"
  | "ESP32-S2"
  | "ESP32-S3"
  | "ESP8266";

export type InstallMethod =
  | { kind: "esp-web-tools"; chipFamily: EspChipFamily }
  | { kind: "uf2-download" }
  | { kind: "webusb-dfu"; vendorId: number; productId?: number }
  | { kind: "external-tool"; instructionsUrl: string };

export interface FirmwareSourcePart {
  /** Immutable HTTPS download for this exact binary. */
  sourceUrl: string;
  /** File name emitted under public/firmware/<device>/<version>/. */
  fileName: string;
  /** ESP flash address. */
  offset: number;
  /** Lowercase SHA-256 of the source bytes. Builds reject a mismatch. */
  sha256: string;
}

interface FirmwareReleaseBase {
  version: string;
}

export interface EspWebToolsFirmwareRelease extends FirmwareReleaseBase {
  artifact: {
    kind: "esp-web-tools";
    /** Raw flash region the Iterate firmware reads as iterate-kit/v1 config. */
    configurationPartition: {
      offset: number;
      size: number;
    };
    parts: readonly FirmwareSourcePart[];
  };
}

export interface Uf2FirmwareRelease extends FirmwareReleaseBase {
  artifact: {
    kind: "uf2";
    sourceUrl: string;
    fileName: string;
    sha256: string;
  };
}

export interface WebUsbDfuFirmwareRelease extends FirmwareReleaseBase {
  artifact: {
    kind: "webusb-dfu";
    sourceUrl: string;
    fileName: string;
    sha256: string;
  };
}

export interface ExternalToolFirmwareRelease extends FirmwareReleaseBase {
  artifact: {
    kind: "external-tool";
    downloadUrl: string;
  };
}

export type FirmwareRelease =
  | EspWebToolsFirmwareRelease
  | Uf2FirmwareRelease
  | WebUsbDfuFirmwareRelease
  | ExternalToolFirmwareRelease;

export interface FirmwareDevice {
  id: string;
  name: string;
  description: string;
  installMethod: InstallMethod;
  releases: readonly FirmwareRelease[];
}

/**
 * The deployment firmware inventory.
 *
 * Releases deliberately start empty: stock Home Assistant / StackChan images
 * do not understand Iterate's project credential, so offering them here would
 * produce a device that flashed successfully but could never connect. Add an
 * Iterate-aware release only after its binaries, offsets, config partition,
 * and SHA-256 digests are known. `pnpm firmware:sync` then mirrors those exact
 * bytes into the Worker's static assets and emits ESP Web Tools manifests.
 */
export const firmwareCatalog: readonly FirmwareDevice[] = [
  {
    id: DEFAULT_DEVICE_ID,
    name: "Home Assistant Voice Preview Edition",
    description: "ESP32-S3 voice satellite",
    installMethod: { kind: "esp-web-tools", chipFamily: "ESP32-S3" },
    releases: [],
  },
  {
    id: "stackchan",
    name: "StackChan",
    description: "M5Stack CoreS3 desktop companion",
    installMethod: { kind: "esp-web-tools", chipFamily: "ESP32-S3" },
    releases: [],
  },
];

export function findFirmwareDevice(deviceId: string) {
  return firmwareCatalog.find((device) => device.id === deviceId);
}

export function resolveFirmwareRelease(
  device: FirmwareDevice,
  requestedVersion: string,
): FirmwareRelease | undefined {
  if (requestedVersion === DEFAULT_FIRMWARE_VERSION) {
    return device.releases[0];
  }
  return device.releases.find((release) => release.version === requestedVersion);
}

export function isEspWebToolsRelease(
  release: FirmwareRelease,
): release is EspWebToolsFirmwareRelease {
  return release.artifact.kind === "esp-web-tools";
}

export function firmwareManifestPath(deviceId: string, version: string) {
  return `/firmware/${encodeURIComponent(deviceId)}/${encodeURIComponent(version)}/manifest.json`;
}
