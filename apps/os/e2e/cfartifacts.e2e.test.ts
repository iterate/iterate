// cfartifacts.e2e.test.ts — `itx.cfArtifacts`, THE BINDING PROXY, against the REAL Cloudflare
// Artifacts binding on the DEPLOYED worker (env.ARTIFACTS → the `project-worker-repos` namespace),
// and the repo facet's git wire (src/repo/git-wire.ts) against the real remote that proxy names: what
// the unit tests over fakes (src/context/cf-artifacts.test.ts, src/repo/git-wire.test.ts) and the local
// e2e run's fake remote (support/fake-git-server.ts) cannot prove — the binding is wired, the remote URL
// and the token the proxy hands out open the real git-over-HTTPS endpoint, and the project scoping
// holds end to end across /api. DEPLOYED-TARGET ONLY: every row skips against a local worker (plain
// `pnpm e2e`) — run them with `WORKER_BASE_URL=https://os.iterate.com pnpm e2e cfartifacts`. A repo is
// addressed by its context PATH (`/e2e/<suffix>`, unique per run; the Artifacts NAME behind it is
// src/context/cf-artifacts.ts's own detail — the remote URL ends with it); every repo created here is
// deleted in a `finally`, so prd is never littered. Pins:
//   • the proxy: create (idempotent: created true, then false) / get(path).createToken and
//     get(path).remote() (an RpcTarget's methods, pipelined server-side in ONE expression) / list /
//     delete: `list` answers in PATHS and returns ONE namespace-wide page + a cursor (the binding does
//     not filter by project), so membership is asserted over ALL pages, never page one alone
//   • isolation: one project never sees another's repos
//   • THE GIT ROUND TRIP through the facet (`itx.repos.get(path)`) against the real remote: born
//     through the collection (`itx.repos.create(path)`, whose processor saga provisions the Artifacts
//     repo), an unborn `main` reads as no file, the first commit lands parentless, a second lands a
//     write and a delete onto the tip's tree, a commit that changes nothing commits nothing, `log` is
//     newest-first with parents

import { expect, test } from "vitest";
import { repoArtifactName } from "../src/context/cf-artifacts.ts";
import type { RepoLogEntry } from "../src/repo/git-wire.ts";
import { freshCtx, openItx, runId, workerSlot } from "./support/client.ts";

/** A repo path unique to this run — one segment under `/e2e`, inside Artifacts' name grammar
 *  (`[a-zA-Z0-9._-]+`, never `--`). */
let repoCounter = 0;
const freshRepoPath = (prefix: string): string =>
  // Per run and per worker process (client.ts), never random: a collision would delete a sibling's repo.
  `/e2e/${prefix}-${runId()}-${workerSlot()}-${repoCounter++}`;

/** Every repo path this project can see, following the namespace-wide cursor to exhaustion — the
 *  binding pages, and `cfArtifacts.list` filters one page locally, so a project's repos can straddle
 *  pages (or a page can hold none of them yet still precede one that does). */
async function allRepoPaths(itx: ReturnType<typeof openItx>): Promise<string[]> {
  const paths: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await itx.cfArtifacts.list(cursor ? { cursor } : undefined);
    paths.push(...page.repos.map((r: { path: string }) => r.path));
    cursor = page.cursor;
  } while (cursor);
  return paths;
}

test("cfArtifacts create/get/list/delete against the real binding, by path, project-scoped", async () => {
  const a = openItx(freshCtx("cfa"));
  const path = freshRepoPath("smoke");

  // create → a real repo, main unborn; idempotent — the second create finds it.
  expect(await a.cfArtifacts.create(path)).toEqual({ created: true });
  try {
    expect(await a.cfArtifacts.create(path)).toEqual({ created: false });

    // list (all pages) → THIS project's repos, as paths.
    expect(await allRepoPaths(a)).toContain(path);

    // get(path).createToken(...) pipelined server-side → a real git credential; no closure on the wire.
    const tok = await a.cfArtifacts.get(path).createToken("read", 300);
    expect(typeof tok.plaintext).toBe("string");
    expect(tok.plaintext.length).toBeGreaterThan(0);

    // get(path).remote() → the git-over-HTTPS URL of THAT repo: the account's Artifacts host, the
    // namespace, and `<project>.<name>.git` — the name the proxy derives from the path.
    const remote = await a.cfArtifacts.get(path).remote();
    expect(remote).toMatch(/^https:\/\/[^/]+\.artifacts\.cloudflare\.net\/git\/[^/]+\/.+\.git$/);
    expect(remote.endsWith(`.${repoArtifactName(path)}.git`)).toBe(true);
  } finally {
    expect(await a.cfArtifacts.delete(path)).toBe(true);
  }

  // after delete, the repo is gone from this project's list (checked across all pages).
  expect(await allRepoPaths(a)).not.toContain(path);
});

test("cfArtifacts isolation: one project never sees another's repos", async () => {
  const a = openItx(freshCtx("cfaIsoA"));
  const b = openItx(freshCtx("cfaIsoB"));
  const path = freshRepoPath("iso");

  await a.cfArtifacts.create(path);
  try {
    // b lists its OWN repos (all pages) — a's repo lives under a's project and is filtered out.
    expect(await allRepoPaths(b)).not.toContain(path);
  } finally {
    await a.cfArtifacts.delete(path);
  }
});

// ── the git half: the repo facet against the real remote, through real git-over-HTTPS ──

test("the repo facet round-trips files through the real remote: create, an unborn main, a write, a read, a write + a delete, a no-op, the log", async () => {
  const itx = openItx(freshCtx("cfagit"));
  const path = freshRepoPath("cfg");
  const repo = itx.repos.get(path);
  const source = `export default { note: "from a real Artifacts repo ${path}" };\n`;

  try {
    // Created (the Artifacts repo provisioned through the proxy by the repo processor's saga), main
    // unborn: no tip, no file.
    expect(await itx.repos.create(path)).toEqual({ path });
    expect(await repo.tip()).toBeNull();
    expect(await repo.readFile("worker.ts")).toBeNull();
    expect(await repo.listFiles()).toEqual({ commitOid: null, paths: [] });

    // The first commit lands worker.ts on main (parentless), pushed to the real remote.
    const first = await repo.writeFile("worker.ts", source);
    expect(first).toEqual({
      commitOid: expect.stringMatching(/^[0-9a-f]{40}$/),
      changedPaths: ["worker.ts"],
    });
    expect(await repo.tip()).toBe(first.commitOid);

    // Read it back — ls-refs, the tip's shallow fetch, commit → tree → the blob's bytes, verbatim.
    expect(await repo.readFile("worker.ts")).toBe(source);
    expect(await repo.listFiles()).toEqual({ commitOid: first.commitOid, paths: ["worker.ts"] });

    // A second commit onto the tip's tree (parent = the first): a nested write and a delete.
    const second = await repo.commitFiles({
      message: "second",
      changes: [
        { path: "notes/log.md", content: "# log\n" },
        { path: "worker.ts", delete: true },
      ],
    });
    expect(second.commitOid).toMatch(/^[0-9a-f]{40}$/);
    expect(second.commitOid).not.toBe(first.commitOid);
    expect(second.changedPaths).toEqual(["worker.ts", "notes/log.md"]); // deletes land first
    expect(await repo.readFile("worker.ts")).toBeNull();
    expect(await repo.readFile("notes/log.md")).toBe("# log\n");
    expect(await repo.listFiles()).toEqual({
      commitOid: second.commitOid,
      paths: ["notes/log.md"],
    });

    // Changes that leave the tree as it is commit nothing: the tip stays the second commit.
    expect(
      await repo.commitFiles({
        message: "noop",
        changes: [{ path: "notes/log.md", content: "# log\n" }],
      }),
    ).toEqual({ commitOid: second.commitOid, changedPaths: [] });

    // The log, newest first, each commit with its parents — a shallow fetch that deep.
    expect((await repo.log()).map((c: RepoLogEntry) => [c.oid, c.parents, c.message])).toEqual([
      [second.commitOid, [first.commitOid], "second"],
      [first.commitOid, [], "write worker.ts"],
    ]);
  } finally {
    await itx.cfArtifacts.delete(path); // teardown — the repo, by its path
  }
}, 120_000);
