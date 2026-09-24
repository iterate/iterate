import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { firmwareCatalog, supportedBoardProofTargets } from "./catalog.ts";

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

test("the catalog is the source for installer and proof identities", () => {
  expect(supportedBoardProofTargets.map((board) => board.name)).toEqual(
    firmwareCatalog.map((device) => device.id),
  );
});
