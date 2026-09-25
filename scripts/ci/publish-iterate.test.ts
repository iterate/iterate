// The version prd's SDK is published under: npm's latest plus one patch, unless the repo's
// package.json deliberately names something higher; never a version npm already has.
import { expect, test } from "vitest";
import { nextVersion } from "./publish-iterate.ts";

test.each([
  ["the next patch after npm's", "0.4.0", "0.4.0", "0.4.1"],
  ["npm ahead of the repo keeps counting", "0.4.17", "0.4.0", "0.4.18"],
  ["a minor bump in the repo wins", "0.4.17", "0.5.0", "0.5.0"],
  ["a major bump in the repo wins", "0.4.17", "1.0.0", "1.0.0"],
  ["a lower minor in the repo does not", "0.5.2", "0.4.9", "0.5.3"],
  ["never published: the repo's version", undefined, "0.4.0", "0.4.0"],
])("%s", (_, published, declared, expected) => {
  expect(nextVersion(published, declared)).toBe(expected);
});

test("a prerelease or malformed version is refused, not guessed at", () => {
  expect(() => nextVersion("0.4.0-beta.1", "0.4.0")).toThrow(/major.minor.patch/);
});
