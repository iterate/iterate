import { expect, test } from "vitest";
import { rootManifestListing } from "./install.ts";

const name = "@iterate-com/agents";
const version = "https://pkg.pr.new/iterate/iterate/@iterate-com/agents@abc1234";

test.each([
  [
    "a root without the package lists it among its devDependencies, in order",
    manifest({ private: true, devDependencies: { typescript: "^7.0.2", iterate: "x" } }),
    manifest({
      private: true,
      devDependencies: { "@iterate-com/agents": version, iterate: "x", typescript: "^7.0.2" },
    }),
  ],
  [
    "a root listing another version as a devDependency is moved to this one",
    manifest({ devDependencies: { "@iterate-com/agents": "old" } }),
    manifest({ devDependencies: { "@iterate-com/agents": version } }),
  ],
  [
    "a root that lists this version already is left as it is",
    manifest({ devDependencies: { "@iterate-com/agents": version } }),
    undefined,
  ],
  [
    "a root that depends on the package at runtime keeps its own pin",
    manifest({ dependencies: { "@iterate-com/agents": "https://pkg.pr.new/…@main" } }),
    undefined,
  ],
  [
    "a repo without a root package.json gets one",
    null,
    manifest({ devDependencies: { [name]: version } }),
  ],
])("%s", (_, before, after) => {
  expect(rootManifestListing(before, name, version)).toBe(after);
});

/** A package.json as a repo holds it. */
function manifest(json: object) {
  return `${JSON.stringify(json, null, 2)}\n`;
}
