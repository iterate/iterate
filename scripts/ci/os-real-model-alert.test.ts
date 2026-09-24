import { expect, test } from "vitest";
import { mainE2ePage, previousMainE2eState } from "./main-e2e-alert.ts";
import { REAL_MODEL_SUITE, realModelVerdict } from "./os-real-model-alert.ts";

test("every REAL: row passed → green; the intercepted rows beside them are not the suite's", () => {
  expect(
    realModelVerdict(
      report([
        { title: "one turn through the default model, the provider intercepted", status: "failed" },
        { title: "REAL: one turn through the default model", status: "passed" },
        { title: "REAL: the default model SEES an attached image", status: "passed" },
      ]),
    ),
  ).toEqual({ verdict: "green", failingRows: [] });
});

test("a failed REAL: row → red, naming the row and its error's first line", () => {
  expect(
    realModelVerdict(
      report([
        {
          title: "REAL: one turn through the default model",
          status: "failed",
          failureMessages: [
            "Error: the AI Gateway's spend cap refused the model request: openai/gpt-6-astra 429\n    at answeredLog",
          ],
        },
        { title: "REAL: the default model SEES an attached image", status: "passed" },
      ]),
    ),
  ).toEqual({
    verdict: "red",
    failingRows: [
      "REAL: one turn through the default model (Error: the AI Gateway's spend cap refused the model request: openai/gpt-6-astra 429)",
    ],
  });
});

test.each([
  { label: "no REAL: rows", rows: [{ title: "an intercepted row", status: "passed" }] },
  {
    label: "REAL: rows skipped (E2E_REAL_MODELS unset)",
    rows: [{ title: "REAL: one turn through the default model", status: "skipped" }],
  },
])("a broken probe: $label", ({ rows }) => {
  expect(realModelVerdict(report(rows))).toMatchObject({ broken: expect.any(String) });
});

test("the suite's pages and state are its own, never main e2e's", () => {
  const page = mainE2ePage({
    suite: REAL_MODEL_SUITE,
    previous: "green",
    verdict: "red",
    commitSha: "0123456789abcdef",
    commitSubject: "Some change (#1)",
    failedJobs: ["real-model rows"],
    failingRows: ["REAL: one turn"],
  });
  expect(page?.startsWith("🔴 real-model e2e red at `012345678`")).toBe(true);
  const history = [
    { bot_id: "B", text: page! },
    { bot_id: "B", text: "🟢 main e2e green again at `x`" },
  ];
  expect(previousMainE2eState(history, REAL_MODEL_SUITE)).toBe("red");
  expect(previousMainE2eState(history)).toBe("green");
});

const report = (rows: { title: string; status: string; failureMessages?: string[] }[]) => ({
  testResults: [{ assertionResults: rows }],
});
