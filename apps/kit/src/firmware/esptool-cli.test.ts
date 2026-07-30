import { describe, expect, it } from "vitest";
import {
  buildEsptoolReadFlashArguments,
  buildEsptoolWriteFlashArguments,
  type PreparedFlashFile,
} from "./esptool-cli.ts";
import type { FirmwareFlashPlan } from "./prepare-flash-plan.ts";

const plan: FirmwareFlashPlan = {
  chipFamily: "ESP32-S3",
  eraseAll: true,
  parts: [
    { address: 0, data: Uint8Array.of(1, 2), label: "bootloader.bin" },
    {
      address: 0x11_0000,
      data: new TextEncoder().encode("ITERKIT1secret"),
      label: "iterate-kit/v1 configuration",
    },
  ],
};

const files: PreparedFlashFile[] = [
  { address: 0, path: "/private/tmp/iterate-kit/part-0.bin" },
  { address: 0x11_0000, path: "/private/tmp/iterate-kit/part-1.bin" },
];

describe("buildEsptoolWriteFlashArguments", () => {
  it("builds a verified, bounded command for the shared byte plan", () => {
    const args = buildEsptoolWriteFlashArguments({
      baudrate: 921_600,
      files,
      plan,
      port: "/dev/cu.usbmodem101",
    });

    expect(args).toEqual([
      "-m",
      "esptool",
      "--chip",
      "esp32s3",
      "--port",
      "/dev/cu.usbmodem101",
      "--baud",
      "921600",
      "--before",
      "default_reset",
      "--after",
      "hard_reset",
      "write_flash",
      "--erase-all",
      "--flash_mode",
      "keep",
      "--flash_size",
      "detect",
      "--flash_freq",
      "keep",
      "--compress",
      "--verify",
      "0x0",
      "/private/tmp/iterate-kit/part-0.bin",
      "0x110000",
      "/private/tmp/iterate-kit/part-1.bin",
    ]);
    expect(args.join(" ")).not.toContain("secret");
  });

  it("rejects a path/address list that does not exactly match the plan", () => {
    expect(() =>
      buildEsptoolWriteFlashArguments({
        baudrate: 921_600,
        files: [{ address: 0, path: "/tmp/only-one.bin" }],
        plan,
        port: "/dev/cu.usbmodem101",
      }),
    ).toThrow("does not match the prepared firmware plan");
  });
});

describe("buildEsptoolReadFlashArguments", () => {
  it("reads exactly one bounded provisioning partition without erasing", () => {
    expect(
      buildEsptoolReadFlashArguments({
        baudrate: 921_600,
        chipFamily: "ESP32-S3",
        outputPath: "/private/tmp/iterate-kit/config.bin",
        port: "/dev/cu.usbmodem101",
        region: { offset: 0x21_0000, size: 0x1000 },
      }),
    ).toEqual([
      "-m",
      "esptool",
      "--chip",
      "esp32s3",
      "--port",
      "/dev/cu.usbmodem101",
      "--baud",
      "921600",
      "--before",
      "default_reset",
      "--after",
      "hard_reset",
      "read_flash",
      "0x210000",
      "0x1000",
      "/private/tmp/iterate-kit/config.bin",
    ]);
  });
});
