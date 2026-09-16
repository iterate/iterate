import { expect, test } from "vitest";
import { previewResultFromChecks } from "./preview-result.ts";

test("a completed preview reports the whole run's red result", () => {
  expect(previewResultFromChecks("candidate", checks("first", 1, "failure"))).toMatchObject({
    commit: "candidate",
    conclusion: "failure",
  });
});

test("a newer incomplete workflow blocks an older green, even if the old finalizer appeared last", () => {
  const old = checks("old", 1, "success");
  old.at(-1)!.id = 1000;
  const next = checks("next", 100, "success").slice(0, 2);
  next[0].status = "in_progress";
  expect(previewResultFromChecks("candidate", [...old, ...next])).toBeNull();
});

test.each(["cancelled", "skipped", "neutral"])(
  "%s is not a conclusive preview result",
  (conclusion) => {
    const run = checks("run", 1, "success");
    run[1].conclusion = conclusion;
    expect(previewResultFromChecks("candidate", run)).toBeNull();
  },
);

test("a partial job rerun cannot borrow the previous finalizer", () => {
  const run = checks("run", 1, "success");
  const rerun = { ...run[1], id: 100, completed_at: "2026-09-16T22:06:00Z" };
  expect(previewResultFromChecks("candidate", [...run, rerun])).toBeNull();
});

test("main's complete preview is conclusive, but missing shards are not", () => {
  const run = checks("main", 1, "success").map((check) => ({
    ...check,
    name: check.name.replace("Preview /", "Preview Main /"),
  }));
  expect(previewResultFromChecks("candidate", run)).toMatchObject({ conclusion: "success" });
  expect(
    previewResultFromChecks(
      "candidate",
      run.filter((check) => !check.name.includes("3/6")),
    ),
  ).toBeNull();
});

test("only Depot's actual preview checks count", () => {
  const foreign = checks("foreign", 100, "success").map((check) => ({
    ...check,
    app: { slug: "another-app" },
  }));
  expect(previewResultFromChecks("candidate", foreign)).toBeNull();
  expect(
    previewResultFromChecks("candidate", [...checks("own", 1, "failure"), ...foreign]),
  ).toMatchObject({ conclusion: "failure" });
});

function checks(workflow: string, firstId: number, outcome: string) {
  return [
    "Deploy and readiness",
    "App tests",
    ...[1, 2, 3, 4, 5, 6].map((n) => `Playwright ${n}/6`),
    "Collect results and clean up",
  ].map((name, index) => ({
    id: firstId + index,
    name: `Preview / ${name}`,
    status: "completed",
    conclusion: name === "Collect results and clean up" ? outcome : "success",
    started_at: "2026-09-16T22:00:00Z",
    completed_at: "2026-09-16T22:05:00Z",
    details_url: `https://depot.dev/orgs/0p91s0lz49/workflows/${workflow}?job=${index}`,
    app: { slug: "depot-code-access" },
  }));
}
