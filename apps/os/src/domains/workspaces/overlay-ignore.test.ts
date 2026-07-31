import { describe, expect, test } from "vitest";
import { filterPublishablePaths } from "./overlay-ignore.ts";

function withFiles(files: Record<string, string | null>) {
  return {
    paths: Object.keys(files),
    readFile: (path: string) => Promise.resolve(files[path] ?? null),
  };
}

describe("filterPublishablePaths", () => {
  test("no .gitignore publishes everything", async () => {
    const files = { "/a.txt": "", "/b/c.txt": "" };
    expect(await filterPublishablePaths(withFiles(files))).toEqual(["/a.txt", "/b/c.txt"]);
  });

  test("a `*` .gitignore hides its whole directory, including itself", async () => {
    const files = {
      "/notes.md": "",
      "/generated/.gitignore": "*\n",
      "/generated/bundle.json": "{}",
    };
    expect(await filterPublishablePaths(withFiles(files))).toEqual(["/notes.md"]);
  });

  test("name, extension, directory, and anchored patterns", async () => {
    const files = {
      "/.gitignore": "node_modules/\n*.log\nsecret.txt\n/exact-only.md\n",
      "/app.log": "",
      "/deep/nested/other.log": "",
      "/deep/secret.txt": "",
      "/exact-only.md": "",
      "/nested/exact-only.md": "",
      "/node_modules/pkg/index.js": "",
      "/src/main.ts": "",
    };
    expect(await filterPublishablePaths(withFiles(files))).toEqual([
      "/.gitignore",
      "/nested/exact-only.md",
      "/src/main.ts",
    ]);
  });

  test("comments, blanks, and negations are skipped; unsupported patterns fail open", async () => {
    const files = {
      "/.gitignore": "# comment\n\n!keep.txt\nfoo**bar\nmid*dle\n",
      "/fooXbar": "",
      "/keep.txt": "",
      "/midWWdle": "",
    };
    expect(await filterPublishablePaths(withFiles(files))).toEqual([
      "/.gitignore",
      "/fooXbar",
      "/keep.txt",
      "/midWWdle",
    ]);
  });

  test("a nested .gitignore only affects its own subtree", async () => {
    const files = {
      "/build/out.js": "",
      "/sub/.gitignore": "*.js\n",
      "/sub/lib.js": "",
      "/sub/lib.ts": "",
    };
    expect(await filterPublishablePaths(withFiles(files))).toEqual([
      "/build/out.js",
      "/sub/.gitignore",
      "/sub/lib.ts",
    ]);
  });
});
