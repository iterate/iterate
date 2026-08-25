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
import {
  computeScenarioOutputs,
  loadScenarios,
  regenerateFixtureText,
  synthesizeEvents,
} from "./fixture-helpers.ts";

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

test("dollar patterns in scenario content survive page generation byte-exact", () => {
  // $& / $$ / $' are replacement patterns in String.prototype.replace — the
  // generator must embed the JSON through a replacer function so content
  // containing them lands on the page literally.
  const content = "replace every match with `$&` ($$ escapes a dollar, $' is the tail)";
  const entries = [
    {
      off: 1,
      t: "0ms",
      type: "agents/context-added",
      payload: { role: "user", content, actor: { type: "user", origin: "web" } },
    },
    {
      off: 2,
      t: "1s",
      type: "agent/llm-request-requested",
      payload: { model: "test-model" },
    },
  ];
  const scenario: any = {
    filePath: "synthetic",
    fileName: "synthetic.md",
    id: "synthetic",
    base: null,
    title: "Synthetic — dollar guard",
    intro: "guard",
    entries,
    annotations: [],
    chainEntries: entries,
    chainEvents: entries.flatMap(synthesizeEvents),
    requestOffsets: [2],
  };
  const html = generateExplainerHtml([scenario]);
  expect(html).toContain("replace every match with `$&`");
  expect(html).toContain("($$ escapes a dollar, $' is the tail)");
  expect(html).not.toContain("__SCENARIO_DATA_JSON__");
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
