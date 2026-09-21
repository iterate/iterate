export const DEFAULT_DEVICE_ID = "home-assistant-voice-preview-edition";
export const DEFAULT_FIRMWARE_VERSION = "latest";
export const espWebToolsChipFamily = "ESP32-S3";
export const publicEspWebToolsInstallMethod = {
  kind: "esp-web-tools",
  chipFamily: espWebToolsChipFamily,
} as const;

export interface FirmwareBuildPart {
  /** Path relative to the target's ESP-IDF build directory. */
  buildPath: string;
  /** Stable name emitted beneath public/firmware/<device>/<version>/. */
  fileName: string;
  /** ESP flash address. */
  offset: number;
}

export interface EspWebToolsFirmwareRelease {
  version: string;
  artifact: {
    kind: "esp-web-tools";
    /** ESP-IDF target directory under firmware/targets/. */
    target: string;
    /** Raw flash region the Iterate firmware reads as iterate-kit/v1 config. */
    configurationPartition: {
      offset: number;
      size: number;
    };
    /** The exact ESP-IDF flash plan, including bootloader and model images. */
    parts: readonly FirmwareBuildPart[];
  };
}

export interface FirmwareDevice {
  id: string;
  name: string;
  description: string;
  /** Compact label for the hardware proof command's output. */
  proofLabel: string;
  releases: readonly EspWebToolsFirmwareRelease[];
}

interface BoardProofTarget {
  name: string;
  label: string;
}

const bootloader = {
  buildPath: "bootloader/bootloader.bin",
  fileName: "bootloader.bin",
  offset: 0,
};
const partitionTable = {
  buildPath: "partition_table/partition-table.bin",
  fileName: "partition-table.bin",
  offset: 0x8000,
};

function release(input: {
  version?: string;
  target: string;
  app: string;
  otaDataOffset: number;
  configurationOffset: number;
  hasWakeWordModel?: boolean;
}): EspWebToolsFirmwareRelease {
  return {
    version: input.version || "gpt-live-1",
    artifact: {
      kind: "esp-web-tools",
      target: input.target,
      configurationPartition: { offset: input.configurationOffset, size: 0x1000 },
      parts: [
        bootloader,
        partitionTable,
        { buildPath: input.app, fileName: input.app, offset: 0x10000 },
        {
          buildPath: "ota_data_initial.bin",
          fileName: "ota_data_initial.bin",
          offset: input.otaDataOffset,
        },
        ...(input.hasWakeWordModel
          ? [{ buildPath: "srmodels/srmodels.bin", fileName: "srmodels.bin", offset: 0xa20000 }]
          : []),
      ],
    },
  };
}

/**
 * The supported ESP32-S3 firmware inventory. Every release is built from this
 * checkout by `pnpm firmware:release`; sync publishes only its verified cache.
 */
export const firmwareCatalog: readonly FirmwareDevice[] = [
  {
    id: "zectrix-note4",
    name: "ZECTRIX NOTE4",
    description: "E-paper voice companion with monochrome and 16-level grayscale images",
    proofLabel: "ZECTRIX NOTE4",
    releases: [
      release({
        target: "zectrix_note4",
        app: "iterate-kit-zectrix-note4.bin",
        otaDataOffset: 0x411000,
        configurationOffset: 0x410000,
      }),
    ],
  },
  {
    id: "waveshare-rlcd-4-2",
    name: "Waveshare ESP32-S3 RLCD 4.2",
    description: "Reflective display and KEY-button voice companion (experimental audio)",
    proofLabel: "Waveshare RLCD 4.2",
    releases: [
      release({
        target: "waveshare_s3_rlcd",
        app: "iterate-kit-waveshare-s3-rlcd.bin",
        otaDataOffset: 0x411000,
        configurationOffset: 0x410000,
      }),
    ],
  },
  {
    id: DEFAULT_DEVICE_ID,
    name: "Home Assistant Voice Preview Edition",
    description: "ESP32-S3 voice satellite",
    proofLabel: "HA Voice PE",
    releases: [
      release({
        target: "havpe",
        app: "iterate-kit-havpe.bin",
        otaDataOffset: 0x511000,
        configurationOffset: 0x510000,
        hasWakeWordModel: true,
      }),
    ],
  },
  {
    id: "satellite1",
    name: "FutureProofHomes Satellite1",
    description: "ESP32-S3 XMOS voice satellite",
    proofLabel: "Future Home Satellite",
    releases: [
      release({
        target: "satellite1",
        app: "iterate-kit-satellite1.bin",
        otaDataOffset: 0x511000,
        configurationOffset: 0x510000,
        hasWakeWordModel: true,
      }),
    ],
  },
  {
    id: "m5stick-s3",
    name: "M5StickS3",
    description: "ESP32-S3 pocket voice companion",
    proofLabel: "M5StickS3",
    releases: [
      release({
        target: "m5sticks3",
        app: "iterate-kit-m5sticks3.bin",
        otaDataOffset: 0x211000,
        configurationOffset: 0x210000,
      }),
    ],
  },
  {
    id: "stackchan",
    name: "StackChan",
    description: "M5Stack CoreS3 desktop companion",
    proofLabel: "StackChan CoreS3",
    releases: [
      release({
        target: "stackchan",
        app: "iterate-kit-stackchan.bin",
        otaDataOffset: 0x511000,
        configurationOffset: 0x510000,
      }),
    ],
  },
  {
    id: "waveshare",
    name: "Waveshare ESP32-S3 Touch AMOLED",
    description: "ESP32-S3 screen voice companion",
    proofLabel: "Waveshare AMOLED",
    releases: [
      release({
        target: "waveshare_s3_amoled",
        app: "iterate-kit-waveshare-s3-amoled.bin",
        otaDataOffset: 0x411000,
        configurationOffset: 0x410000,
      }),
    ],
  },
];

/** The supported physical boards, in the installer order, for live air-path proof. */
export const supportedBoardProofTargets: readonly BoardProofTarget[] = firmwareCatalog.map(
  ({ id, proofLabel }) => ({ name: id, label: proofLabel }),
);

export function findFirmwareDevice(deviceId: string) {
  return firmwareCatalog.find((device) => device.id === deviceId);
}

export function resolveFirmwareRelease(
  device: FirmwareDevice,
  requestedVersion: string,
): EspWebToolsFirmwareRelease | undefined {
  if (requestedVersion === DEFAULT_FIRMWARE_VERSION) return device.releases[0];
  return device.releases.find((release) => release.version === requestedVersion);
}

export function firmwareManifestPath(deviceId: string, version: string) {
  return `/firmware/${encodeURIComponent(deviceId)}/${encodeURIComponent(version)}/manifest.json`;
}
