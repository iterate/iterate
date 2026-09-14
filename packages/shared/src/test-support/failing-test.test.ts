import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { expectFailure, createFailing } from "./failing-test.ts";

// The wrapper through vitest's REAL expected-fail machinery is proven by the
// child-process fixture in ./flake-test-fixture (the createFailing case): a
// live registration here would run under the CI suite's FLAKE_RECORD_DIR and
// leak a synthetic pin row onto the real test-health dashboard.

test("registration lands on the runner's own expected-fail variant", async () => {
  // Scoped record dir: the body executions below would otherwise write
  // kind-failing records into the CI run's real FLAKE_RECORD_DIR.
  using _records = scopedFlakeRecordDir();
  const registered: { args: unknown[]; body: (...bodyArgs: unknown[]) => Promise<unknown> }[] = [];
  const plain = vi.fn();
  const fakeVitest = Object.assign(plain, {
    fails: (...args: unknown[]) =>
      registered.push({ args: args.slice(0, -1), body: args.at(-1) as any }),
  });

  createFailing(fakeVitest, /pinned/)("name", { timeout: 123 }, async (fixtures: any) => {
    throw new Error(`pinned, saw fixture ${fixtures.page}`);
  });

  // Registered through .fails, never through the plain test function — that is
  // what makes the pin native to the runner's reporting (summary counts,
  // telemetry expectedState).
  expect(plain).not.toHaveBeenCalled();
  // The registrar timeout is forced to the wrapper's own deadline + 1s so the
  // runner never fires before the wrapper's race resolves — a caller-passed
  // timeout (123) is overridden (default timeoutMs 30_000 → 31_000), and
  // retry is pinned to zero so a suite-level retry never re-runs a pin.
  expect(registered).toMatchObject([{ args: ["name", { timeout: 31_000, retry: 0 }] }]);
  // The wrapped body forwards playwright-style fixtures, and a pinned throw
  // passes through to satisfy the expected-fail machinery.
  await expect(registered[0]!.body({ page: "fake-page" })).rejects.toThrow(/pinned/);
  // Runners discover fixtures by PARSING the test function's source for its
  // destructured first parameter — the wrapper must present the body's own
  // source or playwright/test.extend would instantiate no fixtures at all.
  expect(String(registered[0]!.body)).toContain("fixtures");
  expect(String(registered[0]!.body)).not.toContain("bodyArgs");
});

test("every outcome writes a kind-failing record when FLAKE_RECORD_DIR is set", async () => {
  using records = scopedFlakeRecordDir();
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const registered: ((...args: unknown[]) => Promise<unknown>)[] = [];
    const fake = Object.assign(vi.fn(), {
      fails: (...args: unknown[]) => registered.push(args.at(-1) as any),
    });
    const fail = createFailing(fake, /pinned/);
    fail("holds", async () => {
      throw new Error("pinned as expected");
    });
    fail("fixed?", async () => {});
    await expect(registered[0]!()).rejects.toThrow(/pinned/);
    await expect(registered[1]!()).resolves.toBeUndefined();

    expect(records.records()).toMatchObject([
      { name: "holds", kind: "failing", outcome: "pinned-fail", pattern: "pinned" },
      { name: "fixed?", kind: "failing", outcome: "unexpected-pass" },
    ]);
  } finally {
    consoleError.mockRestore();
  }
});

test("a playwright-shaped test object registers through .fail", async () => {
  const registered: unknown[][] = [];
  const configured: unknown[] = [];
  // A faithful playwright shape: describe invokes its body synchronously and
  // carries configure, exactly like the real test object — the wrapper calls
  // both unconditionally rather than hedging on their presence.
  const fakePlaywright = Object.assign(vi.fn(), {
    fail: (...args: unknown[]) => registered.push(args),
    setTimeout: vi.fn(),
    describe: Object.assign((body: () => void) => body(), {
      configure: (options: unknown) => configured.push(options),
    }),
  });
  createFailing(fakePlaywright, /pinned/)("name", async () => {});
  expect(registered).toHaveLength(1);
  // Same zero-retry describe pin as createFlake — see that test for why.
  expect(configured).toEqual([{ retries: 0 }]);
});

test("a body failing for a different reason returns success, so the native machinery goes red", async () => {
  // Scoped record dir: the body executions below would otherwise write
  // kind-failing records into the CI run's real FLAKE_RECORD_DIR.
  using _records = scopedFlakeRecordDir();
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const registered: ((...args: unknown[]) => Promise<unknown>)[] = [];
    const fake = Object.assign(vi.fn(), {
      fails: (...args: unknown[]) => registered.push(args.at(-1) as any),
    });
    createFailing(fake, /foo bar exploded/)("name", async () => {
      throw new Error("ECONNREFUSED: the test infra broke");
    });

    // Resolving WITHOUT throwing is the inverted failure signal: test.fails /
    // test.fail reject a successful body ("Expect test to fail" / "passed
    // unexpectedly"), so the pin goes red — where a bare test.fails would have
    // stayed silently green. The reason lives in the adjacent log line.
    await expect(registered[0]!()).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringMatching(/Expected failure to match \/foo bar exploded\//),
      expect.objectContaining({ message: expect.stringContaining("ECONNREFUSED") }),
    );
  } finally {
    consoleError.mockRestore();
  }
});

test("a body that succeeds returns success with delete-the-wrapper instructions in the log", async () => {
  // Scoped record dir: the body executions below would otherwise write
  // kind-failing records into the CI run's real FLAKE_RECORD_DIR.
  using _records = scopedFlakeRecordDir();
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const registered: ((...args: unknown[]) => Promise<unknown>)[] = [];
    const fake = Object.assign(vi.fn(), {
      fails: (...args: unknown[]) => registered.push(args.at(-1) as any),
    });
    createFailing(fake, /foo bar exploded/)("name", async () => {
      expect(1 + 1).toBe(2);
    });

    await expect(registered[0]!()).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringMatching(/should have failed .* delete the createFailing\(\) wrapper/s),
    );
  } finally {
    consoleError.mockRestore();
  }
});

test("a hung body reports as not-the-pinned-failure at the wrapper's own deadline", async () => {
  // Scoped record dir: the body executions below would otherwise write
  // kind-failing records into the CI run's real FLAKE_RECORD_DIR.
  using _records = scopedFlakeRecordDir();
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const registered: ((...args: unknown[]) => Promise<unknown>)[] = [];
    const fake = Object.assign(vi.fn(), {
      fails: (...args: unknown[]) => registered.push(args.at(-1) as any),
    });
    createFailing(fake, /pinned/, { timeoutMs: 50 })("name", async () => new Promise(() => {}));

    // Without the wrapper's own deadline this would ride to the RUNNER's test
    // timeout, which the expected-fail machinery counts as the pin holding —
    // the hang would pass vacuously.
    await expect(registered[0]!()).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith(expect.stringMatching(/still running after 50ms/));
  } finally {
    consoleError.mockRestore();
  }
});

// expectFailure is the standalone assertion for use INSIDE a plain test,
// where throwing (not inverted success) is the right failure signal.

test("expectFailure: a different reason throws, naming both errors", async () => {
  await expect(
    expectFailure({ failure: /foo bar exploded/ }, async () => {
      throw new Error("ECONNREFUSED: the test infra broke");
    }),
  ).rejects.toThrow(/Expected failure to match \/foo bar exploded\/, got: .*ECONNREFUSED/);
});

test("expectFailure: success throws with delete-the-wrapper instructions", async () => {
  await expect(
    expectFailure({ failure: /foo bar exploded/ }, async () => {
      expect(1 + 1).toBe(2);
    }),
  ).rejects.toThrow(
    /should have failed with \/foo bar exploded\/ but it succeeded.*delete the createFailing\(\) wrapper/,
  );
});

// Same shape as flake-test.test.ts's fixture: point FLAKE_RECORD_DIR at a
// scratch dir for the test's lifetime so synthetic outcomes never leak into
// real telemetry, and read back what was written.
function scopedFlakeRecordDir() {
  const previous = process.env.FLAKE_RECORD_DIR;
  const dir = mkdtempSync(join(tmpdir(), "failing-test-"));
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
