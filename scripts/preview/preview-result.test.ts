import { expect, test } from "vitest";
import { previewResultFromChecks } from "./preview-result.ts";

test("early-green GitHub checks without preview-settled are not inheritable", () => {
  expect(previewResultFromChecks("candidate", checks("run", 1, "success"), [])).toBeNull();
});

test("a completed preview reports the whole run's red result", () => {
  expect(
    previewResultFromChecks("candidate", checks("first", 1, "failure"), [
      settled("first", 9, "failure"),
    ]),
  ).toMatchObject({
    commit: "candidate",
    conclusion: "failure",
  });
});

test("a newer incomplete workflow blocks an older green, even if the old finalizer appeared last", () => {
  const old = checks("old", 1, "success");
  old.at(-1)!.id = 1000;
  const next = checks("next", 100, "success").slice(0, 2);
  next[0].status = "in_progress";
  expect(
    previewResultFromChecks("candidate", [...old, ...next], [settled("old", 1000, "success")]),
  ).toBeNull();
});

test.each(["cancelled", "skipped", "neutral"])(
  "%s is not a conclusive preview result",
  (conclusion) => {
    const run = checks("run", 1, "success");
    run[1].conclusion = conclusion;
    expect(previewResultFromChecks("candidate", run, [settled("run", 9, "success")])).toBeNull();
  },
);

test("a partial job rerun cannot borrow the previous finalizer", () => {
  const run = checks("run", 1, "success");
  const rerun = { ...run[1], id: 100, completed_at: "2026-09-16T22:06:00Z" };
  expect(
    previewResultFromChecks("candidate", [...run, rerun], [settled("run", 9, "success")]),
  ).toBeNull();
});

test("main's complete preview is conclusive, but missing shards are not", () => {
  const run = checks("main", 1, "success").map((check) => ({
    ...check,
    name: check.name.replace("Preview /", "Preview Main /"),
  }));
  expect(previewResultFromChecks("candidate", run, [settled("main", 9, "success")])).toMatchObject({
    conclusion: "success",
  });
  expect(
    previewResultFromChecks(
      "candidate",
      run.filter((check) => !check.name.includes("3/6")),
      [settled("main", 9, "success")],
    ),
  ).toBeNull();
});

test("only Depot's actual preview checks count", () => {
  const foreign = checks("foreign", 100, "success").map((check) => ({
    ...check,
    app: { slug: "another-app" },
  }));
  expect(
    previewResultFromChecks("candidate", foreign, [settled("foreign", 108, "success")]),
  ).toBeNull();
  expect(
    previewResultFromChecks(
      "candidate",
      [...checks("own", 1, "failure"), ...foreign],
      [settled("own", 9, "failure")],
    ),
  ).toMatchObject({ conclusion: "failure" });
});

test.each([
  { state: "pending" },
  { state: "failure" },
  { description: "tests=unknown; deployment=restored; check=9" },
  { description: "tests=success; deployment=restored; check=99" },
  { target_url: "https://depot.dev/orgs/0p91s0lz49/workflows/other?job=8&attempt=other" },
  { target_url: "https://depot.dev/orgs/0p91s0lz49/workflows/run?job=wrong&attempt=other" },
  { target_url: "https://depot.dev/orgs/0p91s0lz49/workflows/run?job=8" },
])("an invalid or unrelated settlement does not certify this run: %j", (change) => {
  expect(
    previewResultFromChecks("candidate", checks("run", 1, "success"), [
      { ...settled("run", 9, "success"), ...change },
    ]),
  ).toBeNull();
});

test("a later consumer completion cannot borrow a settled signal even if its finalizer also reran", () => {
  const run = checks("run", 1, "success");
  run[1].completed_at = "2026-09-16T22:06:00Z";
  run.at(-1)!.completed_at = "2026-09-16T22:07:00Z";
  expect(previewResultFromChecks("candidate", run, [settled("run", 9, "success")])).toBeNull();
});

test("a restarted finalizer cannot borrow its earlier signal even if the check ID stays the same", () => {
  const run = checks("run", 1, "success");
  run.at(-1)!.started_at = "2026-09-16T22:06:00Z";
  run.at(-1)!.completed_at = "2026-09-16T22:07:00Z";
  expect(previewResultFromChecks("candidate", run, [settled("run", 9, "success")])).toBeNull();
});

test("a stale late publication from an older workflow cannot replace a newer settled result", () => {
  const current = settled("new", 108, "success");
  const stale = { ...settled("old", 9, "success"), id: 101 };
  expect(
    previewResultFromChecks(
      "candidate",
      [...checks("old", 1, "success"), ...checks("new", 100, "success")],
      [current, stale],
    ),
  ).toBeNull();
});

test("generic attempt-scoped settlement certifies its own finalizer", () => {
  const signal = {
    ...settled("run", 9, "success"),
    context: "preview-settled finish-attempt",
    description: "tests=success; deployment=restored",
  };
  expect(previewResultFromChecks("candidate", checks("run", 1, "success"), [signal])).toMatchObject(
    { conclusion: "success" },
  );
  expect(
    previewResultFromChecks("candidate", checks("run", 1, "success"), [
      { ...signal, context: "preview-settled another-attempt" },
    ]),
  ).toBeNull();
});

test("reusable-workflow check-name prefixes do not hide settled evidence", () => {
  const run = checks("run", 1, "success").map((check) => ({
    ...check,
    name: check.name.replace("Preview / ", "Preview / Preview / deploy + e2e / "),
  }));
  expect(previewResultFromChecks("candidate", run, [settled("run", 9, "success")])).toMatchObject({
    conclusion: "success",
  });
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

function settled(workflow: string, checkId: number, tests: string) {
  return {
    id: 100,
    context: "preview-settled",
    state: "success",
    description: `tests=${tests}; deployment=restored; check=${checkId}`,
    target_url: `https://depot.dev/orgs/0p91s0lz49/workflows/${workflow}?job=8&attempt=finish-attempt`,
    created_at: "2026-09-16T22:05:00Z",
  };
}
