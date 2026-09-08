// repos.e2e.test.ts — `itx.repos` against REAL Cloudflare Artifacts on the DEPLOYED worker: the whole
// git-over-HTTPS round-trip (write a commit, read the blob back) through @v3/shared/git-wire, proving
// the layer that will hold the config worker's source. DEPLOYED-TARGET ONLY (Artifacts has no local
// impl); run with `WORKER_BASE_URL=https://project-worker.iterate.workers.dev pnpm e2e repos`.

import { expect, test } from "vitest";
import { freshCtx, openItx } from "./support/client.ts";

const LOCAL_TARGET = /^https?:\/\/(127\.0\.0\.1|localhost)\b/.test(
  process.env.WORKER_BASE_URL ?? "",
);
const rnd = (): string => Math.random().toString(36).slice(2, 8);

test.skipIf(LOCAL_TARGET)(
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
