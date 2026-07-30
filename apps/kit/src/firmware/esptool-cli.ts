import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EspChipFamily } from "./catalog.ts";
import type { FirmwareFlashPlan } from "./prepare-flash-plan.ts";

export interface PreparedFlashFile {
  address: number;
  path: string;
}

interface EsptoolWriteFlashInput {
  baudrate: number;
  files: readonly PreparedFlashFile[];
  plan: FirmwareFlashPlan;
  port: string;
}

export interface EspFlashRegion {
  offset: number;
  size: number;
}

interface EsptoolReadFlashInput {
  baudrate: number;
  chipFamily: EspChipFamily;
  outputPath: string;
  port: string;
  region: EspFlashRegion;
}

export function esptoolChipName(chipFamily: EspChipFamily) {
  return chipFamily.toLowerCase().replaceAll("-", "");
}

export function buildEsptoolWriteFlashArguments(
  input: EsptoolWriteFlashInput,
) {
  if (
    input.files.length !== input.plan.parts.length ||
    input.files.some(
      (file, index) => file.address !== input.plan.parts[index]?.address,
    )
  ) {
    throw new Error(
      "Prepared flash file list does not match the prepared firmware plan.",
    );
  }
  if (
    !Number.isSafeInteger(input.baudrate) ||
    input.baudrate <= 0 ||
    input.baudrate > 3_000_000
  ) {
    throw new Error(`Invalid esptool baud rate ${input.baudrate}.`);
  }
  if (!input.port.trim() || input.port.includes("\0")) {
    throw new Error("A non-empty serial port without NUL bytes is required.");
  }
  if (input.files.some((file) => !file.path || file.path.includes("\0"))) {
    throw new Error("Every prepared flash part requires a valid temporary path.");
  }

  return [
    "-m",
    "esptool",
    "--chip",
    esptoolChipName(input.plan.chipFamily),
    "--port",
    input.port,
    "--baud",
    String(input.baudrate),
    "--before",
    "default_reset",
    "--after",
    "hard_reset",
    "write_flash",
    ...(input.plan.eraseAll ? ["--erase-all"] : []),
    "--flash_mode",
    "keep",
    "--flash_size",
    "detect",
    "--flash_freq",
    "keep",
    "--compress",
    "--verify",
    ...input.files.flatMap((file) => [
      `0x${file.address.toString(16)}`,
      file.path,
    ]),
  ];
}

export function buildEsptoolReadFlashArguments(
  input: EsptoolReadFlashInput,
) {
  if (
    !Number.isSafeInteger(input.baudrate) ||
    input.baudrate <= 0 ||
    input.baudrate > 3_000_000
  ) {
    throw new Error(`Invalid esptool baud rate ${input.baudrate}.`);
  }
  if (!input.port.trim() || input.port.includes("\0")) {
    throw new Error("A non-empty serial port without NUL bytes is required.");
  }
  if (
    !input.outputPath ||
    input.outputPath.includes("\0")
  ) {
    throw new Error("A valid temporary output path is required.");
  }
  if (
    !Number.isSafeInteger(input.region.offset) ||
    input.region.offset < 0 ||
    !Number.isSafeInteger(input.region.size) ||
    input.region.size <= 0
  ) {
    throw new Error("A bounded non-empty flash region is required.");
  }

  return [
    "-m",
    "esptool",
    "--chip",
    esptoolChipName(input.chipFamily),
    "--port",
    input.port,
    "--baud",
    String(input.baudrate),
    "--before",
    "default_reset",
    "--after",
    "hard_reset",
    "read_flash",
    `0x${input.region.offset.toString(16)}`,
    `0x${input.region.size.toString(16)}`,
    input.outputPath,
  ];
}

export async function flashFirmwareWithEsptool(
  plan: FirmwareFlashPlan,
  options: {
    baudrate?: number;
    port: string;
    pythonExecutable?: string;
  },
) {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "iterate-kit-flash-"),
  );
  let operationFailure: unknown;
  try {
    const files = await Promise.all(
      plan.parts.map(async (part, index): Promise<PreparedFlashFile> => {
        const path = join(temporaryDirectory, `part-${index}.bin`);
        await writeFile(path, part.data, { mode: 0o600 });
        return { address: part.address, path };
      }),
    );
    const args = buildEsptoolWriteFlashArguments({
      baudrate: options.baudrate ?? 921_600,
      files,
      plan,
      port: options.port,
    });
    await runProcess(options.pythonExecutable ?? "python", args);
  } catch (error) {
    operationFailure = error;
  }

  let cleanupFailure: unknown;
  try {
    await rm(temporaryDirectory, { force: true, recursive: true });
  } catch (error) {
    cleanupFailure = error;
  }

  if (operationFailure && cleanupFailure) {
    throw new AggregateError(
      [operationFailure, cleanupFailure],
      "Firmware flashing and secret-bearing temporary-file cleanup both failed.",
    );
  }
  if (operationFailure) throw operationFailure;
  if (cleanupFailure) throw cleanupFailure;
}

export async function readFlashRegionWithEsptool(
  options: {
    baudrate?: number;
    chipFamily: EspChipFamily;
    port: string;
    pythonExecutable?: string;
    region: EspFlashRegion;
  },
) {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "iterate-kit-read-flash-"),
  );
  const outputPath = join(temporaryDirectory, "region.bin");
  let operationFailure: unknown;
  let result: Uint8Array | undefined;
  try {
    const args = buildEsptoolReadFlashArguments({
      baudrate: options.baudrate ?? 921_600,
      chipFamily: options.chipFamily,
      outputPath,
      port: options.port,
      region: options.region,
    });
    await runProcess(options.pythonExecutable ?? "python", args);
    const bytes = await readFile(outputPath);
    if (bytes.byteLength !== options.region.size) {
      throw new Error(
        `esptool returned ${bytes.byteLength} bytes; expected ${options.region.size}.`,
      );
    }
    result = Uint8Array.from(bytes);
  } catch (error) {
    operationFailure = error;
  }

  let cleanupFailure: unknown;
  try {
    await rm(temporaryDirectory, { force: true, recursive: true });
  } catch (error) {
    cleanupFailure = error;
  }
  if (operationFailure && cleanupFailure) {
    throw new AggregateError(
      [operationFailure, cleanupFailure],
      "Flash-region reading and secret-bearing temporary-file cleanup both failed.",
    );
  }
  if (operationFailure) throw operationFailure;
  if (cleanupFailure) throw cleanupFailure;
  if (!result) {
    throw new Error("Flash-region reading completed without data.");
  }
  return result;
}

function runProcess(command: string, args: readonly string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          signal
            ? `esptool terminated by signal ${signal}.`
            : `esptool exited with status ${String(code)}.`,
        ),
      );
    });
  });
}
