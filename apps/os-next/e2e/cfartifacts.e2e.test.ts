// cfartifacts.e2e.test.ts — `itx.cfArtifacts` against the REAL Cloudflare Artifacts binding on the
// DEPLOYED worker (env.ARTIFACTS → the `project-worker-repos` namespace): what the unit test over a
// fake (src/context/repos.test.ts) cannot prove — the binding is wired, the git wire reaches it and
// the project scoping holds end to end across /api. DEPLOYED-TARGET ONLY: Artifacts has no local
// implementation, so every row skips against a local worker (plain `pnpm e2e`) — run them with
// `WORKER_BASE_URL=https://os.iterate2.com pnpm e2e cfartifacts`. A repo is addressed by its context
// PATH (`/e2e/<suffix>`, unique per run; the Artifacts repo NAME behind it is src/context/repos.ts's
// own detail); every repo created here is deleted in a `finally`, so prd is never littered. Pins:
//   • create (idempotent: created true, then false) / get(path).createToken (an RpcTarget's method,
//     pipelined server-side in ONE expression) / list / delete: `list` answers in PATHS and returns
//     ONE namespace-wide page + a cursor (the binding does not filter by project), so membership is
//     asserted over ALL pages, never page one alone
//   • isolation: one project never sees another's repos
//   • `commitFiles → snapshot → log` round-trips files through real git-over-HTTPS (context/repos.ts's
//     git wire): an absent repo and an unborn `main` both snapshot as null (no throw across the tree
//     walk), the first commit lands on main parentless, a second lands onto the tip's tree, a commit
//     that changes nothing commits nothing

import { expect } from "vitest";
import { freshCtx, openItx } from "./support/client.ts";
import { deployedOnly } from "./support/project-host.ts";

/** A repo path unique to this run — one segment under `/e2e`, inside Artifacts' name grammar
 *  (`[a-zA-Z0-9._-]+`, never `--`). */
const freshRepoPath = (prefix: string): string =>
  `/e2e/${prefix}-${Math.random().toString(36).slice(2, 8)}`;

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

deployedOnly(
  "cfArtifacts create/get/list/delete against the real binding, by path, project-scoped",
  async () => {
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
    } finally {
      expect(await a.cfArtifacts.delete(path)).toBe(true);
    }

    // after delete, the repo is gone from this project's list (checked across all pages).
    expect(await allRepoPaths(a)).not.toContain(path);
  },
);

deployedOnly("cfArtifacts isolation: one project never sees another's repos", async () => {
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

// ── the git half: commitFiles → snapshot → log through real git-over-HTTPS ──

deployedOnly(
  "cfArtifacts commitFiles → snapshot → log round-trips files through real git-over-HTTPS",
  async () => {
    const itx = openItx(freshCtx("cfagit"));
    const path = freshRepoPath("cfg");
    const source = `export default { note: "from a real Artifacts repo ${path}" };\n`;

    try {
      // No such repo: snapshot and tip answer null (no throw across the whole tree walk).
      expect(await itx.cfArtifacts.snapshot(path)).toBeNull();
      expect(await itx.cfArtifacts.tip(path)).toBeNull();

      // Created, main unborn: still null.
      expect(await itx.cfArtifacts.create(path)).toEqual({ created: true });
      expect(await itx.cfArtifacts.snapshot(path)).toBeNull();
      expect(await itx.cfArtifacts.tip(path)).toBeNull();

      // The first commit lands worker.ts on main (parentless first commit).
      const first = await itx.cfArtifacts.commitFiles(path, {
        message: "first",
        changes: [{ path: "worker.ts", content: source }],
      });
      expect(first).toEqual({
        commitOid: expect.stringMatching(/^[0-9a-f]{40}$/),
        changedPaths: ["worker.ts"],
      });
      expect(await itx.cfArtifacts.tip(path)).toBe(first.commitOid);

      // Read it back — tip commit → tree → the blob's bytes, verbatim.
      expect(await itx.cfArtifacts.snapshot(path)).toEqual({
        commitOid: first.commitOid,
        files: { "worker.ts": source },
      });

      // A second commit updates the same path (onto the tip's tree, parent = the first commit).
      const source2 = `${source}// v2\n`;
      const second = await itx.cfArtifacts.commitFiles(path, {
        message: "second",
        changes: [{ path: "worker.ts", content: source2 }],
      });
      expect(second.commitOid).not.toBe(first.commitOid);
      expect((await itx.cfArtifacts.snapshot(path))?.files).toEqual({ "worker.ts": source2 });

      // Changes that leave the tree as it is commit nothing: the tip stays the second commit.
      expect(
        await itx.cfArtifacts.commitFiles(path, {
          message: "noop",
          changes: [{ path: "worker.ts", content: source2 }],
        }),
      ).toEqual({ commitOid: second.commitOid, changedPaths: [] });

      expect(
        (await itx.cfArtifacts.log(path)).map((c: { oid: string; parents: string[] }) => [
          c.oid,
          c.parents,
        ]),
      ).toEqual([
        [second.commitOid, [first.commitOid]],
        [first.commitOid, []],
      ]);
    } finally {
      await itx.cfArtifacts.delete(path); // teardown — the repo, by its path
    }
  },
);
