import { expect, test } from "vitest";
import {
  faultDelta,
  faultTotals,
  mainWorkers,
  newErrorGroups,
  previewWorkers,
} from "./core-simplification-preview-logs.ts";
import type { FaultReading } from "./prd-fault-alarm.ts";

const reading: FaultReading = {
  serverErrors: [["hidden", 2]],
  causes: [{ cause: "deploy reset", worker: "hidden", serverErrors: [["hidden", 3]] }],
  heals: [["hidden", 5]],
  healEvents: [["hidden", 7]],
  errors: [["hidden", 11]],
  closeResets: [["hidden", 13]],
  pagers: [["hidden", 17]],
};

test("derives the complete preview and matched-main worker sets", () => {
  expect(previewWorkers("pr1234-a1b2c3d")).toEqual([
    "pr1234-a1b2c3d-os",
    "pr1234-a1b2c3d-dash",
    "pr1234-a1b2c3d-agents",
    "pr1234-a1b2c3d-notes",
    "pr1234-a1b2c3d-docs",
    "pr1234-a1b2c3d-admin",
    "pr1234-a1b2c3d-voice",
    "pr1234-a1b2c3d-kit",
  ]);
  expect(mainWorkers).toEqual(["os", "dash", "agents", "notes", "docs", "admin", "voice", "kit"]);
});

test("detects different errors even when totals match, without returning log text", () => {
  const candidate = {
    ...reading,
    errors: [
      ["new error", 2],
      ["new error", 3],
    ] as [string, number][],
  };
  const main = { ...reading, errors: [["old error", 5]] as [string, number][] };
  expect(faultDelta(faultTotals(candidate), faultTotals(main))).toMatchObject({ errors: 0 });
  expect(newErrorGroups(candidate, main)).toEqual([
    { hash: expect.stringMatching(/^[a-f0-9]{64}$/), count: 5 },
  ]);
  expect(JSON.stringify(newErrorGroups(candidate, main))).not.toContain("new error");
  expect(newErrorGroups(candidate, candidate)).toEqual([]);
});

test("reports category deltas without retaining log labels", () => {
  const totals = faultTotals(reading);
  expect(totals).toEqual({
    serverErrors: 2,
    causes: 3,
    heals: 5,
    healEvents: 7,
    errors: 11,
    closeResets: 13,
    pagers: 17,
  });
  expect(faultDelta(totals, faultTotals({ ...reading, errors: [["hidden", 4]] }))).toMatchObject({
    errors: 7,
    serverErrors: 0,
  });
});
