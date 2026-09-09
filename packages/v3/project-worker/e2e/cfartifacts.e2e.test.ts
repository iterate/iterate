// cfartifacts.e2e.test.ts — `itx.cfArtifacts` and `itx.repos` against the REAL Cloudflare Artifacts
// binding on the DEPLOYED worker (env.ARTIFACTS → the `project-worker-repos` namespace): what the unit
// test over a fake (src/context/repos.test.ts) cannot prove — the binding is wired and the
// project scoping holds end to end across /api. DEPLOYED-TARGET ONLY: Artifacts has no local
// implementation, so every row skips against a local worker (plain `pnpm e2e`) — run them with
// `WORKER_BASE_URL=https://project-worker.iterate.workers.dev pnpm e2e cfartifacts`. Every repo created
// here is deleted in a `finally` (the project-teardown path; repos and cfArtifacts address the same
// repo). Pins:
//   • create / get(repo).createToken (an RpcTarget's method, pipelined server-side in ONE expression) /
//     list / delete: the repo is stored as `<projectId>.<repo>` and listed by its bare name; `list`
//     returns ONE namespace-wide page + a cursor (the binding does not filter by name), so membership
//     is asserted over ALL pages, never page one alone
//   • isolation: one project never sees another's repos
//   • `itx.repos.writeFile → readFile` round-trips a file through real git-over-HTTPS (context/repos.ts's git wire):
//     an absent repo or path reads null (no throw across the tree walk), the first write CREATES the repo
//     and commits on main (parentless), a second write commits onto the tip's tree

import { expect } from "vitest";
import { freshCtx, openItx } from "./support/client.ts";
import { deployedOnly } from "./support/project-host.ts";

const rnd = (): string => Math.random().toString(36).slice(2, 8);

/** Every repo name this project can see, following the namespace-wide cursor to exhaustion — the
 *  binding pages, and `cfArtifacts.list` filters one page locally, so a project's repos can straddle
 *  pages (or a page can hold none of them yet still precede one that does). */
async function allRepoNames(itx: ReturnType<typeof openItx>): Promise<string[]> {
  const names: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await itx.cfArtifacts.list(cursor === undefined ? undefined : { cursor });
    names.push(...page.repos.map((r: { name: string }) => r.name));
    cursor = page.cursor;
  } while (cursor !== undefined);
  return names;
}

deployedOnly(
  "cfArtifacts create/get/list/delete against the real binding, project-scoped",
  async () => {
    const a = openItx(freshCtx("cfa"));
    const repo = `smoke-${rnd()}`;

    // create → a real repo (stored as `<projectId>.<repo>` in the namespace); returns a git token.
    const created = await a.cfArtifacts.create(repo);
    expect(typeof created.token).toBe("string");
    expect(created.token.length).toBeGreaterThan(0);

    try {
      // list (all pages) → THIS project's repos, prefix stripped: our repo shows by its bare name.
      expect(await allRepoNames(a)).toContain(repo);

      // get(repo).createToken(...) pipelined server-side → a real git credential; no closure on the wire.
      const tok = await a.cfArtifacts.get(repo).createToken("read", 300);
      expect(typeof tok.plaintext).toBe("string");
      expect(tok.plaintext.length).toBeGreaterThan(0);
    } finally {
      expect(await a.cfArtifacts.delete(repo)).toBe(true);
    }

    // after delete, the repo is gone from this project's list (checked across all pages).
    expect(await allRepoNames(a)).not.toContain(repo);
  },
);

deployedOnly("cfArtifacts isolation: one project never sees another's repos", async () => {
  const a = openItx(freshCtx("cfaIsoA"));
  const b = openItx(freshCtx("cfaIsoB"));
  const repo = `iso-${rnd()}`;

  await a.cfArtifacts.create(repo);
  try {
    // b lists its OWN repos (all pages) — a's repo lives under a's prefix and is filtered out.
    expect(await allRepoNames(b)).not.toContain(repo);
  } finally {
    await a.cfArtifacts.delete(repo);
  }
});

// ── `itx.repos`: the git-over-HTTPS layer that holds a config worker's source ──

deployedOnly(
  "itx.repos writeFile → readFile round-trips a file through real git-over-HTTPS",
  async () => {
    const itx = openItx(freshCtx("repos"));
    const repo = `cfg-${rnd()}`;
    const source = `export default { note: "from a real Artifacts repo ${rnd()}" };\n`;

    try {
      // An unborn/absent repo reads as null (no throw across the whole tree walk).
      expect(await itx.repos.readFile(repo, "worker.ts")).toBeNull();

      // First write CREATES the repo and commits worker.ts on main (parentless first commit).
      const first = await itx.repos.writeFile(repo, "worker.ts", source);
      expect(first.commitOid).toMatch(/^[0-9a-f]{40}$/);

      // Read it back — tip commit → tree → the blob's bytes, verbatim.
      expect(await itx.repos.readFile(repo, "worker.ts")).toBe(source);

      // A second write updates the same path (merge onto the tip's tree, parent = the first commit).
      const source2 = `${source}// v2\n`;
      const second = await itx.repos.writeFile(repo, "worker.ts", source2);
      expect(second.commitOid).not.toBe(first.commitOid);
      expect(await itx.repos.readFile(repo, "worker.ts")).toBe(source2);

      // A path that was never written is absent (null), even though the repo has a commit.
      expect(await itx.repos.readFile(repo, "missing.ts")).toBeNull();
    } finally {
      await itx.cfArtifacts.delete(repo); // teardown — repos and cfArtifacts address the same repo
    }
  },
);
