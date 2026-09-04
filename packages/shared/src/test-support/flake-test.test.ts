import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";
import { createFlake } from "./flake-test.ts";

// The integration proof runs vitest itself on the fixture in
// ./flake-test-fixture — one case per outcome — and asserts vitest's OWN
// verdicts. A child process (rather than registering flake tests here
// directly) keeps the main suite's expected-fail metrics clean: the sentinel
// is the one deliberate expected-fail row, and this stays a plain test that
// goes red deterministically if the wrapper stops satisfying the machinery.
test("vitest's real expected-fail machinery produces the contracted verdicts", async () => {
  const require = createRequire(import.meta.url);
  const vitestPackagePath = require.resolve("vitest/package.json");
  const vitestBin = join(
    dirname(vitestPackagePath),
    (JSON.parse(readFileSync(vitestPackagePath, "utf8")) as any).bin.vitest,
  );
  const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "flake-test-fixture");
  const scratchDir = mkdtempSync(join(tmpdir(), "flake-fixture-"));
  const outputFile = join(scratchDir, "results.json");
  const recordDir = join(scratchDir, "records");

  const result = spawnSync(
    process.execPath,
    [
      vitestBin,
      "run",
      "--config",
      join(fixtureDir, "vitest.config.ts"),
      "--reporter=json",
      `--outputFile=${outputFile}`,
    ],
    {
      cwd: fixtureDir,
      encoding: "utf8",
      timeout: 30_000,
      // Strip the parent runner's own variables: nested VITEST_* can make the
      // child collect no tests, and an inherited FLAKE_RECORD_DIR would leak
      // the fixture's synthetic outcomes into real flake telemetry — the
      // child records into its own scratch dir instead.
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => !key.startsWith("VITEST") && key !== "GITHUB_WORKSPACE" && key !== "TEST",
          ),
        ),
        FLAKE_RECORD_DIR: recordDir,
      },
    },
  );

  // The fixture's unexpected-error case must turn the whole child run red.
  expect(result.status).toBe(1);
  const results = JSON.parse(readFileSync(outputFile, "utf8")) as any;
  const statuses = Object.fromEntries(
    results.testResults.flatMap((file: any) =>
      file.assertionResults.map((a: any) => [a.title, a.status]),
    ),
  );
  expect(statuses).toEqual({
    "matched flake failure is green": "passed",
    "a pass is green": "passed",
    "an unexpected error is red": "failed",
  });

  // Exactly one record per case: the fixture config sets a suite-level
  // `retry` (like the CI e2e suites), and without the wrapper's per-test
  // retry pin each green case would execute — and record — twice.
  const recorded = readdirSync(recordDir).flatMap((file) =>
    readFileSync(join(recordDir, file), "utf8")
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as any).name),
  );
  expect(recorded.toSorted()).toEqual([
    "a pass is green",
    "an unexpected error is red",
    "matched flake failure is green",
  ]);
});

test("registration lands on the runner's own expected-fail variant", async () => {
  // Scoped record dir: this test executes a wrapped body, and without the
  // scope its outcome would land in whatever FLAKE_RECORD_DIR the surrounding
  // run has set — synthetic data leaking into real flake telemetry.
  using _recordDir = flakeRecordDir();
  const registered: { args: unknown[]; body: (...bodyArgs: unknown[]) => Promise<unknown> }[] = [];
  const plain = vi.fn();
  const fakeVitest = Object.assign(plain, {
    fails: (...args: unknown[]) =>
      registered.push({ args: args.slice(0, -1), body: args.at(-1) as any }),
  });

  createFlake(fakeVitest, /flaked/)("name", { timeout: 123 }, async (fixtures: any) => {
    throw new Error(`flaked, saw fixture ${fixtures.page}`);
  });

  expect(plain).not.toHaveBeenCalled();
  // Caller options forward, with the wrapper's retry pin merged in (see the
  // retry note in flake-test.ts — suite-level retry would double-run greens).
  expect(registered).toMatchObject([{ args: ["name", { timeout: 123, retry: 0 }] }]);
  // A matching throw passes through to satisfy the expected-fail machinery,
  // with playwright-style fixtures forwarded.
  await expect(registered[0]!.body({ page: "fake-page" })).rejects.toThrow(/flaked/);
  // Runners discover fixtures by PARSING the test function's source for its
  // destructured first parameter — the wrapper must present the body's own
  // source or playwright/test.extend would instantiate no fixtures at all.
  expect(String(registered[0]!.body)).toContain("fixtures");
  expect(String(registered[0]!.body)).not.toContain("bodyArgs");
});

test("a playwright-shaped test object registers through .fail", async () => {
  const registered: unknown[][] = [];
  const fakePlaywright = Object.assign(vi.fn(), {
    fail: (...args: unknown[]) => registered.push(args),
  });
  createFlake(fakePlaywright, /flaked/)("name", async () => {});
  expect(registered).toHaveLength(1);
});

test("a matching failure rethrows (green) and records a flake-fail line", async () => {
  using recordDir = flakeRecordDir();
  const body = registerWithFakeRunner(/CPU startup time exceeded \d+ms/, async () => {
    throw new Error("CPU startup time exceeded 2000ms");
  });

  await expect(body()).rejects.toThrow(/CPU startup time exceeded/);
  expect(recordDir.records()).toMatchObject([
    {
      name: "name",
      outcome: "flake-fail",
      pattern: "CPU startup time exceeded \\d+ms",
      error: "Error: CPU startup time exceeded 2000ms",
    },
  ]);
});

test("a pass throws 'Flaky test passed this run' (green) and records a pass line", async () => {
  using recordDir = flakeRecordDir();
  const body = registerWithFakeRunner(/CPU startup time exceeded \d+ms/, async () => {
    expect(1 + 1).toBe(2);
  });

  // Throwing is what satisfies test.fails / test.fail — a flake test is green
  // whether the body passes or fails with the allowed pattern.
  await expect(body()).rejects.toThrow(/Flaky test passed this run/);
  expect(recordDir.records()).toMatchObject([{ name: "name", outcome: "pass" }]);
  expect(recordDir.records()[0]).not.toHaveProperty("error");
});

test("a non-matching failure returns success (red) and records an unexpected-error line", async () => {
  using recordDir = flakeRecordDir();
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const body = registerWithFakeRunner(/CPU startup time exceeded \d+ms/, async () => {
      throw new Error("ECONNREFUSED: the test infra broke");
    });

    // Resolving WITHOUT throwing is the inverted failure signal: the
    // expected-fail machinery rejects a successful body, so the test goes red.
    await expect(body()).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringMatching(/does not match the allowed flake pattern/),
      expect.objectContaining({ message: expect.stringContaining("ECONNREFUSED") }),
    );
    expect(recordDir.records()).toMatchObject([
      { outcome: "unexpected-error", error: "Error: ECONNREFUSED: the test infra broke" },
    ]);
  } finally {
    consoleError.mockRestore();
  }
});

test("a hung body goes red at the wrapper's own deadline and records the hang", async () => {
  using recordDir = flakeRecordDir();
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const body = registerWithFakeRunner(/flaked/, async () => new Promise(() => {}), {
      timeoutMs: 50,
    });

    // Without the wrapper's own deadline this would ride to the RUNNER's test
    // timeout, which the expected-fail machinery counts as satisfied — the
    // hang would pass vacuously.
    await expect(body()).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith(expect.stringMatching(/still running after 50ms/));
    expect(recordDir.records()).toMatchObject([
      { outcome: "unexpected-error", error: "hung: still running after 50ms" },
    ]);
  } finally {
    consoleError.mockRestore();
  }
});

test("a relative FLAKE_RECORD_DIR is rebased against GITHUB_WORKSPACE", async () => {
  // Root `pnpm test` runs every workspace with its own cwd; without the
  // rebase each package would write under itself and the repo-root CI
  // reporter would find nothing (the bug this test pins).
  const previous = { dir: process.env.FLAKE_RECORD_DIR, root: process.env.GITHUB_WORKSPACE };
  const workspaceRoot = mkdtempSync(join(tmpdir(), "flake-workspace-"));
  process.env.GITHUB_WORKSPACE = workspaceRoot;
  process.env.FLAKE_RECORD_DIR = "test-results/flake-records";
  try {
    const body = registerWithFakeRunner(/flaked/, async () => {
      throw new Error("flaked again");
    });
    await expect(body()).rejects.toThrow(/flaked/);
    const files = readdirSync(join(workspaceRoot, "test-results/flake-records"));
    expect(files).toHaveLength(1);
  } finally {
    if (previous.dir === undefined) delete process.env.FLAKE_RECORD_DIR;
    else process.env.FLAKE_RECORD_DIR = previous.dir;
    if (previous.root === undefined) delete process.env.GITHUB_WORKSPACE;
    else process.env.GITHUB_WORKSPACE = previous.root;
  }
});

test("without FLAKE_RECORD_DIR nothing is written anywhere", async () => {
  const previous = process.env.FLAKE_RECORD_DIR;
  delete process.env.FLAKE_RECORD_DIR;
  try {
    const body = registerWithFakeRunner(/flaked/, async () => {
      throw new Error("flaked again");
    });
    await expect(body()).rejects.toThrow(/flaked/);
  } finally {
    if (previous !== undefined) process.env.FLAKE_RECORD_DIR = previous;
  }
});

// --- helpers ---

/** Register a body through a fake vitest-shaped runner and return the wrapped body. */
function registerWithFakeRunner(
  pattern: RegExp,
  body: (...args: any[]) => any,
  options?: { timeoutMs: number },
) {
  const registered: ((...args: unknown[]) => Promise<unknown>)[] = [];
  const fake = Object.assign(vi.fn(), {
    fails: (...args: unknown[]) => registered.push(args.at(-1) as any),
  });
  createFlake(fake, pattern, options)("name", body);
  return registered[0]!;
}

/** Point FLAKE_RECORD_DIR at a fresh temp dir for the duration of the test. */
function flakeRecordDir() {
  const previous = process.env.FLAKE_RECORD_DIR;
  const dir = mkdtempSync(join(tmpdir(), "flake-test-"));
  process.env.FLAKE_RECORD_DIR = dir;
  return {
    records: () =>
      readdirSync(dir).flatMap((file) =>
        readFileSync(join(dir, file), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ),
    [Symbol.dispose]() {
      if (previous === undefined) delete process.env.FLAKE_RECORD_DIR;
      else process.env.FLAKE_RECORD_DIR = previous;
    },
  };
}
