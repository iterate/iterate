// __workers-tests__/facet-class-loads-at-startup.test.ts — `FacetHost#callFacet`
// (the one method every `itx.facets.get(...)` call lands in) mints a facet's class ONLY for a facet
// that STARTS, so a facet that is already RUNNING never touches the Worker Loader (Cloudflare's
// facet lifecycle; one isolate
// lookup per warm call, and a running facet unreachable for as long as the loader is unhealthy).
//
// Pinned in the `workers` vitest project (it runs inside workerd) because it needs the real LOADER,
// the real `ctx.facets` and the DO's LIVE instance: `FacetHost#callFacet` reads the DO's `env` at call time
// and `env` is the DurableObject base class's plain field, so inside `runInDurableObject` the test
// replaces `instance.env` with a copy whose `LOADER` COUNTS (a plain delegating object — a Proxy
// would hand the native method a foreign `this`): every `LOADER.get`, every
// `getDurableObjectClass`, every `getCode` (= an isolate actually minted), and a hook that can
// REFUSE a get. The bundle this project runs cannot be `vi.mock`ed; this can.
//
//   • RPC path: hosting a facet is ONE `LOADER.get` + ONE `getDurableObjectClass`; 20 warm calls add
//     NONE. The test's direct release (support.ts `releasePins`) aborts it; the next call re-materializes it — one more of
//     each, the isolate still warm — and warm calls after that again add none.
//   • push path: 20 durable events delivered to a hosted facet's `processEventBatch` add NO
//     `LOADER.get` beyond the enable's catch-up.
//   • availability: a loader that REFUSES every get after the first never touches calls to the
//     running facet; only the re-materialization after a release needs it — and fails, coded by the
//     loader, until it is healthy again.

import { runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import { releasePins, stub, until } from "./support.ts";

/** A facet with in-memory state only: a call counter and a per-instance id. A restart shows as
 *  `calls` back to 1 and a new `instance`. */
const HELLO_SRC = /* js */ `
import { FacetDurableObject } from "./processor.js";
export class Hello extends FacetDurableObject {
  static publicMethods = [...super.publicMethods, "hello"];
  calls = 0;
  instance = crypto.randomUUID();
  hello() { this.calls++; return { calls: this.calls, instance: this.instance }; }
}
`;
const HELLO_SPEC = { source: { "cap.js": HELLO_SRC }, className: "Hello" };

/** A hosted PUSH target that counts what the delivery loop hands it — the two verbs the loop calls
 *  on a facet row (subscription-delivery.ts): `catchUpFromLog` once at enable, `processEventBatch`
 *  per batch. In-memory tallies, read back through `stats()`. */
const TALLY_SRC = /* js */ `
import { FacetDurableObject } from "./processor.js";
export class Tally extends FacetDurableObject {
  static publicMethods = [...super.publicMethods, "stats"];
  batches = 0;
  events = 0;
  catchUpFromLog() {}
  processEventBatch(events) { this.batches++; this.events += events.length; }
  stats() { return { batches: this.batches, events: this.events }; }
}
`;

test("hosting a facet is one LOADER.get + one getDurableObjectClass; 20 warm calls add none; a release costs the next call exactly one more of each", async () => {
  const ctx = "prj_facet_door_warm";
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

  // The test's direct release (support.ts `releasePins`) aborts the live facet (support.ts runs production's release directly). The next call
  // re-materializes it: a fresh instance, one more LOADER.get + class mint — the isolate itself is
  // the loader's to keep (no cold build) — and the calls after that are warm again.
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
  const ctx = "prj_facet_door_push";
  const tap = await tapLoader(ctx);
  // Enable the tally target the way `itx.processors.enable` spells it: ONE subscription-configured
  // whose target is the facet's `processEventBatch` through the load chain (alarm-and-pins.test.ts).
  await stub(ctx).append({
    type: "events.iterate.com/stream/subscription-configured",
    payload: {
      name: "tally",
      target: [
        "itx",
        "facets",
        ["get", "tally", { source: { "cap.js": TALLY_SRC }, className: "Tally" }],
        "processEventBatch",
      ],
    },
  });
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
  const ctx = "prj_facet_door_loader_down";
  const tap = await tapLoader(ctx);
  const first = await hostHello(ctx);
  tap.refuseAfterFirst = new Error("simulated: LOADER unhealthy (LOADER.get threw)");

  let last = first;
  for (let i = 0; i < 10; i++) last = await warmHello(ctx);
  expect(last).toEqual({ calls: 11, instance: first.instance });
  expect(tap.gets.length).toBe(1); // never asked

  // After the release the facet must start again — THAT needs the loader, and gets its refusal,
  // on this call and the next: a startup callback that threw is aborted by `FacetHost#callFacet`, so every
  // attempt asks the loader again instead of replaying the first failure from a broken container.
  await releasePins(ctx);
  // A rejected RPC promise consumed through `expect(…).rejects` is reported UNHANDLED by the workers
  // vitest project
  // (the handler attaches a tick late); a plain rejection handler is not.
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

/** Install the counting LOADER on the context DO's live instance (see the header). Returns the tap
 *  `FacetHost#callFacet` writes into from then on — same isolate, same heap. */
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
  return stub(ctx).invoke(["itx", "facets", ["get", "x", HELLO_SPEC], ["hello"]]) as Promise<Hello>;
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
