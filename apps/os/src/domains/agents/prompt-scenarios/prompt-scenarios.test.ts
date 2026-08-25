// The prompt-scenario fixtures: each .md in this directory is one explainer
// scenario whose events are input data and whose rendered provider requests
// are outputs computed by the REAL fold (buildAgentLlmRequestBody). Plain
// runs assert every output fence is byte-fresh; `vitest run prompt-scenarios
// -u` rewrites the fences and the generated explainer page in place.

import fs from "node:fs";
import { expect, inject, test } from "vitest";
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
