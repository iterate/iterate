import { expect, test } from "vitest";
import { desiredRepoVfs, repoSeedPaths, repoVfsDiff } from "./repo-typescript-vfs.ts";
import { workingTreeStore } from "./staged-changes.ts";

const head = new Map([
  ["src/greet.ts", "export const greet = 1;"],
  ["src/main.ts", 'import "./greet.ts";'],
]);

test("desired vfs is HEAD overlaid with working-tree edits", () => {
  const store = repoStore("oid-overlay");
  store.setWorking("src/main.ts", { type: "write", content: "edited" });
  store.setWorking("src/new.ts", { type: "write", content: "brand new" });
  store.setWorking("src/greet.ts", { type: "delete" });
  // Binary uploads and non-TS files are invisible to the program.
  store.setWorking("logo.png", { type: "write-base64", contentBase64: "aGk=" });
  store.setWorking("notes.md", { type: "write", content: "# notes" });

  expect(desiredRepoVfs(head, store.changes)).toEqual(
    new Map([
      ["src/main.ts", "edited"],
      ["src/new.ts", "brand new"],
    ]),
  );
});

test("a live edit wins over the staged snapshot; the snapshot survives a discard", () => {
  const store = repoStore("oid-staged");
  store.setWorking("src/main.ts", { type: "write", content: "staged version" });
  store.stage("src/main.ts");
  store.setWorking("src/main.ts", { type: "write", content: "edited again" });
  expect(desiredRepoVfs(head, store.changes).get("src/main.ts")).toBe("edited again");

  store.discardWorking("src/main.ts");
  expect(desiredRepoVfs(head, store.changes).get("src/main.ts")).toBe("staged version");
});

test("diff emits only changed writes and removed paths, keyed by vfs-rooted path", () => {
  const pushed = new Map([
    ["src/greet.ts", "export const greet = 1;"],
    ["src/gone.ts", "bye"],
  ]);
  const desired = new Map([
    ["src/greet.ts", "export const greet = 2;"],
    ["src/new.ts", "hi"],
  ]);

  expect(repoVfsDiff(pushed, desired)).toEqual({
    updates: {
      "/src/greet.ts": "export const greet = 2;",
      "/src/new.ts": "hi",
    },
    removals: ["/src/gone.ts"],
  });
});

test("an unchanged vfs diffs to nothing", () => {
  const contents = new Map([["src/main.ts", "same"]]);
  expect(repoVfsDiff(contents, new Map(contents))).toEqual({ updates: {}, removals: [] });
});

test("the seed cap keeps tsconfig.json and package.json even though they sort after app/", () => {
  const paths = Array.from({ length: 600 }, (_, i) => `app/file-${String(i).padStart(3, "0")}.ts`);
  paths.push("tsconfig.json", "package.json", "logo.png");

  const seeded = repoSeedPaths(paths);
  expect(seeded).toHaveLength(502);
  expect(seeded).toContain("tsconfig.json");
  // Dropping package.json would silently disable typm for big repos.
  expect(seeded).toContain("package.json");
  expect(seeded).not.toContain("logo.png");

  // Small repos are untouched (and still exclude non-TS files).
  expect(repoSeedPaths(["tsconfig.json", "src/a.ts", "logo.png"])).toEqual([
    "src/a.ts",
    "tsconfig.json",
  ]);
});

/** A real WorkingTreeStore (module-keyed, so each test uses its own oid). */
function repoStore(commitOid: string) {
  return workingTreeStore({ projectId: "prj_test", repoPath: "/repos/spec", commitOid });
}
