// cfartifacts.e2e.test.ts — `itx.cfArtifacts` against the REAL Cloudflare Artifacts binding on the
// DEPLOYED worker (env.ARTIFACTS → the `project-worker-repos` namespace). Proves the two things the
// unit test (src/context/built-ins-artifacts.test.ts) can only prove over a fake: the binding is
// actually wired, and the project-scoping (prefix + local list filter) holds end-to-end across /api.
//
// DEPLOYED-TARGET ONLY: Artifacts has no local implementation, so these tests skip when the target is
// a local worker (plain `pnpm e2e`) — otherwise they'd reach real Cloudflare from a local run. Run
// them with `WORKER_BASE_URL=https://project-worker.iterate.workers.dev pnpm e2e cfartifacts`.
//
// NOTE the get→createToken CHAIN: `get` returns an RpcTarget whose `createToken` is pipelined
// server-side in ONE expression. And `list` returns ONE namespace-wide page + a cursor (the binding
// does not filter by name), so membership is asserted over ALL pages (`allRepoNames`), never page one
// alone. Every repo created here is deleted in a `finally` (the project-teardown path).

import { expect, test } from "vitest";
import { freshCtx, openItx } from "./support/client.ts";

const LOCAL_TARGET = /^https?:\/\/(127\.0\.0\.1|localhost)\b/.test(
  process.env.WORKER_BASE_URL ?? "",
);
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

test.skipIf(LOCAL_TARGET)(
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

test.skipIf(LOCAL_TARGET)(
  "cfArtifacts isolation: one project never sees another's repos",
  async () => {
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
  },
);
