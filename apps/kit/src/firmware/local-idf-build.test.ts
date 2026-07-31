import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DeviceConfiguration } from "./config-image.ts";
import type { FirmwareDevice } from "./catalog.ts";
import { prepareLocalEspIdfFlashPlan } from "./local-idf-build.ts";

const temporaryDirectories: string[] = [];

const device: FirmwareDevice = {
  id: "m5sticks3",
  name: "M5Stack M5StickS3",
  description: "Test target",
  installMethod: { kind: "esp-serial", chipFamily: "ESP32-S3" },
  releases: [],
};

const configuration: DeviceConfiguration = {
  schemaVersion: 1,
  wifi: { ssid: "studio", password: "secret" },
  iterate: {
    baseUrl: "https://os.iterate.com",
    pcmBaseUrl: "https://kit--voice-lab.iterate.app",
    projectId: "prj_voice_lab",
    projectApiKey: "itxk_test",
  },
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function createBuildFixture(overrides: Record<string, unknown> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "iterate-kit-idf-build-"));
  temporaryDirectories.push(directory);
  await mkdir(join(directory, "bootloader"));
  await mkdir(join(directory, "partition_table"));
  await writeFile(join(directory, "bootloader", "bootloader.bin"), Uint8Array.of(1, 2));
  const partitionTable = new Uint8Array(96).fill(0xff);
  const view = new DataView(partitionTable.buffer);
  view.setUint16(0, 0x50aa, true);
  view.setUint8(2, 0x40);
  view.setUint8(3, 0);
  view.setUint32(4, 0x11_0000, true);
  view.setUint32(8, 4096, true);
  partitionTable.fill(0, 12, 28);
  partitionTable.set(new TextEncoder().encode("iterate_kit"), 12);
  await writeFile(join(directory, "partition_table", "partition-table.bin"), partitionTable);
  await writeFile(join(directory, "iterate-kit-m5sticks3.bin"), Uint8Array.of(5, 6));
  await writeFile(
    join(directory, "flasher_args.json"),
    JSON.stringify({
      flash_files: {
        "0x0": "bootloader/bootloader.bin",
        "0x10000": "iterate-kit-m5sticks3.bin",
        "0x8000": "partition_table/partition-table.bin",
      },
      extra_esptool_args: { chip: "esp32s3" },
      ...overrides,
    }),
  );
  return directory;
}

describe("prepareLocalEspIdfFlashPlan", () => {
  it("feeds a local IDF build through the same verified plan used by the browser", async () => {
    const buildDirectory = await createBuildFixture();

    const plan = await prepareLocalEspIdfFlashPlan({
      buildDirectory,
      configuration,
      configurationPartition: { offset: 0x11_0000, size: 4096 },
      device,
    });

    expect(plan.chipFamily).toBe("ESP32-S3");
    expect(plan.eraseAll).toBe(true);
    expect(plan.parts.map(({ address, label }) => ({ address, label }))).toEqual([
      { address: 0, label: "bootloader/bootloader.bin" },
      { address: 0x8000, label: "partition_table/partition-table.bin" },
      { address: 0x10_000, label: "iterate-kit-m5sticks3.bin" },
      { address: 0x11_0000, label: "iterate-kit/v1 configuration" },
    ]);
    expect(new TextDecoder().decode(plan.parts[3]!.data.slice(0, 8))).toBe("ITERKIT1");
    expect(plan.parts[3]!.data).toHaveLength(4096);
  });

  it("derives the provisioning region from the compiled partition table", async () => {
    const buildDirectory = await createBuildFixture();

    const plan = await prepareLocalEspIdfFlashPlan({
      buildDirectory,
      configuration,
      device,
    });

    expect(plan.parts.at(-1)).toMatchObject({
      address: 0x11_0000,
      label: "iterate-kit/v1 configuration",
    });
    expect(plan.parts.at(-1)?.data).toHaveLength(4096);
  });

  it("rejects a build for a different ESP family", async () => {
    const buildDirectory = await createBuildFixture({
      extra_esptool_args: { chip: "esp32c3" },
    });

    await expect(
      prepareLocalEspIdfFlashPlan({
        buildDirectory,
        configuration,
        configurationPartition: { offset: 0x11_0000, size: 4096 },
        device,
      }),
    ).rejects.toThrow("targets esp32c3; M5Stack M5StickS3 requires esp32s3");
  });

  it("does not allow flasher metadata to read outside the selected build", async () => {
    const buildDirectory = await createBuildFixture({
      flash_files: { "0x0": "../private.bin" },
    });

    await expect(
      prepareLocalEspIdfFlashPlan({
        buildDirectory,
        configuration,
        configurationPartition: { offset: 0x11_0000, size: 4096 },
        device,
      }),
    ).rejects.toThrow("escapes the ESP-IDF build directory");
  });
});
