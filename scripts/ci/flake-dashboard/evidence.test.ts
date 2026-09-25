import { expect, test } from "vitest";
import { planReads, recentRuns, suiteRun } from "./evidence.ts";

const now = new Date("2026-01-10T12:00:00Z");

test("a folder's suites come from its flake-records paths, and it counts once its manifest is listed", () => {
  const planned = planReads(
    [
      ...folder("main", "job1/testrun_a", "2026-01-10T10:00:00Z", [
        "flake-records/flake-records-1.jsonl",
        "flake-records/flake-records-2.jsonl",
        "flake-records/suite-summary.json",
      ]),
      ...folder("pr", "job2/testrun_b", "2026-01-10T11:00:00Z", [
        "flake-records/preview-e2e/flake-records-1.jsonl",
        "flake-records/preview-e2e/suite-summary.json",
        "playwright-html/index.html",
      ]),
      ...folder("pr", "job3/testrun_c", undefined, ["flake-records/specs/suite-summary.json"]),
    ],
    now,
  );

  expect(planned).toEqual([
    {
      suite: "preview-e2e",
      main: false,
      uploadedAt: "2026-01-10T11:00:00Z",
      newest: true,
      recordKeys: [key("pr", "job2/testrun_b", "flake-records/preview-e2e/flake-records-1.jsonl")],
      summaryKey: key("pr", "job2/testrun_b", "flake-records/preview-e2e/suite-summary.json"),
      readSummary: true,
    },
    {
      suite: "unit",
      main: true,
      uploadedAt: "2026-01-10T10:00:00Z",
      newest: true,
      recordKeys: [
        key("main", "job1/testrun_a", "flake-records/flake-records-1.jsonl"),
        key("main", "job1/testrun_a", "flake-records/flake-records-2.jsonl"),
      ],
      summaryKey: key("main", "job1/testrun_a", "flake-records/suite-summary.json"),
      readSummary: true,
    },
  ]);
});

test("every main run of the window is read, each suite's newest runs with their summaries, and nothing older", () => {
  // One run a minute, every tenth on main: the newest hold fewer main runs than newestMain.
  const runs = Array.from({ length: recentRuns.newest + 200 }, (_, n) => {
    const uploadedAt = new Date(now.getTime() - n * 60_000).toISOString();
    return folder(n % 10 === 0 ? "main" : "pr", `job${n}/testrun_${n}`, uploadedAt, [
      "flake-records/suite-summary.json",
    ]);
  });
  const tooOld = folder("main", "old/testrun_old", "2026-01-03T11:59:00Z", [
    "flake-records/suite-summary.json",
  ]);

  const planned = planReads([...runs.flat(), ...tooOld], now);
  const newest = planned.slice(0, recentRuns.newest);
  const older = planned.slice(recentRuns.newest);
  expect(newest.every((run) => run.readSummary && run.newest)).toBe(true);
  expect(older).toHaveLength(20);
  expect(older.every((run) => run.main && !run.newest)).toBe(true);
  expect(planned.filter((run) => run.main && run.readSummary)).toHaveLength(recentRuns.newestMain);
  expect(planned.some((run) => run.uploadedAt.startsWith("2026-01-03"))).toBe(false);
});

test("a run's torn record is dropped and marks its summary incomplete, like records that do not add up", () => {
  const planned = { suite: "unit", main: true, uploadedAt: "2026-01-10T10:00:00Z", newest: true };
  const flake = JSON.stringify({
    name: "deploy",
    kind: "flake",
    outcome: "pass",
    pattern: "CPU",
    durationMs: 5,
    at: "2026-01-10T09:00:00Z",
  });

  const clean = suiteRun(planned, { records: [`${flake}\n`], summary: summary(0) });
  expect(clean?.records).toHaveLength(1);
  expect(clean?.summary?.status).toBe("complete");

  const torn = suiteRun(planned, { records: [`${flake}\n{"name":`], summary: summary(0) });
  expect(torn?.records).toHaveLength(1);
  expect(torn?.summary).toMatchObject({
    status: "incomplete",
    diagnostics: ["Malformed flake record"],
  });

  const uncounted = suiteRun(planned, { records: [flake], summary: summary(1) });
  expect(uncounted?.summary).toMatchObject({
    status: "incomplete",
    diagnostics: ["Unknown flake records do not match the full runner result"],
  });

  expect(suiteRun(planned, { records: [flake], summary: undefined })?.summary).toBeUndefined();
  expect(suiteRun(planned, { records: [flake], summary: "{}" })).toBeUndefined();
});

function folder(
  trust: "main" | "pr",
  path: string,
  manifestAt: string | undefined,
  files: string[],
) {
  const lastModified = manifestAt || "2026-01-10T11:30:00Z";
  return [
    ...files.map((file) => ({ key: key(trust, path, file), lastModified })),
    ...(manifestAt ? [{ key: key(trust, path, "manifest.json"), lastModified: manifestAt }] : []),
  ];
}

function key(trust: string, path: string, file: string) {
  const [job, testRun] = path.split("/");
  return `evidence/ci/trust=${trust}/date=2026-01-10/job=${job}/${testRun}/${file}`;
}

function summary(unknownFlakeCount: number) {
  return JSON.stringify({
    headSha: "abc",
    branch: "main",
    status: "complete",
    startedAt: "2026-01-10T09:00:00.000Z",
    finishedAt: "2026-01-10T09:10:00.000Z",
    testCount: 1,
    tests: [{ name: "deploy", outcome: "pass", durationMs: 1_000, failed: false }],
    unknownFlakeCount,
    failedCount: 0,
    diagnostics: [],
    runUrl: "https://depot.dev/runs/1",
  });
}
