import { test } from "vitest";
import { appendFileSync } from "node:fs";
import {
  append,
  collector,
  disposeSessions,
  freshCtx,
  openItx,
  readAll,
  sleep,
} from "./support/client.ts";
import { SOURCES } from "./support/sources.ts";
const log = (line: string) => appendFileSync(process.env.PROBE_LOG!, line + "\n");
const wokens = async (itx: any) =>
  (await readAll(itx))
    .filter((e) => e.type === "events.iterate.com/stream/woken")
    .map((e) => `${e.payload.incarnation}:${e.payload.reason}`);
const ring = async (itx: any) =>
  (
    (await itx.invoke(["itx", ["readEvents", 0, 500, { includeEphemeral: true }]])) as {
      events: any[];
    }
  ).events
    .filter((e) => e.type === "events.iterate.com/stream/trace/alarm")
    .map(
      (e) =>
        `${e.payload.reason}@${new Date(e.payload.at).toISOString().slice(11, 19)}→${e.payload.alarm.after === null ? "none" : new Date(e.payload.alarm.after).toISOString().slice(11, 19)} stubs=${e.payload.borrowedRpcStubs} facets=${JSON.stringify(e.payload.liveFacets)}`,
    );
test("pins after", { timeout: 9 * 60_000 }, async () => {
  // (1) a "*" facet root: a request materializes the facet; nothing must arm.
  const facetCtx = freshCtx("facet3");
  let f = openItx(facetCtx);
  await f.invoke([
    "itx",
    "processors",
    ["enable", "tally", { source: SOURCES.tally, className: "TallyDurableObject" }],
  ]);
  await append(f, { type: "demo/ping", payload: { n: 1 } });
  await sleep(500);
  await f.invoke("itx.facets.get('tally').snapshot()");
  // (2) a live "*" client root: the push borrows the stub, which pins; its idle alarm must fire in place, once.
  const liveCtx = freshCtx("live3");
  const live = openItx(liveCtx); // kept open for the whole probe: the row and the lent stub live with it
  const pushed = collector();
  await live.subscribe({ name: "live", consumes: ["*"], target: pushed.fn });
  await append(live, { type: "mark" });
  await sleep(1500);
  log(
    `${new Date().toISOString()} set up facet=${facetCtx} live=${liveCtx} pushes=${pushed.invocations.length}`,
  );
  const t0 = Date.now();
  for (const minute of [1, 2, 3, 5, 7]) {
    await sleep(Math.max(0, t0 + minute * 60_000 - Date.now()));
    f = openItx(facetCtx);
    log(
      `${new Date().toISOString()} +${minute}m facet wokens=${JSON.stringify(await wokens(f))} ring=${JSON.stringify(await ring(f))}`,
    );
    const l = openItx(liveCtx);
    log(
      `${new Date().toISOString()} +${minute}m live  wokens=${JSON.stringify(await wokens(l))} ring=${JSON.stringify(await ring(l))} pushes=${pushed.invocations.length}`,
    );
  }
  disposeSessions();
});
