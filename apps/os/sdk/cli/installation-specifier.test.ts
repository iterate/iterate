import { test, expect } from "vitest";
import { parseSpecifier } from "./installation-specifier.ts";

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

test("checkoutInstallationCommand", async () => {
  expect(parseSpecifier("github:example-org/example-repo#ci/test&path:packages/example-package"))
    .toMatchInlineSnapshot(`
      {
        "raw": "github:example-org/example-repo#ci/test&path:packages/example-package",
        "protocol": "github:",
        "cloneUrl": "https://github.com/example-org/example-repo",
        "owner": "example-org",
        "repo": "example-repo",
        "ref": "ci/test",
        "directory": "packages/example-package",
      }
    `);

  expect(
    parseSpecifier(
      "git:https://github.com/example-org/example-repo.git#ci/test&path:packages/example-package",
    ),
  ).toMatchInlineSnapshot(`
    {
      "raw": "git:https://github.com/example-org/example-repo.git#ci/test&path:packages/example-package",
      "protocol": "git:",
      "cloneUrl": "https://github.com/example-org/example-repo",
      "owner": "example-org",
      "repo": "example-repo",
      "ref": "ci/test",
      "directory": "packages/example-package",
    }
  `);

  expect(
    parseSpecifier(
      "https://github.com/example-org/example-repo#ci/test&path:packages/example-package",
    ),
  ).toMatchInlineSnapshot(`
    {
      "raw": "https://github.com/example-org/example-repo#ci/test&path:packages/example-package",
      "protocol": "https:",
      "cloneUrl": "https://github.com/example-org/example-repo",
      "owner": "example-org",
      "repo": "example-repo",
      "ref": "ci/test",
      "directory": "packages/example-package",
    }
  `);

  expect(parseSpecifier("git:example-org/example-repo")).toMatchInlineSnapshot(`
    {
      "raw": "git:example-org/example-repo",
      "protocol": "git:",
      "cloneUrl": "https://github.com/example-org/example-repo",
      "owner": "example-org",
      "repo": "example-repo",
    }
  `);

  expect(parseSpecifier("git:example-org/example-repo#&path:packages/example-package"))
    .toMatchInlineSnapshot(`
      {
        "raw": "git:example-org/example-repo#&path:packages/example-package",
        "protocol": "git:",
        "cloneUrl": "https://github.com/example-org/example-repo",
        "owner": "example-org",
        "repo": "example-repo",
        "directory": "packages/example-package",
      }
    `);
});

test("bad", async () => {
  expect(() => parseSpecifier("example-org/example-repo.git")).toThrowErrorMatchingInlineSnapshot(
    `
    Error: Can't parse specifier: example-org/example-repo.git. Examples of valid specifiers:
    A github repo: git:some-org/some-repo
    A github repo with a https url: https://github.com/some-org/some-repo
    A github repo with a ref: git:some-org/some-repo#some-ref
    A github repo with a path: git:some-org/some-repo#some-ref&path:some/path
    A github repo with a path and a ref: git:some-org/some-repo#some-ref&path:some/path
  `,
  );

  expect(() => parseSpecifier("bitbucket:example-org/example-repo.git"))
    .toThrowErrorMatchingInlineSnapshot(`
    Error: Invalid protocol: bitbucket:. Only git: and github: and https://github.com are supported. Examples of valid specifiers:
    A github repo: git:some-org/some-repo
    A github repo with a https url: https://github.com/some-org/some-repo
    A github repo with a ref: git:some-org/some-repo#some-ref
    A github repo with a path: git:some-org/some-repo#some-ref&path:some/path
    A github repo with a path and a ref: git:some-org/some-repo#some-ref&path:some/path
  `);
});
