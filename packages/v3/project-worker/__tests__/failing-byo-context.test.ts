// __tests__/failing-byo-context.test.ts — THE OFF-PLATFORM (BRING-YOUR-OWN) CONTEXT.
//
// The vision: `/homeassistant` is a COMPLETELY DIFFERENT context that you implement on the Home
// Assistant box — its own capabilities (run code on the box), its own event log — yet it has all
// the SAME interactions with other contexts, the edge network, and parked capability stubs as a
// DO-backed context. A box connects to /api over capnweb and provides itself; the platform routes
// to it and relays its callbacks.
//
// What ALREADY works (proven live, proofs/prove_byo_stream.mjs): inbound method calls
// (append/read/runCode) route to the off-platform object; its events live in the box, never a CF
// DO. The ONE missing piece is the LIVE FEED below — a subscriber's callback must survive the
// mount so the box can push to it. That callback is a stub in the CONSUMER's capnweb session;
// pushing to it from the BOX's session crosses two sessions through the DO, and nothing retains it
// past the subscribe call. So today it dies "RpcImportHook was already disposed". This test flips
// green once the platform PARKS a callback arg the same way it already parks a top-level provided
// capability (the #parkAsTarget machinery, extended to invoke args).
//
// Run: pnpm exec vitest run --project harness __tests__/failing-byo-context.test.ts

import { afterAll, beforeAll, expect, test } from "vitest";
import { RpcTarget } from "capnweb";
import { startProjectHarness, type ProjectHarness } from "./harness.ts";

const RUN = Date.now().toString(36);
const c = (name: string) => `prj_byo${RUN}_${name}`;

let harness: ProjectHarness;
beforeAll(async () => {
  harness = await startProjectHarness();
}, 120_000);
afterAll(async () => {
  await harness?.stop();
});

async function until<T>(
  label: string,
  fn: () => Promise<T | undefined | false> | T | undefined | false,
  ms = 10_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v !== undefined && v !== false) return v as T;
      last = v;
    } catch (e) {
      last = e;
    }
    if (Date.now() > deadline) throw new Error(`until(${label}): ${String(last)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** The OFF-PLATFORM context/stream, implemented on the box: events in a plain array HERE, and it
 *  pushes each append to any live subscriber. In production this is a Deno/celld/node process; in
 *  the harness it is an in-process RpcTarget reached over the real capnweb + relay + DO path. */
class BoxContext extends RpcTarget {
  log: unknown[] = [];
  #subs: Array<(e: unknown) => unknown> = [];
  append(event: unknown) {
    const offset = this.log.length;
    this.log.push(event);
    for (const cb of this.#subs) void cb(event); // push to live feeds
    return offset;
  }
  read(after = 0) {
    return this.log.slice(after);
  }
  subscribe(cb: (e: unknown) => unknown) {
    this.#subs.push(cb);
    return { ok: true, from: this.log.length };
  }
}

// PROVEN-GREEN BASELINE (the request/response half already works — pins the regression):
test("BYO context: inbound append/read route to the off-platform box (no CF DO stores the events)", async () => {
  const ctx = c("rr");
  const box = new BoxContext();
  const boxItx = await harness.itx(ctx);
  await boxItx.provideCapability({ type: "live", path: ["homeassistant"], capability: box });

  const itx = await harness.itx(ctx);
  await until("mount routable", async () => Array.isArray(await itx.homeassistant.read(0)));
  const off = await itx.homeassistant.append({ type: "motion", room: "kitchen" });
  expect(off).toBe(0);
  expect(box.log).toEqual([{ type: "motion", room: "kitchen" }]); // lives in the box, not a DO
  expect(await itx.homeassistant.read(0)).toEqual([{ type: "motion", room: "kitchen" }]);
});

// THE GAP — flips green when arg-passed callbacks are parked/relayed across the two sessions:
// BUG: a callback handed to a provided (off-platform) capability is a stub in the CONSUMER's
//   capnweb session. subscribe() returns fine (the box stores the reference), but the box's later
//   push crosses BOX-session → DO → CONSUMER-session, and nothing retained the callback past the
//   call — capnweb has disposed it.
// EXPECTED: the box pushes each appended event to the subscriber's callback (a live feed).
// ACTUAL (verified live, prove_byo_stream.mjs): the first push throws
//   "This RpcImportHook was already disposed."
// WHY IT MATTERS: a full off-platform context's clients subscribe to its feeds (sensor streams);
//   without this, /homeassistant can answer calls but can never PUSH — half a context.
test.fails("BYO full context: a live-feed callback survives the mount and receives the box's pushes", async () => {
  const ctx = c("feed");
  const box = new BoxContext();
  const boxItx = await harness.itx(ctx);
  await boxItx.provideCapability({ type: "live", path: ["homeassistant"], capability: box });

  const itx = await harness.itx(ctx);
  const seen: Array<Record<string, unknown>> = [];
  await until("mount routable", async () => Array.isArray(await itx.homeassistant.read(0)));

  await itx.homeassistant.subscribe((e: Record<string, unknown>) => {
    seen.push(e); // the consumer's callback — must survive so the box can push to it
  });
  await itx.homeassistant.append({ type: "doorbell", room: "porch" });

  const got = await until("the box pushed the live event back", () =>
    seen.some((e) => e.type === "doorbell") ? seen : false,
  );
  expect(got).toContainEqual({ type: "doorbell", room: "porch" });
});
