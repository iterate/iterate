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

export interface EspFlashRegion {
  offset: number;
  size: number;
}

export function esptoolChipName(chipFamily: EspChipFamily) {
  return chipFamily.toLowerCase().replaceAll("-", "");
}

interface EsptoolWriteFlashInput {
  baudrate: number;
  files: readonly PreparedFlashFile[];
  plan: FirmwareFlashPlan;
  port: string;
}

export function buildEsptoolWriteFlashArguments(input: EsptoolWriteFlashInput) {
  if (
    input.files.length !== input.plan.parts.length ||
    input.files.some((file, index) => file.address !== input.plan.parts[index]?.address)
  ) {
    throw new Error("Prepared flash file list does not match the prepared firmware plan.");
  }
  if (!Number.isSafeInteger(input.baudrate) || input.baudrate <= 0 || input.baudrate > 3_000_000) {
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
    ...input.files.flatMap((file) => [`0x${file.address.toString(16)}`, file.path]),
  ];
}

interface EsptoolReadFlashInput {
  baudrate: number;
  chipFamily: EspChipFamily;
  outputPath: string;
  port: string;
  region: EspFlashRegion;
}

export function buildEsptoolReadFlashArguments(input: EsptoolReadFlashInput) {
  if (!Number.isSafeInteger(input.baudrate) || input.baudrate <= 0 || input.baudrate > 3_000_000) {
    throw new Error(`Invalid esptool baud rate ${input.baudrate}.`);
  }
  if (!input.port.trim() || input.port.includes("\0")) {
    throw new Error("A non-empty serial port without NUL bytes is required.");
  }
  if (!input.outputPath || input.outputPath.includes("\0")) {
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

interface EsptoolRunApplicationInput {
  chipFamily: EspChipFamily;
  port: string;
}

export function buildEsptoolRunApplicationArguments(input: EsptoolRunApplicationInput) {
  if (!input.port.trim() || input.port.includes("\0")) {
    throw new Error("A non-empty serial port without NUL bytes is required.");
  }
  /*
   * ESP32-S2/S3 native USB Serial/JTAG needs esptool's 1200-baud USB reset to
   * leave the downloaded stub reliably. `default_reset` can report a hard
   * reset while the physical Stick remains in the ROM loader. Older families
   * normally sit behind the conventional RTS/DTR UART circuit, where the
   * default strategy remains the compatible choice.
   */
  const before =
    input.chipFamily === "ESP32-S2" || input.chipFamily === "ESP32-S3"
      ? "usb_reset"
      : "default_reset";
  return [
    "-m",
    "esptool",
    "--chip",
    esptoolChipName(input.chipFamily),
    "--port",
    input.port,
    "--before",
    before,
    "--after",
    "hard_reset",
    "run",
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
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "iterate-kit-flash-"));
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

export async function readFlashRegionWithEsptool(options: {
  baudrate?: number;
  chipFamily: EspChipFamily;
  port: string;
  pythonExecutable?: string;
  region: EspFlashRegion;
}) {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "iterate-kit-read-flash-"));
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
    let readFailure: unknown;
    try {
      await runProcess(options.pythonExecutable ?? "python", args);
    } catch (error) {
      readFailure = error;
    }

    let applicationStartFailure: unknown;
    try {
      /*
       * `read_flash --after hard_reset` is not a reliable application-start
       * boundary on native USB Serial/JTAG. A physical ESP32-S3 printed
       * "Hard resetting" yet remained in the ROM loader until a distinct
       * esptool `run` transaction. Always perform that transaction—even after
       * a failed read—so a diagnostic/provisioning probe cannot silently take
       * an otherwise healthy device off Wi-Fi.
       */
      await runProcess(
        options.pythonExecutable ?? "python",
        buildEsptoolRunApplicationArguments({
          chipFamily: options.chipFamily,
          port: options.port,
        }),
      );
    } catch (error) {
      applicationStartFailure = error;
    }

    if (readFailure && applicationStartFailure) {
      throw new AggregateError(
        [readFailure, applicationStartFailure],
        "Flash-region reading failed and the application could not be restarted.",
      );
    }
    if (readFailure) throw readFailure;
    if (applicationStartFailure) throw applicationStartFailure;
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
