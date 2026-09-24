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
// careless rows of e2e/context-residency.e2e.test.ts read the facet's own start across incarnations,
// and the opt-in perf/context-residency.perf.test.ts times how long the platform keeps such a facet
// running. A reset is an abort and a start (facet-host.ts FACET_START_WATCHDOG_MS), of the facets
// called since their last start only; why the start, and the birth's before its first write, is a
// deployed fact too: e2e/facet-abort-storage-reset.e2e.test.ts.

import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { expect, onTestFinished, test, vi } from "vitest";
import type { StreamEvent } from "iterate/stream/processor";
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

/** A loaded class serving plain HTTP; its page names the instance. */
const site = {
  source: {
    "cap.js": /* js */ `import { FacetDurableObject } from "./processor.js";
export class SiteDurableObject extends FacetDurableObject {
  id = crypto.randomUUID();
  fetch() { return new Response(this.id); }
}`,
  },
  className: "SiteDurableObject",
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

test("a birth resets only the facets the last incarnation called: one no call reached since is left alone", async () => {
  const ctx = "prj_facet_birth_reset_only_what_ran";
  const s = stub(ctx);
  expect(await s.invoke(["itx", "facets", ["get", "idle", spec], ["hello"]])).toEqual(
    expect.any(String),
  );
  for (let i = 0; i < 2; i++) {
    await releasePins(ctx);
    await evictDurableObject(s);
    await s.invoke(["itx", ["whoami"]]);
  }
  const { events } = (await s.invoke(["itx", ["readEvents", 0, 500]])) as { events: StreamEvent[] };
  const woken = events.filter((event) => event.type === "events.iterate.com/stream/woken");
  expect(woken.map((event) => (event.payload as { facetsReset?: string[] }).facetsReset)).toEqual([
    undefined,
    ["idle"],
    undefined,
  ]);
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

test("a call from loaded code counts while in flight but never restarts the sweep's quiet clock: the unclaimed facet is reset a quiet period after the last OUTSIDE call", async () => {
  const ctx = "prj_facet_sweep_outside_clock";
  const s = stub(ctx);
  const t0 = Date.now();
  vi.useFakeTimers({ now: t0, toFake: ["Date"] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const before = (await s.invoke(["itx", "facets", ["get", "chatty", spec], ["hello"]])) as string;
  // Loaded code calling its own context half a period later — what a chatty facet does.
  vi.setSystemTime(t0 + UNCLAIMED_FACET_SWEEP_AFTER_QUIET_MS / 2);
  await s.invoke("itx.whoami()", [], { principal: null, app: true });
  vi.setSystemTime(t0 + UNCLAIMED_FACET_SWEEP_AFTER_QUIET_MS);
  expect(await runDurableObjectAlarm(s)).toBe(true);
  expect(await s.invoke(["itx", "facets", ["get", "chatty"], ["hello"]])).not.toBe(before);
});

test("an outside HTTP request restarts the sweep's quiet clock: a loaded facet a project host keeps reaching is reset only a quiet period after the last request", async () => {
  const ctx = "prj_facet_sweep_http_clock";
  const s = stub(ctx);
  const t0 = Date.now();
  vi.useFakeTimers({ now: t0, toFake: ["Date"] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  // What the edge sends a context for a project host's request (worker.ts): a plain fetch naming
  // the facet by itx expression, no loaded-code marker — outside activity.
  const page = async () =>
    (
      await s.fetch(
        new Request("https://site.test/", {
          headers: { "x-itx-expression": JSON.stringify(["itx", "facets", ["get", "site", site]]) },
        }),
      )
    ).text();
  const first = await page();
  vi.setSystemTime(t0 + UNCLAIMED_FACET_SWEEP_AFTER_QUIET_MS / 2);
  expect(await page()).toBe(first);
  // The deadline the materialization armed comes due, but the request half a period in restarted
  // the clock: the pass re-arms a quiet period after that request, and resets nothing.
  vi.setSystemTime(t0 + UNCLAIMED_FACET_SWEEP_AFTER_QUIET_MS);
  expect(await runDurableObjectAlarm(s)).toBe(true);
  expect(await runInDurableObject(s, (_instance, state) => state.storage.getAlarm())).toBe(
    t0 + (UNCLAIMED_FACET_SWEEP_AFTER_QUIET_MS * 3) / 2,
  );
  vi.setSystemTime(t0 + (UNCLAIMED_FACET_SWEEP_AFTER_QUIET_MS * 3) / 2);
  expect(await runDurableObjectAlarm(s)).toBe(true);
  expect(await page()).not.toBe(first);
});

test("a claim's release arms the sweep again: a facet the sweep spared while it was claimed is reset a quiet period after the release", async () => {
  const ctx = "prj_facet_sweep_after_release";
  const s = stub(ctx);
  const t0 = Date.now();
  vi.useFakeTimers({ now: t0, toFake: ["Date"] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const before = (await s.invoke(["itx", "facets", ["get", "busy", spec], ["hello"]])) as string;
  await s.invoke(["itx", "processors", ["claim", "busy", t0 + 10 * 60_000]]);
  // The sweep runs while the claim holds the facet: it spares it, and disarms — nothing is owed
  // until the claim, 10 minutes out.
  vi.setSystemTime(t0 + UNCLAIMED_FACET_SWEEP_AFTER_QUIET_MS);
  expect(await runDurableObjectAlarm(s)).toBe(true);
  expect(await runInDurableObject(s, (_instance, state) => state.storage.getAlarm())).toBe(
    t0 + 10 * 60_000,
  );
  // The release — the facet's own last call — arms it again, a quiet period out.
  const releasedAt = t0 + 2 * UNCLAIMED_FACET_SWEEP_AFTER_QUIET_MS;
  vi.setSystemTime(releasedAt);
  await s.invoke(["itx", "processors", ["claim", "busy", null]], [], {
    principal: null,
    app: true,
  });
  expect(await runInDurableObject(s, (_instance, state) => state.storage.getAlarm())).toBe(
    releasedAt + UNCLAIMED_FACET_SWEEP_AFTER_QUIET_MS,
  );
  vi.setSystemTime(releasedAt + UNCLAIMED_FACET_SWEEP_AFTER_QUIET_MS);
  expect(await runDurableObjectAlarm(s)).toBe(true);
  // The instance the claim kept running is gone: a fresh one answers.
  expect(await s.invoke(["itx", "facets", ["get", "busy"], ["hello"]])).not.toBe(before);
});
