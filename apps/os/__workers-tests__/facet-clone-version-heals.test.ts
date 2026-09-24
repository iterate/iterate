// __workers-tests__/facet-clone-version-heals.test.ts — a call into a LOADED facet that rejects the
// way the platform's facet-start defect does (V8's clone-version text, or the bare "internal error;
// reference = …") is made once more on a restarted facet under a fresh loaded identity, the pushed
// batch is reduced exactly once, and the facet's row counts the restart. The condition is prd's
// (never local workerd's: `context/facet-host.ts`, `isFacetStartPlatformFailure`), so the
// facet here THROWS the message itself on its first push — recorded in its own SQLite, which survives
// the abort and the new isolate, so the second attempt goes through.
import { runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import { stub, until } from "./support.ts";

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
    expect(snap).toMatchObject({ state: { n: durable } }); // every durable event counted once — no double, no loss
    const loaderIdAfter = await runInDurableObject(
      s,
      (_i, state) => state.storage.kv.get("facet:flaky:loader-id") as string,
    );
    // The loaded identity was retired once: a fresh isolate. `loaderIdBefore` may already be the
    // retry's (`…#1`): the configure batch is pushed, rejected and retried while `until` polls, and
    // on a loaded machine the first read lands after the retry (2026-09-24, 1 of 17 local runs).
    expect(loaderIdAfter).toBe(`${loaderIdBefore.replace(/#1$/, "")}#1`);
    const rows = (await s.invoke("itx.processors.list()")) as {
      hostedFacet: { restarts: number };
    }[];
    expect(rows.map((row) => row.hostedFacet.restarts)).toEqual([1]); // the one restart, on the row
  });
}

test("concurrent stale start failures do not retire the replacement generation twice", async () => {
  const source = {
    "cap.js": `
import { FacetDurableObject } from "./processor.js";
export class Racing extends FacetDurableObject {
  static publicMethods = [...super.publicMethods, "run"];
  #releaseBothStarts = function () {};
  #bothStarts = new Promise(
    function (resolve) {
      this.#releaseBothStarts = resolve;
    }.bind(this),
  );

  async run() {
    const n = Number(this.ctx.storage.kv.get("n") || 0) + 1;
    this.ctx.storage.kv.put("n", n);
    if (n <= 2) {
      if (n === 2) this.#releaseBothStarts();
      await this.#bothStarts;
      throw new Error("internal error; reference = race");
    }
    return { n };
  }
}`,
  };
  const s = stub("prj_facet_race");
  const call = () =>
    s.invoke(["itx", "facets", ["get", "race", { source, className: "Racing" }], ["run"]]);
  const [a, b] = await Promise.all([call(), call()]);
  expect(a).toMatchObject({ n: expect.any(Number) });
  expect(b).toMatchObject({ n: expect.any(Number) });
  expect(
    await runInDurableObject(s, (_i, state) => state.storage.kv.get("facet:race:restarts")),
  ).toBe(1);
});

// PRD 2026-09-23 06:36–09:10Z (Lispwoso and Garple homepages 500ing on a first request): a facet
// started from this worker's own `ctx.exports` answered its FIRST call and rejected every later
// one with "internal error; reference = …" before the method ran — each start was good for exactly
// one call. A lone caller heals (restart, retry first on the fresh start); two callers on a running
// facet did not: both failed, one restarted, and the other's retry became the fresh start's SECOND
// call. The facet here plays that runtime: its instance answers once, then throws the platform's
// text.
test("on a runtime whose facet starts answer one call each, concurrent calls on a running facet each answer", async () => {
  const source = {
    "cap.js": `
import { FacetDurableObject } from "./processor.js";
export class OneCallPerStart extends FacetDurableObject {
  static publicMethods = [...super.publicMethods, "run"];
  #answered = false;
  #releasePair = () => {};
  #pairArrived = new Promise((resolve) => (this.#releasePair = resolve));
  async run() {
    if (this.#answered) {
      // The 2nd and 3rd rejections ever are the concurrent pair: they meet on one start first.
      const rejected = Number(this.ctx.storage.kv.get("rejected") || 0) + 1;
      this.ctx.storage.kv.put("rejected", rejected);
      if (rejected === 3) this.#releasePair();
      if (rejected === 2) await this.#pairArrived;
      throw new Error("internal error; reference = spent");
    }
    this.#answered = true;
    const n = Number(this.ctx.storage.kv.get("n") || 0) + 1;
    this.ctx.storage.kv.put("n", n);
    return { n };
  }
}`,
  };
  const s = stub("prj_facet_one_call_per_start");
  const call = () =>
    s.invoke([
      "itx",
      "facets",
      ["get", "spent", { source, className: "OneCallPerStart" }],
      ["run"],
    ]);
  expect(await call()).toEqual({ n: 1 }); // the start's one answer
  expect(await call()).toEqual({ n: 2 }); // a lone caller: restarted, retried first
  // The Lispwoso shape: a page's call and a background push on the same running facet.
  const pair = await Promise.all([call(), call()]);
  expect(pair.map((answer) => (answer as { n: number }).n).sort()).toEqual([3, 4]);
  expect(
    await runInDurableObject(s, (_i, state) => state.storage.kv.get("facet:spent:restarts")),
  ).toBe(3); // one per failed call
});

// The same runtime, the cold shape the Lispwoso trace shows: a call in flight on the start it
// opened is killed by a peer's restart, retries on the replacement — whose one call the peer's
// retry spent — and then on a restart of its own.
test("on a runtime whose facet starts answer one call each, a call killed by a peer's restart answers on a start of its own", async () => {
  const source = {
    "cap.js": `
import { FacetDurableObject } from "./processor.js";
export class OneCallPerStart extends FacetDurableObject {
  static publicMethods = [...super.publicMethods, "run", "inFlight"];
  #answered = false;
  inFlight() {
    return this.ctx.storage.kv.get("in-flight") === true;
  }
  async run() {
    if (this.#answered) throw new Error("internal error; reference = spent");
    this.#answered = true;
    if (!this.ctx.storage.kv.get("in-flight")) {
      this.ctx.storage.kv.put("in-flight", true);
      await new Promise(() => {}); // the first start's call hangs until a restart aborts it
    }
    const n = Number(this.ctx.storage.kv.get("n") || 0) + 1;
    this.ctx.storage.kv.put("n", n);
    return { n };
  }
}`,
  };
  const s = stub("prj_facet_one_call_per_start_cold");
  const facet = (step: string) =>
    s.invoke(["itx", "facets", ["get", "spent", { source, className: "OneCallPerStart" }], [step]]);
  const first = facet("run");
  await until("the first call is in flight", async () =>
    (await facet("inFlight")) ? true : undefined,
  );
  const second = facet("run"); // the start's second call: rejected, so it restarts the facet
  expect(
    (await Promise.all([first, second])).map((answer) => (answer as { n: number }).n).sort(),
  ).toEqual([1, 2]);
  expect(
    await runInDurableObject(s, (_i, state) => state.storage.kv.get("facet:spent:restarts")),
  ).toBe(2);
});

// One platform failure among calls in flight restarts the facet ONCE: the calls its restart kills
// retry on the replacement without restarting it again.
test("one platform failure while other calls are in flight restarts the facet once; every call answers", async () => {
  const source = {
    "cap.js": `
import { FacetDurableObject } from "./processor.js";
export class Steady extends FacetDurableObject {
  static publicMethods = [...super.publicMethods, "slow", "failOnce"];
  async slow() {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return "slow";
  }
  failOnce() {
    if (this.ctx.storage.kv.get("failed")) return "recovered";
    this.ctx.storage.kv.put("failed", true);
    throw new Error("internal error; reference = once");
  }
}`,
  };
  const s = stub("prj_facet_one_failure_in_traffic");
  const facet = (step: string) =>
    s.invoke(["itx", "facets", ["get", "steady", { source, className: "Steady" }], [step]]);
  expect(await facet("slow")).toBe("slow");
  const answers = await Promise.all([
    ...Array.from({ length: 5 }, () => facet("slow")),
    facet("failOnce"),
    ...Array.from({ length: 5 }, () => facet("slow")),
  ]);
  expect(answers).toEqual([...Array(5).fill("slow"), "recovered", ...Array(5).fill("slow")]);
  expect(
    await runInDurableObject(s, (_i, state) => state.storage.kv.get("facet:steady:restarts")),
  ).toBe(1);
});

/** A loaded processor whose FIRST push ever rejects with `message`; every try is recorded in its own
 *  SQLite, which survives the abort and the new isolate. */
function flakyFacetSource(message: string) {
  return /* js */ `
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
  static publicMethods = [...super.publicMethods, "tries"];
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
}
