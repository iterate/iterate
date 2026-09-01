import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { createFlake } from "./flake-test.ts";

// The wrapper in real use, registered through vitest itself: both land on
// vitest's native `test.fails`, so they report in the "expected fail" summary
// count. A matching failure AND a pass are both green — only an unexpected
// error would go red. (Named "self-test" so dashboard tooling can ignore them.)
const flake = createFlake(test, /the dice came up bad/);
flake("flake-test self-test: a matching failure is green", async () => {
  throw new Error("boom: the dice came up bad this run");
});
flake("flake-test self-test: a pass is green too", async () => {
  expect(1 + 1).toBe(2);
});

test("registration lands on the runner's own expected-fail variant", async () => {
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
  expect(registered).toMatchObject([{ args: ["name", { timeout: 123 }] }]);
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
