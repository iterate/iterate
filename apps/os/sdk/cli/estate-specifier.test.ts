import { test, expect } from "vitest";
import { parseSpecifier } from "./estate-specifier.ts";

// alphabetising key order makes snapshots confusing-looking and serve less well as self-documentation
expect.addSnapshotSerializer({
  test: () => true,
  print: (val) => JSON.stringify(val, null, 2).replaceAll(`"\n`, `",\n`),
});

// errors don't serialise nicely
expect.addSnapshotSerializer({
  test: (val) => val instanceof Error,
  print: (val) => String(val),
});

test("checkoutEstateCommand", async () => {
  expect(parseSpecifier("github:mmkal/lerna-learning#ci/test&path:packages/greeting-util"))
    .toMatchInlineSnapshot(`
      {
        "raw": "github:mmkal/lerna-learning#ci/test&path:packages/greeting-util",
        "protocol": "github:",
        "cloneUrl": "https://github.com/mmkal/lerna-learning",
        "owner": "mmkal",
        "repo": "lerna-learning",
        "ref": "ci/test",
        "directory": "packages/greeting-util",
      }
    `);

  expect(
    parseSpecifier(
      "git:https://github.com/mmkal/lerna-learning.git#ci/test&path:packages/greeting-util",
    ),
  ).toMatchInlineSnapshot(`
    {
      "raw": "git:https://github.com/mmkal/lerna-learning.git#ci/test&path:packages/greeting-util",
      "protocol": "git:",
      "cloneUrl": "https://github.com/mmkal/lerna-learning",
      "owner": "mmkal",
      "repo": "lerna-learning",
      "ref": "ci/test",
      "directory": "packages/greeting-util",
    }
  `);

  expect(
    parseSpecifier("https://github.com/mmkal/lerna-learning#ci/test&path:packages/greeting-util"),
  ).toMatchInlineSnapshot(`
    {
      "raw": "https://github.com/mmkal/lerna-learning#ci/test&path:packages/greeting-util",
      "protocol": "https:",
      "cloneUrl": "https://github.com/mmkal/lerna-learning",
      "owner": "mmkal",
      "repo": "lerna-learning",
      "ref": "ci/test",
      "directory": "packages/greeting-util",
    }
  `);

  expect(parseSpecifier("git:mmkal/lerna-learning")).toMatchInlineSnapshot(`
    {
      "raw": "git:mmkal/lerna-learning",
      "protocol": "git:",
      "cloneUrl": "https://github.com/mmkal/lerna-learning",
      "owner": "mmkal",
      "repo": "lerna-learning",
    }
  `);

  expect(parseSpecifier("git:mmkal/lerna-learning#&path:packages/greeting-util"))
    .toMatchInlineSnapshot(`
      {
        "raw": "git:mmkal/lerna-learning#path:packages/greeting-util",
        "protocol": "git:",
        "cloneUrl": "https://github.com/mmkal/lerna-learning",
        "owner": "mmkal",
        "repo": "lerna-learning",
        "ref": "path:packages/greeting-util",
      }
    `);
});

test("bad", async () => {
  expect(() => parseSpecifier("mmkal/lerna-learning.git")).toThrowErrorMatchingInlineSnapshot(
    `
    Error: Can't parse specifier: mmkal/lerna-learning.git. Examples of valid specifiers:
    A github repo: git:some-org/some-repo
    A github repo with a https url: https://github.com/some-org/some-repo
    A github repo with a ref: git:some-org/some-repo#some-ref
    A github repo with a path: git:some-org/some-repo#some-ref&path:some/path
    A github repo with a path and a ref: git:some-org/some-repo#some-ref&path:some/path
  `,
  );

  expect(() => parseSpecifier("bitbucket:mmkal/lerna-learning.git"))
    .toThrowErrorMatchingInlineSnapshot(`
    Error: Invalid protocol: bitbucket:. Only git: and github: and https://github.com are supported. Examples of valid specifiers:
    A github repo: git:some-org/some-repo
    A github repo with a https url: https://github.com/some-org/some-repo
    A github repo with a ref: git:some-org/some-repo#some-ref
    A github repo with a path: git:some-org/some-repo#some-ref&path:some/path
    A github repo with a path and a ref: git:some-org/some-repo#some-ref&path:some/path
  `);
});
