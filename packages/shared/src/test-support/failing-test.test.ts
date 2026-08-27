import { expect, test } from "vitest";
import { expectFailure } from "./failing-test.ts";

test("a body failing for the pinned reason passes", async () => {
  await expectFailure({ failure: /foo bar exploded/ }, async () => {
    throw new Error("boom: foo bar exploded (as pinned)");
  });
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
    /should have failed with \/foo bar exploded\/ but it succeeded.*delete the failingTest wrapper/,
  );
});
