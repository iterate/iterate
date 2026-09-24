// e2e/facet-abort-storage-reset.e2e.test.ts — A CLOUDFLARE FAULT, MEASURED, AND THE PLATFORM'S
// WORKAROUND (context/facet-host.ts FACET_START_WATCHDOG_MS). Deployed-only and OPT-IN, because the
// first row resets the Durable Object it runs on:
//
//   RUN_FACET_ABORT_REPRO=1 WORKER_BASE_URL=https://<preview> pnpm e2e facet-abort-storage-reset
//   FACET_ABORT_REPRO_RUNS=16 …   (each row that many times at once; default 1)
//
// A facet whose SQLite database took a few dozen pages of writes (40 rows of 2 KB; 16 rows rewritten
// for half a second) and then STOPS — `ctx.facets.abort(name)`, or an eviction with its context —
// makes one of the context's next storage commits fail with "Internal error in Durable Object
// storage caused object to be reset; reference = …": the whole object resets, and every call in
// flight on it fails. The facet started again before the context commits anything more avoids it.
// So the platform never stops a facet without starting it again, and a birth starts every facet
// the last incarnation ran before its first write. Each row below drives one way a facet stops,
// with a storage-heavy loaded facet, and asserts the context is not reset. Measured on os-preview
// previews, 2026-09-24, with FACET_ABORT_REPRO_RUNS=16 (runs whose context reset once the path
// began; none reset during setup), a preview of main before and of this workaround after:
//   • `itx.facets.abort` right after 40 rows of 2 KB:            63 of 64 → 0 of 64
//   • the facet evicted with its context right after them; the
//     next incarnation's calls (no platform abort at all):         64 of 64 → 0 of 64
//   • the birth reset of a facet left running, writing every 5 ms:  5 of 64 → 0 of 64
//   • the call watchdog's reset of a facet hung mid-write:          2 of 64 → 0 of 64
//   • the sweep's reset in place of a facet still writing:          1 of 63 → 0 of 63
//   • a new loaded identity right after 40 rows:                    0 of 64 → 0 of 64
//   • the raw fault, a facet aborting its own child facet:         64 of 64 → 64 of 64
// The first row asserts the fault is STILL there, with no platform code between the abort and the
// fault: a loaded facet aborts its OWN child facet. When it stops reproducing, Cloudflare fixed it —
// remove the workaround (FACET_START_WATCHDOG_MS names every piece).
import { expect, test } from "vitest";
import { adminCredentials, freshCtx, openItx, readAll, session, sleep } from "./support/client.ts";
import { projectHostsAreLocal } from "./support/project-host.ts";

/** A loaded facet that writes: `write(n)` n rows of 2 KB, one commit each — a table of many pages;
 *  `writeOn()` keeps its `env.ITX` answer (so it runs on after its context evicts) and writes a
 *  2 KB row every 5 ms; `hangWriting()` does the same inside a call that never answers; `chatter()`
 *  appends to its context every 2 s, which keeps the context resident. `childWrite`/`childAbort`
 *  write through, and abort, a facet of ITS OWN (`ctx.facets` inside the facet). */
const WRITER_SOURCE = (tag: string) => ({
  "cap.js": `import { DurableObject } from "cloudflare:workers";
import { FacetDurableObject } from "./processor.js";
const put = (storage, key, i) => storage.kv.put(key, "x".repeat(2048) + i);
const pause = () => new Promise((resolve) => setTimeout(resolve, 1));
export class ChildDurableObject extends DurableObject {
  async write(n) {
    for (let i = 0; i < n; i++) { put(this.ctx.storage, "row" + i, i); await pause(); }
    return n;
  }
}
export class WriterDurableObject extends FacetDurableObject {
  static publicMethods = [...super.publicMethods, "write", "writeOn", "hangWriting", "chatter", "childWrite", "childAbort"];
  kept = [];
  async write(n) {
    for (let i = 0; i < n; i++) { put(this.ctx.storage, "row" + i, i); await pause(); }
    return n;
  }
  #writeEvery5Ms(prefix) {
    let i = 0;
    const tick = () => { put(this.ctx.storage, prefix + (i++ % 40), i); setTimeout(tick, 5); };
    tick();
  }
  async writeOn() {
    this.kept.push(await this.env.ITX.get().whoami());
    this.#writeEvery5Ms("w");
    return true;
  }
  hangWriting() {
    this.#writeEvery5Ms("h");
    return new Promise(() => {});
  }
  chatter() {
    const tick = async () => {
      const itx = this.env.ITX.get();
      this.kept.push(itx, await itx.append({ type: "facet-abort-reset/chatter" }));
      setTimeout(tick, 2_000);
    };
    void tick();
    return "chattering";
  }
  #child() {
    return this.ctx.facets.get("child", () => ({ class: this.ctx.exports.ChildDurableObject }));
  }
  childWrite(n) { return this.#child().write(n); }
  childAbort() { this.ctx.facets.abort("child", new Error("aborted by its parent facet")); return true; }
}
// ${tag}`,
});
const writer = (tag = "v1") => ({ source: WRITER_SOURCE(tag), className: "WriterDurableObject" });
const call = (itx: any, method: string, ...args: unknown[]) =>
  itx.invoke(["itx", "facets", ["get", "writer", writer()], [method, ...args]]);

const RESET = /Internal error in Durable Object storage caused object to be reset/;
const RUNS = Number(process.env.FACET_ABORT_REPRO_RUNS || 1);
const repro = test.skipIf(projectHostsAreLocal() || process.env.RUN_FACET_ABORT_REPRO !== "1");

/** A session of its own on `ctx`: `close()` ends it alone — a row's other runs keep theirs. */
function ownSession(ctx: string): { itx: any; close: () => void } {
  const s = session();
  return {
    itx: s.authenticate(adminCredentials()).projects.get(ctx),
    close: () => s[Symbol.dispose](),
  };
}

/** The context's next five commits, 200 ms apart: the fault lands on one of them. */
async function probeCommits(itx: any): Promise<void> {
  for (let k = 0; k < 5; k++) {
    await itx.append({ type: "facet-abort-reset/probe", payload: { k } });
    await sleep(200);
  }
}

/** `flow` RUNS times at once, each on a fresh context: how many reset their context once the path
 *  under test began (`run.onPath()`, called right before it), how many while the facet was still
 *  being set up, and how many answered "inconclusive" (the path did not run where the flow could
 *  see it). */
async function tally(
  row: string,
  flow: (ctx: string, run: { onPath: () => void }) => Promise<"ok" | "inconclusive">,
) {
  const outcomes = await Promise.all(
    Array.from({ length: RUNS }, async (_, i) => {
      await sleep(i * 150);
      let onPath = false;
      return flow(freshCtx("facet_abort_reset"), { onPath: () => (onPath = true) }).catch(
        (error: Error) => {
          if (RESET.test(error.message)) return onPath ? "reset" : "reset in setup";
          throw error;
        },
      );
    }),
  );
  const counts = {
    row,
    runs: RUNS,
    reset: outcomes.filter((outcome) => outcome === "reset").length,
    resetInSetup: outcomes.filter((outcome) => outcome === "reset in setup").length,
    inconclusive: outcomes.filter((outcome) => outcome === "inconclusive").length,
  };
  process.stdout.write(`${JSON.stringify({ event: "facet-abort-reset.tally", ...counts })}\n`);
  return counts;
}

repro(
  "Cloudflare resets a context whose loaded facet aborts its own child facet right after 40 rows of 2 KB",
  async () => {
    const { reset } = await tally("raw child abort", async (ctx, run) => {
      const itx = openItx(ctx);
      expect(await call(itx, "childWrite", 40)).toBe(40);
      run.onPath();
      await call(itx, "childAbort");
      await probeCommits(itx);
      return "ok";
    });
    expect(reset).toBe(RUNS);
  },
  240_000,
);

repro(
  "itx.facets.abort right after 40 rows of 2 KB resets the facet, never its context",
  async () => {
    const counts = await tally("itx.facets.abort", async (ctx, run) => {
      const itx = openItx(ctx);
      expect(await call(itx, "write", 40)).toBe(40);
      run.onPath();
      await itx.facets.abort("writer");
      await probeCommits(itx);
      return "ok";
    });
    expect(counts).toMatchObject({ reset: 0, resetInSetup: 0 });
  },
  240_000,
);

repro(
  "a facet evicted with its context right after 40 rows of 2 KB: the next incarnation answers",
  async () => {
    const counts = await tally("eviction", async (ctx, run) => {
      const first = ownSession(ctx);
      expect(await call(first.itx, "write", 40)).toBe(40);
      run.onPath();
      first.close();
      await sleep(13_000); // the context evicts in ~10 s, and the facet, which holds nothing, with it
      await probeCommits(openItx(ctx));
      return "ok";
    });
    expect(counts).toMatchObject({ reset: 0, resetInSetup: 0 });
  },
  240_000,
);

repro(
  "the birth reset of a facet the last incarnation left running and writing resets the facet, never the context",
  async () => {
    const counts = await tally("birth reset", async (ctx, run) => {
      const first = ownSession(ctx);
      expect(await call(first.itx, "writeOn")).toBe(true);
      run.onPath();
      first.close();
      await sleep(13_000); // the context evicts; the facet, holding its env.ITX answer, writes on
      await probeCommits(openItx(ctx));
      return "ok";
    });
    expect(counts).toMatchObject({ reset: 0, resetInSetup: 0 });
  },
  240_000,
);

repro(
  "a new loaded identity restarts a facet that just wrote 40 rows of 2 KB, never its context",
  async () => {
    const counts = await tally("loaded identity", async (ctx, run) => {
      const itx = openItx(ctx);
      expect(await call(itx, "write", 40)).toBe(40);
      run.onPath();
      expect(
        await itx.invoke(["itx", "facets", ["get", "writer", writer("v2")], ["write", 1]]),
      ).toBe(1);
      await probeCommits(itx);
      return "ok";
    });
    expect(counts).toMatchObject({ reset: 0, resetInSetup: 0 });
  },
  240_000,
);

repro(
  "the sweep's reset in place of a facet still writing resets the facet, never the context",
  async () => {
    const counts = await tally("sweep", async (ctx, run) => {
      const t0 = Date.now();
      const first = ownSession(ctx);
      expect(await call(first.itx, "writeOn")).toBe(true);
      expect(await call(first.itx, "chatter")).toBe("chattering");
      run.onPath();
      first.close();
      // No outside call until the sweep's quiet minute is up; the chatter keeps the context resident.
      await sleep(64_000 - (Date.now() - t0));
      const itx = openItx(ctx);
      await probeCommits(itx);
      const log = await readAll(itx);
      const lastChatter = log.findLast((e: any) => e.type === "facet-abort-reset/chatter");
      const firstProbe = log.find((e: any) => e.type === "facet-abort-reset/probe");
      // Conclusive only when the sweep reset the chattering facet before the first probe landed.
      return lastChatter.offset < firstProbe.offset ? "ok" : "inconclusive";
    });
    expect(counts).toMatchObject({ reset: 0, resetInSetup: 0 });
  },
  240_000,
);

repro(
  "the call watchdog's reset of a facet hung mid-write resets the facet, never the context",
  async () => {
    const counts = await tally("call watchdog", async (ctx, run) => {
      const itx = openItx(ctx);
      expect(await call(itx, "write", 40)).toBe(40);
      run.onPath();
      await expect(call(itx, "hangWriting")).rejects.toThrow(/no answer in 60s/);
      await probeCommits(itx);
      return "ok";
    });
    expect(counts).toMatchObject({ reset: 0, resetInSetup: 0 });
  },
  240_000,
);
