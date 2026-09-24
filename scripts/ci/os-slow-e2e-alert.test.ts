import { expect, test } from "vitest";
import { mainE2ePage, previousMainE2eState } from "./main-e2e-alert.ts";
import { SLOW_E2E_SUITE, slowRowsVerdict } from "./os-slow-e2e-alert.ts";

test("every row tagged slow passed → green; the rows the filter left out are not the suite's", () => {
  expect(
    slowRowsVerdict([artifact([slow("the careless facet", "passed"), skipped(), skipped()])]),
  ).toEqual({ verdict: "green", failingRows: [] });
});

test("a failed slow row → red, naming it", () => {
  expect(
    slowRowsVerdict([
      artifact([
        slow("the careless facet", "passed"),
        slow("the chatty facet", "failed"),
        skipped(),
      ]),
    ]),
  ).toEqual({
    verdict: "red",
    failingRows: ["context-residency.e2e.test.ts: the chatty facet"],
  });
});

test.each([
  { label: "no telemetry", artifacts: [] },
  {
    label: "no row tagged slow",
    artifacts: [artifact([{ name: "a plain row", state: "passed" }])],
  },
  {
    label: "every slow row skipped",
    artifacts: [artifact([slow("the careless facet", "skipped")])],
  },
  {
    label: "a runner that did not finish",
    artifacts: [artifact([slow("the careless facet", "passed")], "interrupted")],
  },
])("a broken probe: $label", ({ artifacts }) => {
  expect(slowRowsVerdict(artifacts)).toMatchObject({ broken: expect.any(String) });
});

test("the suite's pages and state are its own, never main e2e's", () => {
  const page = mainE2ePage({
    suite: SLOW_E2E_SUITE,
    previous: "green",
    verdict: "red",
    commitSha: "0123456789abcdef",
    commitSubject: "Some change (#1)",
    failedJobs: ["slow e2e rows"],
    failingRows: ["context-residency.e2e.test.ts: the chatty facet"],
  });
  expect(page?.startsWith("🔴 slow e2e rows red at `012345678`")).toBe(true);
  const history = [
    { bot_id: "B", text: page! },
    { bot_id: "B", text: "🟢 main e2e green again at `x`" },
  ];
  expect(previousMainE2eState(history, SLOW_E2E_SUITE)).toBe("red");
  expect(previousMainE2eState(history)).toBe("green");
});

type Row = { name: string; state: string; tags?: string[] };

/** The parts of a vitest telemetry artifact the judge reads. */
function artifact(
  rows: Row[],
  status = rows.some((row) => row.state === "failed") ? "failed" : "passed",
) {
  return {
    run: { status },
    tests: rows.map((row) => ({
      fullName: row.name,
      leafName: row.name,
      moduleId: "/repo/apps/os/e2e/context-residency.e2e.test.ts",
      state: row.state,
      tags: row.tags || [],
    })),
  } as unknown as Parameters<typeof slowRowsVerdict>[0][number];
}

function slow(name: string, state: string): Row {
  return { name, state, tags: ["slow"] };
}

function skipped(): Row {
  return { name: "a row the tags filter left out", state: "skipped" };
}
