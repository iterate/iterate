/**
 * Live probe of git-wire.ts against a REAL Artifacts repo — the module's
 * whole surface end to end: ls-refs, closure fetch, the dir-tree-haves sync
 * recipe, exact-blob hydration, and a receive-pack push (create + CAS-reject
 * + delete on a scratch branch; main is never touched).
 *
 *   ARTIFACTS_REMOTE=https://<acct>.artifacts.cloudflare.net/git/<ns>/<repo>.git \
 *   ARTIFACTS_TOKEN=<repo token> pnpm exec tsx scripts/probe-git-wire-live.ts
 */
import {
  buildPack,
  createGitWireTransport,
  encodeCommit,
  encodeTree,
  hashObject,
  parseCommit,
  parseTree,
  type RawGitObject,
} from "../src/domains/repos/git-wire.ts";

const remote = process.env.ARTIFACTS_REMOTE;
const token = process.env.ARTIFACTS_TOKEN;
if (!remote || !token) throw new Error("set ARTIFACTS_REMOTE and ARTIFACTS_TOKEN");
const wire = createGitWireTransport({ remote, token });
const text = new TextEncoder();
const ZERO = "0".repeat(40);
const ok = (label: string) => console.log(`ok: ${label}`);

// 1. Resolve main.
const refs = await wire.lsRefs(["refs/heads/"]);
const main = refs.find((ref) => ref.name === "refs/heads/main");
if (!main) throw new Error(`no refs/heads/main in ${refs.map((r) => r.name).join(", ")}`);
ok(`ls-refs: main = ${main.oid}`);

// 2. Snapshot fetch (closure at head, depth 1).
const snapshot = await wire.fetchObjects({ deepen: 1, wants: [main.oid] });
const byOid = new Map(snapshot.map((object) => [object.oid, object]));
const head = byOid.get(main.oid);
if (head?.type !== "commit") throw new Error("head commit missing from snapshot pack");
const rootTreeOid = parseCommit(head.payload).tree;
const trees = snapshot.filter((object) => object.type === "tree");
ok(`snapshot: ${snapshot.length} objects (${trees.length} trees), root tree ${rootTreeOid}`);

// 3. Build a one-file change entirely locally: new blob under tasks/.
const findTree = (oid: string) => {
  const object = byOid.get(oid);
  if (object?.type !== "tree") throw new Error(`tree ${oid} missing`);
  return parseTree(object.payload);
};
const rootEntries = findTree(rootTreeOid);
const tasksEntry = rootEntries.find((entry) => entry.name === "tasks" && entry.mode === "40000");
if (!tasksEntry) throw new Error("scratch repo has no tasks/ directory");
const newBlobPayload = text.encode(`# live wire probe ${process.pid}\n`);
const newBlobOid = await hashObject("blob", newBlobPayload);
const tasksEntries = findTree(tasksEntry.oid)
  .filter((entry) => entry.name !== "wire-probe.md")
  .concat([{ mode: "100644", name: "wire-probe.md", oid: newBlobOid }]);
const newTasksTree = encodeTree(tasksEntries);
const newTasksOid = await hashObject("tree", newTasksTree);
const newRootTree = encodeTree(
  rootEntries.map((entry) => (entry.name === "tasks" ? { ...entry, oid: newTasksOid } : entry)),
);
const newRootOid = await hashObject("tree", newRootTree);
const newCommit = encodeCommit({
  author: { date: new Date(), email: "wire@iterate.com", name: "wire-probe" },
  message: "wire probe commit\n",
  parents: [main.oid],
  tree: newRootOid,
});
const newCommitOid = await hashObject("commit", newCommit);
const pack = await buildPack([
  { payload: newBlobPayload, type: "blob" },
  { payload: newTasksTree, type: "tree" },
  { payload: newRootTree, type: "tree" },
  { payload: newCommit, type: "commit" },
]);
ok(`built commit ${newCommitOid} locally (pack ${pack.length}B, no clone anywhere)`);

// 4. Push it to a scratch branch (create), verify, CAS-reject, then delete.
// gitty ignores ref-prefix filters (probed: it returns every ref regardless),
// so resolve refs by NAME from the full listing.
const branch = "refs/heads/wire-probe";
const findRef = async (name: string) =>
  (await wire.lsRefs([name])).find((entry) => entry.name === name);
const leftover = await findRef(branch);
if (leftover) {
  const cleaned = await wire.push({
    newOid: ZERO,
    oldOid: leftover.oid,
    pack: await buildPack([]),
    ref: branch,
  });
  if (cleaned.kind !== "applied") {
    throw new Error(`stale scratch branch cleanup failed: ${JSON.stringify(cleaned)}`);
  }
  ok("cleaned up a scratch branch left by a prior run");
}
const created = await wire.push({ newOid: newCommitOid, oldOid: ZERO, pack, ref: branch });
if (created.kind !== "applied") throw new Error(`create push: ${JSON.stringify(created)}`);
if ((await findRef(branch))?.oid !== newCommitOid) {
  throw new Error("branch did not land at the new commit");
}
ok("receive-pack: scratch branch created at the locally built commit");

const casReject = await wire.push({
  newOid: main.oid,
  oldOid: ZERO, // wrong: the branch exists now, so this old-oid must be rejected
  pack: await buildPack([]),
  ref: branch,
});
if (casReject.kind !== "rejected") {
  throw new Error(
    `stale old-oid push was NOT rejected — CAS is broken: ${JSON.stringify(casReject)}`,
  );
}
ok(`receive-pack: stale old-oid rejected (${casReject.detail})`);

// 5. The sync recipe: want new head, have every old directory tree.
const oldDirTrees = trees.map((tree) => tree.oid);
const delta = await wire.fetchObjects({ deepen: 1, haves: oldDirTrees, wants: [newCommitOid] });
const kinds = delta.reduce<Record<string, number>>((acc, object: RawGitObject) => {
  acc[object.type] = (acc[object.type] ?? 0) + 1;
  return acc;
}, {});
const unchangedRefetched = delta.some((object) => byOid.has(object.oid) && object.type === "blob");
ok(
  `sync recipe: ${delta.length} objects ${JSON.stringify(kinds)} — unchanged blobs refetched: ${unchangedRefetched}`,
);
if (!delta.some((object) => object.oid === newBlobOid)) {
  throw new Error("sync fetch is missing the new blob");
}

// 6. Exact blob hydration.
const hydrated = await wire.fetchObjects({ wants: [newBlobOid] });
if (hydrated.length !== 1 || hydrated[0]!.oid !== newBlobOid) {
  throw new Error(`hydration fetched ${hydrated.length} objects`);
}
ok(`hydration: exact blob fetch returned ${hydrated[0]!.payload.length}B payload`);

// 7. Clean up the scratch branch.
const deleted = await wire.push({
  newOid: ZERO,
  oldOid: newCommitOid,
  pack: await buildPack([]),
  ref: branch,
});
if (deleted.kind !== "applied") throw new Error(`branch delete: ${JSON.stringify(deleted)}`);
ok("receive-pack: scratch branch deleted — remote left as found");

console.log("git-wire live probe: ALL GREEN");
