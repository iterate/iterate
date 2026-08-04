import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { z } from "zod";

const executeFile = promisify(execFile);
const espressifUsbSerialJtagVendorId = 0x303a;
const espressifUsbSerialJtagProductId = 0x1001;

const usbSerialInventorySchema = z.array(
  z.strictObject({
    device: z.string(),
    pid: z.number().int().nullable(),
    serial: z.string().nullable(),
    vid: z.number().int().nullable(),
  }),
);

export interface EspUsbSerialDevice {
  port: string;
  stableUsbSerial: string;
}

/**
 * Resolves a physical board from the ESP32-S3 ROM MAC exposed as its USB
 * serial string. macOS assigns `/dev/cu.usbmodem*` suffixes afresh after hub
 * changes, and every board in this rig has the same VID/PID. Consequently a
 * remembered port or a VID/PID-only match can flash the wrong adjacent board.
 * The stable serial is the identity; VID/PID and path are independent safety
 * checks on the one matching observation.
 */
export function resolveEspUsbSerialDevice(
  inventoryJson: string,
  requestedStableUsbSerial: string,
): EspUsbSerialDevice {
  const stableUsbSerial = requestedStableUsbSerial.trim().toUpperCase();
  if (!/^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/u.test(stableUsbSerial)) {
    throw new Error("The stable USB serial must be a colon-delimited six-byte ROM MAC.");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(inventoryJson);
  } catch (error) {
    throw new Error("USB serial inventory was not valid JSON.", { cause: error });
  }
  const inventory = usbSerialInventorySchema.parse(decoded);
  const matches = inventory.filter(
    ({ serial }) => serial?.trim().toUpperCase() === stableUsbSerial,
  );
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one USB device with stable serial ${stableUsbSerial}; found ${matches.length}.`,
    );
  }
  const match = matches[0]!;
  if (
    match.vid !== espressifUsbSerialJtagVendorId ||
    match.pid !== espressifUsbSerialJtagProductId
  ) {
    throw new Error(
      `USB device ${stableUsbSerial} does not expose the expected Espressif USB Serial/JTAG VID:PID.`,
    );
  }
  if (!/^\/dev\/cu\.usbmodem[0-9]+$/u.test(match.device)) {
    throw new Error(`USB device ${stableUsbSerial} has an unexpected macOS serial path.`);
  }
  return { port: match.device, stableUsbSerial };
}

/**
 * Enumerates without opening a serial port. Opening native USB Serial/JTAG
 * resets these boards, so discovery must not destroy the live failure state it
 * is meant to identify. The returned observation is still re-resolved before
 * every read/write transaction because a hub can re-enumerate between them.
 */
export async function discoverEspUsbSerialDevice(input: {
  pythonExecutable: string;
  stableUsbSerial: string;
}) {
  const script =
    "import json; from serial.tools import list_ports; " +
    "print(json.dumps([{'device': p.device, 'serial': p.serial_number, 'vid': p.vid, 'pid': p.pid} " +
    "for p in list_ports.comports()]))";
  const { stdout } = await executeFile(input.pythonExecutable, ["-c", script]);
  return resolveEspUsbSerialDevice(stdout, input.stableUsbSerial);
}

interface UsbSerialWaitDependencies {
  delay?: (milliseconds: number) => Promise<void>;
  discover?: typeof discoverEspUsbSerialDevice;
  now?: () => number;
}

/**
 * Waits through one bounded native-USB re-enumeration interval.
 *
 * An ESP32-S3 hard reset removes the macOS device node and may assign a new
 * suffix when it returns. Retrying a remembered path is both flaky and unsafe
 * on a multi-board hub. Re-running the non-opening inventory query makes the
 * stable ROM MAC authoritative immediately before every esptool transaction;
 * the timeout keeps a detached board from turning cleanup into an infinite
 * retry loop.
 */
export async function waitForEspUsbSerialDevice(
  input: {
    pollIntervalMs?: number;
    pythonExecutable: string;
    stableUsbSerial: string;
    timeoutMs?: number;
  },
  dependencies: UsbSerialWaitDependencies = {},
) {
  const timeoutMs = input.timeoutMs ?? 15_000;
  const pollIntervalMs = input.pollIntervalMs ?? 100;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
    throw new TypeError("USB serial wait timeout must be a non-negative integer.");
  }
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 0) {
    throw new TypeError("USB serial poll interval must be a non-negative integer.");
  }
  const now = dependencies.now ?? performance.now.bind(performance);
  const wait = dependencies.delay ?? (async (milliseconds) => await delay(milliseconds));
  const discover = dependencies.discover ?? discoverEspUsbSerialDevice;
  const deadline = now() + timeoutMs;
  let lastFailure: unknown;
  for (;;) {
    try {
      return await discover({
        pythonExecutable: input.pythonExecutable,
        stableUsbSerial: input.stableUsbSerial,
      });
    } catch (error) {
      lastFailure = error;
    }
    if (now() >= deadline) {
      throw new Error(
        `Timed out waiting for USB device ${input.stableUsbSerial} to re-enumerate.`,
        { cause: lastFailure },
      );
    }
    await wait(pollIntervalMs);
  }
}
