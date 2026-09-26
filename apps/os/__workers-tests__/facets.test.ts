// __workers-tests__/facets.test.ts — a context's facets: Durable Objects nested in the context's own,
// built from a class this worker exports (a first-party facet) or loaded from source
// (context/facet-host.ts), and the loaded workers the same loader builds (context/worker-loader.ts).
// Every row needs what only workerd has: a real `ctx.facets` and its abort, a real LOADER, the
// context's live instance, eviction and the alarm on demand. The named loaded code is ./sources.ts;
// the facet-start defect rows keep their runtimes inline. The two rows that wait out the real 60 s
// facet watchdog are files of their own, so they run beside each other:
// facet-push-timeout-heals.test.ts and facet-timeout-restart-heals-sibling-push.test.ts.
//
// The rows share one worker, in file order: the rows that read the console come before the rows
// that leave a project's creation running in the background.

import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { newWebSocketRpcSession, newWorkersRpcResponse, RpcTarget } from "capnweb";
import { expect, type MockInstance, onTestFinished, test, vi } from "vitest";
import type { FacetSpec } from "iterate/api";
import type { ItxExpression, ItxExpressionInput } from "iterate/expression";
import { errorCode } from "iterate/lib";
import { UNCLAIMED_FACET_SWEEP_AFTER_QUIET_MS } from "../src/context/facet-host.ts";
import { hmacSha256Hex } from "../src/secrets.ts";
import {
  APP_FACET,
  CLONE_VERSION_TEXT,
  CLONE_VERSION_WORKER,
  COUNTING_TALLY,
  flakyCounter,
  FRAGILE,
  hangingCounter,
  HELLO,
  HELLO_PROCESSOR,
  HELLO_WORKER,
  IDENTITY_PROBE,
  PLAIN_DURABLE_OBJECT,
  PRODUCER,
  PUSH_TALLY,
  TICK_TALLY,
} from "./sources.ts";
import { publishConfigWorker } from "../e2e/support/config-worker.ts";
import {
  adminCredentials,
  openSession,
  readLog,
  releasePins,
  signedInSession,
  snapshot,
  stub,
  until,
} from "./support.ts";

// ── what a facet is: the platform primitives the facet host leans on ──

test("a facet from getDurableObjectClass(name, { props }) sees ctx.props: how a processor's host learns its identity, with no configure() side channel", async () => {
  const { props, identity } = await runInDurableObject(
    stub("prj_facet_props_probe"),
    async (_instance, state) => {
      // A fixed key: low-cardinality by construction (the loader cacheKey rule), tests only.
      const worker = env.LOADER.get("probe:facet-props:v1", () => ({
        compatibilityDate: "2026-09-01",
        mainModule: "probe.js",
        modules: { "probe.js": IDENTITY_PROBE },
      }));
      const props = { iterateContextName: state.id.name, name: "probe" };
      const klass = worker.getDurableObjectClass("ProbeDurableObject", { props });
      const facet = state.facets.get("probe", () => ({ class: klass })) as unknown as {
        identity(): Promise<{ props: unknown; idName: string | null; exportsKind: string }>;
      };
      return { props, identity: await facet.identity() };
    },
  );
  // Props arrive exactly. A facet's `ctx.id.name` is its PARENT's codec name and `ctx.exports` is
  // populated (workerd via wrangler 4.127.1, 2026-09-01), so the props carry the facet's own `name`.
  expect(identity).toEqual({ props, idName: props.iterateContextName, exportsKind: "object" });
});

test("a facet from ctx.exports.<Class>({ props }) sees ctx.props and answers through its own loopback", async () => {
  const seen = await runInDurableObject(
    stub("prj_facet_exports_probe"),
    async (_instance, state) => {
      const exportsOf = (state as unknown as { exports: Record<string, unknown> }).exports;
      const entry = exportsOf.ProjectDurableObject as (options: {
        props: { iterateContextName: string; name: string };
      }) => unknown;
      const props = { iterateContextName: state.id.name!, name: "project" };
      const klass = entry({ props });
      const facet = state.facets.get("project", () => ({ class: klass as never })) as unknown as {
        snapshot(): Promise<{ offset: number; state: unknown }>;
      };
      return {
        entryKind: Object.getPrototypeOf(entry)?.constructor?.name,
        classKind: Object.getPrototypeOf(klass)?.constructor?.name,
        // `snapshot()` catches up from the context's log through `withItx` — the loopback the class
        // minted from its props — so a fresh context answers the processor's empty view.
        snapshot: await facet.snapshot(),
      };
    },
  );
  // Exact: the empty view is the point, so an extra key or a non-empty map must fail.
  expect(seen).toEqual({
    entryKind: "LoopbackDurableObjectNamespace",
    classKind: "DurableObjectClass",
    snapshot: {
      offset: expect.any(Number),
      state: {
        creation: null,
        deletion: null,
        repos: {},
        workspaces: {},
        contexts: {},
        secrets: {},
        configRepoTip: null,
        publishedCommitOid: null,
        publishedAt: null,
        hostnames: {},
        integrations: {},
        primaryHostname: null,
      },
    },
  });
});

test("a first-party facet name refuses a spec — no source ever names a class of this worker", async () => {
  // Refused INSIDE the object: a rejected RPC promise crossing to the test is reported as unhandled
  // in the object whatever the caller does with it.
  const refusals = await runInDurableObject(
    stub("prj_facet_exports_refusal"),
    async (instance: unknown) => {
      const context = instance as { invoke(call: unknown): Promise<unknown> };
      const refusal = async (call: unknown) => {
        try {
          await context.invoke(call);
          return null;
        } catch (error) {
          return String(error);
        }
      };
      const spec = { source: { "worker.js": "export class X {}" }, className: "X" };
      return {
        facet: await refusal(["itx", "facets", ["get", "repo", spec], ["tip"]]),
        processor: await refusal(["itx", "processors", ["enable", "repo", spec]]),
      };
    },
  );
  expect(refusals.facet).toMatch(/first-party/);
  expect(refusals.processor).toMatch(/first-party/);
});

// ── work cut off: an abort, a removal or a restart ends a call in flight ──
// Work `itx.facets.abort` cuts off is an outcome someone asked for, so it is modeled, not reported:
// the host rejects the call FACET_ABORTED and whoever made it owes the fresh instance the same work
// — a push one catch-up from the log, a revive its claim again (due now, no failure counted), a
// catch-up a rerun — never a halt, a backoff or an issue line. A restart under a new loaded identity
// is the same, coded FACET_RESTARTED. The counter hangs on each of those calls and would never
// answer: the abort from the host needs nothing from it.

test("a push hung on a facet that itx.facets.abort resets is caught up by the fresh instance — reduced once, the row live, the context not reset", async () => {
  const ctx = "prj_facet_abort_heals_its_push";
  await hostCounter(ctx);
  const [owed] = (await stub(ctx).append({ type: "pin/hang" })) as { offset: number }[];
  await until("the hanging push is on the facet", async () => (await probe(ctx)).seen.length === 2);
  const wakesBefore = (await readLog(ctx)).filter((e) => e.type === "events.iterate.com/itx/woken");

  const errors = vi.spyOn(console, "error");
  const aborted = await stub(ctx).invoke(["itx", "facets", ["abort", "counter", "unstick"]]);
  expect(aborted).toMatchObject({
    type: "events.iterate.com/itx/facet-aborted",
    payload: { name: "counter", reason: "unstick" },
  });
  // Seconds, not the 60 s watchdog: the fresh instance reads the owed span from the log.
  const healed = await caughtUpPast(ctx, owed!.offset, errors);
  expect(healed.seen.filter((row) => Number(row.hung) === 1)).toHaveLength(1); // never re-pushed
  expect((await readLog(ctx)).filter((e) => e.type === "events.iterate.com/itx/woken")).toEqual(
    wakesBefore,
  );
});

test("a revive hung on a facet that itx.facets.abort resets is owed again at once — no backoff, no issue — and the fresh instance's revive runs", async () => {
  const ctx = "prj_facet_abort_owes_its_revive";
  await hostCounter(ctx);
  // A due claim, what a processor holds while a `runInBackground` attempt is in flight.
  await stub(ctx).invoke(["itx", "processors", ["claim", "counter", Date.now()]]);
  const errors = vi.spyOn(console, "error");
  // The pass — the harness's own alarm or this one, whichever runs it first: its revive hangs.
  const pass = runDurableObjectAlarm(stub(ctx));
  await until("the revive hangs on the facet", async () => (await probe(ctx)).revives.length === 1);

  await stub(ctx).invoke(["itx", "facets", ["abort", "counter", "unstick the revive"]]);
  await pass;
  // Owed again and due now: the next pass revives the fresh instance, which answers.
  const revived = await until("the fresh instance was revived", async () => {
    await runDurableObjectAlarm(stub(ctx));
    const p = await probe(ctx);
    return p.revives.length >= 2 ? p : undefined;
  });
  expect(revived.revives.map((row) => Number(row.hung))).toEqual([1, 0]);
  expect(await kv(ctx, "facet-claim-failures:counter")).toBeUndefined(); // no backoff rung
  expect(issueLines(errors)).toEqual([]);
});

test("a catch-up hung on a facet that itx.facets.abort resets runs again on the fresh instance, with no issue", async () => {
  const ctx = "prj_facet_abort_reruns_its_catch_up";
  await hostCounter(ctx);
  const before = (await probe(ctx)).catchups.length;
  await stub(ctx).invoke(["itx", "facets", ["get", "counter"], ["armCatchUpHang"]]);
  const errors = vi.spyOn(console, "error");
  // An operator's resume: a facet row resumes by catching up from the log (subscription-delivery.ts).
  await stub(ctx).append({
    type: "events.iterate.com/itx/subscription-delivery-resumed",
    payload: { name: "counter" },
  });
  await until("the catch-up hangs", async () => (await probe(ctx)).catchups.length === before + 1);

  await stub(ctx).invoke(["itx", "facets", ["abort", "counter", "unstick the catch-up"]]);
  const caughtUp = await until("the fresh instance caught up", async () => {
    const p = await probe(ctx);
    return p.catchups.length >= before + 2 ? p : undefined;
  });
  expect(caughtUp.catchups.slice(before).map((row) => Number(row.hung))).toEqual([1, 0]);
  expect(issueLines(errors)).toEqual([]);
});

test("a push hung on a facet whose row is removed is that removal — NO_FACET, the facet deleted with its row — logged, never an issue", async () => {
  const ctx = "prj_facet_delete_cuts_its_push";
  await hostCounter(ctx);
  await stub(ctx).append({ type: "pin/hang" });
  await until("the hanging push is on the facet", async () => (await probe(ctx)).seen.length === 2);
  const errors = vi.spyOn(console, "error");
  const logs = vi.spyOn(console, "log");
  await stub(ctx).append({
    type: "events.iterate.com/itx/subscription-configured",
    payload: { name: "counter", target: null },
  });
  expect(await logged(logs, "delivery.facet-removed-in-flight")).toMatchObject({
    name: "counter",
    failureSite: "subscription-delivery.deliver",
    message: `facet "counter" was deleted while this call was in flight`,
  });
  expect(issueLines(errors)).toEqual([]);
});

test("a claim released after its facet was deleted leaves no facet-ran row for a birth to start", async () => {
  const ctx = "prj_facet_release_after_delete";
  await hostCounter(ctx);
  await stub(ctx).append({
    type: "events.iterate.com/itx/subscription-configured",
    payload: { name: "counter", target: null },
  });
  expect(await kv(ctx, "facet-ran:counter")).toBeUndefined(); // the deletion took it
  // What the facet's own release does when it lands after that (processors.claim, from the facet).
  await stub(ctx).invoke(["itx", "processors", ["claim", "counter", null]], [], {
    principal: null,
    app: true,
  });
  expect(await kv(ctx, "facet-ran:counter")).toBeUndefined();
});

test("a push in flight on a facet restarted under a new loaded identity rejects FACET_RESTARTED — logged, caught up on the new instance, never an issue", async () => {
  const ctx = "prj_facet_restart_heals_its_push";
  await hostCounter(ctx);
  const [owed] = (await stub(ctx).append({ type: "pin/hang" })) as { offset: number }[];
  await until("the hanging push is on the facet", async () => (await probe(ctx)).seen.length === 2);

  const errors = vi.spyOn(console, "error");
  const logs = vi.spyOn(console, "log");
  // The same name and class, a NEW source: the row's next call restarts the facet in place.
  await enable(ctx, "counter", hangingCounter(false));
  expect(await logged(logs, "delivery.facet-restarted-in-flight")).toMatchObject({
    name: "counter",
    failureSite: "subscription-delivery.deliver",
    code: "FACET_RESTARTED",
  });
  await caughtUpPast(ctx, owed!.offset, errors);
});

// ── starting a facet: the loader ──
// `FacetHost#callFacet` mints a facet's class ONLY for a facet that STARTS, so a RUNNING facet never
// touches the Worker Loader: one isolate lookup per warm call otherwise, and a running facet
// unreachable while the loader is unhealthy. `tapLoader` counts the context's LOADER calls.

test("hosting a facet is one LOADER.get + one getDurableObjectClass; 20 warm calls add none; a release costs the next call exactly one more of each", async () => {
  const ctx = "prj_facet_host_warm";
  const tap = await tapLoader(ctx);
  const first = await hostHello(ctx);
  expect(first).toMatchObject({ calls: 1 });
  expect({ gets: tap.gets.length, classGets: tap.classGets, minted: tap.codeCallbacks }).toEqual({
    gets: 1,
    classGets: 1,
    minted: 1,
  });

  let last = first;
  for (let i = 0; i < 20; i++) last = await warmHello(ctx);
  expect(last).toEqual({ calls: 21, instance: first.instance }); // running the whole time
  expect({ gets: tap.gets.length, classGets: tap.classGets }).toEqual({ gets: 1, classGets: 1 });

  // The release aborts the live facet. The next call re-materializes it: a fresh instance, one more
  // LOADER.get + class mint — the isolate itself is the loader's to keep (no cold build) — and the
  // calls after that are warm again.
  await releasePins(ctx);
  const again = await warmHello(ctx);
  expect(again).toMatchObject({ calls: 1 });
  expect(again).not.toMatchObject({ instance: first.instance });
  expect({ gets: tap.gets.length, classGets: tap.classGets, minted: tap.codeCallbacks }).toEqual({
    gets: 2,
    classGets: 2,
    minted: 1,
  });
  for (let i = 0; i < 5; i++) await warmHello(ctx);
  expect(tap.gets.length).toBe(2);
});

test("20 durable events pushed to a hosted facet's processEventBatch add no LOADER.get beyond the enable's catch-up", async () => {
  const ctx = "prj_facet_host_push";
  const tap = await tapLoader(ctx);
  await enable(ctx, "tally", PUSH_TALLY);
  // The enable's catch-up (`catchUpFromLog`) is the facet's cold start; let it and any first push land.
  await untilLoaderQuiet(tap);
  expect(tap.gets.length).toBe(1);
  const enableClassGets = tap.classGets;

  // 20 durable events, one at a time, each awaited (committed). Every one is delivered — pushed,
  // awaited, in order — to the running tally facet through `FacetHost#callFacet`.
  for (let i = 0; i < 20; i++) await stub(ctx).append({ type: `pin/${i}` });
  await untilLoaderQuiet(tap);
  const stats = (await stub(ctx).invoke("itx.facets.get('tally').stats()")) as {
    batches: number;
    events: number;
  };
  expect(stats.events).toBeGreaterThanOrEqual(20); // every appended event was delivered
  expect({ gets: tap.gets.length, classGetsDuringPushes: tap.classGets - enableClassGets }).toEqual(
    { gets: 1, classGetsDuringPushes: 0 },
  );
});

test("a RUNNING facet is not coupled to loader availability: with the loader refusing every get, warm calls are answered; only the re-materialization after a release needs it", async () => {
  const ctx = "prj_facet_host_loader_down";
  const tap = await tapLoader(ctx);
  const first = await hostHello(ctx);
  tap.refuseAfterFirst = new Error("simulated: LOADER unhealthy (LOADER.get threw)");

  let last = first;
  for (let i = 0; i < 10; i++) last = await warmHello(ctx);
  expect(last).toEqual({ calls: 11, instance: first.instance });
  expect(tap.gets.length).toBe(1); // never asked

  // After the release the facet must start again — THAT needs the loader, and gets its refusal, on
  // this call and the next: a startup callback that threw is aborted by `FacetHost#callFacet`, so
  // every attempt asks the loader again instead of replaying the first failure from a broken
  // container. A plain rejection handler, not `expect(…).rejects`: a rejected RPC promise consumed
  // that way is reported unhandled here (the handler attaches a tick late).
  await releasePins(ctx);
  const refused = async () =>
    warmHello(ctx).then(
      () => "answered",
      (error: unknown) => String(error),
    );
  expect(await refused()).toMatch(/LOADER unhealthy/);
  expect(await refused()).toMatch(/LOADER unhealthy/);
  expect(tap.gets.length).toBe(3);
  // Healthy again: the next call re-materializes it.
  tap.refuseAfterFirst = undefined;
  const again = await warmHello(ctx);
  expect(again).toMatchObject({ calls: 1 });
  expect(tap.gets.length).toBe(4);
  for (let i = 0; i < 5; i++) await warmHello(ctx);
  expect(tap.gets.length).toBe(4);
});

// ── pushes: an idle processor a row pushes reads its log once per incarnation ──
// A processor facet's read verbs catch up from the log unless the reduce has provably reached the
// head it was SHOWN (iterate/stream/processor.ts). A push shows a head, and a facet a row pushes is
// told so as it starts (`fedByPushes` in its props, context/facet-host.ts), so its first catch-up's
// head counts as shown too.

test("a processor a row pushes, read between commits it does not consume, reads its log once; one appended after is applied before the next read", async () => {
  const ctx = "prj_idle_facet_reads_once";
  await enable(ctx, "tally", COUNTING_TALLY, ["test/counted"]);
  const facet = tallyOn(ctx);
  // The enable caught the facet up from the log: its one read of this incarnation.
  expect(
    await until("the enable's catch-up", async () => (await facet.logReads()) || undefined),
  ).toBe(1);
  const snapshots: unknown[] = [];
  for (let i = 0; i < 5; i++) {
    await stub(ctx).append({ type: "test/noise" }); // the busy log: a commit the row does not push
    snapshots.push((await facet.snapshot()).state);
  }
  expect({ logReads: await facet.logReads(), snapshots }).toEqual({
    logReads: 1,
    snapshots: [{ n: 0 }, { n: 0 }, { n: 0 }, { n: 0 }, { n: 0 }],
  });
  // An event the row consumes is pushed as it commits: the very next read holds it.
  await stub(ctx).append({ type: "test/counted" });
  expect(await facet.snapshot()).toMatchObject({ state: { n: 1 } });
  await stub(ctx).append({ type: "test/noise" }, { type: "test/counted" });
  expect(await facet.snapshot()).toMatchObject({ state: { n: 2 } });
});

test("a processor no row pushes reads its log on every read — the host's word is what lets a head read from the log stand", async () => {
  const ctx = "prj_unpushed_facet_reads_each_time";
  const facet = tallyOn(ctx, COUNTING_TALLY); // hosted by expression: no row
  const states: unknown[] = [];
  for (let i = 0; i < 4; i++) {
    await stub(ctx).append({ type: "test/counted" });
    states.push((await facet.snapshot()).state);
  }
  expect({ logReads: await facet.logReads(), states }).toEqual({
    logReads: 4,
    states: [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }],
  });
});

// ── a birth and the quiet sweep reset the loaded facets that hold no claim ──
// A claimed facet's work outlives the call that started it on purpose; a first-party facet keeps no
// startup memo and is never reset. A reset is an abort and a start, of the facets called since their
// last start only. What it ENDS — a careless facet billed after its context was evicted — is a
// deployed fact (workerd cannot evict a context whose facet is live, workerd#6800):
// e2e/context-residency.e2e.test.ts and e2e/facet-abort-storage-reset.e2e.test.ts.

test("a context's birth resets its loaded facets that hold no claim, names them on its wake record, and spares a claimed one", async () => {
  const ctx = "prj_facet_birth_reset";
  const s = stub(ctx);
  for (const name of ["idle", "busy"])
    expect(await instanceOf(ctx, name, HELLO)).toEqual(expect.any(String));
  // What `runInBackground` holds while an attempt is in flight: a claim on the context's alarm.
  await s.invoke(["itx", "processors", ["claim", "busy", Date.now() + 60_000]]);
  await releasePins(ctx); // workerd keeps a DO with a live facet resident; the edge does not
  await evictDurableObject(s);

  const woken = (await readLog(ctx)).filter((e) => e.type === "events.iterate.com/itx/woken");
  expect(woken.length).toBe(2);
  expect(woken[0]!.payload).not.toHaveProperty("facetsReset");
  expect(woken[1]!.payload).toMatchObject({ facetsReset: ["idle"] });
  // Both answer after the birth: the reset facet from its startup memo, the claimed one as it was.
  for (const name of ["idle", "busy"])
    expect(await instanceOf(ctx, name)).toEqual(expect.any(String));
  await s.invoke(["itx", "processors", ["claim", "busy", null]]);
});

test("a birth resets only the facets the last incarnation called: one no call reached since is left alone", async () => {
  const ctx = "prj_facet_birth_reset_only_what_ran";
  const s = stub(ctx);
  expect(await instanceOf(ctx, "idle", HELLO)).toEqual(expect.any(String));
  for (let i = 0; i < 2; i++) {
    await releasePins(ctx);
    await evictDurableObject(s);
    await s.invoke(["itx", ["whoami"]]);
  }
  const woken = (await readLog(ctx)).filter((e) => e.type === "events.iterate.com/itx/woken");
  expect(woken.map((event) => (event.payload as { facetsReset?: string[] }).facetsReset)).toEqual([
    undefined,
    ["idle"],
    undefined,
  ]);
});

test("a birth whose start of a facet fails keeps the facet's facet-ran row, and the next birth that starts it drops it", async () => {
  const ctx = "prj_facet_birth_start_fails";
  const s = stub(ctx);
  const rebirth = async () => {
    await releasePins(ctx);
    await evictDurableObject(s);
    await s.invoke(["itx", ["whoami"]]);
  };
  await s.invoke(["itx", "facets", ["get", "fragile", FRAGILE], ["failStartsFor", 3_000]]);
  const failingUntil = Date.now() + 3_000;
  await rebirth();
  expect(await kv(ctx, "facet-ran:fragile")).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, failingUntil - Date.now() + 100));
  await rebirth();
  expect(await kv(ctx, "facet-ran:fragile")).toBeUndefined();
});

test("a context still resident a quiet period after it materialized a loaded facet resets its unclaimed ones in place, on the alarm, and spares a claimed one", async () => {
  const ctx = "prj_facet_quiet_sweep";
  const s = stub(ctx);
  const t0 = fakeDate();
  const before: Record<string, string> = {};
  for (const name of ["idle", "busy"]) before[name] = await instanceOf(ctx, name, HELLO);
  await s.invoke(["itx", "processors", ["claim", "busy", t0 + 10 * 60_000]]);
  // Materializing a loaded facet armed the sweep: the alarm is due a quiet period out.
  expect(await alarmOf(ctx)).toBe(t0 + UNCLAIMED_FACET_SWEEP_AFTER_QUIET_MS);
  vi.setSystemTime(t0 + UNCLAIMED_FACET_SWEEP_AFTER_QUIET_MS);
  expect(await runDurableObjectAlarm(s)).toBe(true);
  // The same incarnation answers: the unclaimed facet from a fresh instance, the claimed one as it was.
  expect(await instanceOf(ctx, "idle")).not.toBe(before.idle);
  expect(await instanceOf(ctx, "busy")).toBe(before.busy);
  const events = await readLog(ctx);
  expect(events.filter((event) => event.type === "events.iterate.com/itx/woken").length).toBe(1);
  await s.invoke(["itx", "processors", ["claim", "busy", null]]);
});

test("the sweep's alarm an evicted incarnation left wakes a fresh one that appends nothing, and re-derives only the durable deadlines", async () => {
  const ctx = "prj_facet_sweep_fresh_wake";
  const s = stub(ctx);
  const t0 = fakeDate();
  await instanceOf(ctx, "plain", HELLO); // arms the sweep
  // A durable deadline ten minutes out: the sweep's alarm is the earlier one.
  const later = t0 + 10 * 60_000;
  await s.invoke([
    "itx",
    "schedules",
    [
      "set",
      { key: "later", when: { at: new Date(later).toISOString() }, events: [{ type: "later" }] },
    ],
  ]);
  expect(await alarmOf(ctx)).toBe(t0 + UNCLAIMED_FACET_SWEEP_AFTER_QUIET_MS);
  const before = await readLog(ctx);
  const incarnation = await runInDurableObject(s, (_instance, state) =>
    Number(
      state.storage.sql.exec("SELECT value FROM stream_meta WHERE key = 'incarnation'").one().value,
    ),
  );
  await releasePins(ctx);
  await evictDurableObject(s);
  vi.setSystemTime(t0 + UNCLAIMED_FACET_SWEEP_AFTER_QUIET_MS);
  expect(await runDurableObjectAlarm(s)).toBe(true);
  expect(await alarmOf(ctx)).toBe(later);
  // The wake appended nothing: the one new event is the wake record of the read below — this
  // incarnation's first inbound call, so its reason is "request" — naming the facet its birth reset.
  const appended = (await readLog(ctx)).slice(before.length);
  expect(appended.map((event) => [event.type, event.payload])).toEqual([
    [
      "events.iterate.com/itx/woken",
      { incarnation: incarnation + 1, reason: "request", facetsReset: ["plain"] },
    ],
  ]);
});

test("the sweep's alarm an evicted incarnation left, with nothing durable, leaves no alarm", async () => {
  const ctx = "prj_facet_sweep_fresh_wake_empty";
  const s = stub(ctx);
  const t0 = fakeDate();
  await instanceOf(ctx, "plain", HELLO);
  expect(await alarmOf(ctx)).toBe(t0 + UNCLAIMED_FACET_SWEEP_AFTER_QUIET_MS);
  await releasePins(ctx);
  await evictDurableObject(s);
  vi.setSystemTime(t0 + UNCLAIMED_FACET_SWEEP_AFTER_QUIET_MS);
  expect(await runDurableObjectAlarm(s)).toBe(true);
  expect(await alarmOf(ctx)).toBeNull();
});

test("a call from loaded code counts while in flight but never restarts the sweep's quiet clock: the unclaimed facet is reset a quiet period after the last OUTSIDE call", async () => {
  const ctx = "prj_facet_sweep_outside_clock";
  const s = stub(ctx);
  const t0 = fakeDate();
  const before = await instanceOf(ctx, "chatty", HELLO);
  // Loaded code calling its own context half a period later — what a chatty facet does.
  vi.setSystemTime(t0 + UNCLAIMED_FACET_SWEEP_AFTER_QUIET_MS / 2);
  await s.invoke("itx.whoami()", [], { principal: null, app: true });
  vi.setSystemTime(t0 + UNCLAIMED_FACET_SWEEP_AFTER_QUIET_MS);
  expect(await runDurableObjectAlarm(s)).toBe(true);
  expect(await instanceOf(ctx, "chatty")).not.toBe(before);
});

test("an outside HTTP request restarts the sweep's quiet clock: a loaded facet a project host keeps reaching is reset only a quiet period after the last request", async () => {
  const ctx = "prj_facet_sweep_http_clock";
  const s = stub(ctx);
  const t0 = fakeDate();
  // What the edge sends a context for a project host's request (worker.ts): a plain fetch naming
  // the facet by itx expression, no loaded-code marker — outside activity.
  const page = async () =>
    (
      await s.fetch(
        new Request("https://site.test/", {
          headers: {
            "x-itx-expression": JSON.stringify(["itx", "facets", ["get", "site", HELLO]]),
          },
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
  expect(await alarmOf(ctx)).toBe(t0 + (UNCLAIMED_FACET_SWEEP_AFTER_QUIET_MS * 3) / 2);
  vi.setSystemTime(t0 + (UNCLAIMED_FACET_SWEEP_AFTER_QUIET_MS * 3) / 2);
  expect(await runDurableObjectAlarm(s)).toBe(true);
  expect(await page()).not.toBe(first);
});

test("a claim's release arms the sweep again: a facet the sweep spared while it was claimed is reset a quiet period after the release", async () => {
  const ctx = "prj_facet_sweep_after_release";
  const s = stub(ctx);
  const t0 = fakeDate();
  const before = await instanceOf(ctx, "busy", HELLO);
  await s.invoke(["itx", "processors", ["claim", "busy", t0 + 10 * 60_000]]);
  // The sweep runs while the claim holds the facet: it spares it, and disarms — nothing is owed
  // until the claim, 10 minutes out.
  vi.setSystemTime(t0 + UNCLAIMED_FACET_SWEEP_AFTER_QUIET_MS);
  expect(await runDurableObjectAlarm(s)).toBe(true);
  expect(await alarmOf(ctx)).toBe(t0 + 10 * 60_000);
  // The release — the facet's own last call — arms it again, a quiet period out.
  const releasedAt = t0 + 2 * UNCLAIMED_FACET_SWEEP_AFTER_QUIET_MS;
  vi.setSystemTime(releasedAt);
  await s.invoke(["itx", "processors", ["claim", "busy", null]], [], {
    principal: null,
    app: true,
  });
  expect(await alarmOf(ctx)).toBe(releasedAt + UNCLAIMED_FACET_SWEEP_AFTER_QUIET_MS);
  vi.setSystemTime(releasedAt + UNCLAIMED_FACET_SWEEP_AFTER_QUIET_MS);
  expect(await runDurableObjectAlarm(s)).toBe(true);
  // The instance the claim kept running is gone: a fresh one answers.
  expect(await instanceOf(ctx, "busy")).not.toBe(before);
});

test("a first-party facet's release arms no sweep: the sweep never resets one, so its finished work leaves the context owing no alarm", async () => {
  const ctx = "prj_facet_sweep_first_party_release";
  const s = stub(ctx);
  await s.invoke(["itx", "processors", ["claim", "project", Date.now() + 10 * 60_000]]);
  await s.invoke(["itx", "processors", ["claim", "project", null]], [], {
    principal: null,
    app: true,
  });
  expect(await alarmOf(ctx)).toBeNull();
});

// ── a claim at a birth ──
// A FIRST-PARTY facet's claim on its context's alarm (an SDK engine's attempt in flight, owed a
// `revive()` by its time) is due at the next birth: the incarnation that ran the attempt is over,
// and work that died with it would otherwise wait out the claim's time. A loaded facet's claim is
// its author's "revive me by `at`" and keeps its time, and so does a claim on the ladder of failed
// revives: a facet that cannot be revived must not cost a revive per birth.

test("a first-party facet's claim the last incarnation left is revived by the next birth at once, not at the claim's time", async () => {
  const ctx = "prj_claim_due_at_birth";
  // The repo facet's engine, as a creation's `runInBackground` holds it: a claim, here a minute out.
  await stub(ctx).invoke(["itx", "processors", ["claim", "repo", Date.now() + 60_000]]);
  await releasePins(ctx); // workerd keeps a DO with a live facet resident; the edge does not
  await evictDurableObject(stub(ctx));

  // The birth: the first call of the fresh incarnation. Its pass revives the facet now, which
  // spends the claim (an engine with nothing in flight claims nothing again).
  await stub(ctx).invoke(["itx", ["readEvents", 0, 1]]);
  await runDurableObjectAlarm(stub(ctx));
  await until(
    "the fresh incarnation revived the repo facet",
    async () => (await kv(ctx, "facet-claim:repo")) === undefined,
  );
});

test("a claim on the ladder of failed revives keeps its backoff across a birth", async () => {
  const ctx = "prj_claim_on_ladder_at_birth";
  const at = Date.now() + 60_000;
  await stub(ctx).invoke(["itx", ["readEvents", 0, 1]]);
  // A claim put back after a revive threw once (FacetHost `reviveDueClaims`), as its rows stand.
  await runInDurableObject(stub(ctx), (_instance, state) => {
    state.storage.kv.put("facet-claim:repo", at);
    state.storage.kv.put("facet-claim-failures:repo", 1);
  });
  await evictDurableObject(stub(ctx));

  await stub(ctx).invoke(["itx", ["readEvents", 0, 1]]);
  await runDurableObjectAlarm(stub(ctx)); // whatever the birth armed: the claim is not due
  expect(await kv(ctx, "facet-claim:repo")).toBe(at);
});

test("a loaded facet's claim keeps its time across a birth: its author's revive-by, never sooner", async () => {
  const ctx = "prj_loaded_claim_at_birth";
  await hostCounter(ctx, hangingCounter(false));
  const at = Date.now() + 60_000;
  await stub(ctx).invoke(["itx", "processors", ["claim", "counter", at]]);
  await releasePins(ctx);
  await evictDurableObject(stub(ctx));

  await stub(ctx).invoke(["itx", ["readEvents", 0, 1]]);
  await runDurableObjectAlarm(stub(ctx));
  expect(await probe(ctx)).toMatchObject({ revives: [] });
  expect(await kv(ctx, "facet-claim:counter")).toBe(at);
});

// ── the platform's facet-start defect ──
// A call into LOADED code that rejects the way the platform's facet-start defect does (V8's
// clone-version text, or the bare "internal error; reference = …") is made once more on a restart
// under a fresh loaded identity, and the facet's row counts the restart. The condition is prd's,
// never local workerd's (`isFacetStartPlatformFailure`), so the loaded code here throws the text
// itself.

test.for([
  { failure: "clone_version", message: CLONE_VERSION_TEXT },
  { failure: "internal_error", message: "internal error; reference = 4f4r7cgj5qomq11vmhb2gc1f" },
])(
  "a facet call that rejects with the platform's $failure text is retried once on a restarted facet under a fresh loaded identity; the batch is reduced exactly once; the row counts one restart",
  async ({ failure, message }) => {
    const ctx = `prj_facet_${failure}`;
    const s = stub(ctx);
    await s.append({
      type: "events.iterate.com/itx/subscription-configured",
      payload: {
        name: "flaky",
        target: [
          "itx",
          "builtins",
          "facets",
          ["get", "flaky", flakyCounter(message)],
          "processEventBatch",
        ],
      },
    });
    const loaderIdBefore = await until("the facet materialized at configure", () =>
      kv<string>(ctx, "facet:flaky:loader-id"),
    );
    // The configure batch is the facet's FIRST push (rejected by the facet, retried by the DO on a
    // restarted facet); the appended event is the next.
    await s.append({ type: "a/1" });
    const durable = (await readLog(ctx)).length;
    await until("every durable event reduced", async () => {
      const snap = await snapshot<{ n: number }>(ctx, "flaky");
      return snap.state.n === durable ? snap : undefined;
    });
    const tries = (await s.invoke("itx.facets.get('flaky').tries()")) as { seq: number }[];
    // The rejected push and its retry at least; the appended event rides the retry when its commit
    // landed while the first push was in flight (a pending push folds), or comes as a third push.
    expect(tries.length).toBeGreaterThanOrEqual(2);
    // every durable event counted once — no double, no loss
    expect(await snapshot<{ n: number }>(ctx, "flaky")).toMatchObject({ state: { n: durable } });
    // The loaded identity was retired once: a fresh isolate. `loaderIdBefore` may already be the
    // retry's (`…#1`) when the configure batch was pushed, rejected and retried before `until`'s
    // first read landed.
    expect(await kv(ctx, "facet:flaky:loader-id")).toBe(`${loaderIdBefore.replace(/#1$/, "")}#1`);
    const rows = (await s.invoke("itx.processors.list()")) as {
      hostedFacet: { restarts: number };
    }[];
    expect(rows.map((row) => row.hostedFacet.restarts)).toEqual([1]); // the one restart, on the row
  },
);

test("a platform start that rejects with the platform's clone-version text restarts once under a fresh loaded identity, and the facet answers", async () => {
  // The platform's own start (facet-host.ts `#start`, after every abort it makes and at a birth)
  // makes one call, `listPublicMethods`: here it rejects once, after `itx.facets.abort`.
  const source = {
    "worker.js": `
import { FacetDurableObject } from "iterate/sdk";
export class StartsFlaky extends FacetDurableObject {
  static publicMethods = [...super.publicMethods, "arm", "hello"];
  arm() { this.ctx.storage.kv.put("reject-next-start", true); }
  hello() { return "hello"; }
  listPublicMethods() {
    if (this.ctx.storage.kv.get("reject-next-start")) {
      this.ctx.storage.kv.delete("reject-next-start");
      throw new Error(${JSON.stringify(CLONE_VERSION_TEXT)});
    }
    return super.listPublicMethods();
  }
}`,
  };
  const ctx = "prj_facet_start_clone_version";
  const s = stub(ctx);
  const call = (method: string) =>
    s.invoke(["itx", "facets", ["get", "flaky", { source, className: "StartsFlaky" }], [method]]);
  await call("arm");
  const loaderIdBefore = await kv<string>(ctx, "facet:flaky:loader-id");
  await s.invoke(["itx", "facets", ["abort", "flaky", "restart it"]]);
  expect(await call("hello")).toBe("hello");
  expect({
    loaderId: await kv(ctx, "facet:flaky:loader-id"),
    restarts: await kv(ctx, "facet:flaky:restarts"),
  }).toEqual({ loaderId: `${loaderIdBefore}#1`, restarts: 1 });
});

test("concurrent stale start failures do not retire the replacement generation twice", async () => {
  const source = {
    "worker.js": `
import { FacetDurableObject } from "iterate/sdk";
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
  const ctx = "prj_facet_race";
  const call = () =>
    stub(ctx).invoke(["itx", "facets", ["get", "race", { source, className: "Racing" }], ["run"]]);
  const [a, b] = await Promise.all([call(), call()]);
  expect(a).toMatchObject({ n: expect.any(Number) });
  expect(b).toMatchObject({ n: expect.any(Number) });
  expect(await kv(ctx, "facet:race:restarts")).toBe(1);
});

test("on a runtime whose facet starts answer one call each, concurrent calls on a running facet each answer", async () => {
  // A lone caller heals (restart, retry first on the fresh start). Two callers on a running facet
  // both fail on it; one restarts it, and the other's retry must not become the fresh start's
  // SECOND call. The facet plays that runtime: its instance answers once, then throws the text.
  const source = {
    "worker.js": `
import { FacetDurableObject } from "iterate/sdk";
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
  const ctx = "prj_facet_one_call_per_start";
  const call = () =>
    stub(ctx).invoke([
      "itx",
      "facets",
      ["get", "spent", { source, className: "OneCallPerStart" }],
      ["run"],
    ]);
  expect(await call()).toEqual({ n: 1 }); // the start's one answer
  expect(await call()).toEqual({ n: 2 }); // a lone caller: restarted, retried first
  // A page's call and a background push on the same running facet.
  const pair = await Promise.all([call(), call()]);
  expect(pair.map((answer) => (answer as { n: number }).n).sort()).toEqual([3, 4]);
  expect(await kv(ctx, "facet:spent:restarts")).toBe(3); // one per failed call
});

test("on a runtime whose facet starts answer one call each, a call killed by a peer's restart answers on a start of its own", async () => {
  // A call in flight on the start it opened is killed by a peer's restart, retries on the
  // replacement — whose one call the peer's retry spent — and then on a restart of its own.
  const source = {
    "worker.js": `
import { FacetDurableObject } from "iterate/sdk";
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
  const ctx = "prj_facet_one_call_per_start_cold";
  const facet = (step: string) =>
    stub(ctx).invoke([
      "itx",
      "facets",
      ["get", "spent", { source, className: "OneCallPerStart" }],
      [step],
    ]);
  const first = facet("run");
  await until("the first call is in flight", async () =>
    (await facet("inFlight")) ? true : undefined,
  );
  const second = facet("run"); // the start's second call: rejected, so it restarts the facet
  expect(
    (await Promise.all([first, second])).map((answer) => (answer as { n: number }).n).sort(),
  ).toEqual([1, 2]);
  expect(await kv(ctx, "facet:spent:restarts")).toBe(2);
});

test("one platform failure while other calls are in flight restarts the facet once; every call answers", async () => {
  // The calls its restart kills retry on the replacement without restarting it again.
  const source = {
    "worker.js": `
import { FacetDurableObject } from "iterate/sdk";
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
  const ctx = "prj_facet_one_failure_in_traffic";
  const facet = (step: string) =>
    stub(ctx).invoke(["itx", "facets", ["get", "steady", { source, className: "Steady" }], [step]]);
  expect(await facet("slow")).toBe("slow");
  const answers = await Promise.all([
    ...Array.from({ length: 5 }, () => facet("slow")),
    facet("failOnce"),
    ...Array.from({ length: 5 }, () => facet("slow")),
  ]);
  expect(answers).toEqual([...Array(5).fill("slow"), "recovered", ...Array(5).fill("slow")]);
  expect(await kv(ctx, "facet:steady:restarts")).toBe(1);
});

// A LOADED WORKER (`itx.workers.get(spec)`, the project ingress's config worker) whose cached
// isolate answers the clone-version text retires its loaded identity (built-ins.ts `workers.get`).
test.for([
  {
    name: "a GET is replayed once on a fresh isolate and answers",
    first: { method: "GET" },
    firstAnswer: { status: 200, text: "GET from a healthy isolate" },
    event: "workers.platform-failure-retry",
  },
  {
    name: "a POST with a body is not replayed: it fails, and the next request answers from a fresh isolate",
    first: { method: "POST", body: "form=1" },
    firstAnswer: { status: 500, text: `expression fetch error: ${CLONE_VERSION_TEXT}\n` },
    event: "workers.platform-failure-retire",
  },
])(
  "a loaded worker whose isolate answers the clone-version text: $name",
  async ({ first, firstAnswer, event }) => {
    const s = stub(`prj_worker_clone_${first.method.toLowerCase()}`);
    const warns = vi.spyOn(console, "warn");
    const page = async (init: RequestInit) => {
      const response = await s.fetch(
        new Request("https://site.test/", {
          ...init,
          headers: {
            "x-itx-expression": JSON.stringify([
              "itx",
              "workers",
              ["get", { source: CLONE_VERSION_WORKER }],
            ]),
          },
        }),
      );
      return { status: response.status, text: await response.text() };
    };

    expect(await page(first)).toEqual(firstAnswer);
    expect(await page({ method: "GET" })).toEqual({
      status: 200,
      text: "GET from a healthy isolate",
    });
    expect(
      warns.mock.calls.filter(([line]) =>
        String(line?.event).startsWith("workers.platform-failure"),
      ),
    ).toEqual([
      [
        expect.objectContaining({
          event,
          requestMethod: first.method,
          message: expect.stringContaining("Unable to deserialize cloned data"),
        }),
      ],
    ]);
  },
);

test("a burst of 20 concurrent callers after a loaded worker's failed cold load runs the producer once, and every caller gets the site", async () => {
  const s = stub("prj_loader_recovers_once");
  expect(await s.invoke(["itx", "facets", ["get", "producer", PRODUCER], ["runs"]])).toBe(0);
  const site: ItxExpression = [
    "itx",
    "workers",
    ["get", { source: ["itx", "facets", ["get", "producer"], ["modules"]], cacheKey: "site@1" }],
    ["hello"],
  ];
  // The cold load's producer answers no modules, so the load fails inside the loader: its id is
  // dead from here. Called in the object: a rejection over the raw stub is also reported unhandled.
  await expect(runInDurableObject(s, (instance) => instance.invoke(site))).rejects.toThrow(
    /a source is its files/,
  );
  const answers = await Promise.all(Array.from({ length: 20 }, () => s.invoke(site)));
  expect(answers).toEqual(Array.from({ length: 20 }, () => "hi"));
  // The failed load and ONE recovery, not one per caller.
  expect(await s.invoke(["itx", "facets", ["get", "producer"], ["runs"]])).toBe(2);
});

// ── sockets: a facet reached by itx expression never answers one; the `secret` facet proxies one ──
// A socket terminates at the edge (a session's /api pager socket, a project host's lent-stub
// upgrade leg), and the facet behind it is reached by itx expression; so `facets.get` refuses an
// upgrade aimed at a facet, FACET_NO_UPGRADE, before the facet is even materialized. A socket a
// facet HELD would die with it, 1006, unseen by the parent. The `secret` facet is reached by
// EGRESS instead: it dials the pinned host with the bearer substituted and hands the 101 straight
// back, holding no socket of its own. Its upstream is in-process (`serveShop`); the dial over the
// real network to a real third party is e2e/secrets.e2e.test.ts's deployed row.

const SHOP = "https://petshop.test";

test("a project host reaches a facet-hosted app over plain HTTP and RPC; a WebSocket upgrade on it is refused (400, FACET_NO_UPGRADE) and materializes nothing", async () => {
  const { ctx, host } = await projectWithAppFacet("facet-app");

  // The upgrade FIRST — before any plain call: a refusal that touched the facet would show as a hit.
  const upgrade = await exports.default.fetch(`${host}/live`, {
    headers: { Upgrade: "websocket" },
  });
  expect(upgrade).toMatchObject({ status: 400, webSocket: null });
  expect(await upgrade.text()).toMatch(/never a WebSocket/);

  // Plain HTTP through the same route: the facet's own fetch answers.
  const page = await exports.default.fetch(`${host}/index`);
  expect(page).toMatchObject({ status: 200 });
  expect(await page.json()).toEqual({ served: "plain-http", hits: 1, path: "/index" });
  // RPC through the itx expression: the same instance (the refused upgrade never reached it).
  expect(await stub(ctx).invoke("itx.facets.get('app').hits()")).toBe(1);
});

test("the DO's invoke method refuses the same upgrade, coded, on a facet it has never started", async () => {
  const ctx = "prj_facet_no_upgrade";
  const upgrade = new Request("https://facet.internal/live", { headers: { Upgrade: "websocket" } });
  const outcome = await (
    stub(ctx).invoke([
      "itx",
      "facets",
      ["get", "app", APP_FACET],
      ["fetch", upgrade],
    ]) as Promise<unknown>
  ).then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, code: errorCode(error), message: String(error) }),
  );
  expect(outcome).toMatchObject({ ok: false, code: "FACET_NO_UPGRADE" });
  // Nothing was materialized: a bare-name call finds no facet to address.
  const bare = await (stub(ctx).invoke("itx.facets.get('app').hits()") as Promise<unknown>).then(
    () => "answered",
    (error: unknown) => errorCode(error),
  );
  expect(bare).toBe("NO_FACET");
  // A plain fetch through `FacetHost#callFacet` hosts it and answers — the ordinary method walk.
  const plain = (await stub(ctx).invoke([
    "itx",
    "facets",
    ["get", "app", APP_FACET],
    ["fetch", new Request("https://facet.internal/page")],
  ])) as Response;
  expect(plain).toMatchObject({ status: 200 });
  expect(await plain.json()).toMatchObject({ served: "plain-http", path: "/page" });
});

test("a WebSocket 101 through a secret: the caller's context forwards to /secrets/shop, whose facet dials the shop's capnweb endpoint with the bearer substituted and hands the 101 back; frames round-trip; the use is a fact with status 101; aborting the facet closes the socket 1006", async () => {
  const accessToken = serveShop();

  const project = "prj_secret_facet_socket";
  const secret = stub(`${project}.iterate/secrets/shop`);
  expect(
    await stub(project).invoke(
      ["itx", "secrets", ["set", "/secrets/shop", accessToken, { urls: [SHOP] }]],
      [],
      { principal: null },
    ),
  ).toEqual({ path: "/secrets/shop" });

  // The upgrade from ANOTHER context of the project — its `#egress` forwards to the secret's.
  const response = await stub(`${project}.iterate/agents/dialler`).fetch(
    new Request(`${SHOP}/capnweb`, {
      headers: { upgrade: "websocket", authorization: 'Bearer getSecret("/secrets/shop")' },
    }),
  );
  expect(response).toMatchObject({ status: 101 });
  const socket = response.webSocket;
  if (!socket) throw new Error("no webSocket on the 101");
  socket.accept();
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    socket.addEventListener("close", (event) =>
      resolve({ code: event.code, reason: event.reason }),
    ),
  );
  const shop = newWebSocketRpcSession(socket as unknown as WebSocket) as any;
  expect(await shop.getPet("pet-1")).toMatchObject({ id: "pet-1", name: "Biscuit" });

  // The use is a fact on the secret's path — the request as received, never the bearer.
  const used = await until("the secret/used fact", async () =>
    (await readLog(`${project}.iterate/secrets/shop`)).find(
      (event) => event.type === "events.iterate.com/secret/used",
    ),
  );
  expect(used).toMatchObject({ payload: { method: "GET", url: `${SHOP}/capnweb`, status: 101 } });
  expect(JSON.stringify(used)).not.toContain(accessToken);

  // The socket lives as long as the facet's dial: abort the facet under it.
  await runInDurableObject(secret, (_instance, state) => {
    state.facets.abort("secret", "the pin: a proxied socket dies with the facet that dialled it");
  });
  expect(await closed).toMatchObject({ code: 1006 });
});

test("a WebSocket whose credential rides in Sec-WebSocket-Protocol: egress substitutes the placeholder there, the shop's /gateway-subprotocol accepts the upgrade and selects its real subprotocol, and the frames round-trip", async () => {
  // A browser cannot set Authorization on a WebSocket, so browser-shaped APIs carry the credential
  // as one of the offered subprotocols, as apps/dummy-petshop/src/gateway.ts reads it.
  const accessToken = serveShop();

  const project = "prj_secret_facet_subprotocol";
  await stub(project).invoke(
    ["itx", "secrets", ["set", "/secrets/shop", accessToken, { urls: [SHOP] }]],
    [],
    { principal: null },
  );

  const response = await stub(`${project}.iterate/agents/browser`).fetch(
    new Request(`${SHOP}/gateway-subprotocol`, {
      headers: {
        upgrade: "websocket",
        "sec-websocket-protocol": 'petshop.v1, petshop.access-token.getSecret("/secrets/shop")',
      },
    }),
  );
  expect(response).toMatchObject({ status: 101 });
  expect(response.headers.get("sec-websocket-protocol")).toBe("petshop.v1");
  const socket = response.webSocket;
  if (!socket) throw new Error("no webSocket on the 101");
  const frames: unknown[] = [];
  socket.addEventListener("message", (event) => {
    frames.push(JSON.parse(event.data as string));
  });
  const closed = new Promise<never>((_, reject) =>
    socket.addEventListener("close", (event) =>
      reject(new Error(`closed ${event.code} after ${JSON.stringify(frames)}`)),
    ),
  );
  closed.catch(() => {});
  const received = (count: number) =>
    Promise.race([
      new Promise<void>((resolve) => {
        const check = () => {
          if (frames.length >= count) resolve();
        };
        socket.addEventListener("message", check);
        check();
      }),
      closed,
    ]);
  socket.accept();

  // The gateway authenticates at the upgrade: a placeholder that reached it unsubstituted is no
  // 101 at all (the fake answers 401), so `ready` is the substituted token accepted.
  await received(2);
  expect(frames).toEqual([{ op: "hello", heartbeatIntervalMs: 30_000 }, { op: "ready" }]);
  socket.send("ping");
  await received(3);
  expect(frames[2]).toEqual({ op: "echo", received: "ping" });
  socket.close();
});

test("an app's fetch expression inherits WebSocket egress through its parent context", async () => {
  // The deployed voice-agent e2e covers the full loaded-facet and audio path; this row is the
  // parent-context forwarding alone, with no deployed Worker Loader.
  const project = "prj_voice_parent_socket";
  const root = stub(project);
  const child = stub(`${project}.iterate/agents/voice`);
  await child.invoke([
    "itx",
    [
      "append",
      {
        type: "events.iterate.com/itx/rewrite-rule-configured",
        payload: { match: "itx", target: ["itx", "builtins", ["cd", "/"]] },
      },
    ],
  ]);
  const accessToken = serveShop();
  await root.invoke(["itx", "secrets", ["set", "/secrets/shop", accessToken, { urls: [SHOP] }]]);
  const response = await child.fetch(
    new Request(`${SHOP}/capnweb`, {
      headers: {
        upgrade: "websocket",
        "x-itx-expression": "itx.fetch",
        "x-itx-app": "1",
        authorization: 'Bearer getSecret("/secrets/shop")',
      },
    }),
  );
  expect(response, response.status === 101 ? "upgraded" : await response.text()).toMatchObject({
    status: 101,
  });
  response.webSocket!.accept();
  response.webSocket!.close();
});

// ── who reaches a facet: what its class lists, where the platform hosts it, what feeds it ──
// Every rule of src/context/facet-public-methods.ts and src/context/first-party-facet-placement.ts
// (each a table test beside it), end to end through a person who signed in with the login form.

/** Where the platform hosts each facet, as `contextOf` names the context, and the facet named
 *  there: the loaded processor is `HELLO_PROCESSOR` enabled at `/tally`, the plain Durable Object
 *  `PLAIN_DURABLE_OBJECT` hosted by expression at `/plain`. */
const FACET_HOSTS = {
  account: ["session.user", ["get", "account"]],
  organization: ["organization", ["get", "organization"]],
  project: ["project /", ["get", "project"]],
  repo: ["project /repos/notes", ["get", "repo"]],
  workspace: ["project /workspaces/notes", ["get", "workspace"]],
  secret: ["project /secrets/api-key", ["get", "secret"]],
  "loaded processor": ["project /tally", ["get", "tally"]],
  "plain Durable Object": ["project /plain", ["get", "plain", PLAIN_DURABLE_OBJECT]],
} satisfies Record<string, [string, unknown[]]>;

/** One row: a facet, a method called on it by itx expression, and what comes of it. A call that
 *  reaches the facet may still fail there (a repo never created, a method called without its
 *  arguments): that is the facet's answer, not the list's. */
const FACET_PUBLIC_METHOD_ROWS: {
  facet: keyof typeof FACET_HOSTS;
  method: string;
  byExpression: "reaches the facet" | "FORBIDDEN";
}[] = [
  // What a class lists reaches the facet: the processor reads every processor lists, and a
  // class's own methods on top.
  { facet: "account", method: "snapshot", byExpression: "reaches the facet" },
  { facet: "account", method: "liveSnapshot", byExpression: "reaches the facet" },
  { facet: "account", method: "waitUntilProcessed", byExpression: "reaches the facet" },
  { facet: "account", method: "fetch", byExpression: "reaches the facet" },
  { facet: "organization", method: "snapshot", byExpression: "reaches the facet" },
  { facet: "project", method: "snapshot", byExpression: "reaches the facet" },
  { facet: "project", method: "repos", byExpression: "reaches the facet" },
  { facet: "project", method: "workspaces", byExpression: "reaches the facet" },
  { facet: "repo", method: "readFile", byExpression: "reaches the facet" },
  { facet: "repo", method: "commitFiles", byExpression: "reaches the facet" },
  { facet: "workspace", method: "readFile", byExpression: "reaches the facet" },
  { facet: "workspace", method: "gitStatus", byExpression: "reaches the facet" },
  { facet: "secret", method: "snapshot", byExpression: "reaches the facet" },
  { facet: "loaded processor", method: "snapshot", byExpression: "reaches the facet" },
  { facet: "loaded processor", method: "hello", byExpression: "reaches the facet" },
  // What feeds a facet is on no list — first-party and loaded alike.
  { facet: "account", method: "processEventBatch", byExpression: "FORBIDDEN" },
  { facet: "account", method: "catchUpFromLog", byExpression: "FORBIDDEN" },
  { facet: "account", method: "revive", byExpression: "FORBIDDEN" },
  { facet: "organization", method: "processEventBatch", byExpression: "FORBIDDEN" },
  { facet: "project", method: "processEventBatch", byExpression: "FORBIDDEN" },
  { facet: "project", method: "catchUpFromLog", byExpression: "FORBIDDEN" },
  { facet: "repo", method: "processEventBatch", byExpression: "FORBIDDEN" },
  { facet: "workspace", method: "revive", byExpression: "FORBIDDEN" },
  { facet: "loaded processor", method: "processEventBatch", byExpression: "FORBIDDEN" },
  { facet: "loaded processor", method: "catchUpFromLog", byExpression: "FORBIDDEN" },
  { facet: "loaded processor", method: "revive", byExpression: "FORBIDDEN" },
  // Nor is what a class has but never listed: the SDK's own plumbing.
  { facet: "account", method: "listPublicMethods", byExpression: "FORBIDDEN" },
  { facet: "account", method: "withItx", byExpression: "FORBIDDEN" },
  { facet: "loaded processor", method: "publishLiveState", byExpression: "FORBIDDEN" },
  // The `secret` facet lists its reads alone.
  { facet: "secret", method: "write", byExpression: "FORBIDDEN" },
  { facet: "secret", method: "clear", byExpression: "FORBIDDEN" },
  { facet: "secret", method: "beginOAuth", byExpression: "FORBIDDEN" },
  { facet: "secret", method: "completeOAuth", byExpression: "FORBIDDEN" },
  { facet: "secret", method: "verifyHmac", byExpression: "FORBIDDEN" },
  { facet: "secret", method: "fetch", byExpression: "FORBIDDEN" },
  { facet: "secret", method: "exportForProjectSeed", byExpression: "FORBIDDEN" },
  { facet: "secret", method: "processEventBatch", byExpression: "FORBIDDEN" },
  // A loaded class that extends neither shell lists nothing.
  { facet: "plain Durable Object", method: "hello", byExpression: "FORBIDDEN" },
  { facet: "plain Durable Object", method: "fetch", byExpression: "FORBIDDEN" },
];

test("a signed-in person calls each facet by itx expression: what its class lists reaches the facet, and everything else is refused FORBIDDEN", async () => {
  const { contextOf } = await personWithProject("facet-public-methods");
  await contextOf("project /tally").invoke([
    "itx",
    "processors",
    ["enable", "tally", HELLO_PROCESSOR],
  ]);
  const outcomes = [];
  for (const row of FACET_PUBLIC_METHOD_ROWS)
    outcomes.push({
      ...row,
      byExpression: await byExpression(() => {
        const [context, facet] = FACET_HOSTS[row.facet];
        return contextOf(context).invoke(["itx", "facets", facet, [row.method]]);
      }),
    });
  expect(outcomes).toEqual(FACET_PUBLIC_METHOD_ROWS);
});

/** One row: the first-party facet named on a context the person holds, and whether the platform
 *  hosts it there. `context` is `session.user` (their own `global:/users/<id>`), `organization` (an
 *  organization they created) or `project <path>` (a path of a project they created). */
const FIRST_PARTY_FACET_PLACEMENT_ROWS: { facet: string; context: string; allowed: boolean }[] = [
  // Where the platform's own code hosts each one.
  { facet: "account", context: "session.user", allowed: true },
  { facet: "organization", context: "organization", allowed: true },
  { facet: "project", context: "project /", allowed: true },
  { facet: "secret", context: "project /secrets/api-key", allowed: true },
  { facet: "repo", context: "project /repos/notes", allowed: true },
  { facet: "workspace", context: "project /", allowed: true },
  // The same names on a context the person holds but the platform never hosts them on.
  { facet: "project", context: "session.user", allowed: false },
  { facet: "organization", context: "session.user", allowed: false },
  { facet: "secret", context: "session.user", allowed: false },
  { facet: "repo", context: "session.user", allowed: false },
  { facet: "workspace", context: "session.user", allowed: false },
  { facet: "account", context: "organization", allowed: false },
  { facet: "account", context: "project /", allowed: false },
  { facet: "organization", context: "project /", allowed: false },
  { facet: "project", context: "project /notes", allowed: false },
  { facet: "secret", context: "project /notes", allowed: false },
  { facet: "secret", context: "project /", allowed: false },
];

test("a signed-in person reaches `itx.facets.get(name)` on every context they hold, but a first-party facet answers only where the platform hosts it — every other placement is refused FORBIDDEN", async () => {
  const { contextOf } = await personWithProject("placement");
  const outcomes = [];
  for (const row of FIRST_PARTY_FACET_PLACEMENT_ROWS)
    outcomes.push({
      ...row,
      outcome: await outcomeOf(() =>
        contextOf(row.context).invoke(["itx", "facets", ["get", row.facet], ["snapshot"]]),
      ),
    });
  expect(outcomes).toEqual(
    FIRST_PARTY_FACET_PLACEMENT_ROWS.map((row) => ({
      ...row,
      outcome: row.allowed ? "answered" : "FORBIDDEN",
    })),
  );
});

test("`processors.enable` of a first-party name off its placement is refused before anything is appended: no row, no facet", async () => {
  const session = await signedInSession("placement-enable@example.com");
  expect(
    await outcomeOf(() => session.user.invoke(["itx", "processors", ["enable", "project"]])),
  ).toBe("FORBIDDEN");
  const rows = (await session.user.invoke(["itx", "processors", ["list"]])) as { name: string }[];
  expect(rows.map((row) => row.name)).not.toContain("project");
});

test("a secret path that resolves onto its owner's root (`/secrets/..`, `/secrets/.`) is refused at `itx.secrets.set`, before it can steer the `secret` facet onto the project's or the person's own root", async () => {
  const session = await signedInSession("placement-secret@example.com");
  const project = await session.projects.create({ project: "placement-secret" });
  for (const context of [project, session.user])
    for (const secretPath of ["/secrets/..", "/secrets/."]) {
      expect(
        await outcomeOf(() =>
          context.invoke([
            "itx",
            "secrets",
            ["set", secretPath, "material", { urls: ["https://api.example.test"] }],
          ]),
        ),
      ).toMatch(
        /a secret's path is \/secrets\/<name>, the name \[a-zA-Z0-9._-\]\+ and never "\." or "\.\."/,
      );
      const rows = (await context.invoke(["itx", "processors", ["list"]])) as { name: string }[];
      expect(rows.map((row) => row.name)).not.toContain("secret");
    }
});

/** Each way a person's OWN code is loaded on a context, as the call a client makes. It runs inside
 *  a project, never in the global namespace: a person's account and an organization run the
 *  platform's code alone. */
const LOADED_CODE_CALLS: Record<string, ItxExpressionInput> = {
  "facets.get(name, spec)": ["itx", "facets", ["get", "tally", PUSH_TALLY], ["hello"]],
  "processors.enable(name, spec)": ["itx", "processors", ["enable", "tally-processor", PUSH_TALLY]],
  "workers.get(spec)": ["itx", "workers", ["get", { source: HELLO_WORKER }], ["hello"]],
  "run(script)": ["itx", ["run", "async (itx) => 'hello from loaded code'"]],
};

const LOADED_CODE_ROWS: {
  call: keyof typeof LOADED_CODE_CALLS;
  context: string;
  allowed: boolean;
}[] = [
  { call: "facets.get(name, spec)", context: "project /", allowed: true },
  { call: "processors.enable(name, spec)", context: "project /", allowed: true },
  { call: "workers.get(spec)", context: "project /notes", allowed: true },
  { call: "run(script)", context: "project /", allowed: true },
  { call: "facets.get(name, spec)", context: "session.user", allowed: false },
  { call: "processors.enable(name, spec)", context: "session.user", allowed: false },
  { call: "workers.get(spec)", context: "session.user", allowed: false },
  { call: "run(script)", context: "session.user", allowed: false },
  { call: "facets.get(name, spec)", context: "organization", allowed: false },
  { call: "workers.get(spec)", context: "organization", allowed: false },
];

test("a signed-in person's own code — a facet, a processor, a worker, a script — runs inside their project, and never on their account or their organization in the global namespace", async () => {
  const { session, contextOf } = await personWithProject("loaded-code");
  const outcomes = [];
  for (const row of LOADED_CODE_ROWS) {
    const outcome = await outcomeOf(() =>
      contextOf(row.context).invoke(LOADED_CODE_CALLS[row.call]),
    );
    // A refused script run settles `failed` on the log; its message crosses, its code does not.
    outcomes.push({
      ...row,
      outcome: /loaded code runs only in a project/.test(outcome) ? "FORBIDDEN" : outcome,
    });
  }
  expect(outcomes).toEqual(
    LOADED_CODE_ROWS.map((row) => ({ ...row, outcome: row.allowed ? "answered" : "FORBIDDEN" })),
  );
  // A refused processor left no row behind, and a refused facet no class to address.
  const rows = (await session.user.invoke(["itx", "processors", ["list"]])) as { name: string }[];
  expect(rows.map((row) => row.name)).not.toContain("tally-processor");
});

// What feeds a facet is the platform's, never a caller's. A facet that reduces its context's log
// is fed by the subscription delivery loop — committed events, with the scanned range that proves
// them — so a forged fact would enter its state without ever being on the log, and a forged range
// would move its checkpoint past real events it would then never reduce. Only the delivery loop and
// the context's alarm drive its catch-up and revive. The `secret` facet holds a value only through
// `itx.secrets`, whose verbs append the attributed facts, and the operator's export takes the admin
// credential only over native RPC. Each row asserts what can be observed afterwards, never which
// mechanism refused it.

/** How far past the facet's checkpoint a forged range claims the log reaches. */
const FORGED_RANGE_LENGTH = 1000;

const OAUTH_PROVIDER = {
  authorizationEndpoint: "https://provider.example.test/authorize",
  tokenEndpoint: "https://provider.example.test/token",
  clientId: "a-client",
};

test("a signed-in person pushes a forged batch into their own `account` facet: no forged fact enters its state, its checkpoint does not move past the log, and their next real fact still folds", async () => {
  const session = await signedInSession("forged-account@example.com");
  const account = session.user;
  const snapshotOf = () =>
    account.invoke(["itx", "facets", ["get", "account"], ["snapshot"]]) as Promise<
      Snapshot<{ authentications: { operationId: string }[]; secrets: Record<string, unknown> }>
    >;
  const before = await snapshotOf();
  const forgedThrough = before.offset + FORGED_RANGE_LENGTH;
  const forgedBatch = [
    forgedEvent(forgedThrough - 1, "events.iterate.com/account/authenticated", {
      credential: "admin-secret",
      at: Date.now(),
      operationId: "forged",
    }),
    forgedEvent(forgedThrough, "events.iterate.com/secret/set", {
      path: "/secrets/forged",
      urls: ["https://evil.example.test"],
    }),
  ];

  await outcomeOf(() =>
    account.invoke([
      "itx",
      "facets",
      ["get", "account"],
      ["processEventBatch", forgedBatch, { after: before.offset, through: forgedThrough }],
    ]),
  );

  const after = await snapshotOf();
  expect.soft(after.state.authentications.map((fact) => fact.operationId)).not.toContain("forged");
  expect.soft(Object.keys(after.state.secrets)).not.toContain("/secrets/forged");
  expect.soft(after.offset).toBeLessThan(forgedThrough);
  // The next real fact on the account: a secret of the person's own, its certificate cross-posted
  // to their account, where `itx.secrets.list()` reads the catalog.
  await account.invoke([
    "itx",
    "secrets",
    ["set", "/secrets/after-forgery", "material", { urls: ["https://api.example.test"] }],
  ]);
  const listed = (await account.invoke(["itx", "secrets", ["list"]])) as { path: string }[];
  expect(listed.map((row) => row.path)).toEqual(["/secrets/after-forgery"]);
});

test("a project member pushes a forged batch into the `project` facet at `/`: no forged certificate enters the catalog, its checkpoint does not move past the log, and the next real secret still lists", async () => {
  const session = await signedInSession("forged-project@example.com");
  const project = await session.projects.create({ project: "forged-project" });
  const snapshotOf = () =>
    project.invoke(["itx", "facets", ["get", "project"], ["snapshot"]]) as Promise<
      Snapshot<{ secrets: Record<string, unknown> }>
    >;
  const before = await snapshotOf();
  const forgedThrough = before.offset + FORGED_RANGE_LENGTH;

  await outcomeOf(() =>
    project.invoke([
      "itx",
      "facets",
      ["get", "project"],
      [
        "processEventBatch",
        [
          forgedEvent(forgedThrough, "events.iterate.com/secret/set", {
            path: "/secrets/forged",
            urls: ["https://evil.example.test"],
          }),
        ],
        { after: before.offset, through: forgedThrough },
      ],
    ]),
  );

  const after = await snapshotOf();
  expect.soft(Object.keys(after.state.secrets)).not.toContain("/secrets/forged");
  expect.soft(after.offset).toBeLessThan(forgedThrough);
  await project.invoke([
    "itx",
    "secrets",
    ["set", "/secrets/after-forgery", "material", { urls: ["https://api.example.test"] }],
  ]);
  const listed = (await project.invoke(["itx", "secrets", ["list"]])) as { path: string }[];
  expect(listed.map((row) => row.path)).toEqual(["/secrets/after-forgery"]);
});

test("a project member pushes forged ticks into their own loaded processor's facet: its count and checkpoint are untouched, and the next real tick still counts", async () => {
  const { facet, tick, snapshot } = await projectWithTally("forged-loaded");
  const before = await snapshot();
  expect(before).toMatchObject({ state: { ticks: 1 } });
  const forgedThrough = before.offset + FORGED_RANGE_LENGTH;
  const forgedTicks = [1, 2, 3, 4, 5].map((n) =>
    forgedEvent(before.offset + n, "events.iterate.com/test/ticked", {}),
  );

  await outcomeOf(() =>
    facet(["processEventBatch", forgedTicks, { after: before.offset, through: forgedThrough }]),
  );

  const after = await snapshot();
  expect.soft(after.state.ticks).toBe(1);
  expect.soft(after.offset).toBeLessThan(forgedThrough);
  await tick();
  expect(await snapshot()).toMatchObject({ state: { ticks: 2 } });
});

test("a project member cannot drive their loaded processor's catch-up or revive: both are the platform's to schedule, and neither answers a caller", async () => {
  const { facet } = await projectWithTally("drive-loaded");
  expect.soft(await outcomeOf(() => facet(["catchUpFromLog"]))).not.toBe("answered");
  expect(await outcomeOf(() => facet(["revive"]))).not.toBe("answered");
});

test.for([
  {
    method: "write",
    args: [{ material: "forged-key", urls: ["https://evil.example.test"], refresh: null }],
  },
  { method: "clear", args: [] },
  {
    // with a callback origin of the caller's choosing
    method: "beginOAuth",
    args: [
      {
        ...OAUTH_PROVIDER,
        clientSecret: "",
        clientAuth: "client_secret_basic",
        urls: ["https://provider.example.test"],
        extra: {},
      },
      "https://evil.example.test",
    ],
  },
])(
  "a project member calls `$method` on the `secret` facet directly: refused, and the value `itx.secrets.set` stored is the one that still verifies",
  async ({ method, args }) => {
    const { secretFacet, verifies } = await projectWithSecret(
      `direct-secret-${method.toLowerCase()}`,
    );
    expect.soft(await outcomeOf(() => secretFacet([method, ...args]))).not.toBe("answered");
    expect(await verifies("forged-key")).toBe(false);
    expect(await verifies("original-key")).toBe(true);
  },
);

test("a project member completes an OAuth exchange on the `secret` facet directly, skipping the `secret/set` fact: refused, and no token is live", async () => {
  const { project, verifies } = await projectWithSecret("direct-secret-complete");
  // The attempt begins the platform's way; its nonce rides the signed `state` of the authorize URL.
  const { authorizationUrl } = (await project.invoke([
    "itx",
    "secrets",
    ["beginOAuth", "/secrets/oauth", OAUTH_PROVIDER],
  ])) as { authorizationUrl: string };
  const [claims] = new URL(authorizationUrl).searchParams.get("state")!.split(".");
  const { nonce } = JSON.parse(
    atob(
      claims!
        .replace(/-/g, "+")
        .replace(/_/g, "/")
        .padEnd(Math.ceil(claims!.length / 4) * 4, "="),
    ),
  ) as { nonce: string };
  // The provider answers the exchange with a token.
  const provider = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    return request.url === OAUTH_PROVIDER.tokenEndpoint
      ? Response.json({ access_token: "direct-access-token", refresh_token: "direct-refresh" })
      : new Response("not found", { status: 404 });
  });
  try {
    expect
      .soft(
        await outcomeOf(() =>
          project
            .cd("/secrets/oauth")
            .invoke([
              "itx",
              "facets",
              ["get", "secret"],
              ["completeOAuth", { code: "a-code", nonce }],
            ]),
        ),
      )
      .not.toBe("answered");
  } finally {
    provider.mockRestore();
  }
  expect(await verifies("direct-access-token", "/secrets/oauth", "accessToken")).toBe(false);
});

test("the operator's secret export takes the admin credential only over native RPC — never through an expression a project's rules could read", async () => {
  const session = await signedInSession("direct-secret-export@example.com");
  const project = (await session.projects.create({ project: "direct-secret-export" })) as {
    invoke(call: unknown[]): Promise<unknown>;
  };
  await project.invoke([
    "itx",
    "secrets",
    ["set", "/secrets/hook", "original-key", { urls: ["https://api.example.test"] }],
  ]);
  const { projectId } = (await project.invoke(["itx", ["whoami"]])) as { projectId: string };
  expect(
    await outcomeOf(() =>
      stub(`${projectId}.iterate/secrets/hook`).invoke([
        "itx",
        "facets",
        ["get", "secret"],
        ["exportForProjectSeed", adminCredentials().secret],
      ]),
    ),
  ).not.toBe("answered");
});

// ── helpers ──

type Snapshot<State> = { offset: number; state: State };

/** `itx.processors.enable(name, spec)` spelled raw at the DO's `append` method: ONE
 *  subscription-configured whose target is the facet's `processEventBatch` through the load chain. */
function enable(ctx: string, name: string, spec: FacetSpec, consumes?: string[]) {
  return stub(ctx).append({
    type: "events.iterate.com/itx/subscription-configured",
    payload: {
      name,
      target: ["itx", "facets", ["get", name, spec], "processEventBatch"],
      consumes,
    },
  });
}

/** `spec`, the hanging counter by default, enabled on `ctx` as the row `counter`, its configure
 *  batch pushed. */
async function hostCounter(ctx: string, spec = hangingCounter(true)) {
  await enable(ctx, "counter", spec);
  await until("the configure batch was pushed", async () => (await probe(ctx)).seen.length === 1);
}

/** What the hanging counter on `ctx` recorded, read without touching the engine. */
function probe(ctx: string) {
  return stub(ctx).invoke(["itx", "facets", ["get", "counter"], ["probe"]]) as Promise<{
    seen: { through: number; hung: number }[];
    revives: { hung: number }[];
    catchups: { hung: number }[];
    checkpoints: { reduced_through_offset: number; state: string }[];
  }>;
}

/** The counter on `ctx` has reduced past `offset` on a fresh instance: every durable event once,
 *  the row live, and no issue logged. */
async function caughtUpPast(ctx: string, offset: number, errors: MockInstance) {
  const healed = await until("the fresh instance reduced past the cut-off batch", async () => {
    const p = await probe(ctx);
    return p.checkpoints.some((c) => c.reduced_through_offset > offset) ? p : undefined;
  });
  const events = await readLog(ctx);
  expect(JSON.parse(healed.checkpoints[0]!.state)).toEqual({ n: events.length }); // each once
  const row = (await stub(ctx).invoke(["itx", "subscriptions", ["get", "counter"]])) as {
    halted?: unknown;
  };
  expect(row.halted).toBeUndefined();
  expect(issueLines(errors)).toEqual([]);
  return healed;
}

/** The `reportIssue` lines the context logged — it runs in this isolate, so they are this console's. */
function issueLines(errors: MockInstance) {
  return errors.mock.calls.flat().filter((line) => JSON.stringify(line).includes('"issue"'));
}

/** The first line logged with `event`. */
function logged(logs: MockInstance, event: string) {
  return until(`the ${event} line`, async () =>
    logs.mock.calls.flat().find((line) => JSON.stringify(line).includes(`"${event}"`)),
  );
}

/** A storage kv row of `ctx`'s DO. */
function kv<T>(ctx: string, key: string) {
  return runInDurableObject(stub(ctx), (_instance, state) => state.storage.kv.get(key) as T);
}

function alarmOf(ctx: string) {
  return runInDurableObject(stub(ctx), (_instance, state) => state.storage.getAlarm());
}

/** Date faked for the rest of the test, from now, which it returns. */
function fakeDate() {
  const t0 = Date.now();
  vi.useFakeTimers({ now: t0, toFake: ["Date"] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  return t0;
}

/** The instance answering as `HELLO` facet `name` on `ctx`, hosted by `spec` when given. */
async function instanceOf(ctx: string, name: string, spec?: FacetSpec) {
  const hello = (await stub(ctx).invoke([
    "itx",
    "facets",
    spec ? ["get", name, spec] : ["get", name],
    ["hello"],
  ])) as { instance: string };
  return hello.instance;
}

type LoaderTap = {
  /** Every `LOADER.get` id, in call order — a refused one included. */
  gets: string[];
  /** Every `WorkerStub.getDurableObjectClass`. */
  classGets: number;
  /** Every `getCode` the REAL loader ran — a cold isolate actually minted. */
  codeCallbacks: number;
  /** When set, every `LOADER.get` after the first throws it. */
  refuseAfterFirst: Error | undefined;
};

/** A counting LOADER on the context DO's live instance, whose facet host reads its `env` at call
 *  time: `env` is the DurableObject base class's plain field, so a copy with a delegating `LOADER`
 *  replaces it (a Proxy would hand the native method a foreign `this`). The tap it returns counts
 *  every `LOADER.get`, `getDurableObjectClass` and `getCode`, and can refuse a get. */
async function tapLoader(ctx: string): Promise<LoaderTap> {
  const tap: LoaderTap = { gets: [], classGets: 0, codeCallbacks: 0, refuseAfterFirst: undefined };
  await runInDurableObject(stub(ctx), (instance) => {
    const inst = instance as unknown as { env: Record<string, unknown> & { LOADER: WorkerLoader } };
    const real = inst.env.LOADER;
    const counting = {
      get(id: string, getCode: Parameters<WorkerLoader["get"]>[1]): WorkerStub {
        const n = tap.gets.push(id);
        if (n > 1 && tap.refuseAfterFirst) throw tap.refuseAfterFirst;
        // Loosely typed on purpose: the stub's generic signatures only get in the way of counting.
        const worker = real.get(id, async () => {
          tap.codeCallbacks++;
          return getCode();
        }) as unknown as Record<
          "getEntrypoint" | "getDurableObjectClass",
          (...a: unknown[]) => unknown
        >;
        return {
          getEntrypoint: (...args: unknown[]) => worker.getEntrypoint(...args),
          getDurableObjectClass: (...args: unknown[]) => {
            tap.classGets++;
            return worker.getDurableObjectClass(...args);
          },
        } as unknown as WorkerStub;
      },
    } as unknown as WorkerLoader;
    inst.env = { ...inst.env, LOADER: counting };
    if (inst.env.LOADER !== counting) throw new Error("instance.env is not patchable this way");
  });
  return tap;
}

type Hello = { calls: number; instance: string };
function hostHello(ctx: string) {
  return stub(ctx).invoke(["itx", "facets", ["get", "x", HELLO], ["hello"]]) as Promise<Hello>;
}
function warmHello(ctx: string) {
  return stub(ctx).invoke("itx.facets.get('x').hello()") as Promise<Hello>;
}

/** `gets.length` unchanged for `quietMs` — the push path has drained (nothing else calls
 *  `FacetHost#callFacet`). */
async function untilLoaderQuiet(tap: LoaderTap, quietMs = 400, timeoutMs = 8_000): Promise<void> {
  let last = tap.gets.length;
  let quietSince = Date.now();
  await until(
    "loader quiet",
    () => {
      if (tap.gets.length !== last) {
        last = tap.gets.length;
        quietSince = Date.now();
      }
      return Date.now() - quietSince >= quietMs;
    },
    timeoutMs,
  );
}

/** The counting tally facet `tally` on `ctx`, by itx expression — `spec` hosts it. */
function tallyOn(ctx: string, spec?: FacetSpec) {
  const call = (step: unknown[]) =>
    stub(ctx).invoke(["itx", "facets", spec ? ["get", "tally", spec] : ["get", "tally"], step]);
  return {
    logReads: () => call(["logReads"]) as Promise<number>,
    snapshot: () => call(["snapshot"]) as Promise<Snapshot<unknown>>,
  };
}

/** The project in the directory, its root context on the admin session, and the app facet
 *  published as its config worker — the ingress target is the hosting spelling. */
async function projectWithAppFacet(project: string) {
  const itx = await (
    await openSession()
  )
    .authenticate(adminCredentials())
    .projects.create({ project });
  await publishConfigWorker(itx, ["itx", "facets", ["get", "app", APP_FACET]]);
  const { projectId } = (await itx.invoke("itx.whoami()")) as { projectId: string };
  return { ctx: projectId, host: `https://app--${project}.projects.test` };
}

/** The shop at `SHOP` for the rest of the test: the isolate's `fetch` — which the secret facet's
 *  terminal dial is — answers that origin in-process and leaves every other one alone. Its endpoints
 *  accept one freshly minted bearer, returned: `/capnweb` in `Authorization` (a capnweb session
 *  over the socket), `/gateway-subprotocol` as the offered `petshop.access-token.<token>`. Anything
 *  else — an unsubstituted placeholder included — is a 401 and no socket. */
function serveShop(): string {
  const accessToken = `shop-token-${crypto.randomUUID()}`;
  const network = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).origin !== SHOP) return network(request);
    return shopFetch(request, accessToken);
  });
  return accessToken;
}

async function shopFetch(request: Request, accessToken: string): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (request.headers.get("upgrade") !== "websocket")
    return new Response("a websocket endpoint", { status: 426 });
  if (pathname === "/capnweb") {
    if (request.headers.get("authorization") !== `Bearer ${accessToken}`)
      return new Response("invalid_token", { status: 401 });
    return newWorkersRpcResponse(request, new Shop());
  }
  if (pathname === "/gateway-subprotocol") {
    const offered = (request.headers.get("sec-websocket-protocol") ?? "")
      .split(",")
      .map((protocol) => protocol.trim());
    if (!offered.includes(`petshop.access-token.${accessToken}`))
      return new Response("invalid_token", { status: 401 });
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    server.accept();
    server.send(JSON.stringify({ op: "hello", heartbeatIntervalMs: 30_000 }));
    server.send(JSON.stringify({ op: "ready" }));
    server.addEventListener("message", (event) => {
      server.send(JSON.stringify({ op: "echo", received: event.data }));
    });
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "sec-websocket-protocol": "petshop.v1" },
    });
  }
  return new Response("not found", { status: 404 });
}

/** The shop's capnweb API, as far as these rows call it. */
class Shop extends RpcTarget {
  getPet(id: string) {
    if (id !== "pet-1") throw new Error(`No pet with id ${id}`);
    return { id: "pet-1", name: "Biscuit", species: "beagle" };
  }
}

/** What a call by expression came to: refused by the list, or anything else — an answer, or the
 *  facet's own failure. */
async function byExpression(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
    return "reaches the facet";
  } catch (error) {
    const refusedByTheList =
      errorCode(error) === "FORBIDDEN" &&
      /is not one of its public methods/.test(error instanceof Error ? error.message : "");
    return refusedByTheList ? "FORBIDDEN" : "reaches the facet";
  }
}

/** What a call came to: `"answered"`, or the code it was refused with (the message when uncoded). */
async function outcomeOf(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
    return "answered";
  } catch (error) {
    return errorCode(error) ?? String(error);
  }
}

/** `<slug>@example.com`, signed in, with an organization and a project `slug` in it; `contextOf`
 *  names a context they hold: `session.user`, `organization`, or `project <path>`. */
async function personWithProject(slug: string) {
  const session = await signedInSession(`${slug}@example.com`);
  const organization = await session.organizations.create({ name: `${slug} org` });
  const project = await session.projects.create({ project: slug, orgId: organization.id });
  const contextOf = (context: string) => {
    if (context === "session.user") return session.user;
    if (context === "organization") return session.organizations.get(organization.id);
    return project.cd(context.slice("project ".length));
  };
  return { session, contextOf };
}

/** A committed-looking event no log ever held, at `offset`. */
function forgedEvent(offset: number, type: string, payload: unknown) {
  return { offset, type, payload, path: "/", createdAt: new Date().toISOString() };
}

/** `<slug>@example.com`'s project `slug` with `TICK_TALLY` enabled at `/tally` and one real tick
 *  reduced. */
async function projectWithTally(slug: string) {
  const session = await signedInSession(`${slug}@example.com`);
  const project = await session.projects.create({ project: slug });
  const tally = project.cd("/tally");
  await tally.invoke(["itx", "processors", ["enable", "tally", TICK_TALLY]]);
  const facet = (call: unknown[]) => tally.invoke(["itx", "facets", ["get", "tally"], call]);
  const tick = async () => {
    const [appended] = (await tally.invoke([
      "itx",
      ["append", { type: "events.iterate.com/test/ticked" }],
    ])) as { offset: number }[];
    await facet(["waitUntilProcessed", { offset: appended!.offset }]);
  };
  await tick();
  return {
    facet,
    tick,
    snapshot: () => facet(["snapshot"]) as Promise<Snapshot<{ ticks: number }>>,
  };
}

/** `<slug>@example.com`'s project `slug` with `/secrets/hook` set through `itx.secrets.set`, and
 *  what a caller reaches: the secret's facet directly, and whether a key verifies as the stored
 *  value. */
async function projectWithSecret(slug: string) {
  const session = await signedInSession(`${slug}@example.com`);
  const project = await session.projects.create({ project: slug });
  await project.invoke([
    "itx",
    "secrets",
    ["set", "/secrets/hook", "original-key", { urls: ["https://api.example.test"] }],
  ]);
  const verifies = async (key: string, secretPath = "/secrets/hook", field?: string) =>
    project.invoke([
      "itx",
      "secrets",
      [
        "verifyHmac",
        secretPath,
        {
          payload: "a webhook body",
          signature: await hmacSha256Hex(key, "a webhook body"),
          field,
        },
      ],
    ]) as Promise<boolean>;
  expect(await verifies("original-key")).toBe(true);
  return {
    project,
    secretFacet: (call: unknown[]) =>
      project.cd("/secrets/hook").invoke(["itx", "facets", ["get", "secret"], call]),
    verifies,
  };
}
