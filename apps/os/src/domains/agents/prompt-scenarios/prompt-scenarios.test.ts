// The prompt-scenario fixtures: each .md in this directory is one explainer
// scenario whose events are input data and whose rendered provider requests
// are outputs computed by the REAL fold (buildAgentLlmRequestBody). Plain
// runs assert every output fence is byte-fresh; `vitest run prompt-scenarios
// -u` rewrites the fences and the generated explainer page in place.

import fs from "node:fs";
import { expect, inject, test } from "vitest";
import {
  computeChainSnapshots,
  explainerPath,
  generateExplainerHtml,
} from "./explainer-generator.ts";
import { computeScenarioOutputs, loadScenarios, regenerateFixtureText } from "./fixture-helpers.ts";

const scenarios = loadScenarios();
const UPDATE_HINT =
  "fixture outputs are generated — refresh with: pnpm --dir apps/os vitest run prompt-scenarios -u";

for (const scenario of scenarios) {
  test(`scenario fixture: ${scenario.fileName}`, () => {
    const original = fs.readFileSync(scenario.filePath, "utf8");
    const expected = regenerateFixtureText(original, computeScenarioOutputs(scenario));
    if (inject("updateSnapshots")) {
      if (expected !== original) fs.writeFileSync(scenario.filePath, expected);
      return;
    }
    expect(original, UPDATE_HINT).toBe(expected);
  });
}

test("the page's per-event snapshot at a requested offset IS the pinned request fence, byte for byte", () => {
  const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  for (const scenario of scenarios) {
    const snapshots = new Map(
      computeChainSnapshots(scenario, byId).map((snapshot) => [snapshot.off, snapshot.content]),
    );
    for (const output of computeScenarioOutputs(scenario)) {
      expect(snapshots.get(output.offset), `${scenario.fileName} request@${output.offset}`).toBe(
        output.content.trimEnd(),
      );
    }
  }
});

test("explainers/prompt-sections.html is generated from these fixtures", () => {
  const expected = generateExplainerHtml(scenarios);
  const original = fs.readFileSync(explainerPath, "utf8");
  if (inject("updateSnapshots")) {
    if (expected !== original) fs.writeFileSync(explainerPath, expected);
    return;
  }
  expect(original, UPDATE_HINT).toBe(expected);
});
