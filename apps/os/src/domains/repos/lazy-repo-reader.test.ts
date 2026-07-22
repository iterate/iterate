import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import {
  encodeCommit,
  encodeTree,
  hashObject,
  parseCommit,
  parsePack,
  parseTree,
  type GitWireTransport,
  type LsRefsEntry,
  type PushReport,
  type RawGitObject,
} from "./git-wire.ts";
import { createLazyRepoReader } from "./lazy-repo-reader.ts";
import { CorruptStoredObject, sqliteGitObjectStore } from "./repo-object-store.ts";

const sqlite = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => {
    exec(query: string): void;
    prepare(query: string): {
      all(...bindings: unknown[]): Record<string, unknown>[];
      run(...bindings: unknown[]): unknown;
    };
  };
};

/**
 * The Durable Object sql surface over Node's real SQLite, with REAL
 * transactions (BEGIN IMMEDIATE / COMMIT / ROLLBACK) and a fault hook: arm
 * `failOn` to make the Nth statement matching a fragment throw mid-transaction
 * — rollback behavior is then observable, not assumed.
 */
function nodeStorage() {
  const db = new sqlite.DatabaseSync(":memory:");
  const fault = { armed: null as null | { fragment: string; remaining: number } };
  return {
    failOn: (fragment: string, nth = 1) => {
      fault.armed = { fragment, remaining: nth };
    },
    sql: {
      exec: (query: string, ...bindings: unknown[]) => {
        if (fault.armed !== null && query.includes(fault.armed.fragment)) {
          fault.armed.remaining -= 1;
          if (fault.armed.remaining <= 0) {
            fault.armed = null;
            throw new Error(`injected fault on: ${query.slice(0, 40)}…`);
          }
        }
        const statement = db.prepare(query);
        if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
          const rows = statement.all(...(bindings as never[]));
          return { toArray: () => rows };
        }
        statement.run(...(bindings as never[]));
        return { toArray: () => [] };
      },
    },
    transactionSync: <T>(closure: () => T): T => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = closure();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

const text = new TextEncoder();
const AUTHOR = { date: new Date(1767323045000), email: "probe@iterate.com", name: "probe" };

/**
 * An in-memory Artifacts remote speaking the PROBED gitty semantics:
 * closure-walk from wants, recursive exclusion of in-closure have-closures,
 * deepen 1 cutting parents, missing wants silently dropped, CAS on push.
 */
function fakeRemote() {
  const objects = new Map<string, RawGitObject>();
  const refs = new Map<string, string>();
  const log = {
    fetches: [] as { haves: string[]; wants: string[] }[],
    lastPushPackOids: [] as string[],
    pushes: 0,
  };
  const faults = { lsRefsErrors: 0, pushError: null as null | "apply-then-throw" | "throw" };

  const closure = (oid: string, out: Set<string>, cutParents: boolean) => {
    if (out.has(oid)) return;
    const object = objects.get(oid);
    if (object === undefined) return; // missing oids drop silently, like gitty
    out.add(oid);
    if (object.type === "commit") {
      const commit = parseCommit(object.payload);
      closure(commit.tree, out, cutParents);
      if (!cutParents) for (const parent of commit.parents) closure(parent, out, cutParents);
    } else if (object.type === "tree") {
      for (const entry of parseTree(object.payload)) {
        if (entry.mode !== "160000") closure(entry.oid, out, cutParents);
      }
    }
  };

  const applyPush = async (
    pack: Uint8Array,
    ref: string,
    oldOid: string,
    newOid: string,
  ): Promise<PushReport> => {
    const current = refs.get(ref) ?? "0".repeat(40);
    if (current !== oldOid) return { detail: `${ref}: stale ref`, kind: "rejected" };
    const unpacked = await parsePack(pack);
    log.lastPushPackOids = unpacked.map((object) => object.oid);
    for (const object of unpacked) objects.set(object.oid, object);
    if (newOid === "0".repeat(40)) refs.delete(ref);
    else refs.set(ref, newOid);
    return { kind: "applied" };
  };

  const wire: GitWireTransport = {
    fetchObjects: async ({ deepen, haves = [], wants }) => {
      log.fetches.push({ haves: [...haves], wants: [...wants] });
      const wanted = new Set<string>();
      for (const want of wants) closure(want, wanted, deepen === 1);
      const excluded = new Set<string>();
      for (const have of haves) {
        if (wanted.has(have)) closure(have, excluded, false);
      }
      return [...wanted]
        .filter((oid) => !excluded.has(oid) || wants.includes(oid))
        .map((oid) => objects.get(oid)!);
    },
    lsRefs: async () => {
      if (faults.lsRefsErrors > 0) {
        faults.lsRefsErrors -= 1;
        throw new Error("ls-refs transiently unavailable");
      }
      // gitty ignores ref-prefix filters; always return everything.
      const entries: LsRefsEntry[] = [];
      for (const [name, oid] of refs) entries.push({ name, oid });
      return entries;
    },
    push: async ({ newOid, oldOid, pack, ref }) => {
      log.pushes += 1;
      if (faults.pushError === "throw") {
        faults.pushError = null;
        throw new Error("socket closed before response");
      }
      if (faults.pushError === "apply-then-throw") {
        faults.pushError = null;
        await applyPush(pack, ref, oldOid, newOid);
        throw new Error("response lost after the server applied the push");
      }
      return applyPush(pack, ref, oldOid, newOid);
    },
  };

  const putBlob = async (content: string) => {
    const payload = text.encode(content);
    const oid = await hashObject("blob", payload);
    objects.set(oid, { oid, payload, type: "blob" });
    return oid;
  };
  const putTree = async (entries: { mode: string; name: string; oid: string }[]) => {
    const payload = encodeTree(entries);
    const oid = await hashObject("tree", payload);
    objects.set(oid, { oid, payload, type: "tree" });
    return oid;
  };
  const putCommit = async (tree: string, parents: string[], message: string) => {
    const payload = encodeCommit({
      author: { date: new Date(1767323045000), email: "remote@iterate.com", name: "remote" },
      message,
      parents,
      tree,
    });
    const oid = await hashObject("commit", payload);
    objects.set(oid, { oid, payload, type: "commit" });
    return oid;
  };

  return { faults, log, objects, putBlob, putCommit, putTree, refs, wire };
}

type Remote = ReturnType<typeof fakeRemote>;

/** Seed: tasks/one.md, tasks/two.md, sub/tasks/three.md, big.bin, tool (exec). */
async function seededRemote() {
  const remote = fakeRemote();
  const one = await remote.putBlob("# one\n");
  const two = await remote.putBlob("# two\n");
  const three = await remote.putBlob("# three\n");
  const big = await remote.putBlob("x".repeat(700 * 1024)); // spans two chunk rows
  const tool = await remote.putBlob("#!/bin/sh\n");
  const tasks = await remote.putTree([
    { mode: "100644", name: "one.md", oid: one },
    { mode: "100644", name: "two.md", oid: two },
  ]);
  const subTasks = await remote.putTree([{ mode: "100644", name: "three.md", oid: three }]);
  const sub = await remote.putTree([{ mode: "40000", name: "tasks", oid: subTasks }]);
  const root = await remote.putTree([
    { mode: "100644", name: "big.bin", oid: big },
    { mode: "40000", name: "sub", oid: sub },
    { mode: "40000", name: "tasks", oid: tasks },
    { mode: "100755", name: "tool", oid: tool },
  ]);
  const head = await remote.putCommit(root, [], "seed\n");
  remote.refs.set("refs/heads/main", head);
  return { head, remote, root };
}

function subject(remote: Remote) {
  const storage = nodeStorage();
  const store = sqliteGitObjectStore(storage);
  return {
    reader: createLazyRepoReader({ branch: "main", store, wire: remote.wire }),
    storage,
    store,
  };
}

const syncTip = async (
  reader: ReturnType<typeof createLazyRepoReader>,
): Promise<{ commitOid: string; rootTreeOid: string }> =>
  reader.syncToHead(await reader.resolveRemoteHead());

/** Push a one-file add/edit as an EXTERNAL writer, returning the new head. */
async function externalEdit(remote: Remote, path: string, content: string) {
  const head = remote.refs.get("refs/heads/main")!;
  const root = parseCommit(remote.objects.get(head)!.payload).tree;
  const segments = path.split("/");
  const rebuild = async (treeOid: string, depth: number): Promise<string> => {
    const entries = parseTree(remote.objects.get(treeOid)!.payload);
    const name = segments[depth]!;
    if (depth === segments.length - 1) {
      const blob = await remote.putBlob(content);
      const next = entries.some((entry) => entry.name === name)
        ? entries.map((entry) => (entry.name === name ? { ...entry, oid: blob } : entry))
        : [...entries, { mode: "100644", name, oid: blob }];
      return remote.putTree(next);
    }
    const child = entries.find((entry) => entry.name === name)!;
    const rebuilt = await rebuild(child.oid, depth + 1);
    return remote.putTree(
      entries.map((entry) => (entry.name === name ? { ...entry, oid: rebuilt } : entry)),
    );
  };
  const newRoot = await rebuild(root, 0);
  const newHead = await remote.putCommit(newRoot, [head], `edit ${path}\n`);
  remote.refs.set("refs/heads/main", newHead);
  return newHead;
}

describe("sync", () => {
  test("first sync ingests the snapshot and builds the manifest", async () => {
    const { head, remote } = await seededRemote();
    const { reader } = subject(remote);
    const synced = await syncTip(reader);
    expect(synced.commitOid).toBe(head);
    expect((await reader.listHead()).paths).toEqual([
      "big.bin",
      "sub/tasks/three.md",
      "tasks/one.md",
      "tasks/two.md",
      "tool",
    ]);
    expect(remote.log.fetches[0]?.haves).toEqual([]); // nothing to exclude yet
  });

  test("incremental sync sends dir-tree haves and applies only the delta", async () => {
    const { remote } = await seededRemote();
    const { reader } = subject(remote);
    await syncTip(reader);
    const newHead = await externalEdit(remote, "tasks/one.md", "# one v2\n");

    const before = remote.log.fetches.length;
    const synced = await syncTip(reader);
    expect(synced.commitOid).toBe(newHead);
    expect(remote.log.fetches[before]!.haves.length).toBeGreaterThan(0);
    await expect(reader.readPaths(["tasks/one.md", "sub/tasks/three.md"])).resolves.toEqual([
      "# one v2\n",
      "# three\n",
    ]);
  });

  test("a no-op sync (already at target) touches no wire", async () => {
    const { head, remote } = await seededRemote();
    const { reader } = subject(remote);
    await syncTip(reader);
    const fetches = remote.log.fetches.length;
    await reader.syncToHead(head);
    expect(remote.log.fetches.length).toBe(fetches);
  });

  test("a blob moved in from an UNCHANGED directory hydrates by exact oid (server under-send)", async () => {
    const { remote } = await seededRemote();
    const { reader } = subject(remote);
    await syncTip(reader);

    // The new head copies sub/tasks/three.md's BLOB to tasks/copied.md; sub/
    // is untouched, so the server's have-closure exclusion swallows the blob.
    const head = remote.refs.get("refs/heads/main")!;
    const root = parseCommit(remote.objects.get(head)!.payload).tree;
    const rootEntries = parseTree(remote.objects.get(root)!.payload);
    const threeBlob = await hashObject("blob", text.encode("# three\n"));
    const tasksOid = rootEntries.find((entry) => entry.name === "tasks")!.oid;
    const tasksEntries = parseTree(remote.objects.get(tasksOid)!.payload);
    const newTasks = await remote.putTree([
      ...tasksEntries,
      { mode: "100644", name: "copied.md", oid: threeBlob },
    ]);
    const newRoot = await remote.putTree(
      rootEntries.map((entry) => (entry.name === "tasks" ? { ...entry, oid: newTasks } : entry)),
    );
    const newHead = await remote.putCommit(newRoot, [head], "copy\n");
    remote.refs.set("refs/heads/main", newHead);

    await syncTip(reader);
    await expect(reader.readPaths(["tasks/copied.md"])).resolves.toEqual(["# three\n"]);
  });

  test("a mid-transaction fault rolls the snapshot install back atomically", async () => {
    const { head, remote } = await seededRemote();
    const { reader, storage } = subject(remote);
    await syncTip(reader);
    const newHead = await externalEdit(remote, "tasks/one.md", "# one v2\n");

    storage.failOn("INSERT INTO git_dir_trees");
    await expect(reader.syncToHead(newHead)).rejects.toThrow(/injected fault/);
    // The whole install rolled back: head, manifest, and dirs still name the
    // OLD snapshot — never a half-applied mixture.
    expect(reader.head()?.commitOid).toBe(head);
    await expect(reader.readPaths(["tasks/one.md"])).resolves.toEqual(["# one\n"]);

    await expect(reader.syncToHead(newHead)).resolves.toMatchObject({ commitOid: newHead });
    await expect(reader.readPaths(["tasks/one.md"])).resolves.toEqual(["# one v2\n"]);
  });

  test("concurrent syncs with different targets both apply, in order", async () => {
    const { head, remote } = await seededRemote();
    const { reader, store } = subject(remote);
    const v2Head = await externalEdit(remote, "tasks/one.md", "# racing v2\n");

    const first = reader.syncToHead(head);
    const second = reader.syncToHead(v2Head);
    const [a, b] = await Promise.all([first, second]);
    expect(a.commitOid).toBe(head);
    expect(b.commitOid).toBe(v2Head);
    expect(store.head("main")?.commitOid).toBe(v2Head);
    await expect(reader.readPaths(["tasks/one.md"])).resolves.toEqual(["# racing v2\n"]);
  });
});

describe("verified reads", () => {
  test("a 700KB blob round-trips through chunked rows", async () => {
    const { remote } = await seededRemote();
    const { reader } = subject(remote);
    await syncTip(reader);
    const { bytes } = await reader.readHeadPaths(["big.bin"]);
    expect(bytes[0]?.length).toBe(700 * 1024);
  });

  test("a mutated chunk is detected, quarantined, and rehydrated", async () => {
    const { remote } = await seededRemote();
    const { reader, storage, store } = subject(remote);
    await syncTip(reader);
    const [entry] = store.manifestEntries("main", ["tasks/one.md"]);
    storage.sql.exec(
      `UPDATE git_object_chunks SET bytes = ? WHERE oid = ?`,
      text.encode("# EVIL!\n"),
      entry!.blobOid,
    );
    // A direct store read reports corruption and deletes the row…
    await expect(store.getObject(entry!.blobOid)).rejects.toThrow(CorruptStoredObject);
    // …and the reader path self-heals by rehydrating the exact oid.
    await expect(reader.readPaths(["tasks/one.md"])).resolves.toEqual(["# one\n"]);
  });

  test("a MISSING chunk (silent truncation) is detected, never served", async () => {
    const { remote } = await seededRemote();
    const { reader, storage, store } = subject(remote);
    await syncTip(reader);
    const [entry] = store.manifestEntries("main", ["big.bin"]);
    storage.sql.exec(`DELETE FROM git_object_chunks WHERE oid = ? AND idx = 1`, entry!.blobOid);
    await expect(store.getObject(entry!.blobOid)).rejects.toThrow(/assembled/);
    const { bytes: healed } = await reader.readHeadPaths(["big.bin"]);
    expect(healed[0]?.length).toBe(700 * 1024);
  });
});

describe("lifecycle", () => {
  test("superseded objects are pruned on every install — storage IS the working set", async () => {
    const { remote } = await seededRemote();
    const { reader, storage } = subject(remote);
    await syncTip(reader);
    const countRows = () =>
      storage.sql.exec(`SELECT COUNT(*) AS n FROM git_objects`).toArray()[0]!.n as number;
    const baseline = countRows();

    for (let round = 1; round <= 5; round++) {
      const outcome = await reader.commitFiles({
        author: AUTHOR,
        changes: [{ content: `# one round ${round}\n`, path: "tasks/one.md" }],
        message: `round ${round}`,
      });
      expect(outcome.kind).toBe("applied");
    }
    // Five commits later the object count is UNCHANGED: every superseded
    // blob, tree, and commit was pruned inside the install transaction.
    expect(countRows()).toBe(baseline);
  });

  test("manifestByteSize sums the manifest's blob sizes", async () => {
    const { remote } = await seededRemote();
    const { reader, store } = subject(remote);
    await syncTip(reader);
    const total = store.manifestByteSize("main");
    expect(total).toBeGreaterThan(700 * 1024);
    expect(total).toBeLessThan(701 * 1024 + 100);
  });
});

describe("resilience and reach (round 2)", () => {
  test("a corrupt UNCHANGED subtree self-heals during the next sync", async () => {
    const { remote } = await seededRemote();
    const { reader, storage, store } = subject(remote);
    await syncTip(reader);
    // Rot the sub/ tree object at rest. Its oid stays advertised as a have,
    // so the server will keep excluding that closure from sync packs.
    const subTree = store.dirTrees("main").find((dir) => dir.path === "sub")!;
    storage.sql.exec(`DELETE FROM git_object_chunks WHERE oid = ?`, subTree.treeOid);
    storage.sql.exec(`UPDATE git_objects SET size = 1 WHERE oid = ?`, subTree.treeOid);

    const newHead = await externalEdit(remote, "tasks/one.md", "# healed era\n");
    await expect(reader.syncToHead(newHead)).resolves.toMatchObject({ commitOid: newHead });
    await expect(reader.readPaths(["sub/tasks/three.md", "tasks/one.md"])).resolves.toEqual([
      "# three\n",
      "# healed era\n",
    ]);
  });

  test("pruning is reachability across ALL branches — shared objects survive", async () => {
    const { head, remote } = await seededRemote();
    const { reader, store } = subject(remote);
    await syncTip(reader);
    // A second branch snapshot sharing every object with main's head.
    store.installSnapshot("release", {
      commitOid: head,
      dirs: store.dirTrees("main"),
      removes: [],
      rootTreeOid: store.head("main")!.rootTreeOid,
      upserts: store.manifest("main"),
    });

    const outcome = await reader.commitFiles({
      author: AUTHOR,
      changes: [{ content: "# main moved on\n", path: "tasks/one.md" }],
      message: "main only",
    });
    expect(outcome.kind).toBe("applied");
    // main's OLD one.md blob is still reachable from release's manifest.
    const [releaseEntry] = store.manifestEntries("release", ["tasks/one.md"]);
    await expect(store.getObject(releaseEntry!.blobOid)).resolves.not.toBeNull();
  });

  test("gitlinks survive sync and commits in the same directory", async () => {
    const remote = fakeRemote();
    const gitlinkOid = "1234567890123456789012345678901234567890";
    const one = await remote.putBlob("# one\n");
    const tasks = await remote.putTree([
      { mode: "100644", name: "one.md", oid: one },
      { mode: "160000", name: "vendored", oid: gitlinkOid },
    ]);
    const root = await remote.putTree([{ mode: "40000", name: "tasks", oid: tasks }]);
    const head = await remote.putCommit(root, [], "seed with gitlink\n");
    remote.refs.set("refs/heads/main", head);

    const { reader } = subject(remote);
    await syncTip(reader);
    // The gitlink is not a readable file…
    expect((await reader.listHead()).paths).toEqual(["tasks/one.md"]);
    await expect(reader.readPaths(["tasks/vendored"])).resolves.toEqual([null]);

    // …and a commit in the SAME directory carries it through untouched.
    const outcome = await reader.commitFiles({
      author: AUTHOR,
      changes: [{ content: "# one v2\n", path: "tasks/one.md" }],
      message: "edit next to the gitlink",
    });
    expect(outcome.kind).toBe("applied");
    if (outcome.kind !== "applied") throw new Error("unreachable");
    const newRoot = parseCommit(remote.objects.get(outcome.commitOid)!.payload).tree;
    const tasksEntry = parseTree(remote.objects.get(newRoot)!.payload).find(
      (entry) => entry.name === "tasks",
    )!;
    const vendored = parseTree(remote.objects.get(tasksEntry.oid)!.payload).find(
      (entry) => entry.name === "vendored",
    );
    expect(vendored).toEqual({ mode: "160000", name: "vendored", oid: gitlinkOid });
  });
});

describe("lazy commits", () => {
  test("commit builds locally, pushes CAS, and reads back with zero fetches", async () => {
    const { remote } = await seededRemote();
    const { reader } = subject(remote);
    await syncTip(reader);

    const fetchesBefore = remote.log.fetches.length;
    const outcome = await reader.commitFiles({
      author: AUTHOR,
      changes: [
        { content: "# one edited\n", path: "tasks/one.md" },
        { content: "# fresh\n", path: "deep/new/tasks/fresh.md" },
        { delete: true, path: "sub/tasks/three.md" },
      ],
      message: "board commit",
    });
    expect(outcome.kind).toBe("applied");
    if (outcome.kind !== "applied") throw new Error("unreachable");
    expect(outcome.changedPaths).toEqual([
      "deep/new/tasks/fresh.md",
      "sub/tasks/three.md",
      "tasks/one.md",
    ]);
    expect(remote.refs.get("refs/heads/main")).toBe(outcome.commitOid);
    await expect(
      reader.readPaths(["tasks/one.md", "deep/new/tasks/fresh.md", "sub/tasks/three.md"]),
    ).resolves.toEqual(["# one edited\n", "# fresh\n", null]);
    expect(remote.log.fetches.length).toBe(fetchesBefore);
    expect((await reader.listHead()).paths).not.toContain("sub/tasks/three.md");

    // A FRESH reader syncing from the remote converges on identical state.
    const fresh = subject(remote);
    await syncTip(fresh.reader);
    expect((await fresh.reader.listHead()).paths).toEqual((await reader.listHead()).paths);
  });

  test("the pushed pack carries ONLY the changed ancestor chain", async () => {
    const { remote } = await seededRemote();
    const { reader } = subject(remote);
    await syncTip(reader);
    const outcome = await reader.commitFiles({
      author: AUTHOR,
      changes: [{ content: "# one v2\n", path: "tasks/one.md" }],
      message: "one file",
    });
    expect(outcome.kind).toBe("applied");
    // Exactly: 1 blob + tasks/ tree + root tree + commit. sub/'s subtree
    // never rides, and nothing is duplicated.
    expect(remote.log.lastPushPackOids).toHaveLength(4);
    expect(new Set(remote.log.lastPushPackOids).size).toBe(4);
  });

  test("two changes with identical content pack ONE blob object", async () => {
    const { remote } = await seededRemote();
    const { reader } = subject(remote);
    await syncTip(reader);
    const outcome = await reader.commitFiles({
      author: AUTHOR,
      changes: [
        { content: "# twins\n", path: "tasks/alpha.md" },
        { content: "# twins\n", path: "tasks/beta.md" },
      ],
      message: "identical twins",
    });
    expect(outcome.kind).toBe("applied");
    const pushedOids = remote.log.lastPushPackOids;
    expect(new Set(pushedOids).size).toBe(pushedOids.length);
  });

  test("preserves executable modes and reports no-op commits as applied-empty", async () => {
    const { remote } = await seededRemote();
    const { reader } = subject(remote);
    await syncTip(reader);
    const same = await reader.commitFiles({
      author: AUTHOR,
      changes: [{ content: "#!/bin/sh\n", path: "tool" }],
      message: "no-op",
    });
    expect(same).toMatchObject({ changedPaths: [], kind: "applied" });

    const changed = await reader.commitFiles({
      author: AUTHOR,
      changes: [{ content: "#!/bin/sh\necho v2\n", path: "tool" }],
      message: "tool v2",
    });
    expect(changed.kind).toBe("applied");
    const head = remote.refs.get("refs/heads/main")!;
    const root = parseCommit(remote.objects.get(head)!.payload).tree;
    const toolEntry = parseTree(remote.objects.get(root)!.payload).find(
      (entry) => entry.name === "tool",
    );
    expect(toolEntry?.mode).toBe("100755");
  });

  test("rejects FINAL-state file/dir collisions; permits same-batch replacements", async () => {
    const { remote } = await seededRemote();
    const { reader } = subject(remote);
    await syncTip(reader);
    await expect(
      reader.commitFiles({
        author: AUTHOR,
        changes: [{ content: "x", path: "tool/nested.md" }],
        message: "under a file",
      }),
    ).rejects.toThrow(/"tool" is a file/);
    await expect(
      reader.commitFiles({
        author: AUTHOR,
        changes: [{ content: "x", path: "tasks" }],
        message: "over a directory",
      }),
    ).rejects.toThrow(/"tasks" is a file but "tasks\/one\.md" nests under it/);

    // Validation judges the FINAL manifest: emptying a directory and writing
    // a file of its name in ONE batch is a legal transition.
    const outcome = await reader.commitFiles({
      author: AUTHOR,
      changes: [
        { delete: true, path: "sub/tasks/three.md" },
        { content: "# sub is a file now\n", path: "sub" },
      ],
      message: "directory becomes a file",
    });
    expect(outcome.kind).toBe("applied");
    await expect(reader.readPaths(["sub"])).resolves.toEqual(["# sub is a file now\n"]);
  });

  test("deleting every file commits git's canonical empty tree", async () => {
    const { remote } = await seededRemote();
    const { reader } = subject(remote);
    await syncTip(reader);
    const outcome = await reader.commitFiles({
      author: AUTHOR,
      changes: (await reader.listHead()).paths.map((path) => ({ delete: true as const, path })),
      message: "scorched earth",
    });
    expect(outcome.kind).toBe("applied");
    expect((await reader.listHead()).paths).toEqual([]);
    const head = remote.refs.get("refs/heads/main")!;
    expect(parseCommit(remote.objects.get(head)!.payload).tree).toBe(
      "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
    );
  });

  test("a stale head is a REJECTED outcome; the post-resync retry carries the true parent", async () => {
    const { remote } = await seededRemote();
    const first = subject(remote);
    const second = subject(remote);
    await syncTip(first.reader);
    await syncTip(second.reader);
    const winner = await first.reader.commitFiles({
      author: AUTHOR,
      changes: [{ content: "# a\n", path: "tasks/one.md" }],
      message: "a wins",
    });
    expect(winner.kind).toBe("applied");
    if (winner.kind !== "applied") throw new Error("unreachable");
    const loser = await second.reader.commitFiles({
      author: AUTHOR,
      changes: [{ content: "# b\n", path: "tasks/one.md" }],
      message: "b loses",
    });
    expect(loser.kind).toBe("rejected");

    await syncTip(second.reader);
    const retried = await second.reader.commitFiles({
      author: AUTHOR,
      changes: [{ content: "# b\n", path: "tasks/one.md" }],
      message: "b retries",
    });
    expect(retried.kind).toBe("applied");
    if (retried.kind !== "applied") throw new Error("unreachable");
    expect(retried.parentCommitOid).toBe(winner.commitOid);
    expect(remote.refs.get("refs/heads/main")).toBe(retried.commitOid);
  });

  test("push transport death reconciles: applied when the ref shows our commit", async () => {
    const { remote } = await seededRemote();
    const { reader } = subject(remote);
    await syncTip(reader);
    remote.faults.pushError = "apply-then-throw";
    const outcome = await reader.commitFiles({
      author: AUTHOR,
      changes: [{ content: "# survived\n", path: "tasks/one.md" }],
      message: "response lost",
    });
    expect(outcome.kind).toBe("applied");
    if (outcome.kind !== "applied") throw new Error("unreachable");
    expect(remote.refs.get("refs/heads/main")).toBe(outcome.commitOid);
    await expect(reader.readPaths(["tasks/one.md"])).resolves.toEqual(["# survived\n"]);
  });

  test("push transport death reconciles: rejected when the ref never moved", async () => {
    const { remote } = await seededRemote();
    const { reader } = subject(remote);
    await syncTip(reader);
    remote.faults.pushError = "throw";
    const outcome = await reader.commitFiles({
      author: AUTHOR,
      changes: [{ content: "# never landed\n", path: "tasks/one.md" }],
      message: "socket died",
    });
    expect(outcome.kind).toBe("rejected");
    await expect(reader.readPaths(["tasks/one.md"])).resolves.toEqual(["# one\n"]);
  });

  test("push transport death with an unreachable ref is INDETERMINATE — never a plain error", async () => {
    const { remote } = await seededRemote();
    const { reader } = subject(remote);
    await syncTip(reader);
    remote.faults.pushError = "throw";
    remote.faults.lsRefsErrors = 3; // every reconcile attempt fails too
    const outcome = await reader.commitFiles({
      author: AUTHOR,
      changes: [{ content: "# unknown\n", path: "tasks/one.md" }],
      message: "black hole",
    });
    expect(outcome.kind).toBe("indeterminate");
    if (outcome.kind !== "indeterminate") throw new Error("unreachable");
    expect(outcome.proposedCommitOid).toMatch(/^[0-9a-f]{40}$/);
  });

  test("a pushed commit whose LOCAL install fails is applied-with-error; a resync heals", async () => {
    const { remote } = await seededRemote();
    const { reader, storage } = subject(remote);
    await syncTip(reader);
    storage.failOn("INSERT INTO git_manifest");
    const outcome = await reader.commitFiles({
      author: AUTHOR,
      changes: [{ content: "# pushed anyway\n", path: "tasks/one.md" }],
      message: "install dies",
    });
    expect(outcome.kind).toBe("applied");
    if (outcome.kind !== "applied") throw new Error("unreachable");
    expect(outcome.localInstallError).toBeDefined();
    expect(remote.refs.get("refs/heads/main")).toBe(outcome.commitOid);
    // The local store still shows the PARENT (the install rolled back)…
    await expect(reader.readPaths(["tasks/one.md"])).resolves.toEqual(["# one\n"]);
    // …until a sync converges it on the pushed head.
    await syncTip(reader);
    await expect(reader.readPaths(["tasks/one.md"])).resolves.toEqual(["# pushed anyway\n"]);
  });
});
