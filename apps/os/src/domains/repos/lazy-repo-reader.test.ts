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
  type RawGitObject,
} from "./git-wire.ts";
import { createLazyRepoReader, LazyRepoConflict } from "./lazy-repo-reader.ts";
import { sqliteGitObjectStore } from "./repo-object-store.ts";

const sqlite = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => {
    exec(query: string): void;
    prepare(query: string): {
      all(...bindings: unknown[]): Record<string, unknown>[];
      run(...bindings: unknown[]): unknown;
    };
  };
};

/** The Durable Object sql surface over Node's real SQLite. */
function nodeStorage() {
  const db = new sqlite.DatabaseSync(":memory:");
  return {
    sql: {
      exec: (query: string, ...bindings: unknown[]) => {
        const statement = db.prepare(query);
        if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
          const rows = statement.all(...(bindings as never[]));
          return { toArray: () => rows };
        }
        statement.run(...(bindings as never[]));
        return { toArray: () => [] };
      },
    },
    transactionSync: <T>(closure: () => T): T => closure(),
  };
}

const text = new TextEncoder();

/**
 * An in-memory Artifacts remote speaking the PROBED gitty semantics:
 * closure-walk from wants, recursive exclusion of have-closures, deepen 1
 * cutting parents, missing wants silently dropped, CAS on push.
 */
function fakeRemote() {
  const objects = new Map<string, RawGitObject>();
  const refs = new Map<string, string>();
  const log = { fetches: [] as { haves: string[]; wants: string[] }[], pushes: 0 };

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

  const wire: GitWireTransport = {
    fetchObjects: async ({ deepen, haves = [], wants }) => {
      log.fetches.push({ haves: [...haves], wants: [...wants] });
      const wanted = new Set<string>();
      for (const want of wants) closure(want, wanted, deepen === 1);
      const excluded = new Set<string>();
      for (const have of haves) {
        // gitty excludes a have's closure when the have is itself part of
        // the wanted closure (probed: in-closure tree haves ACK + exclude).
        if (wanted.has(have)) closure(have, excluded, false);
      }
      return [...wanted]
        .filter((oid) => !excluded.has(oid) || wants.includes(oid))
        .map((oid) => objects.get(oid)!);
    },
    lsRefs: async () => {
      // gitty ignores ref-prefix filters; always return everything.
      const entries: LsRefsEntry[] = [];
      for (const [name, oid] of refs) entries.push({ name, oid });
      return entries;
    },
    push: async ({ newOid, oldOid, pack, ref }) => {
      log.pushes += 1;
      const current = refs.get(ref) ?? "0".repeat(40);
      if (current !== oldOid) return { ok: false, refErrors: [`${ref}: stale ref`] };
      for (const object of await parsePack(pack)) objects.set(object.oid, object);
      if (newOid === "0".repeat(40)) refs.delete(ref);
      else refs.set(ref, newOid);
      return { ok: true, refErrors: [] };
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

  return { log, objects, putBlob, putCommit, putTree, refs, wire };
}

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

function subject(remote: ReturnType<typeof fakeRemote>) {
  const store = sqliteGitObjectStore(nodeStorage());
  return { reader: createLazyRepoReader({ branch: "main", store, wire: remote.wire }), store };
}

describe("sync", () => {
  test("first sync ingests the snapshot and builds the manifest", async () => {
    const { head, remote } = await seededRemote();
    const { reader } = subject(remote);
    const synced = await reader.syncToHead();
    expect(synced.commitOid).toBe(head);
    expect(reader.listPaths()).toEqual([
      "big.bin",
      "sub/tasks/three.md",
      "tasks/one.md",
      "tasks/two.md",
      "tool",
    ]);
    expect(remote.log.fetches[0]?.haves).toEqual([]); // nothing to exclude yet
  });

  test("incremental sync sends every known dir tree as a have and applies the delta", async () => {
    const { remote } = await seededRemote();
    const { reader, store } = subject(remote);
    await reader.syncToHead();

    // The remote moves: tasks/one.md edited (a fresh remote commit).
    const oneV2 = await remote.putBlob("# one v2\n");
    const tasksTree = await remote.putTree([
      { mode: "100644", name: "one.md", oid: oneV2 },
      { mode: "100644", name: "two.md", oid: await hashObject("blob", text.encode("# two\n")) },
    ]);
    const rootEntries = parseTree(
      remote.objects.get(
        parseCommit(remote.objects.get(remote.refs.get("refs/heads/main")!)!.payload).tree,
      )!.payload,
    );
    const newRoot = await remote.putTree(
      rootEntries.map((entry) => (entry.name === "tasks" ? { ...entry, oid: tasksTree } : entry)),
    );
    const newHead = await remote.putCommit(
      newRoot,
      [remote.refs.get("refs/heads/main")!],
      "edit\n",
    );
    remote.refs.set("refs/heads/main", newHead);

    const before = remote.log.fetches.length;
    const synced = await reader.syncToHead();
    expect(synced.commitOid).toBe(newHead);
    const syncFetch = remote.log.fetches[before]!;
    expect(syncFetch.haves.length).toBeGreaterThan(0); // dir trees rode along
    await expect(reader.readPaths(["tasks/one.md"])).resolves.toEqual(["# one v2\n"]);
    // Unchanged manifest rows survived the resync.
    expect(store.manifestEntries("main", ["sub/tasks/three.md"])[0]?.blobOid).toBeTruthy();
  });

  test("a no-op sync (same head) fetches nothing", async () => {
    const { remote } = await seededRemote();
    const { reader } = subject(remote);
    await reader.syncToHead();
    const fetches = remote.log.fetches.length;
    await reader.syncToHead();
    expect(remote.log.fetches.length).toBe(fetches);
  });
});

describe("reads", () => {
  test("readPaths serves from the store, hydrates evicted blobs by exact oid", async () => {
    const { remote } = await seededRemote();
    const { reader, store } = subject(remote);
    await reader.syncToHead();

    await expect(reader.readPaths(["tasks/one.md", "nope.md"])).resolves.toEqual(["# one\n", null]);

    // Evict everything evictable, then read again: the reader must re-fetch
    // exactly the blob it needs.
    store.evictBlobs(0);
    const fetchesBefore = remote.log.fetches.length;
    await expect(reader.readPaths(["tasks/two.md"])).resolves.toEqual(["# two\n"]);
    const hydration = remote.log.fetches[fetchesBefore]!;
    expect(hydration.wants).toHaveLength(1);
  });

  test("a 700KB blob round-trips through chunked rows", async () => {
    const { remote } = await seededRemote();
    const { reader } = subject(remote);
    await reader.syncToHead();
    const [big] = await reader.readPathBytes(["big.bin"]);
    expect(big?.length).toBe(700 * 1024);
  });
});

describe("lazy commits", () => {
  test("commit builds locally, pushes CAS, and primes read-your-write", async () => {
    const { remote } = await seededRemote();
    const { reader } = subject(remote);
    await reader.syncToHead();

    const fetchesBefore = remote.log.fetches.length;
    const committed = await reader.commitFiles({
      author: { date: new Date(1767323045000), email: "probe@iterate.com", name: "probe" },
      changes: [
        { content: "# one edited\n", path: "tasks/one.md" },
        { content: "# fresh\n", path: "deep/new/tasks/fresh.md" },
        { delete: true, path: "sub/tasks/three.md" },
      ],
      message: "board commit",
    });
    expect(committed.noChanges).toBe(false);
    expect(remote.refs.get("refs/heads/main")).toBe(committed.commitOid);
    // Read-your-write costs zero fetches.
    await expect(
      reader.readPaths(["tasks/one.md", "deep/new/tasks/fresh.md", "sub/tasks/three.md"]),
    ).resolves.toEqual(["# one edited\n", "# fresh\n", null]);
    expect(remote.log.fetches.length).toBe(fetchesBefore);
    // Empty directories were pruned: sub/ vanished with its last file.
    expect(reader.listPaths()).not.toContain("sub/tasks/three.md");

    // A FRESH reader syncing from the remote converges on identical state.
    const fresh = subject(remote);
    await fresh.reader.syncToHead();
    await expect(fresh.reader.readPaths(["deep/new/tasks/fresh.md"])).resolves.toEqual([
      "# fresh\n",
    ]);
    expect(fresh.reader.listPaths()).toEqual(reader.listPaths());
  });

  test("preserves executable modes and reports no-op commits", async () => {
    const { remote } = await seededRemote();
    const { reader } = subject(remote);
    await reader.syncToHead();
    const same = await reader.commitFiles({
      author: { date: new Date(1767323045000), email: "probe@iterate.com", name: "probe" },
      changes: [{ content: "#!/bin/sh\n", path: "tool" }],
      message: "no-op",
    });
    expect(same.noChanges).toBe(true);

    await reader.commitFiles({
      author: { date: new Date(1767323045000), email: "probe@iterate.com", name: "probe" },
      changes: [{ content: "#!/bin/sh\necho v2\n", path: "tool" }],
      message: "tool v2",
    });
    const fresh = subject(remote);
    await fresh.reader.syncToHead();
    const head = remote.refs.get("refs/heads/main")!;
    const root = parseCommit(remote.objects.get(head)!.payload).tree;
    const toolEntry = parseTree(remote.objects.get(root)!.payload).find(
      (entry) => entry.name === "tool",
    );
    expect(toolEntry?.mode).toBe("100755");
  });

  test("a stale head surfaces as LazyRepoConflict", async () => {
    const { remote } = await seededRemote();
    const first = subject(remote);
    const second = subject(remote);
    await first.reader.syncToHead();
    await second.reader.syncToHead();
    await first.reader.commitFiles({
      author: { date: new Date(1767323045000), email: "a@iterate.com", name: "a" },
      changes: [{ content: "# a\n", path: "tasks/one.md" }],
      message: "a wins",
    });
    await expect(
      second.reader.commitFiles({
        author: { date: new Date(1767323045000), email: "b@iterate.com", name: "b" },
        changes: [{ content: "# b\n", path: "tasks/one.md" }],
        message: "b loses",
      }),
    ).rejects.toThrow(LazyRepoConflict);
    // After re-syncing, the loser can commit on the new head — and the
    // result's parent is the WINNER's commit, not the stale pre-conflict head
    // (the caller's push metadata and tree-patch preconditions hang off it).
    await second.reader.syncToHead();
    const winnerHead = remote.refs.get("refs/heads/main")!;
    const retried = await second.reader.commitFiles({
      author: { date: new Date(1767323045000), email: "b@iterate.com", name: "b" },
      changes: [{ content: "# b\n", path: "tasks/one.md" }],
      message: "b retries",
    });
    expect(remote.refs.get("refs/heads/main")).toBe(retried.commitOid);
    expect(retried.parentCommitOid).toBe(winnerHead);
  });

  test("commit results carry the parent they were built on", async () => {
    const { head, remote } = await seededRemote();
    const { reader } = subject(remote);
    await reader.syncToHead();
    const committed = await reader.commitFiles({
      author: { date: new Date(1767323045000), email: "probe@iterate.com", name: "probe" },
      changes: [{ content: "# parent check\n", path: "tasks/one.md" }],
      message: "parent check",
    });
    expect(committed.parentCommitOid).toBe(head);
  });
});

describe("sync serialization", () => {
  test("concurrent syncs with different targets both apply, in order", async () => {
    const { head, remote } = await seededRemote();
    const { reader, store } = subject(remote);

    // Prepare the v2 commit up front so both syncs can start back-to-back in
    // the same tick — a REAL race on the single-flight machinery.
    const v2Blob = await remote.putBlob("# racing v2\n");
    const oldRoot = parseCommit(remote.objects.get(head)!.payload).tree;
    const rootEntries = parseTree(remote.objects.get(oldRoot)!.payload);
    const tasksOid = rootEntries.find((entry) => entry.name === "tasks")!.oid;
    const tasksEntries = parseTree(remote.objects.get(tasksOid)!.payload).map((entry) =>
      entry.name === "one.md" ? { ...entry, oid: v2Blob } : entry,
    );
    const newTasks = await remote.putTree(tasksEntries);
    const newRoot = await remote.putTree(
      rootEntries.map((entry) => (entry.name === "tasks" ? { ...entry, oid: newTasks } : entry)),
    );
    const v2Head = await remote.putCommit(newRoot, [head], "v2\n");

    const first = reader.syncToHead(); // ls-refs: still the seeded head
    const second = reader.syncToHead(v2Head); // explicit later target

    const [a, b] = await Promise.all([first, second]);
    remote.refs.set("refs/heads/main", v2Head);
    // Each caller got the head IT asked for; the store finished at the later
    // target — never a label from one sync over content from another.
    expect(a.commitOid).toBe(head);
    expect(b.commitOid).toBe(v2Head);
    expect(store.head("main")?.commitOid).toBe(v2Head);
    await expect(reader.readPaths(["tasks/one.md"])).resolves.toEqual(["# racing v2\n"]);
  });
});
