/**
 * Live probe of the WHOLE lazy stack (wire + store + reader) against a real
 * Artifacts repo — sized like production. Run it against a scratch FORK of a
 * big repo; it commits to the fork's main.
 *
 *   ARTIFACTS_REMOTE=… ARTIFACTS_TOKEN=… pnpm exec tsx scripts/probe-lazy-reader-live.ts
 *
 * Reports: cold sync (one-time ingest), warm no-op sync, scoped reads,
 * clone-free commit, post-commit read-your-write, and the incremental resync
 * a SECOND store pays after that commit (the "other reader after a push"
 * case — the one that used to cost a full re-clone).
 */
import { createRequire } from "node:module";
import { createGitWireTransport } from "../src/domains/repos/git-wire.ts";
import { createLazyRepoReader } from "../src/domains/repos/lazy-repo-reader.ts";
import { sqliteGitObjectStore } from "../src/domains/repos/repo-object-store.ts";

const remote = process.env.ARTIFACTS_REMOTE;
const token = process.env.ARTIFACTS_TOKEN;
if (!remote || !token) throw new Error("set ARTIFACTS_REMOTE and ARTIFACTS_TOKEN");

const sqlite = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => {
    prepare(query: string): {
      all(...bindings: unknown[]): Record<string, unknown>[];
      run(...bindings: unknown[]): unknown;
    };
  };
};

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

const wire = createGitWireTransport({ remote, token });
const timed = async <T>(label: string, work: () => Promise<T>): Promise<T> => {
  const start = Date.now();
  const result = await work();
  console.log(`${label}: ${Date.now() - start}ms`);
  return result;
};

// -- reader A: the cold ingest + reads + a commit -------------------------------
const storeA = sqliteGitObjectStore(nodeStorage());
const readerA = createLazyRepoReader({ branch: "main", store: storeA, wire });

const head = await timed("cold sync (one-time full ingest)", () => readerA.syncToHead());
const paths = readerA.listPaths();
const taskFiles = paths.filter((path) => /(^|\/)tasks\/[^/]+\.md$/.test(path));
console.log(
  `manifest: ${paths.length} files, ${taskFiles.length} task files, head ${head.commitOid.slice(0, 8)}`,
);

await timed("warm no-op sync", () => readerA.syncToHead());
const contents = await timed(`scoped read of ${taskFiles.length} task files`, () =>
  readerA.readPaths(taskFiles),
);
const bytes = contents.reduce((total, content) => total + (content?.length ?? 0), 0);
console.log(`  → ${bytes} chars`);

const committed = await timed("clone-free commit (1 file)", () =>
  readerA.commitFiles({
    author: { date: new Date(), email: "probe@iterate.com", name: "lazy-probe" },
    changes: [
      {
        content: `# lazy reader probe\n${new Date().toISOString()}\n`,
        path: "tasks/lazy-probe.md",
      },
    ],
    message: "lazy reader live probe",
  }),
);
console.log(`  → commit ${committed.commitOid.slice(0, 8)} noChanges=${committed.noChanges}`);
await timed("post-commit read-your-write (must be ~0 network)", async () => {
  const [content] = await readerA.readPaths(["tasks/lazy-probe.md"]);
  if (!content?.includes("lazy reader probe")) throw new Error("read-your-write failed");
});

// -- reader B: a second store that synced BEFORE the commit ---------------------
// This is every OTHER repo-DO-equivalent after someone pushes: the resync must
// transfer only the delta, not the snapshot.
const storeB = sqliteGitObjectStore(nodeStorage());
const readerB = createLazyRepoReader({ branch: "main", store: storeB, wire });
console.log("\npriming reader B at the PRE-commit head is impossible now — it syncs to the");
console.log(
  "post-commit head cold (same one-time cost), then we push again and measure its delta:",
);
await timed("reader B cold sync", () => readerB.syncToHead());

const secondCommit = await readerA.commitFiles({
  author: { date: new Date(), email: "probe@iterate.com", name: "lazy-probe" },
  changes: [{ content: `# probe v2\n${new Date().toISOString()}\n`, path: "tasks/lazy-probe.md" }],
  message: "lazy reader live probe v2",
});
console.log(`second commit ${secondCommit.commitOid.slice(0, 8)} pushed by reader A`);
await timed("reader B INCREMENTAL resync after that push", () => readerB.syncToHead());
const [seen] = await readerB.readPaths(["tasks/lazy-probe.md"]);
if (!seen?.includes("probe v2")) throw new Error("reader B did not converge on the pushed content");
console.log("reader B converged on reader A's push");

console.log("\nlazy reader live probe: ALL GREEN");
