import { expect, test } from "vitest";
import { renderDashboard } from "./dashboard.ts";
import type { FlakeRecord, SuiteRun } from "./evidence.ts";

test("wrapped tests' stats count main's runs; squares show any branch's, linked to their commits", () => {
  const body = render([
    run(1, [record("deploy", "flake-fail", { at: day(1) })]),
    run(2, [record("deploy", "pass", { at: day(2) }), record("boot", "pass", { at: day(2) })], {
      suite: "preview-e2e",
    }),
    run(3, [record("deploy", "flake-fail", { at: day(3) })], { main: false }),
  ]);

  expect(line(body, "`deploy`")).toBe(
    "`deploy` | pattern: `/CPU startup time exceeded/`<br>suites: unit, preview-e2e | runs: 2<br>flake rate: 50%<br>last flake: Jan 2, 12:00am | " +
      "[🟥](https://github.com/iterate/iterate/commit/commit-1)[🟩](https://github.com/iterate/iterate/commit/commit-2)[🟥](https://github.com/iterate/iterate/commit/commit-3)<br>1× pass (main)",
  );
  expect(line(body, "`boot`")).toContain("runs: 1<br>flake rate: 0%<br>last flake: never");
});

test("streak squares show the last 10 outcomes, oldest first, and the main streak rides below them", () => {
  const runs = [run(0, [record("deploy", "flake-fail", { at: day(0) })])];
  for (let n = 1; n <= 8; n++) runs.push(run(n, [record("deploy", "pass", { at: day(n) })]));
  runs.push(run(9, [record("deploy", "unexpected-error", { at: day(9) })], { main: false }));
  runs.push(run(10, [record("deploy", "pass", { at: day(10) })]));

  const row = line(render(runs), "`deploy`");
  expect(row.match(/🟥|🟩|❌/gu)).toEqual([...Array<string>(8).fill("🟩"), "❌", "🟩"]);
  expect(row).toContain("<br>9× pass (main)");
});

test("a test whose wrapper came off leaves Flakes once it records as a plain test", () => {
  const runs = Array.from({ length: 20 }, (_, n) =>
    run(n, [record("deploy", "pass", { at: day(n) })]),
  );
  expect(line(render(runs), "`deploy`")).toContain("proposed: unwrap");

  runs.push(
    run(20, [record("deploy", "retried-pass", { at: day(20), kind: "unknown", error: "boom" })]),
  );
  const body = render(runs);
  expect(body).not.toContain("`deploy`");
  expect(body).toContain("deploy | `boom` | unit |");
  expect(body).not.toContain("retired");
});

test("rows group into sections by kind, sentinels split out of Flakes", () => {
  const body = render([
    run(1, [
      record("deploy", "flake-fail"),
      record("flake sentinel", "pass"),
      record("stale facet", "pinned-fail", { kind: "failing" }),
      record("chat upload", "retried-pass", {
        kind: "unknown",
        error: "Timeout 30000ms exceeded | waiting for getByLabel('attachment')",
      }),
    ]),
  ]);

  const positions = [
    "## Flakes",
    "`deploy`",
    "## Failures",
    "`stale facet`",
    "## Unknown flakes",
    "chat upload |",
    "## Sentinels",
    "`flake sentinel`",
  ].map((needle) => body.indexOf(needle));
  expect(positions.every((position) => position >= 0)).toBe(true);
  expect(positions).toEqual(positions.toSorted((a, b) => a - b));
  expect(body).toContain("<details>\n<summary>1 test · unit: 1</summary>");
  expect(body).not.toContain("`chat upload`");
});

test("a pin's row shows pin-held stats, and pinned since dates the switch from createFlake", () => {
  const row = line(
    render([
      run(0, [record("stale facet", "flake-fail", { at: day(0) })]),
      run(1, [record("stale facet", "pinned-fail", { at: day(1), kind: "failing" })]),
      run(2, [record("stale facet", "pinned-fail", { at: day(2), kind: "failing" })]),
      run(3, [record("stale facet", "unexpected-pass", { at: day(3), kind: "failing" })]),
    ]),
    "`stale facet`",
  );

  expect(row).toContain(
    "runs: 3<br>pin held: 2<br>unexpected passes: 1<br>pinned since: Jan 2, 12:00am",
  );
  expect(row.match(/🟥|🟩|❌/gu)).toEqual(["🟥", "🟥", "🟩"]);
});

test("a renamed test's row retires once absent from its suite's last 3 complete runs", () => {
  const runs = [run(1, [record("old name", "flake-fail")], { suite: "specs", main: false })];
  for (const n of [2, 3]) runs.push(run(n, [record("new name", "pass")], { suite: "specs" }));
  expect(render(runs)).toContain("`old name`");

  runs.push(run(4, [record("new name", "pass")], { suite: "specs" }));
  const body = render(runs);
  expect(body).not.toContain("`old name`");
  expect(body).toContain("`new name`");
  expect(body).toContain("_1 retired test hidden (absent from the last 3 runs of their suite)._");
});

test("incomplete runs cannot retire a pin or a sentinel", () => {
  const runs = [
    run(
      1,
      [record("stale facet", "pinned-fail", { kind: "failing" }), record("flake sentinel", "pass")],
      {
        suite: "specs",
      },
    ),
  ];
  for (const n of [2, 3, 4, 5]) runs.push(run(n, [], { suite: "specs", complete: false }));

  const body = render(runs);
  expect(body).toContain("`stale facet`");
  expect(body).toContain("`flake sentinel`");
});

test("a test in two suites stays visible while either still carries it", () => {
  const body = render([
    run(1, [record("flake sentinel", "pass")], { suite: "unit" }),
    run(2, [record("flake sentinel", "pass")], { suite: "local-smoke" }),
    run(3, [record("boot", "pass")], { suite: "unit" }),
    run(4, [record("boot", "pass")], { suite: "unit" }),
    run(5, [record("boot", "pass")], { suite: "unit" }),
  ]);

  expect(body).toContain("`flake sentinel`");
});

test("20 main passes in a row propose unwrapping, however quickly; a later flake withdraws it", () => {
  const runs = Array.from({ length: 20 }, (_, n) =>
    run(n / 100, [record("deploy", "pass", { at: day(n / 100) })]),
  );
  expect(line(render(runs), "`deploy`")).toContain("proposed: unwrap");

  runs.push(run(1, [record("deploy", "flake-fail", { at: day(1) })]));
  expect(line(render(runs), "`deploy`")).not.toContain("proposed:");
});

test("main streaks ignore other branches and end at an unexpected error", () => {
  const runs = Array.from({ length: 19 }, (_, n) =>
    run(n, [record("deploy", "pass", { at: day(n) })]),
  );
  runs.push(run(19, [record("deploy", "flake-fail", { at: day(19) })], { main: false }));
  runs.push(run(20, [record("deploy", "pass", { at: day(20) })]));
  expect(line(render(runs), "`deploy`")).toContain("proposed: unwrap");
  expect(line(render(runs), "`deploy`")).toContain("<br>20× pass (main)");

  runs.push(run(21, [record("deploy", "unexpected-error", { at: day(21) })]));
  const row = line(render(runs), "`deploy`");
  expect(row).not.toContain("proposed:");
  expect(row).not.toContain("(main)");
});

test("switch-to-failing needs 25 main flakes over two days; unwrap-failing 10 unexpected passes over two", () => {
  const flakes = (span: number) =>
    Array.from({ length: 25 }, (_, n) =>
      run((n * span) / 24, [record("deploy", "flake-fail", { at: day((n * span) / 24) })]),
    );
  expect(line(render(flakes(1)), "`deploy`")).not.toContain("proposed:");
  expect(line(render(flakes(2)), "`deploy`")).toContain("proposed: switch-to-failing");

  const passes = Array.from({ length: 10 }, (_, n) =>
    run((n * 2) / 9, [record("pin", "unexpected-pass", { at: day((n * 2) / 9), kind: "failing" })]),
  );
  expect(line(render(passes), "`pin`")).toContain("proposed: unwrap-failing");
});

test("sentinels never propose", () => {
  const runs = Array.from({ length: 30 }, (_, n) =>
    run(n, [record("flake sentinel", "pass", { at: day(n) })]),
  );

  expect(line(render(runs), "`flake sentinel`")).not.toContain("proposed:");
});

test("an unknown flake on main stays until it passes 20 complete main runs in a row", () => {
  const flake = record("chat upload", "retried-pass", {
    at: day(1),
    kind: "unknown",
    error: "Timeout 30000ms exceeded | waiting\nfor getByLabel('attachment')",
  });
  const passed = { tests: [{ name: "chat upload", outcome: "pass" as const }] };
  const runs = [run(1, [flake], { main: false })];
  expect(render(runs)).not.toContain("chat upload |");

  runs.push(run(2, [flake]));
  expect(render(runs)).toContain(
    "chat upload | `Timeout 30000ms exceeded \\| waiting for getByLabel('attachment')` | unit | [🟥](https://github.com/iterate/iterate/commit/commit-2)<br>0/20 consecutive passes",
  );
  runs.push(run(3, [], { ...passed, complete: false }));
  runs.push(run(4, [], { tests: [{ name: "chat upload", outcome: "skip" }] }));
  for (let n = 5; n < 24; n++) runs.push(run(n, [], passed));
  expect(render(runs)).toContain("19/20 consecutive passes");

  runs.push(run(24, [], passed));
  expect(render(runs)).not.toContain("chat upload |");

  runs.push(run(25, [flake]));
  expect(render(runs)).toContain("0/20 consecutive passes");
});

test("a plain test's hard failure on main opens an unknown row with its error", () => {
  const failure = record("socket opens", "unexpected-error", {
    kind: "unknown",
    error: "socket closed before the stream opened",
  });

  const body = render([run(1, [failure], { tests: [{ name: "socket opens", outcome: "fail" }] })]);
  expect(body).toContain(
    "socket opens | `socket closed before the stream opened` | unit | [❌](https://github.com/iterate/iterate/commit/commit-1)<br>0/20 consecutive passes",
  );
});

test("an unknown streak counts only its test's complete main passes in its own suite", () => {
  const pass = { name: "chat upload", outcome: "pass" } as const;
  const body = render([
    run(1, [record("chat upload", "retried-pass", { kind: "unknown" })]),
    run(2, [], { tests: [pass] }),
    run(3, [], { tests: [pass], main: false }),
    run(4, [], { tests: [pass], suite: "specs" }),
    run(5, [], { tests: [pass], complete: false }),
    run(6, [], { tests: [pass, { name: "chat upload", outcome: "skip" }] }),
    run(7, [], { tests: [pass] }),
  ]);

  expect(body).toContain("2/20 consecutive passes");
  expect(line(body, "chat upload |").match(/🟥|🟩|❌/gu)).toEqual(["🟥", "🟩", "🟩"]);
});

test("a complete main run's test list without the test retires its unknown row; an incomplete one does not", () => {
  const runs = [
    run(1, [record("gone", "retried-pass", { kind: "unknown" })], {
      tests: [{ name: "gone", outcome: "pass" }],
    }),
    run(2, [], { tests: [{ name: "other", outcome: "pass" }], complete: false }),
  ];
  expect(render(runs)).toContain("gone |");

  runs.push(run(3, [], { tests: [{ name: "other", outcome: "pass" }] }));
  expect(render(runs)).not.toContain("gone |");
});

test("a wrapper on main adopts an unknown flake: its row moves from Unknown flakes to Flakes", () => {
  const body = render([
    run(1, [record("chat upload", "retried-pass", { kind: "unknown" })]),
    run(2, [record("chat upload", "pass")]),
  ]);

  expect(body).not.toContain("chat upload |");
  expect(body).toContain("`chat upload`");
});

test("each suite's line names its latest complete main run, and an incomplete attempt after it", () => {
  const body = render([
    run(1, [], { suite: "unit" }),
    run(2, [], { suite: "unit", complete: false }),
    run(3, [], { suite: "specs", complete: false }),
  ]);

  expect(body).toContain(
    "- **unit:** [commit-](https://depot.dev/runs/run-1) · Jan 2, 12:01am UTC · 1 tests · 0 failed. Latest attempt [commit-](https://depot.dev/runs/run-2) incomplete: test runner interrupted.",
  );
  expect(body).toContain(
    "- **specs:** awaiting a complete main result. Latest attempt [commit-](https://depot.dev/runs/run-3) incomplete: test runner interrupted.",
  );
  expect(body).toContain("_No active unknown flakes.");
});

test("the Cost section prices each suite's rows: percentiles, marginal wall, retries, PR failures and proposals", () => {
  const row = (name: string, startMs: number, durationMs: number, extra = {}) => ({
    name,
    outcome: "pass" as const,
    startMs,
    durationMs,
    ...extra,
  });
  const incident = (n: number) =>
    Array.from({ length: 8 }, (_, i) =>
      row(`quick ${i}`, 0, 2_000, {
        outcome: "fail",
        retries: 1,
        error: `internal error; reference = ${n}f00ba4${i}deadbeef`,
      }),
    );
  const body = render(
    [1, 2, 3, 4].map((n) =>
      run(n, [], {
        suite: "preview-e2e",
        main: n === 4,
        tests: [
          row("a quiet minute", 13_000, 181_000),
          row("a row just past the budget", 13_000, 61_000),
          row("a slow row", 13_000, 400_000, { tags: ["slow"] }),
          row("a flaky row", 13_000, 3_000, {
            outcome: "fail",
            retries: 1,
            failed: n === 2,
            error: "socket closed",
          }),
          row("a quick row", 13_000, 9_000),
          row("a sometimes slow row", 13_000, n === 1 ? 12_000 : 5_000),
          ...(n === 3 ? incident(n) : []),
        ],
      }),
    ),
  );

  expect(body).toContain("### preview-e2e: 4 runs since Jan 2, 12:00am UTC · 1 incident");
  expect(
    body
      .split("\n")
      .filter(
        (line) => line.endsWith("proposal") || / \| (—|make faster.*|tagged `slow`)$/u.test(line),
      ),
  ).toEqual([
    "row | p50 | p95 | marginal | retries | PR failures | proposal",
    "a slow row | 400.0 s | 400.0 s | 219.0 s | 0 | 0 | tagged `slow`",
    "a quiet minute | 181.0 s | 181.0 s | — | 0 | 0 | make faster, or tag `slow`",
    "a row just past the budget | 61.0 s | 61.0 s | — | 0 | 0 | make faster, or tag `slow`",
    "a sometimes slow row | < 10.0 s | 12.0 s | — | 0 | 0 | —",
    "a flaky row | 3.0 s | 3.0 s | — | 4 | 1 | —",
  ]);
  expect(body).toContain(
    "- incident, Jan 4, 12:00am UTC: 8 rows failed an attempt with `internal error; reference = …`",
  );
  expect(body).not.toContain("a quick row");
});

test("the Cost window is each suite's last 100 complete runs among its newest", () => {
  const priced = (n: number, name: string) =>
    run(n, [], { tests: [{ name, outcome: "pass", startMs: 0, durationMs: 20_000 }] });
  const runs = [priced(1, "an old row"), priced(2, "an old row")];
  for (let n = 3; n <= 102; n++) runs.push(priced(n, "a new row"));
  runs.push(
    run(104, [], {
      newest: false,
      tests: [{ name: "a main row read for its outcome", outcome: "pass", durationMs: 20_000 }],
    }),
  );

  const body = render(runs);
  expect(body).toContain("### unit: 100 runs since Jan 4, 12:00am UTC");
  expect(body).toContain("a new row |");
  expect(body).not.toContain("an old row");
  expect(body).not.toContain("a main row read for its outcome");
});

function render(runs: SuiteRun[]) {
  return renderDashboard(runs, { owner: "iterate", repo: "iterate" });
}

function line(body: string, start: string) {
  const found = body.split("\n").find((candidate) => candidate.startsWith(start));
  if (!found) throw new Error(`no line starts with ${start}`);
  return found;
}

type SummaryTest = NonNullable<SuiteRun["summary"]>["tests"][number];

/** A suite run uploaded `n` days after the epoch: main and complete unless told otherwise. Its
 *  tests ran 0 ms and did not fail unless told otherwise. */
function run(
  n: number,
  records: FlakeRecord[],
  options: {
    suite?: string;
    main?: boolean;
    complete?: boolean;
    newest?: boolean;
    tests?: (Pick<SummaryTest, "name" | "outcome"> & Partial<SummaryTest>)[];
  } = {},
): SuiteRun {
  const complete = options.complete !== false;
  return {
    suite: options.suite || "unit",
    main: options.main !== false,
    uploadedAt: day(n + 0.001),
    newest: options.newest !== false,
    records,
    summary: {
      headSha: `commit-${n}`,
      branch: options.main === false ? "some-pr" : "main",
      status: complete ? "complete" : "incomplete",
      startedAt: day(n),
      finishedAt: day(n + 0.001),
      testCount: options.tests?.length || Math.max(1, records.length),
      tests: (options.tests || []).map((test) => ({ durationMs: 0, failed: false, ...test })),
      unknownFlakeCount: records.filter((record) => record.kind === "unknown").length,
      failedCount: 0,
      diagnostics: complete ? [] : ["test runner interrupted"],
      runUrl: `https://depot.dev/runs/run-${n}`,
    },
  };
}

function record(
  name: string,
  outcome: FlakeRecord["outcome"],
  options: { at?: string; kind?: FlakeRecord["kind"]; error?: string } = {},
): FlakeRecord {
  const kind = options.kind || "flake";
  return {
    name,
    kind,
    outcome,
    pattern: kind === "unknown" ? undefined : "CPU startup time exceeded",
    error: options.error,
    durationMs: 5,
    at: options.at || day(0),
  };
}

/** ISO timestamp `days` (fractional ok) after a fixed epoch. */
function day(days: number) {
  return new Date(Date.UTC(2026, 0, 1) + days * 24 * 60 * 60 * 1000).toISOString();
}
