import { expect, test } from "vitest";
import {
  commitPlan,
  effectiveEntry,
  textContentForEntry,
  workingTreeGitStatus,
  workingTreeStore,
  type FileEntry,
} from "./staged-changes.ts";

test("editing sets a working entry; editing back to the baseline clears it", () => {
  using fixture = storageFixture();
  const store = fixture.store("oid-1");

  store.setWorking("README.md", write("hello"));
  expect(store.changes.get("README.md")).toMatchObject({ working: { content: "hello" } });

  // The IDE clears the working slot when the buffer matches the baseline
  // again (repo-editor-pane compares against staged ?? HEAD and passes
  // undefined) — the store just needs to drop the empty record.
  store.setWorking("README.md", undefined);
  expect(store.changes.size).toBe(0);
});

test("stage moves the working entry to the staged slot; a re-edit occupies both", () => {
  using fixture = storageFixture();
  const store = fixture.store("oid-1");

  store.setWorking("README.md", write("v1"));
  store.stage("README.md");
  expect(store.changes.get("README.md")).toMatchObject({ staged: { content: "v1" } });
  expect(store.changes.get("README.md")!.working).toBeUndefined();

  // vscode's shape: editing after staging shows the file in BOTH sections.
  store.setWorking("README.md", write("v2"));
  expect(store.changes.get("README.md")).toMatchObject({
    staged: { content: "v1" },
    working: { content: "v2" },
  });
});

test("a working edit identical to the staged snapshot is no edit at all", () => {
  using fixture = storageFixture();
  const store = fixture.store("oid-1");

  store.setWorking("a.ts", write("same"));
  store.stage("a.ts");
  store.setWorking("a.ts", write("same"));
  expect(store.changes.get("a.ts")!.working).toBeUndefined();

  // And the mirror image: staging a snapshot that matches the live edit
  // (block-staging the last dirty chunk) absorbs the working entry.
  store.setWorking("b.ts", write("chunk"));
  store.setStaged("b.ts", write("chunk"));
  expect(store.changes.get("b.ts")).toMatchObject({ staged: { content: "chunk" } });
  expect(store.changes.get("b.ts")!.working).toBeUndefined();
});

test("unstage keeps live edits when they exist, else moves the snapshot back", () => {
  using fixture = storageFixture();
  const store = fixture.store("oid-1");

  store.setWorking("clean.ts", write("staged-only"));
  store.stage("clean.ts");
  store.unstage("clean.ts");
  expect(store.changes.get("clean.ts")).toMatchObject({ working: { content: "staged-only" } });
  expect(store.changes.get("clean.ts")!.staged).toBeUndefined();

  store.setWorking("dirty.ts", write("v1"));
  store.stage("dirty.ts");
  store.setWorking("dirty.ts", write("v2"));
  store.unstage("dirty.ts");
  expect(store.changes.get("dirty.ts")).toMatchObject({ working: { content: "v2" } });
  expect(store.changes.get("dirty.ts")!.staged).toBeUndefined();
});

test("discardWorking reverts to the staged snapshot, not to nothing", () => {
  using fixture = storageFixture();
  const store = fixture.store("oid-1");

  store.setWorking("a.md", write("v1"));
  store.stage("a.md");
  store.setWorking("a.md", write("v2"));
  store.discardWorking("a.md");
  expect(store.changes.get("a.md")).toMatchObject({ staged: { content: "v1" } });

  store.setWorking("b.md", write("only-working"));
  store.discardWorking("b.md");
  expect(store.changes.has("b.md")).toBe(false);
});

test("commitPlan takes staged snapshots when anything is staged, else everything", () => {
  using fixture = storageFixture();
  const store = fixture.store("oid-1");

  store.setWorking("one.ts", write("1"));
  store.setWorking("two.png", { type: "write-base64", contentBase64: "QUJD" });
  store.setWorking("gone.ts", { type: "delete" });
  expect(commitPlan(store.changes)).toMatchObject({
    mode: "everything",
    fileChanges: [
      { path: "one.ts", content: "1" },
      { path: "two.png", contentBase64: "QUJD" },
      { path: "gone.ts", delete: true },
    ],
  });

  store.stage("one.ts");
  expect(commitPlan(store.changes)).toMatchObject({
    mode: "staged",
    paths: ["one.ts"],
    fileChanges: [{ path: "one.ts", content: "1" }],
  });
});

test("clearStaged drops committed snapshots but keeps live edits", () => {
  using fixture = storageFixture();
  const store = fixture.store("oid-1");

  store.setWorking("committed.ts", write("v1"));
  store.stage("committed.ts");
  store.setWorking("committed.ts", write("v2"));
  store.setWorking("untouched.ts", write("keep"));

  store.clearStaged(["committed.ts"]);
  expect(store.changes.get("committed.ts")).toMatchObject({ working: { content: "v2" } });
  expect(store.changes.get("committed.ts")!.staged).toBeUndefined();
  expect(store.changes.get("untouched.ts")).toMatchObject({ working: { content: "keep" } });
});

test("clearCommitted keeps slots that changed while the commit was in flight", () => {
  using fixture = storageFixture();
  const store = fixture.store("oid-1");

  store.setWorking("tasks/a.md", write("committed a"));
  store.setWorking("tasks/b.md", write("committed b"));
  store.stage("tasks/b.md");
  store.setWorking("tasks/c.md", { type: "delete" });
  const committed = new Map<string, FileEntry>([
    ["tasks/a.md", write("committed a")],
    ["tasks/b.md", write("committed b")],
    ["tasks/c.md", { type: "delete" }],
  ]);
  // An edit landing between the commit RPC going out and its response must
  // survive the cleanup — this is the autosave-while-typing case.
  store.setWorking("tasks/a.md", write("edited during flight"));

  store.clearCommitted(committed);
  expect(store.changes.get("tasks/a.md")).toMatchObject({
    working: { content: "edited during flight" },
  });
  expect(store.changes.has("tasks/b.md")).toBe(false);
  expect(store.changes.has("tasks/c.md")).toBe(false);
});

test("git status derives from the effective entry, staged or live", () => {
  using fixture = storageFixture();
  const store = fixture.store("oid-1");
  const headPaths = new Set(["existing.ts", "doomed.ts"]);

  store.setWorking("existing.ts", write("edited"));
  store.setWorking("brand-new.ts", write("hi"));
  store.setWorking("doomed.ts", { type: "delete" });
  store.stage("doomed.ts");

  expect(workingTreeGitStatus(store.changes, headPaths)).toEqual([
    { path: "existing.ts", status: "modified" },
    { path: "brand-new.ts", status: "added" },
    { path: "doomed.ts", status: "deleted" },
  ]);
  expect(effectiveEntry(store.changes.get("doomed.ts")!)).toEqual({ type: "delete" });
});

test("text content decodes UTF-8 files written through the base64 upload lane", () => {
  const markdown = "# Caf\u00e9 \u2615\n";
  const bytes = new TextEncoder().encode(markdown);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);

  expect(textContentForEntry({ type: "write-base64", contentBase64: btoa(binary) })).toBe(markdown);
  expect(
    textContentForEntry({ type: "write-base64", contentBase64: "not base64" }),
  ).toBeUndefined();
  expect(textContentForEntry({ type: "delete" })).toBeUndefined();
});

test("a moved HEAD orphans stale state: older-oid keys are swept on load", () => {
  using fixture = storageFixture();
  fixture.seed("oid-old", [["README.md", { working: write("stale") }]]);

  const fresh = fixture.store("oid-new");
  expect(fresh.changes.size).toBe(0);
  expect(fixture.keys()).toEqual([]);
});

test("migrateTo carries surviving changes to the new oid's store", () => {
  using fixture = storageFixture();
  const before = fixture.store("oid-1");
  before.setWorking("survivor.ts", write("still dirty"));

  const after = fixture.store("oid-2");
  before.migrateTo(after);

  expect(after.changes.get("survivor.ts")).toMatchObject({ working: { content: "still dirty" } });
  expect(before.changes.size).toBe(0);
  expect(fixture.keys()).toEqual([`${fixture.prefix}oid-2`]);
});

// ---------------------------------------------------------------------------

function write(content: string): FileEntry {
  return { type: "write", content };
}

/**
 * A fake `localStorage` for the store's persistence, plus store accessors.
 * Each fixture uses a unique repo identity because the module caches store
 * instances per key — reusing one across tests would leak state between them.
 */
function storageFixture() {
  const backing = new Map<string, string>();
  const fake = {
    get length() {
      return backing.size;
    },
    key: (index: number) => [...backing.keys()][index] ?? null,
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => void backing.set(key, value),
    removeItem: (key: string) => void backing.delete(key),
    clear: () => backing.clear(),
  };
  const previous = (globalThis as any).localStorage;
  (globalThis as any).localStorage = fake;

  const repo = { projectId: `prj_${crypto.randomUUID().slice(0, 8)}`, repoPath: "/repos/x" };
  return {
    prefix: `repo-ide-working-tree:${repo.projectId}:${repo.repoPath}:`,
    store: (commitOid: string) => workingTreeStore({ ...repo, commitOid }),
    seed(commitOid: string, entries: Array<[string, unknown]>) {
      backing.set(
        `repo-ide-working-tree:${repo.projectId}:${repo.repoPath}:${commitOid}`,
        JSON.stringify(entries),
      );
    },
    keys: () => [...backing.keys()],
    [Symbol.dispose]() {
      (globalThis as any).localStorage = previous;
    },
  };
}
