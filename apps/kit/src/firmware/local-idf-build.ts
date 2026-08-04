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
  configurationPartition?: {
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
  assertBuildMatchesDevice(metadata.chip, metadata.projectName, input.device);

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
  let configurationPartition = input.configurationPartition;
  if (!configurationPartition) {
    const partitionTable = parts.find((part) =>
      part.descriptor.fileName.endsWith("partition_table/partition-table.bin"),
    );
    if (!partitionTable) {
      throw new Error("ESP-IDF build does not include its compiled partition table.");
    }
    configurationPartition = findCompiledPartition(partitionTable.bytes, "iterate_kit");
  }
  const release: EspSerialFlashInput = {
    artifact: {
      configurationPartition,
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

/**
 * Reads one partition address from the exact compiled image selected for a
 * physical device run. This intentionally performs no flash access: callers
 * use the result to read the already-provisioned board before they possess the
 * credentials needed to construct a new flash plan. Sharing the binary parser
 * with `prepareLocalEspIdfFlashPlan` keeps reads and writes on one authority.
 */
export async function readLocalEspIdfNamedPartition(input: {
  buildDirectory: string;
  device: FirmwareDevice;
  partitionLabel: string;
}) {
  if (input.device.installMethod.kind !== "esp-serial") {
    throw new Error(`${input.device.name} is not an ESP serial device.`);
  }
  const buildDirectory = resolve(input.buildDirectory);
  const metadata = await readFlasherMetadata(buildDirectory);
  assertBuildMatchesDevice(metadata.chip, metadata.projectName, input.device);
  const partitionTable = metadata.files.find(({ relativePath }) =>
    relativePath.split("\\").join("/").endsWith("partition_table/partition-table.bin"),
  );
  if (!partitionTable) {
    throw new Error("ESP-IDF build does not include its compiled partition table.");
  }
  const path = resolveBuildPath(buildDirectory, partitionTable.relativePath);
  return findCompiledPartition(new Uint8Array(await readFile(path)), input.partitionLabel);
}

/**
 * Captures immutable application provenance for physical evidence.
 *
 * A build directory is mutable and therefore cannot identify the bytes that
 * ran a test. The app hash is the authority; the small allowlisted cache value
 * additionally names HAVPE's cumulative XMOS tap so two byte-distinct A/B
 * builds remain human-auditable. This performs no USB access and deliberately
 * ignores every unrelated CMake cache value, which may contain machine-local
 * paths and does not belong in retained evidence.
 */
export async function readLocalEspIdfApplicationProvenance(input: {
  buildDirectory: string;
  device: FirmwareDevice;
}) {
  const buildDirectory = resolve(input.buildDirectory);
  const metadata = await readFlasherMetadata(buildDirectory);
  assertBuildMatchesDevice(metadata.chip, metadata.projectName, input.device);
  if (!metadata.applicationFile) {
    throw new Error("ESP-IDF project_description.json is missing app_bin metadata.");
  }
  if (!metadata.files.some(({ relativePath }) => relativePath === metadata.applicationFile)) {
    throw new Error("ESP-IDF application binary is not present in flasher metadata.");
  }
  const applicationPath = resolveBuildPath(buildDirectory, metadata.applicationFile);
  const [application, cache] = await Promise.all([
    readFile(applicationPath),
    readFile(resolve(buildDirectory, "CMakeCache.txt"), "utf8"),
  ]);
  const stageMatch = cache.match(
    /^ITERATE_KIT_VOICE_PE_XMOS_UPLINK_STAGE:(?:STRING|UNINITIALIZED)=([0-4])$/mu,
  );
  return {
    applicationBytes: application.byteLength,
    applicationFile: metadata.applicationFile,
    applicationSha256: createHash("sha256").update(application).digest("hex"),
    iterateKitVoicePeXmosUplinkStage: stageMatch ? Number(stageMatch[1]) : null,
    projectName: metadata.projectName,
  };
}

/**
 * ESP-IDF's compiled partition table is the flash authority. Reading the
 * provisioning region from that binary prevents a target-specific TypeScript
 * constant from silently drifting away from the image that will actually boot.
 * Each normal entry is a fixed 32-byte packed `esp_partition_info_t`; the
 * 0xffff erased marker and 0xebeb MD5 trailer terminate normal entries.
 */
function findCompiledPartition(bytes: Uint8Array, requestedLabel: string) {
  const entryBytes = 32;
  const magic = 0x50aa;
  const md5Magic = 0xebeb;
  const decoder = new TextDecoder();
  let result: { offset: number; size: number } | undefined;

  for (let start = 0; start + entryBytes <= bytes.byteLength; start += entryBytes) {
    const entry = bytes.subarray(start, start + entryBytes);
    const view = new DataView(entry.buffer, entry.byteOffset, entry.byteLength);
    const entryMagic = view.getUint16(0, true);
    if (entryMagic === 0xffff || entryMagic === md5Magic) break;
    if (entryMagic !== magic) {
      throw new Error(`ESP-IDF partition table has invalid magic at byte ${start}.`);
    }

    const rawLabel = entry.subarray(12, 28);
    const terminator = rawLabel.indexOf(0);
    const label = decoder.decode(terminator < 0 ? rawLabel : rawLabel.subarray(0, terminator));
    if (label !== requestedLabel) continue;
    if (result) {
      throw new Error(`ESP-IDF partition table contains duplicate ${requestedLabel} entries.`);
    }
    const offset = view.getUint32(4, true);
    const size = view.getUint32(8, true);
    if (size === 0) {
      throw new Error(`ESP-IDF partition ${requestedLabel} has zero size.`);
    }
    result = { offset, size };
  }

  if (!result) {
    throw new Error(`ESP-IDF partition table does not contain ${requestedLabel}.`);
  }
  return result;
}

function assertBuildMatchesDevice(chip: string, projectName: string, device: FirmwareDevice): void {
  if (device.installMethod.kind !== "esp-serial") {
    throw new Error(`${device.name} is not an ESP serial device.`);
  }
  const expectedChip = esptoolChipName(device.installMethod.chipFamily);
  if (chip !== expectedChip) {
    throw new Error(`ESP-IDF build targets ${chip}; ${device.name} requires ${expectedChip}.`);
  }
  const expectedProjectName = `iterate-kit-${device.id}`;
  if (projectName !== expectedProjectName) {
    throw new Error(
      `ESP-IDF build is ${projectName}; ${device.name} requires ${expectedProjectName}.`,
    );
  }
}

async function readFlasherMetadata(buildDirectory: string) {
  let value: unknown;
  let projectDescription: unknown;
  try {
    const [flasherArguments, projectDescriptionText] = await Promise.all([
      readFile(resolve(buildDirectory, "flasher_args.json"), "utf8"),
      readFile(resolve(buildDirectory, "project_description.json"), "utf8"),
    ]);
    value = JSON.parse(flasherArguments);
    projectDescription = JSON.parse(projectDescriptionText);
  } catch (error) {
    throw new Error("Could not read ESP-IDF build metadata.", {
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
  if (!isRecord(projectDescription) || typeof projectDescription.project_name !== "string") {
    throw new Error("ESP-IDF project_description.json is missing project_name metadata.");
  }
  const applicationFile = projectDescription.app_bin;
  if (applicationFile !== undefined && typeof applicationFile !== "string") {
    throw new Error("ESP-IDF project_description.json has invalid app_bin metadata.");
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
  return {
    applicationFile,
    chip: extraArguments.chip,
    files,
    projectName: projectDescription.project_name,
  };
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
