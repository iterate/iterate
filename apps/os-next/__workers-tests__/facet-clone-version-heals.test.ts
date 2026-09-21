// __workers-tests__/facet-clone-version-heals.test.ts — a call into a LOADED facet that rejects the
// way the platform's facet-start defect does (V8's clone-version text, or the bare "internal error;
// reference = …") is made once more on a restarted facet under a fresh loaded identity, the pushed
// batch is reduced exactly once, and the facet's row counts the restart. The condition is prd's
// (never local workerd's: `iterate-context-durable-object.ts`, `isFacetStartPlatformFailure`), so the
// facet here THROWS the message itself on its first push — recorded in its own SQLite, which survives
// the abort and the new isolate, so the second attempt goes through.
import { runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import { stub, until } from "./support.ts";

const flakyFacetSource = (message: string) => /* js */ `
import { StreamProcessor, StreamProcessorDurableObject, defineProcessorContract, z } from "./processor.js";
const contract = defineProcessorContract({
  slug: "flaky",
  version: "1.0.0",
  description: "counts durable events; its FIRST push ever rejects like a clone-version skew",
  stateSchema: z.object({ n: z.number().default(0) }),
  consumes: ["*"],
  emits: [],
});
class FlakyProcessor extends StreamProcessor {
  contract = contract;
  reduce({ state }) { return { n: state.n + 1 }; }
}
export class FlakyDurableObject extends StreamProcessorDurableObject {
  processor = new FlakyProcessor();
  #tries() {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS tries (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER)");
  }
  async processEventBatch(events, range) {
    this.#tries();
    const before = Number(this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM tries").one().n);
    this.ctx.storage.sql.exec("INSERT INTO tries (at) VALUES (?)", Date.now());
    if (before === 0) throw new Error(${JSON.stringify(message)});
    return super.processEventBatch(events, range);
  }
  tries() {
    this.#tries();
    return this.ctx.storage.sql.exec("SELECT * FROM tries").toArray();
  }
}
`;

const platformFailures = {
  clone_version: "Unable to deserialize cloned data due to invalid or unsupported version.",
  internal_error: "internal error; reference = 4f4r7cgj5qomq11vmhb2gc1f",
};

for (const [label, message] of Object.entries(platformFailures)) {
  test(`a facet call that rejects with the platform's ${label} text is retried once on a restarted facet under a fresh loaded identity; the batch is reduced exactly once; the row counts one restart`, async () => {
    const ctx = `prj_facet_${label}`;
    const s = stub(ctx);
    await s.append({
      type: "events.iterate.com/stream/subscription-configured",
      payload: {
        name: "flaky",
        target: [
          "itx",
          "builtins",
          "facets",
          [
            "get",
            "flaky",
            { source: { "cap.js": flakyFacetSource(message) }, className: "FlakyDurableObject" },
          ],
          "processEventBatch",
        ],
      },
    });
    const loaderIdBefore = await until("the facet materialized at configure", () =>
      runInDurableObject(
        s,
        (_i, state) => state.storage.kv.get("facet:flaky:loader-id") as string | undefined,
      ),
    );
    // The configure batch is the facet's FIRST push (rejected by the facet, retried by the DO on a
    // restarted facet); the appended event is the next.
    await s.append({ type: "a/1" });
    const durable = ((await s.invoke(["itx", ["readEvents", 0, 500]])) as { events: unknown[] })
      .events.length;
    await until("every durable event reduced", async () => {
      const snap = (await s.invoke("itx.facets.get('flaky').snapshot()")) as {
        state: { n: number };
      };
      return snap.state.n === durable ? snap : undefined;
    });
    const tries = (await s.invoke("itx.facets.get('flaky').tries()")) as { seq: number }[];
    // The rejected push and its retry at least; the appended event rides the retry when its commit
    // landed while the first push was in flight (a pending push folds), or comes as a third push.
    expect(tries.length).toBeGreaterThanOrEqual(2);
    const snap = (await s.invoke("itx.facets.get('flaky').snapshot()")) as { state: { n: number } };
    expect(snap.state.n).toBe(durable); // every durable event counted once — no double, no loss
    const loaderIdAfter = await runInDurableObject(
      s,
      (_i, state) => state.storage.kv.get("facet:flaky:loader-id") as string,
    );
    expect(loaderIdAfter).not.toBe(loaderIdBefore); // the loaded identity was retired: a fresh isolate
    expect(loaderIdAfter).toMatch(/#1$/);
    const rows = (await s.invoke("itx.processors.list()")) as {
      hostedFacet: { restarts: number };
    }[];
    expect(rows.map((row) => row.hostedFacet.restarts)).toEqual([1]); // the one restart, on the row
  });
}
