import { expect, test } from "vitest";
import { expectFailure, failing } from "./failing-test.ts";

// The wrapper in real use, registered through vitest itself: this test is
// green because its body throws the pinned error.
const fail = failing(test, /foo bar exploded/);
fail("a body failing for the pinned reason passes", async () => {
  throw new Error("boom: foo bar exploded (as pinned)");
});

test("options objects and body arguments pass through the wrapped test function", async () => {
  const registered: { args: unknown[]; body: (...bodyArgs: unknown[]) => Promise<unknown> }[] = [];
  failing(
    (...args: unknown[]) => registered.push({ args: args.slice(0, -1), body: args.at(-1) as any }),
    /pinned/,
  )("name", { timeout: 123 }, async (fixtures: any) => {
    throw new Error(`pinned, saw fixture ${fixtures.page}`);
  });

  expect(registered).toMatchObject([{ args: ["name", { timeout: 123 }] }]);
  // The wrapped body forwards playwright-style fixtures and passes when the
  // pinned error is thrown.
  await registered[0]!.body({ page: "fake-page" });
});

test("a body failing for a different reason fails, naming both errors", async () => {
  await expect(
    expectFailure({ failure: /foo bar exploded/ }, async () => {
      throw new Error("ECONNREFUSED: the test infra broke");
    }),
  ).rejects.toThrow(/Expected failure to match \/foo bar exploded\/, got: .*ECONNREFUSED/);
});

test("a body that succeeds fails with delete-the-wrapper instructions", async () => {
  await expect(
    expectFailure({ failure: /foo bar exploded/ }, async () => {
      expect(1 + 1).toBe(2);
    }),
  ).rejects.toThrow(
    /should have failed with \/foo bar exploded\/ but it succeeded.*delete the failing\(\) wrapper/,
  );
});
