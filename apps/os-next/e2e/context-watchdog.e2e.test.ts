// e2e/context-watchdog.e2e.test.ts — THE RESIDENCY WATCHDOG against the real platform
// (src/context/residency-watchdog.ts). Every inbound call arms a durable alarm a quarter hour out;
// what must hold is what a timer broke (measured 2026-09-23: a pending `setTimeout` kept an idle
// context resident, billed, for its whole length): an armed context is still evicted ~10 s after
// its last call, and one holding a pager socket still hibernates. Each row counts `stream/woken`
// across three 12 s idles, as context-residency.e2e.test.ts does — one per incarnation.
//
// The RECORD itself needs a whole window of residency, too long for every run: inside workerd it is
// proven with Date faked (__workers-tests__/residency-watchdog.test.ts), and the opt-in row at
// the bottom proves it on a deployed worker, on a context its own two-second schedule keeps awake:
//
//   RUN_RESIDENCY_WATCHDOG_WINDOW=1 WORKER_BASE_URL=<preview> doppler run --project project-worker \
//     --config preview -- pnpm --dir apps/os-next e2e context-watchdog
import { expect, test } from "vitest";
import { RESIDENCY_WATCHDOG_WINDOW_MS } from "../src/context/residency-watchdog.ts";
import { freshCtx, openItx, presence, readAll, sleep } from "./support/client.ts";
import { projectHostsAreLocal } from "./support/project-host.ts";
import { Tools } from "./support/targets.ts";

const HELD = "events.iterate.com/context/held-resident-while-idle";
const WOKEN = "events.iterate.com/stream/woken";
const IDLES = 3;

/** Wake the context IDLES times with a 12 s idle between (the platform evicts an idle actor in
 *  ~10 s, context-residency.e2e.test.ts), then read its log. */
async function logAcrossIdles(itx: any): Promise<any[]> {
  for (let i = 0; i < IDLES; i++) {
    await sleep(12_000);
    await itx.whoami();
  }
  return readAll(itx);
}
const incarnations = (events: any[]): number[] =>
  events.filter((event) => event.type === WOKEN).map((event) => event.payload.incarnation);

test("an armed watchdog does not hold an idle context: evicted in every idle, and its alarm fired in none", async () => {
  const itx = openItx(freshCtx("watchdog_idle"));
  await itx.whoami(); // arms the watchdog
  const events = await logAcrossIdles(itx);
  // One incarnation per idle, numbered consecutively: no watchdog wake came between them.
  const woken = incarnations(events);
  expect(woken.length).toBeGreaterThanOrEqual(IDLES + 1);
  expect(woken).toEqual(woken.map((_, i) => woken[0]! + i));
  expect(events.filter((event) => event.type === HELD)).toEqual([]);
}, 90_000);

test("an armed watchdog does not hold a context with a pager socket open: it hibernates in every idle", async () => {
  const itx = openItx(freshCtx("watchdog_pager"));
  await itx.whoami();
  await itx.provide("itx.watchdogPager", new Tools("watchdog"));
  const events = await logAcrossIdles(itx);
  expect(incarnations(events).length).toBeGreaterThanOrEqual(IDLES + 1);
  expect(await presence(itx)).toEqual(["itx.watchdogPager"]); // the socket stayed open throughout
  expect(events.filter((event) => event.type === HELD)).toEqual([]);
}, 90_000);

// ── OPT-IN, deployed only: a whole window with the context held ──

test.skipIf(projectHostsAreLocal() || process.env.RUN_RESIDENCY_WATCHDOG_WINDOW !== "1")(
  "OPT-IN: a context its own two-second schedule keeps resident is recorded once after a whole window; an idle one touched at the same moment is woken once, for nothing",
  { timeout: RESIDENCY_WATCHDOG_WINDOW_MS + 5 * 60_000 },
  async () => {
    // THE HOLD, by design: an alarm every two seconds never lets the actor idle the ~10 s eviction
    // takes, and an alarm is no inbound call — so the incarnation that armed the watchdog is still
    // the one resident a whole window later, with no inbound call since the schedule was set.
    const held = openItx(freshCtx("watchdog_held"));
    await held.schedules.set({
      key: "tick",
      when: { everyMs: 2_000 },
      events: [{ type: "watchdog/tick" }],
    });
    const control = openItx(freshCtx("watchdog_control"));
    await control.whoami();
    try {
      await sleep(RESIDENCY_WATCHDOG_WINDOW_MS + 60_000);
      const heldEvents = await readAll(held);
      const controlEvents = await readAll(control);
      const story = (events: any[]) =>
        JSON.stringify(
          events
            .filter((event) => event.type === HELD || event.type === WOKEN)
            .map((event) => [event.type, event.createdAt, event.payload]),
        );
      console.log(`[watchdog] held: ${story(heldEvents)}`);
      console.log(`[watchdog] control: ${story(controlEvents)}`);
      // THE HOLD: one incarnation the whole window, ticking (an interval coalesces a late tick, so
      // half the ticks is the floor), and recorded once.
      expect(incarnations(heldEvents)).toHaveLength(1);
      expect(
        heldEvents.filter((event) => event.type === "watchdog/tick").length,
      ).toBeGreaterThanOrEqual(RESIDENCY_WATCHDOG_WINDOW_MS / 4_000);
      const records = heldEvents.filter((event) => event.type === HELD);
      expect(records).toHaveLength(1);
      expect(records[0].payload.incarnation).toBe(incarnations(heldEvents)[0]);
      expect(records[0].payload.idleForMs).toBeGreaterThanOrEqual(RESIDENCY_WATCHDOG_WINDOW_MS);
      // THE CONTROL: evicted ~10 s after its call; the watchdog's alarm woke a fresh incarnation
      // that appended nothing — the read's incarnation is two past the first, with no record.
      const controlIncarnations = incarnations(controlEvents);
      expect(controlIncarnations).toEqual([controlIncarnations[0], controlIncarnations[0]! + 2]);
      expect(controlEvents.filter((event) => event.type === HELD)).toEqual([]);
    } finally {
      await held.schedules.cancel("tick");
    }
  },
);
