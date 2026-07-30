import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { DeviceConfiguration } from "./config-image.ts";
import type { FirmwareDevice } from "./catalog.ts";
import { esptoolChipName } from "./esptool-cli.ts";
import {
  prepareFirmwareFlashPlan,
  type EspSerialFlashInput,
  type FirmwareFlashInputPart,
} from "./prepare-flash-plan.ts";

interface LocalPart {
  bytes: Uint8Array;
  descriptor: FirmwareFlashInputPart;
}

export async function prepareLocalEspIdfFlashPlan(input: {
  buildDirectory: string;
  configuration: DeviceConfiguration;
  configurationPartition: {
    offset: number;
    size: number;
  };
  device: FirmwareDevice;
}) {
  if (input.device.installMethod.kind !== "esp-serial") {
    throw new Error(`${input.device.name} is not an ESP serial device.`);
  }

  const buildDirectory = resolve(input.buildDirectory);
  const metadata = await readFlasherMetadata(buildDirectory);
  const expectedChip = esptoolChipName(input.device.installMethod.chipFamily);
  if (metadata.chip !== expectedChip) {
    throw new Error(
      `ESP-IDF build targets ${metadata.chip}; ${input.device.name} requires ${expectedChip}.`,
    );
  }

  const parts = await Promise.all(
    metadata.files.map(async ({ address, relativePath }): Promise<LocalPart> => {
      const path = resolveBuildPath(buildDirectory, relativePath);
      const bytes = new Uint8Array(await readFile(path));
      return {
        bytes,
        descriptor: {
          fileName: relativePath.split(sep).join("/"),
          offset: address,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      };
    }),
  );
  const bytesByDescriptor = new Map(parts.map((part) => [part.descriptor, part.bytes] as const));
  const release: EspSerialFlashInput = {
    artifact: {
      configurationPartition: input.configurationPartition,
      parts: parts.map((part) => part.descriptor),
    },
  };

  return prepareFirmwareFlashPlan({
    configuration: input.configuration,
    device: input.device,
    release,
    loadPart: async (descriptor) => {
      const bytes = bytesByDescriptor.get(descriptor);
      if (!bytes) {
        throw new Error(`ESP-IDF flash part ${descriptor.fileName} was not loaded.`);
      }
      return bytes;
    },
  });
}

async function readFlasherMetadata(buildDirectory: string) {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(resolve(buildDirectory, "flasher_args.json"), "utf8"));
  } catch (error) {
    throw new Error("Could not read ESP-IDF flasher_args.json.", {
      cause: error,
    });
  }
  if (!isRecord(value)) {
    throw new Error("ESP-IDF flasher_args.json must contain an object.");
  }
  const extraArguments = value.extra_esptool_args;
  const flashFiles = value.flash_files;
  if (
    !isRecord(extraArguments) ||
    typeof extraArguments.chip !== "string" ||
    !isRecord(flashFiles)
  ) {
    throw new Error("ESP-IDF flasher_args.json is missing chip or flash-file metadata.");
  }

  const files = Object.entries(flashFiles).map(([rawAddress, relativePath]) => {
    if (
      !/^0x[0-9a-f]+$/iu.test(rawAddress) ||
      typeof relativePath !== "string" ||
      relativePath.length === 0 ||
      relativePath.includes("\0")
    ) {
      throw new Error(
        `ESP-IDF flasher_args.json contains an invalid flash part at ${JSON.stringify(rawAddress)}.`,
      );
    }
    const address = Number.parseInt(rawAddress.slice(2), 16);
    if (!Number.isSafeInteger(address)) {
      throw new Error(`ESP flash address ${rawAddress} is outside the safe integer range.`);
    }
    return { address, relativePath };
  });
  if (files.length === 0) {
    throw new Error("ESP-IDF flasher_args.json contains no flash parts.");
  }
  files.sort((left, right) => left.address - right.address);
  return { chip: extraArguments.chip, files };
}

function resolveBuildPath(buildDirectory: string, relativePath: string) {
  if (isAbsolute(relativePath)) {
    throw new Error(
      `ESP-IDF flash path ${JSON.stringify(relativePath)} escapes the ESP-IDF build directory.`,
    );
  }
  const path = resolve(buildDirectory, relativePath);
  const relation = relative(buildDirectory, path);
  if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error(
      `ESP-IDF flash path ${JSON.stringify(relativePath)} escapes the ESP-IDF build directory.`,
    );
  }
  return path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
