import { deflateRawSync } from "node:zlib";
import { expect, test } from "vitest";
import { FlakeDashboardState, flakeEventTypes, type FlakeDashboardEvent } from "./contract.ts";
import {
  flakeRecordsSuite,
  foldFlakeRuns,
  proposeFlakeTransitions,
  reduceFlakeDashboard,
  renderBody,
  runRecordedFromArtifact,
  startFlakeDashboard,
} from "./fold.ts";

test("folds CI-reported records into per-test stats", async () => {
  const h = makeHarness();
  await h.append(birth(), runRecorded(1, [record("deploy", "flake-fail", { at: day(0) })]));
  await h.append(
    runRecorded(
      2,
      [record("deploy", "pass", { at: day(1) }), record("boot", "pass", { at: day(1) })],
      {
        suite: "e2e",
      },
    ),
  );

  expect(h.state().tests).toMatchObject({
    deploy: {
      pattern: "CPU startup time exceeded",
      suites: ["unit", "e2e"],
      counts: { pass: 1, "flake-fail": 1 },
      lastFlakeAt: day(0),
    },
    boot: { counts: { pass: 1 } },
  });
});

test("a renamed test's old row retires once absent from 3 suite runs, not before", async () => {
  // Tracked tests keep their all-branch history. Three complete runs are
  // needed so a single PR deleting a test cannot hide it repo-wide.
  const h = makeHarness();
  await h.append(
    birth(),
    runRecorded(1, [record("old name", "flake-fail", { at: day(0) })], {
      suite: "specs",
      branch: "some-pr",
    }),
  );
  expect(renderBody(h.state())).toContain("`old name`");

  // Two runs carrying only the new name: the old row is still within the
  // suite's 3-run window, so it stays.
  for (const n of [2, 3]) {
    await h.append(
      runRecorded(n, [record("new name", "pass", { at: day(n) })], {
        suite: "specs",
        branch: "rename-pr",
      }),
    );
  }
  expect(renderBody(h.state())).toContain("`old name`");

  // The third absent run pushes the old name out of the window: retired —
  // hidden from the table, never deleted from state.
  await h.append(
    runRecorded(4, [record("new name", "pass", { at: day(4) })], {
      suite: "specs",
      branch: "another-pr",
    }),
  );
  const body = renderBody(h.state());
  expect(body).not.toContain("`old name`");
  expect(body).toContain("`new name`");
  expect(body).toContain("1 retired test hidden");
  expect(h.state().tests["old name"]).toBeDefined();
});

test("incomplete runs cannot retire tracked failures or sentinels", async () => {
  const h = makeHarness();
  await h.append(
    birth(),
    runRecorded(
      1,
      [
        record("tracked failure", "pinned-fail", { kind: "failing" }),
        record("flake sentinel", "pass"),
      ],
      { suite: "specs" },
    ),
  );
  for (const n of [2, 3, 4, 5])
    await h.append(runRecorded(n, [], { suite: "specs", branch: "docs-only-pr", complete: false }));
  const body = renderBody(h.state());
  expect(body).toContain("`tracked failure`");
  expect(body).toContain("`flake sentinel`");
  expect(h.state().suites.specs!.recentRunOffsets).toHaveLength(1);
});

test("a transiently-absent test survives the window and returns with its history intact", async () => {
  const h = makeHarness();
  await h.append(
    birth(),
    runRecorded(1, [record("deploy", "flake-fail", { at: day(0) })]),
    // A partial run (a push-cancelled suite that died before this test) does
    // not retire the row — one absent run is inside the 3-run window...
    runRecorded(2, [record("boot", "pass", { at: day(1) })]),
  );
  expect(renderBody(h.state())).toContain("`deploy`");
  // ...and its next record resets the window, counts accumulated across the
  // gap — expiry is a projection choice over the log, nothing was deleted.
  await h.append(runRecorded(3, [record("deploy", "pass", { at: day(2) })]));
  expect(renderBody(h.state())).toContain("`deploy`");
  expect(h.state().tests.deploy!.counts).toMatchObject({ pass: 1, "flake-fail": 1 });
});

test("a multi-suite test stays visible while any of its suites still carries it", async () => {
  const h = makeHarness();
  await h.append(
    birth(),
    runRecorded(1, [record("flake sentinel", "pass", { at: day(0) })], { suite: "unit" }),
    runRecorded(2, [record("flake sentinel", "pass", { at: day(0) })], { suite: "local-smoke" }),
    // Three unit runs without the sentinel retire it from unit's window —
    // but it is still in local-smoke's latest run, so the row stays.
    runRecorded(3, [record("boot", "pass", { at: day(1) })], { suite: "unit" }),
    runRecorded(4, [record("boot", "pass", { at: day(1) })], { suite: "unit" }),
    runRecorded(5, [record("boot", "pass", { at: day(1) })], { suite: "unit" }),
  );
  expect(renderBody(h.state())).toContain("`flake sentinel`");
});

test("streak squares show up to 10 outcomes from any branch, oldest first", async () => {
  const h = makeHarness();
  await h.append(birth(), runRecorded(0, [record("deploy", "flake-fail", { at: day(0) })]));
  for (let i = 1; i <= 8; i++) {
    await h.append(runRecorded(i, [record("deploy", "pass", { at: day(i) })]));
  }
  // A PR-branch outcome enters the bar too, for debugging branch failures.
  await h.append(
    runRecorded(99, [record("deploy", "unexpected-error", { at: day(9) })], {
      branch: "some-pr",
    }),
  );
  const row = renderBody(h.state())
    .split("\n")
    .find((line) => line.startsWith("`deploy`"))!;
  // Squares in test-time order, each linking to the commit that produced it.
  expect(row.match(/🟥|🟩|❌/gu)).toEqual(["🟥", ...Array<string>(8).fill("🟩"), "❌"]);
  expect(row).toContain("[🟥](https://github.com/iterate/iterate/commit/commit-0)");
  expect(row).toContain("[❌](https://github.com/iterate/iterate/commit/commit-99)");
  // The numeric default-branch streak rides below the squares.
  expect(row).toContain("<br>8× pass (main)");

  // An 11th outcome evicts the oldest: the bar caps at 10.
  await h.append(runRecorded(10, [record("deploy", "pass", { at: day(10) })]));
  expect(h.state().tests.deploy!).toMatchObject({
    recent: [
      ...Array.from({ length: 8 }, (_, i) => ({
        outcome: "pass",
        commit: `commit-${i + 1}`,
        at: day(i + 1),
      })),
      { outcome: "unexpected-error", commit: "commit-99", at: day(9) },
      { outcome: "pass", commit: "commit-10", at: day(10) },
    ],
  });
});

test("info and stats render as line-per-fact cells with readable dates", async () => {
  const h = makeHarness();
  await h.append(birth(), runRecorded(1, [record("deploy", "flake-fail", { at: day(0) })]));
  const row = renderBody(h.state())
    .split("\n")
    .find((line) => line.startsWith("`deploy`"))!;
  expect(row).toContain("pattern: `/CPU startup time exceeded/`<br>suites: unit");
  expect(row).toContain("runs: 1<br>flake rate: 100%<br>last flake: Jan 1, 12:00am");
});

test("rows group into sections by kind, sentinels split out of Flakes", async () => {
  const h = makeHarness();
  await h.append(
    birth(),
    runRecorded(1, [
      record("deploy", "flake-fail", { at: day(0) }),
      record("flake sentinel", "pass", { at: day(0) }),
      record("stale facet", "pinned-fail", { at: day(0), kind: "failing" }),
      record("chat upload", "retried-pass", {
        at: day(0),
        kind: "unknown",
        error: "Timeout 30000ms exceeded | waiting for getByLabel('attachment')",
      }),
    ]),
  );
  const body = renderBody(h.state());
  // Section order and membership: each row under its own heading.
  const order = [
    "## Flakes",
    "`deploy`",
    "## Failures",
    "`stale facet`",
    "## Unknown flakes",
    "chat upload |",
    "## Sentinels",
    "`flake sentinel`",
  ];
  const positions = order.map((needle) => body.indexOf(needle));
  expect(positions.every((position) => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].toSorted((a, b) => a - b));
  expect(body).toContain("❌ failed differently than expected");
  expect(body).toContain("<details>\n<summary>1 test · unit: 1</summary>");
  expect(body).not.toContain("`chat upload`");
  expect(positions.every((position) => position >= 0)).toBe(true);
});

test("failure rows show pin-held stats and pinned since dates the pin, not the flake era", async () => {
  const h = makeHarness();
  await h.append(
    birth(),
    // The designed lifecycle: tracked as a flake first, then switched to a
    // createFailing pin — "pinned since" must date the switch.
    runRecorded(0, [record("stale facet", "flake-fail", { at: day(0) })]),
    runRecorded(1, [record("stale facet", "pinned-fail", { at: day(1), kind: "failing" })]),
    runRecorded(2, [record("stale facet", "pinned-fail", { at: day(2), kind: "failing" })]),
    runRecorded(3, [record("stale facet", "unexpected-pass", { at: day(3), kind: "failing" })]),
  );
  const row = renderBody(h.state())
    .split("\n")
    .find((line) => line.startsWith("`stale facet`"))!;
  expect(row).toContain(
    "runs: 4<br>pin held: 2<br>unexpected passes: 1<br>pinned since: Jan 2, 12:00am",
  );
  // Honest colors for a pin: red while the bug is present, green when it
  // unexpectedly passes.
  expect(row.match(/🟥|🟩|❌/gu)).toEqual(["🟥", "🟥", "🟥", "🟩"]);
});

test("an unknown flake stays until it passes 20 main runs in a row", async () => {
  const h = makeHarness();
  const flake = record("chat upload", "retried-pass", {
    at: day(0),
    kind: "unknown",
    error: "Timeout 30000ms exceeded | waiting\nfor getByLabel('attachment')",
  });
  await h.append(birth(), runRecorded(1, [flake], { branch: "some-pr" }));
  expect(renderBody(h.state())).not.toContain("chat upload |");
  await h.append(runRecorded(2, [flake]));
  const fresh = renderBody(h.state());
  expect(fresh).toContain("chat upload |");
  expect(fresh).toContain("`Timeout 30000ms exceeded \\| waiting for getByLabel('attachment')`");
  await h.append(runRecorded(3, [], { complete: false }));
  expect(renderBody(h.state())).toContain("chat upload |");
  expect(renderBody(h.state())).toContain("incomplete");
  for (let n = 4; n < 23; n++) {
    await h.append(
      runRecorded(n, [], {
        tests: [{ name: "chat upload", outcome: "pass" }],
      }),
    );
  }
  expect(renderBody(h.state())).toContain("chat upload |");
  expect(renderBody(h.state())).toContain("19/20 consecutive passes");
  await h.append(
    runRecorded(23, [], {
      tests: [{ name: "chat upload", outcome: "pass" }],
    }),
  );
  expect(renderBody(h.state())).not.toContain("chat upload |");
  expect(h.events(flakeEventTypes.transitionProposed)).toHaveLength(0);
  expect(h.state().tests["chat upload"]!.counts).toMatchObject({ "retried-pass": 2 });
  await h.append(runRecorded(24, [flake]));
  expect(renderBody(h.state())).toContain("chat upload |");
  expect(renderBody(h.state())).toContain("0/20 consecutive passes");
});

test("a plain test's hard failure on main opens an unknown row with its error; on a PR it does not", async () => {
  const h = makeHarness();
  const failure = record("socket opens", "unexpected-error", {
    kind: "unknown",
    error: "socket closed before the stream opened",
  });
  const failed = { tests: [{ name: "socket opens", outcome: "fail" as const }] };
  await h.append(birth(), runRecorded(1, [failure], { ...failed, branch: "some-pr" }));
  expect(renderBody(h.state())).not.toContain("socket opens |");
  await h.append(runRecorded(2, [failure], failed));
  const body = renderBody(h.state());
  expect(body).toContain("socket opens |");
  expect(body).toContain("`socket closed before the stream opened`");
  expect(body).toContain("[❌](https://github.com/iterate/iterate/commit/commit-2)<br>0/20");
  expect(h.state().tests["socket opens"]!.counts).toMatchObject({ "unexpected-error": 2 });
});

test("unknown streaks count only that test's complete main results in its suite", async () => {
  const h = makeHarness();
  const pass = { name: "chat upload", outcome: "pass" } as const;
  await h.append(
    birth(),
    runRecorded(1, [record("chat upload", "retried-pass", { kind: "unknown" })]),
    runRecorded(2, [], { tests: [pass] }),
    runRecorded(3, [], { tests: [pass], branch: "some-pr" }),
    runRecorded(4, [], { tests: [pass], suite: "specs" }),
    runRecorded(5, [], { tests: [pass], complete: false }),
    runRecorded(6, [], { tests: [{ ...pass, outcome: "skip" }] }),
    runRecorded(7, [], { tests: [{ name: "another test", outcome: "pass" }], complete: false }),
    // A legacy summary with just counts is not proof of this test passing.
    runRecorded(8, []),
    // Late delivery cannot advance the streak with an older observation.
    runRecorded(0, [], { tests: [pass] }),
    // Two instances sharing a title count as one run, not two passes.
    runRecorded(9, [], { tests: [pass, pass] }),
  );
  expect(renderBody(h.state())).toContain("2/20 consecutive passes");
  await h.append(runRecorded(10, [], { tests: [pass, { ...pass, outcome: "fail" }] }));
  expect(renderBody(h.state())).toContain("0/20 consecutive passes");
});

test("only a complete main test inventory retires absent unknown flakes", async () => {
  const h = makeHarness();
  const flake = record("chat upload", "retried-pass", { kind: "unknown" });
  const anotherTest = { name: "another test", outcome: "pass" } as const;
  await h.append(birth(), runRecorded(1, [flake]));
  await h.append(
    runRecorded(2, [], { tests: [anotherTest], branch: "some-pr" }),
    runRecorded(3, [], { tests: [anotherTest], suite: "specs" }),
    runRecorded(4, [], { tests: [{ name: "chat upload", outcome: "skip" }] }),
    runRecorded(5, []), // A legacy count-only summary cannot prove absence.
    runRecorded(6, [], { tests: [anotherTest], complete: false }),
  );
  expect(renderBody(h.state())).toContain("chat upload |");
  await h.append(runRecorded(7, [], { tests: [anotherTest] }));
  expect(renderBody(h.state())).not.toContain("chat upload |");
  await h.append(
    runRecorded(8, []),
    runRecorded(3.5, [flake, record("late historical retry", "retried-pass", { kind: "unknown" })]),
  );
  expect(renderBody(h.state())).not.toContain("chat upload |");
  expect(renderBody(h.state())).not.toContain("late historical retry |");
  await h.append(runRecorded(9, [flake]));
  expect(renderBody(h.state())).toContain("chat upload |");
  // An older inventory cannot hide a test observed in a newer run.
  await h.append(runRecorded(8.5, [], { tests: [anotherTest] }));
  expect(renderBody(h.state())).toContain("chat upload |");
  await h.append(runRecorded(12, [], { tests: [anotherTest], complete: false }));
  expect(renderBody(h.state())).toContain("chat upload |");
  // The incomplete run did not observe this test and cannot block proof of deletion.
  await h.append(runRecorded(10, [], { tests: [anotherTest] }));
  expect(renderBody(h.state())).not.toContain("chat upload |");
});

test.each(["retry", "final failure"])(
  "a late %s still breaks an unknown pass streak",
  async (failure) => {
    const h = makeHarness();
    const flake = record("chat upload", "retried-pass", { kind: "unknown" });
    const pass = { name: "chat upload", outcome: "pass" } as const;
    await h.append(
      birth(),
      runRecorded(1, [flake]),
      runRecorded(2, [], { tests: [pass] }),
      runRecorded(5, [], { complete: false }),
      // The later incomplete run must not hide a late-delivered failure.
      runRecorded(4, failure === "retry" ? [flake] : [], {
        tests: [{ ...pass, outcome: "fail" }],
      }),
      runRecorded(6, [], { tests: [pass] }),
    );
    expect(renderBody(h.state())).toContain("1/20 consecutive passes");
  },
);

test("a late failure can restore a row that reached 20 passes before that failure arrived", async () => {
  const h = makeHarness();
  await h.append(
    birth(),
    runRecorded(0, [record("chat upload", "retried-pass", { kind: "unknown" })]),
  );
  for (let n = 1; n <= 20; n++) {
    await h.append(runRecorded(n, [], { tests: [{ name: "chat upload", outcome: "pass" }] }));
  }
  expect(renderBody(h.state())).not.toContain("chat upload |");
  await h.append(runRecorded(19.5, [], { tests: [{ name: "chat upload", outcome: "fail" }] }));
  expect(renderBody(h.state())).toContain("chat upload |");
  expect(renderBody(h.state())).toContain("0/20 consecutive passes");
});

test("a retry in an interrupted main run resets an unknown streak; a main wrapper adopts it", async () => {
  const h = makeHarness();
  const flake = record("chat upload", "retried-pass", { kind: "unknown" });
  await h.append(birth(), runRecorded(1, [flake], { complete: false }));
  expect(renderBody(h.state())).toContain("chat upload |");
  await h.append(
    runRecorded(2, [], { tests: [{ name: "chat upload", outcome: "pass" }] }),
    runRecorded(3, [flake], { complete: false }),
  );
  expect(renderBody(h.state())).toContain("0/20 consecutive passes");
  await h.append(runRecorded(4, [record("chat upload", "pass")], { branch: "some-pr" }));
  expect(renderBody(h.state())).toContain("chat upload |");
  await h.append(runRecorded(5, [record("chat upload", "pass")]));
  expect(renderBody(h.state())).not.toContain("chat upload |");
  expect(renderBody(h.state())).toContain("`chat upload` |");
});

test("a late retry cannot undo newer wrapper adoption on main", async () => {
  const h = makeHarness();
  const flake = record("chat upload", "retried-pass", { kind: "unknown" });
  await h.append(
    birth(),
    runRecorded(2, [record("chat upload", "pass")]),
    runRecorded(3, [record("chat upload", "pass")]),
    runRecorded(1, [flake]),
  );
  expect(renderBody(h.state())).not.toContain("chat upload |");
  expect(renderBody(h.state())).toContain("`chat upload` |");
  expect(h.state().tests["chat upload"]).toMatchObject({
    kind: "flake",
    defaultBranchStreak: { outcome: "pass", runs: 2 },
    counts: { "retried-pass": 1 },
  });
  // A newer unwrapped retry is fresh evidence, not a stale pre-adoption run.
  await h.append(runRecorded(4, [flake]));
  expect(renderBody(h.state())).toContain("chat upload |");
});

test("a late wrapper cannot duplicate a newer unknown flake row", async () => {
  const h = makeHarness();
  await h.append(
    birth(),
    runRecorded(3, [record("chat upload", "retried-pass", { kind: "unknown", at: day(3) })]),
    runRecorded(1, [record("chat upload", "pass", { at: day(1) })]),
  );
  expect(renderBody(h.state())).toContain("chat upload |");
  expect(renderBody(h.state())).not.toContain("`chat upload` |");
  expect(h.state().tests["chat upload"]).toMatchObject({
    kind: "unknown",
    pattern: "",
    defaultBranchStreak: { outcome: "retried-pass", runs: 1 },
    counts: { "retried-pass": 1, pass: 1 },
  });
  await h.append(runRecorded(4, [record("chat upload", "pass", { at: day(4) })]));
  expect(renderBody(h.state())).not.toContain("chat upload |");
  expect(renderBody(h.state())).toContain("`chat upload` |");
});

test("late retries keep history chronological without moving last flake backwards", async () => {
  const h = makeHarness();
  await h.append(
    birth(),
    runRecorded(2, [record("chat upload", "flake-fail", { at: day(2) })]),
    runRecorded(3, [
      record("chat upload", "unexpected-error", { at: day(3), error: "new error" }),
      record("signup", "retried-pass", { kind: "unknown", at: day(3), error: "new signup error" }),
    ]),
    runRecorded(1, [
      record("chat upload", "retried-pass", { kind: "unknown", at: day(1), error: "old error" }),
      record("signup", "retried-pass", { kind: "unknown", at: day(1), error: "old signup error" }),
    ]),
  );
  expect(h.state().tests["chat upload"]).toMatchObject({
    kind: "flake",
    lastFlakeAt: day(2),
    lastRecordedAt: day(3),
    recent: [{ commit: "commit-1" }, { commit: "commit-2" }, { commit: "commit-3" }],
    recentErrors: [{ error: "old error" }, { error: "new error" }],
    counts: { "retried-pass": 1, "flake-fail": 1, "unexpected-error": 1 },
  });
  expect(renderBody(h.state())).toContain("last flake: Jan 3, 12:00am");
  expect(h.state().unknownFlakes.unit!.signup).toMatchObject({
    record: { error: "new signup error", at: day(3) },
    recent: [{ commit: "commit-1" }, { commit: "commit-3" }],
  });
});

test("sentinel streaks never propose transitions", async () => {
  const h = makeHarness();
  await h.append(birth());
  for (let i = 0; i < 60; i++) {
    await h.append(runRecorded(i, [record("flake sentinel", "pass", { at: day(i / 5) })]));
  }
  expect(h.events(flakeEventTypes.transitionProposed)).toHaveLength(0);
});

test("a pin that keeps passing unexpectedly proposes unwrap-failing", async () => {
  const h = makeHarness();
  await h.append(birth());
  for (let i = 0; i < 10; i++) {
    await h.append(
      runRecorded(i, [
        record("stale facet", "unexpected-pass", { at: day(i / 3), kind: "failing" }),
      ]),
    );
  }
  expect(h.events(flakeEventTypes.transitionProposed)).toMatchObject([
    { payload: { testName: "stale facet", transition: "unwrap-failing" } },
  ]);
});

test("default-branch streaks ignore other branches and reset on unexpected errors", async () => {
  const h = makeHarness();
  await h.append(
    birth(),
    runRecorded(1, [record("deploy", "pass", { at: day(0) })]),
    runRecorded(2, [record("deploy", "pass", { at: day(1) })]),
    runRecorded(3, [record("deploy", "flake-fail", { at: day(2) })], { branch: "some-pr" }),
  );
  // The PR-branch flake neither breaks nor extends the main-branch streak.
  expect(h.state().tests.deploy!.defaultBranchStreak).toMatchObject({
    outcome: "pass",
    runs: 2,
    firstAt: day(0),
    lastAt: day(1),
  });

  await h.append(runRecorded(4, [record("deploy", "unexpected-error", { at: day(3) })]));
  expect(h.state().tests.deploy!.defaultBranchStreak).toBeNull();
});

test("20 main passes propose unwrapping, even within one hour, and only once", async () => {
  const h = makeHarness();
  await h.append(birth());
  for (let i = 0; i < 19; i++) {
    await h.append(runRecorded(i, [record("deploy", "pass", { at: day(i / 1440) })]));
  }
  expect(h.events(flakeEventTypes.transitionProposed)).toHaveLength(0);
  await h.append(runRecorded(19, [record("deploy", "pass", { at: day(19 / 1440) })]));
  const proposals = h.events(flakeEventTypes.transitionProposed);
  expect(proposals).toHaveLength(1);
  expect(proposals[0]!.payload).toMatchObject({
    testName: "deploy",
    transition: "unwrap",
    evidence: { consecutiveRuns: 20, firstAt: day(0) },
  });

  // The streak keeps growing; the proposal does not repeat.
  await h.append(runRecorded(20, [record("deploy", "pass", { at: day(20 / 1440) })]));
  expect(h.events(flakeEventTypes.transitionProposed)).toHaveLength(1);
  expect(h.state().tests.deploy!).toMatchObject({ proposed: [`unwrap:${day(0)}`] });
});

test("a never-passing test proposes switch-to-failing", async () => {
  const h = makeHarness();
  await h.append(birth());
  for (let i = 0; i < 25; i++) {
    await h.append(runRecorded(i, [record("deploy", "flake-fail", { at: day(i / 10) })]));
  }
  expect(h.events(flakeEventTypes.transitionProposed)).toMatchObject([
    { payload: { testName: "deploy", transition: "switch-to-failing" } },
  ]);
});

test("the writer folds each run and then the proposals it made due, continuing the offsets", async () => {
  const h = makeHarness();
  const runs = Array.from({ length: 21 }, (_, i) =>
    runRecorded(i, [record("deploy", "pass", { at: day(i / 1440) })]),
  );
  await h.append(birth(), ...runs);
  const folded = foldFlakeRuns(
    startFlakeDashboard({ owner: "iterate", repo: "iterate" }),
    runs.map((run) => run.payload),
  );
  // One birth, 21 runs and the one unwrap proposal: the offsets the legacy stream would have held.
  expect(folded).toEqual({ state: h.state(), nextOffset: 23 });
  expect(folded.state.tests.deploy!).toMatchObject({ proposed: [`unwrap:${day(0)}`] });
});

// --- artifact parsing: what the legacy check_run ingestion did with one downloaded zip ---

test("a flake-records artifact becomes one run-recorded fact; malformed lines are skipped", async () => {
  const run = await runRecordedFromArtifact({
    // Both zip entry kinds the reader supports: deflate (what CI uploads) and stored.
    zip: zip({
      "flake-records-123.jsonl": [
        JSON.stringify(record("flake sentinel", "pass")),
        "not json at all",
        JSON.stringify({ name: "bad shape" }),
      ].join("\n"),
      "flake-records-124.jsonl": { stored: JSON.stringify(record("deploy", "flake-fail")) },
    }),
    runId: "run-77-2",
    suite: "unit",
    branch: "main",
    commit: "abc123",
  });
  expect(run).toMatchObject({
    runId: "run-77-2",
    suite: "unit",
    branch: "main",
    commit: "abc123",
    records: [
      { name: "flake sentinel", outcome: "pass" },
      { name: "deploy", outcome: "flake-fail" },
    ],
  });
});

test.each(["clean", "torn record", "missing retry record", "missing test result"])(
  "%s artifact carries an honest completeness result",
  async (scenario) => {
    const summary = {
      headSha: "abc123",
      branch: "main",
      status: "complete",
      startedAt: day(1),
      finishedAt: day(1.001),
      testCount: 10,
      tests: Array.from({ length: scenario === "missing test result" ? 9 : 10 }, (_, i) => ({
        name: `test ${i}`,
        outcome: "pass",
      })),
      failedCount: 0,
      unknownFlakeCount: scenario === "missing retry record" ? 1 : 0,
      diagnostics: [],
      runUrl: "https://depot.dev/runs/run-77",
    };
    const run = await runRecordedFromArtifact({
      zip: zip({
        "suite-summary.json": JSON.stringify(summary),
        ...(scenario === "torn record" && { "partial.jsonl": "{broken" }),
      }),
      runId: "run-77-1",
      suite: "specs",
      branch: "unknown",
      commit: "abc123",
    });
    expect(run).toMatchObject({
      suite: "specs",
      records: [],
      summary: {
        status: scenario === "clean" ? "complete" : "incomplete",
        tests: summary.tests,
      },
    });
  },
);

test("a flake-records artifact names its suite, with or without its job attempt", () => {
  expect(flakeRecordsSuite("flake-records-unit-attempt-qn5lblb3j7")).toBe("unit");
  expect(flakeRecordsSuite("flake-records-preview-e2e-attempt-hcsc54slqf")).toBe("preview-e2e");
  // Uploaded before artifacts were named per attempt.
  expect(flakeRecordsSuite("flake-records-preview-e2e")).toBe("preview-e2e");
  expect(flakeRecordsSuite("preview-test-telemetry-attempt-hcsc54slqf")).toBeUndefined();
});

test("an artifact's own summary names its branch and commit", async () => {
  const summary = {
    ...runRecorded(1, []).payload.summary,
    headSha: "abc123",
    branch: "ci/validation",
  };
  const run = await runRecordedFromArtifact({
    zip: zip({ "suite-summary.json": JSON.stringify(summary) }),
    runId: "run-1-1",
    suite: "specs",
    branch: "main",
    commit: "def456",
  });
  expect(run).toMatchObject({ branch: "ci/validation", commit: "abc123" });
});

test.each(["{broken", JSON.stringify({ status: "complete" })])(
  "an invalid suite summary %s drops that artifact",
  async (invalidSummary) => {
    const run = await runRecordedFromArtifact({
      zip: zip({
        "suite-summary.json": invalidSummary,
        "records.jsonl": JSON.stringify(
          record("backend retry", "retried-pass", { kind: "unknown" }),
        ),
      }),
      runId: "run-1-1",
      suite: "specs",
      branch: "main",
      commit: "abc123",
    });
    expect(run).toBeUndefined();
  },
);

test("an artifact with neither records nor a summary folds nothing", async () => {
  const run = await runRecordedFromArtifact({
    zip: zip({ "notes.txt": "nothing to see" }),
    runId: "run-1-1",
    suite: "unit",
    branch: "main",
    commit: "abc123",
  });
  expect(run).toBeUndefined();
});

test("a folded state survives the JSON round trip the writer's state artifact makes", async () => {
  const h = makeHarness();
  await h.append(
    birth(),
    runRecorded(1, [record("deploy", "flake-fail", { at: day(0) })]),
    runRecorded(2, [record("chat upload", "retried-pass", { kind: "unknown", error: "boom" })], {
      tests: [{ name: "chat upload", outcome: "pass" }],
    }),
  );
  const state = h.state();
  expect(FlakeDashboardState.parse(JSON.parse(JSON.stringify(state)))).toEqual(state);
});

// --- helpers ---

/**
 * The legacy processor host in miniature: every run-recorded fact is followed by the proposals it
 * made due, each an event of its own, and an idempotency key already seen is not appended again.
 */
function makeHarness() {
  let state = FlakeDashboardState.parse({});
  let offset = 0;
  const log: FlakeDashboardEvent[] = [];
  const keys = new Set<string>();
  const apply = (event: FlakeDashboardEvent) => {
    log.push(event);
    state = reduceFlakeDashboard(state, event);
  };
  return {
    async append(...events: Array<ReturnType<typeof birth> | ReturnType<typeof runRecorded>>) {
      for (const event of events) {
        if (keys.has(event.idempotencyKey)) continue;
        keys.add(event.idempotencyKey);
        apply({ ...event, offset: offset++ } as FlakeDashboardEvent);
        if (event.type !== flakeEventTypes.runRecorded) continue;
        for (const payload of proposeFlakeTransitions(state)) {
          apply({ type: flakeEventTypes.transitionProposed, offset: offset++, payload });
        }
      }
    },
    state: () => state,
    events: (type: FlakeDashboardEvent["type"]) => log.filter((event) => event.type === type),
  };
}

/** A zip of the given files: deflated (as CI uploads them) unless marked stored. */
function zip(files: Record<string, string | { stored: string }>) {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const stored = typeof content !== "string";
    const raw = Buffer.from(stored ? content.stored : content);
    const data = stored ? raw : deflateRawSync(raw);
    const nameBytes = Buffer.from(name);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(stored ? 0 : 8, 8);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(stored ? 0 : 8, 10);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    local.push(header, nameBytes, data);
    central.push(entry, nameBytes);
    offset += header.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...local, directory, end]));
}

function birth() {
  return {
    type: flakeEventTypes.created,
    idempotencyKey: "flakes/created",
    payload: {
      config: {
        repository: { owner: "iterate", repo: "iterate" },
        issueTitle: "Flake dashboard",
        defaultBranch: "main",
      },
    },
  } as const;
}

function runRecorded(
  n: number,
  records: ReturnType<typeof record>[],
  overrides?: {
    branch?: string;
    suite?: string;
    complete?: boolean;
    tests?: { name: string; outcome: "pass" | "fail" | "skip" }[];
  },
) {
  return {
    type: flakeEventTypes.runRecorded,
    idempotencyKey: `flakes/run:${n}:${overrides?.suite || "unit"}`,
    payload: {
      runId: `run-${n}`,
      suite: overrides?.suite || "unit",
      branch: overrides?.branch || "main",
      commit: `commit-${n}`,
      records,
      summary: {
        headSha: `commit-${n}`,
        branch: overrides?.branch || "main",
        status: overrides?.complete === false ? "incomplete" : "complete",
        startedAt: day(n),
        finishedAt: day(n + 0.001),
        testCount: overrides?.tests?.length || Math.max(1, records.length),
        tests: overrides?.tests,
        unknownFlakeCount: records.filter((record) => record.kind === "unknown").length,
        failedCount: 0,
        diagnostics: overrides?.complete === false ? ["test runner interrupted"] : [],
        runUrl: `https://depot.dev/runs/run-${n}`,
      },
    },
  } as const;
}

function record(
  name: string,
  outcome:
    | "pass"
    | "flake-fail"
    | "unexpected-error"
    | "pinned-fail"
    | "unexpected-pass"
    | "retried-pass",
  overrides?: { at?: string; kind?: "flake" | "failing" | "unknown"; error?: string },
) {
  const kind = overrides?.kind || "flake";
  return {
    name,
    kind,
    outcome,
    ...(kind === "unknown" ? {} : { pattern: "CPU startup time exceeded" }),
    ...(overrides?.error === undefined ? {} : { error: overrides.error }),
    durationMs: 5,
    at: overrides?.at || "2026-09-02T09:00:00Z",
  };
}

/** ISO timestamp `days` (fractional ok) after a fixed epoch. */
function day(days: number) {
  return new Date(Date.UTC(2026, 0, 1) + days * 24 * 60 * 60 * 1000).toISOString();
}
