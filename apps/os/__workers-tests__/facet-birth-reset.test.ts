// __workers-tests__/facet-birth-reset.test.ts — which facets a context resets (FacetHost
// `resetUnclaimedLoadedFacets`): every LOADED facet that holds no claim on the context's alarm, and
// no other. A claimed facet's work outlives the call that started it on purpose; a first-party facet
// keeps no startup memo and is never reset. Two moments reset them: an incarnation's BIRTH (named on
// its wake record), and the unclaimed-facet SWEEP on the alarm once a context that materialized one
// has been quiet for `UNCLAIMED_FACET_SWEEP_AFTER_QUIET_MS` — in place, when it is still resident
// (here, with Date faked); an incarnation that evicted on time is woken fresh by it, and that birth
// resets them.
//
// What the reset ENDS — a careless facet still running after its context was evicted, billed — is a
// deployed fact (workerd's harness cannot evict a context whose facet is live, workerd#6800): the
// careless rows of e2e/context-residency.e2e.test.ts read the facet's own start across incarnations.

import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { expect, onTestFinished, test, vi } from "vitest";
import type { StreamEvent } from "iterate/next/stream/processor";
import { UNCLAIMED_FACET_SWEEP_AFTER_QUIET_MS } from "../src/context/facet-host.ts";
import { releasePins, stub } from "./support.ts";

/** A plain loaded class; `id` names the instance. */
const spec = {
  source: {
    "cap.js": /* js */ `import { FacetDurableObject } from "./processor.js";
export class PlainDurableObject extends FacetDurableObject {
  static publicMethods = [...super.publicMethods, "hello"];
  id = crypto.randomUUID();
  hello() { return this.id; }
}`,
  },
  className: "PlainDurableObject",
};

test("a context's birth resets its loaded facets that hold no claim, names them on its wake record, and spares a claimed one", async () => {
  const ctx = "prj_facet_birth_reset";
  const s = stub(ctx);
  for (const name of ["idle", "busy"])
    expect(await s.invoke(["itx", "facets", ["get", name, spec], ["hello"]])).toEqual(
      expect.any(String),
    );
  // What `runInBackground` holds while an attempt is in flight: a claim on the context's alarm.
  await s.invoke(["itx", "processors", ["claim", "busy", Date.now() + 60_000]]);
  await releasePins(ctx); // workerd keeps a DO with a live facet resident; the edge does not
  await evictDurableObject(s);

  const { events } = (await s.invoke(["itx", ["readEvents", 0, 500]])) as { events: StreamEvent[] };
  const woken = events.filter((event) => event.type === "events.iterate.com/stream/woken");
  expect(woken.length).toBe(2);
  expect(woken[0]!.payload).not.toHaveProperty("facetsReset");
  expect(woken[1]!.payload).toMatchObject({ facetsReset: ["idle"] });
  // Both answer after the birth: the reset facet from its startup memo, the claimed one as it was.
  for (const name of ["idle", "busy"])
    expect(await s.invoke(["itx", "facets", ["get", name], ["hello"]])).toEqual(expect.any(String));
  await s.invoke(["itx", "processors", ["claim", "busy", null]]);
});

test("a context still resident a quiet period after it materialized a loaded facet resets its unclaimed ones in place, on the alarm, and spares a claimed one", async () => {
  const ctx = "prj_facet_quiet_sweep";
  const s = stub(ctx);
  const t0 = Date.now();
  vi.useFakeTimers({ now: t0, toFake: ["Date"] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const before: Record<string, string> = {};
  for (const name of ["idle", "busy"])
    before[name] = (await s.invoke(["itx", "facets", ["get", name, spec], ["hello"]])) as string;
  await s.invoke(["itx", "processors", ["claim", "busy", t0 + 10 * 60_000]]);
  // Materializing a loaded facet armed the sweep: the alarm is due a quiet period out.
  expect(await runInDurableObject(s, (_instance, state) => state.storage.getAlarm())).toBe(
    t0 + UNCLAIMED_FACET_SWEEP_AFTER_QUIET_MS,
  );
  vi.setSystemTime(t0 + UNCLAIMED_FACET_SWEEP_AFTER_QUIET_MS);
  expect(await runDurableObjectAlarm(s)).toBe(true);
  // The same incarnation answers: the unclaimed facet from a fresh instance, the claimed one as it was.
  expect(await s.invoke(["itx", "facets", ["get", "idle"], ["hello"]])).not.toBe(before.idle);
  expect(await s.invoke(["itx", "facets", ["get", "busy"], ["hello"]])).toBe(before.busy);
  const { events } = (await s.invoke(["itx", ["readEvents", 0, 500]])) as { events: StreamEvent[] };
  expect(events.filter((event) => event.type === "events.iterate.com/stream/woken").length).toBe(1);
  await s.invoke(["itx", "processors", ["claim", "busy", null]]);
});
