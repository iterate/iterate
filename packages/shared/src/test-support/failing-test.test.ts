import { expect, test, vi } from "vitest";
import { expectFailure, failing } from "./failing-test.ts";

// The wrapper in real use, registered through vitest itself: this lands on
// vitest's native `test.fails`, so it reports in the "expected fail" summary
// count, and it is green because its body throws the pinned error.
const fail = failing(test, /foo bar exploded/);
fail("a body failing for the pinned reason passes", async () => {
  throw new Error("boom: foo bar exploded (as pinned)");
});

test("registration lands on the runner's own expected-fail variant", async () => {
  const registered: { args: unknown[]; body: (...bodyArgs: unknown[]) => Promise<unknown> }[] = [];
  const plain = vi.fn();
  const fakeVitest = Object.assign(plain, {
    fails: (...args: unknown[]) =>
      registered.push({ args: args.slice(0, -1), body: args.at(-1) as any }),
  });

  failing(fakeVitest, /pinned/)("name", { timeout: 123 }, async (fixtures: any) => {
    throw new Error(`pinned, saw fixture ${fixtures.page}`);
  });

  // Registered through .fails, never through the plain test function — that is
  // what makes the pin native to the runner's reporting (summary counts,
  // telemetry expectedState).
  expect(plain).not.toHaveBeenCalled();
  expect(registered).toMatchObject([{ args: ["name", { timeout: 123 }] }]);
  // The wrapped body forwards playwright-style fixtures, and a pinned throw
  // passes through to satisfy the expected-fail machinery.
  await expect(registered[0]!.body({ page: "fake-page" })).rejects.toThrow(/pinned/);
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
  failing(fakePlaywright, /pinned/)("name", async () => {});
  expect(registered).toHaveLength(1);
});

test("a body failing for a different reason returns success, so the native machinery goes red", async () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const registered: ((...args: unknown[]) => Promise<unknown>)[] = [];
    const fake = Object.assign(vi.fn(), {
      fails: (...args: unknown[]) => registered.push(args.at(-1) as any),
    });
    failing(fake, /foo bar exploded/)("name", async () => {
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
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const registered: ((...args: unknown[]) => Promise<unknown>)[] = [];
    const fake = Object.assign(vi.fn(), {
      fails: (...args: unknown[]) => registered.push(args.at(-1) as any),
    });
    failing(fake, /foo bar exploded/)("name", async () => {
      expect(1 + 1).toBe(2);
    });

    await expect(registered[0]!()).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringMatching(/should have failed .* delete the failing\(\) wrapper/s),
    );
  } finally {
    consoleError.mockRestore();
  }
});

test("a hung body reports as not-the-pinned-failure at the wrapper's own deadline", async () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const registered: ((...args: unknown[]) => Promise<unknown>)[] = [];
    const fake = Object.assign(vi.fn(), {
      fails: (...args: unknown[]) => registered.push(args.at(-1) as any),
    });
    failing(fake, /pinned/, { timeoutMs: 50 })("name", async () => new Promise(() => {}));

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
    /should have failed with \/foo bar exploded\/ but it succeeded.*delete the failing\(\) wrapper/,
  );
});
