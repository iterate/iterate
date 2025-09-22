import { test, expect } from "vitest";
import { parseSpecifier } from "./estate-specifier.ts";

test("checkoutEstateCommand", async () => {
  expect(parseSpecifier("github:mmkal/lerna-learning#ci/test&path:packages/greeting-util"))
    .toMatchInlineSnapshot(`
      {
        "directory": "packages/greeting-util",
        "owner": "mmkal",
        "protocol": "github:",
        "raw": "github:mmkal/lerna-learning#ci/test&path:packages/greeting-util",
        "ref": "ci/test",
        "repo": "lerna-learning",
      }
    `);
  expect(
    parseSpecifier(
      "git:https://github.com/mmkal/lerna-learning.git#ci/test&path:packages/greeting-util",
    ),
  ).toMatchInlineSnapshot(`
    {
      "directory": "packages/greeting-util",
      "owner": "mmkal",
      "protocol": "git:",
      "raw": "git:https://github.com/mmkal/lerna-learning.git#ci/test&path:packages/greeting-util",
      "ref": "ci/test",
      "repo": "lerna-learning",
    }
  `);
});
