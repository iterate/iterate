import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  firmwareCatalog,
  M5STICKS3_CONFIGURATION_PARTITION,
} from "./catalog.ts";

const targetDirectory = resolve(
  import.meta.dirname,
  "../../firmware/targets/m5sticks3",
);

describe("M5StickS3 firmware layout", () => {
  it("has one dedicated 4 KiB raw configuration partition", () => {
    const partitions = readFileSync(
      resolve(targetDirectory, "partitions.csv"),
      "utf8",
    );
    expect(partitions).toMatch(
      /^factory,\s*app,\s*factory,\s*0x10000,\s*0x200000,\s*$/m,
    );
    expect(partitions).toMatch(
      /^iterate_kit,\s*0x40,\s*0x00,\s*0x210000,\s*0x1000,\s*$/m,
    );
    expect(M5STICKS3_CONFIGURATION_PARTITION).toEqual({
      offset: 0x21_0000,
      size: 0x1000,
    });

    const defaults = readFileSync(
      resolve(targetDirectory, "sdkconfig.defaults"),
      "utf8",
    );
    expect(defaults).toContain("CONFIG_PARTITION_TABLE_CUSTOM=y");
    expect(defaults).toContain(
      'CONFIG_PARTITION_TABLE_CUSTOM_FILENAME="partitions.csv"',
    );
  });

  it("uses the same device identity as the install catalog", () => {
    expect(
      firmwareCatalog.some((device) => device.id === "m5sticks3"),
    ).toBe(true);
  });
});
