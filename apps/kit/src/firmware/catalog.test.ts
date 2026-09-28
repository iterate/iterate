import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { firmwareCatalog } from "./catalog.ts";

test("the catalog lists the seven boards Kit releases, each once", () => {
  const ids = firmwareCatalog.map((device) => device.id);

  expect(ids.toSorted()).toEqual([
    "home-assistant-voice-preview-edition",
    "m5stick-s3",
    "satellite1",
    "stackchan",
    "waveshare",
    "waveshare-rlcd-4-2",
    "zectrix-note4",
  ]);
  expect(ids).toEqual([...new Set(ids)]);
});

// apps/kit/scripts/firmware-release.ts builds firmware/targets/<target> and counts both directories
// as that board's own inputs
test.for(firmwareCatalog)("$id has its own target and device directories", ({ target }) => {
  const firmware = join(import.meta.dirname, "../../firmware");

  expect([
    existsSync(join(firmware, "targets", target)),
    existsSync(join(firmware, "devices", target)),
  ]).toEqual([true, true]);
});

// A board names itself by its catalog id: voice_loop.c builds its `itx.clients` name and every call's
// path from `.device_name`.
test.for(firmwareCatalog)("$id is the name its firmware reports", ({ id, target }) => {
  const directory = join(import.meta.dirname, "../../firmware/devices", target);
  const names = readdirSync(directory)
    .filter((file) => file.endsWith("_device.c"))
    .flatMap((file) => [
      ...readFileSync(join(directory, file), "utf8").matchAll(/\.device_name = "([^"]+)"/g),
    ])
    .map((match) => match[1]);

  expect(names).toEqual([id]);
});
