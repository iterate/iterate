import type { DeviceConfiguration } from "./config-image.ts";
import { encodeDeviceConfiguration } from "./config-image.ts";
import type {
  EspChipFamily,
  FirmwareDevice,
} from "./catalog.ts";

export interface FirmwareFlashInputPart {
  fileName: string;
  offset: number;
  sha256: string;
}

export interface EspSerialFlashInput {
  artifact: {
    configurationPartition: {
      offset: number;
      size: number;
    };
    parts: readonly FirmwareFlashInputPart[];
  };
}

export interface FirmwareFlashPart {
  address: number;
  data: Uint8Array;
  label: string;
}

export interface FirmwareFlashPlan {
  chipFamily: EspChipFamily;
  eraseAll: true;
  parts: FirmwareFlashPart[];
}

export async function prepareFirmwareFlashPlan(input: {
  configuration: DeviceConfiguration;
  device: FirmwareDevice;
  loadPart: (part: FirmwareFlashInputPart) => Promise<Uint8Array>;
  release: EspSerialFlashInput;
}): Promise<FirmwareFlashPlan> {
  if (input.device.installMethod.kind !== "esp-serial") {
    throw new Error(
      `${input.device.name} is not configured for browser or CLI serial flashing.`,
    );
  }

  const parts = await Promise.all(
    input.release.artifact.parts.map(async (sourcePart) => {
      const data = await input.loadPart(sourcePart);
      if (data.byteLength === 0) {
        throw new Error(`${sourcePart.fileName} is empty.`);
      }
      const actualSha256 = await sha256Hex(data);
      if (actualSha256 !== sourcePart.sha256) {
        throw new Error(
          `${sourcePart.fileName} SHA-256 mismatch: expected ${sourcePart.sha256}, received ${actualSha256}.`,
        );
      }
      return {
        address: sourcePart.offset,
        data,
        label: sourcePart.fileName,
      };
    }),
  );

  parts.push({
    address: input.release.artifact.configurationPartition.offset,
    data: encodeDeviceConfiguration(
      input.configuration,
      input.release.artifact.configurationPartition.size,
    ),
    label: "iterate-kit/v1 configuration",
  });
  assertNonOverlapping(parts);

  return {
    chipFamily: input.device.installMethod.chipFamily,
    eraseAll: true,
    parts,
  };
}

async function sha256Hex(bytes: Uint8Array) {
  const digestInput = new Uint8Array(bytes.byteLength);
  digestInput.set(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", digestInput);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function assertNonOverlapping(parts: FirmwareFlashPart[]) {
  const sorted = [...parts].sort((left, right) => left.address - right.address);
  let previous: FirmwareFlashPart | undefined;
  for (const current of sorted) {
    if (previous && previous.address + previous.data.byteLength > current.address) {
      throw new Error(
        `ESP flash regions overlap: ${previous.label} and ${current.label} at 0x${current.address.toString(16)}.`,
      );
    }
    previous = current;
  }
}
