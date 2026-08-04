import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DeviceConfiguration } from "./config-image.ts";
import type { FirmwareDevice } from "./catalog.ts";
import {
  prepareLocalEspIdfFlashPlan,
  readLocalEspIdfApplicationProvenance,
  readLocalEspIdfNamedPartition,
} from "./local-idf-build.ts";

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
    join(directory, "project_description.json"),
    JSON.stringify({
      app_bin: "iterate-kit-m5sticks3.bin",
      project_name: "iterate-kit-m5sticks3",
    }),
  );
  await writeFile(
    join(directory, "CMakeCache.txt"),
    "ITERATE_KIT_VOICE_PE_XMOS_UPLINK_STAGE:STRING=1\n",
  );
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
  it("retains the exact application bytes and DSP build selector used by a physical run", async () => {
    /*
     * A build-directory label is not provenance: the directory can be rebuilt
     * in place, and the XMOS tap was previously changed by editing one enum.
     * Hash the selected application and retain the explicit cache input so an
     * AEC run can be reproduced without trusting the engineer's evidence
     * folder name.
     */
    const buildDirectory = await createBuildFixture();

    await expect(readLocalEspIdfApplicationProvenance({ buildDirectory, device })).resolves.toEqual(
      {
        applicationBytes: 2,
        applicationFile: "iterate-kit-m5sticks3.bin",
        applicationSha256: "c42522128b49193de8cd45d8f7589cd7e085e65f138640d57d4482e5f7189623",
        iterateKitVoicePeXmosUplinkStage: 1,
        projectName: "iterate-kit-m5sticks3",
      },
    );
  });

  it("reads the exact named region needed before existing device configuration can be decoded", async () => {
    /*
     * An unattended proof has to read credentials before it can construct a
     * flash plan. The compiled table—not a model-specific TypeScript offset—
     * must therefore be independently inspectable through the same parser the
     * flasher trusts, or StackChan can silently read a valid-sized wrong page.
     */
    const buildDirectory = await createBuildFixture();

    await expect(
      readLocalEspIdfNamedPartition({
        buildDirectory,
        device,
        partitionLabel: "iterate_kit",
      }),
    ).resolves.toEqual({ offset: 0x11_0000, size: 4096 });
  });

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

  it("rejects another ESP32-S3 board's image before any flash plan is produced", async () => {
    /*
     * A physical Stick was found crash-looping with the Waveshare application.
     * Chip-family validation cannot prevent that mistake because every board
     * in the rig is an ESP32-S3. The IDF project identity must therefore agree
     * with the catalog target before a same-chip image can reach esptool.
     */
    const buildDirectory = await createBuildFixture();
    await writeFile(
      join(buildDirectory, "project_description.json"),
      JSON.stringify({ project_name: "iterate-kit-waveshare-s3-amoled" }),
    );

    await expect(
      prepareLocalEspIdfFlashPlan({
        buildDirectory,
        configuration,
        configurationPartition: { offset: 0x11_0000, size: 4096 },
        device,
      }),
    ).rejects.toThrow(
      "build is iterate-kit-waveshare-s3-amoled; M5Stack M5StickS3 requires iterate-kit-m5sticks3",
    );
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
