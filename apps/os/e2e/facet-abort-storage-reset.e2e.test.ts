// e2e/facet-abort-storage-reset.e2e.test.ts — A CLOUDFLARE FAULT, MEASURED: aborting a running loaded
// facet can reset its whole context. Deployed-only and OPT-IN, because it resets the Durable Object it
// runs on:
//
//   RUN_FACET_ABORT_REPRO=1 WORKER_BASE_URL=https://<preview> pnpm e2e facet-abort-storage-reset
//
// `ctx.facets.abort(name)` on a running loaded facet whose SQLite database has had more than a few
// pages written (40 new rows of 2 KB; or 16 rows of 2 KB rewritten ~1,500 times) makes one of the
// context's next storage commits fail with "Internal error in Durable Object storage caused object to
// be reset; reference = …", and every call in flight fails with it. Measured 2026-09-24 on an
// os-preview preview, a fresh context each run:
//   • 40 rows of 2 KB, abort, then appends:                            96 of 96 runs reset the object
//   • 16 rows rewritten ~1,500 times, abort, then appends:              64 of 96
//   • 20 rows of 2 KB: 6 of 24; 16 rows or fewer, one 80 KB row, one 52 KB row written three
//     times, 40 rows of 100 B, a live agent's own facet:                0 (16 to 48 runs each)
//   • `ctx.facets.delete` of such a facet instead:                       0 of 72
//   • the facet restarted by a call right after the abort:               0 of 48
//   • the birth reset (context/residency.ts) aborting such a facet that
//     the last incarnation left running:                                29 of 48
// The platform aborts loaded facets on its own — the birth reset and the unclaimed-facet sweep
// (context/residency.ts), a loaded identity change (context/facet-host.ts `#materialize`) — so a
// context whose facet has written that much risks its next call. The row asserts the fault is STILL
// there; when it stops reproducing, Cloudflare fixed it — say so where the files that cite this one
// (apps/agents/runtime/collection.ts) rely on it.
import { expect, test } from "vitest";
import { freshCtx, openItx, sleep } from "./support/client.ts";
import { projectHostsAreLocal } from "./support/project-host.ts";

/** A loaded facet that writes `n` rows of 2 KB, one commit each — a table of many pages. */
const ROWS = {
  source: {
    "cap.js": `import { FacetDurableObject } from "./processor.js";
export class RowsDurableObject extends FacetDurableObject {
  static publicMethods = [...super.publicMethods, "write"];
  async write(n) {
    for (let i = 0; i < n; i++) {
      this.ctx.storage.kv.put("row" + i, "x".repeat(2048));
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    return n;
  }
}`,
  },
  className: "RowsDurableObject",
};

const repro = test.skipIf(projectHostsAreLocal() || process.env.RUN_FACET_ABORT_REPRO !== "1");

repro(
  "Cloudflare resets a context whose running loaded facet, holding a table of many pages, is aborted",
  async () => {
    const itx = openItx(freshCtx("facet-abort-reset"));
    expect(await itx.invoke(["itx", "facets", ["get", "rows", ROWS], ["write", 40]])).toBe(40);
    await itx.facets.abort("rows");
    // The failure lands on a LATER commit (the first append after the abort usually still lands).
    const outcome = await (async () => {
      for (let k = 0; k < 5; k++) {
        await itx.append({ type: "facet-abort-reset/probe", payload: { k } });
        await sleep(200);
      }
      return "no reset";
    })().catch((error: Error) => error.message);
    expect(outcome).toMatch(/Internal error in Durable Object storage caused object to be reset/);
  },
);
