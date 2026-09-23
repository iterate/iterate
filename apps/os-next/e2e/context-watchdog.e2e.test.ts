// e2e/context-watchdog.e2e.test.ts — THE RESIDENCY WATCHDOG against the real platform
// (src/context/residency-watchdog.ts). Every inbound call arms a durable alarm a quarter hour out;
// what must hold is what a timer broke (measured 2026-09-23: a pending `setTimeout` kept an idle
// context resident, billed, for its whole length): an armed context is still evicted ~10 s after
// its last call, and one holding a pager socket still hibernates. Each row counts `stream/woken`
// across three 12 s idles, as context-residency.e2e.test.ts does — one per incarnation.
//
// The RECORD itself needs a whole window of residency, too long for every run: inside workerd it is
// proven with Date faked (__workers-tests__/residency-watchdog.test.ts), and the opt-in row at
// the bottom proves it on a deployed worker, on a context an app's open WebSocket holds:
//
//   RUN_RESIDENCY_WATCHDOG_WINDOW=1 WORKER_BASE_URL=<preview> doppler run --project project-worker \
//     --config preview -- pnpm --dir apps/os-next e2e context-watchdog
import { WebSocket as UndiciWebSocket } from "undici";
import { expect, test } from "vitest";
import { RESIDENCY_WATCHDOG_WINDOW_MS } from "../src/context/residency-watchdog.ts";
import { freshCtx, openItx, presence, readAll, sleep } from "./support/client.ts";
import {
  freshDnsSafeProjectSlug,
  projectHostsAreLocal,
  projectUrl,
  registerProject,
} from "./support/project-host.ts";
import { SOURCES } from "./support/sources.ts";
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
  "OPT-IN: a context an app's open WebSocket holds is recorded once after a whole window; an idle one touched at the same moment is woken once, for nothing",
  { timeout: RESIDENCY_WATCHDOG_WINDOW_MS + 5 * 60_000 },
  async () => {
    // THE HOLD: a loaded worker app answers an upgrade with its own WebSocketPair, so the socket runs
    // THROUGH the context — not a hibernatable socket the context accepted — and the context stays
    // resident as long as it is open. Its frames never call the context: a frame every 30 s keeps
    // the edge from closing it idle, and the context sees no inbound call the whole window.
    const slug = freshDnsSafeProjectSlug("watchdog-held");
    const held = openItx(await registerProject(slug));
    await held.provide("itx.apps.site", ["itx", "workers", ["get", { source: SOURCES.site }]]);
    const control = openItx(freshCtx("watchdog_control"));
    await control.whoami();
    const url = projectUrl({ project: slug, app: "site", path: "/" }).href.replace(/^http/, "ws");
    const socket = new UndiciWebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve);
      socket.addEventListener("error", reject);
    });
    const echoes: string[] = [];
    let closed: number | undefined;
    socket.addEventListener("message", (event) => echoes.push(String(event.data)));
    socket.addEventListener("close", (event) => {
      closed = event.code;
    });
    const keepalive = setInterval(() => socket.send("keepalive"), 30_000);
    try {
      await sleep(RESIDENCY_WATCHDOG_WINDOW_MS + 90_000);
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
      // The socket lived the whole window.
      expect(closed).toBeUndefined();
      expect(echoes.length).toBeGreaterThanOrEqual(RESIDENCY_WATCHDOG_WINDOW_MS / 30_000);
      // THE HOLD, recorded once — in the incarnation that is still the current one.
      const records = heldEvents.filter((event) => event.type === HELD);
      expect(records).toHaveLength(1);
      expect(records[0].payload.incarnation).toBe(incarnations(heldEvents).at(-1));
      expect(records[0].payload.idleForMs).toBeGreaterThanOrEqual(RESIDENCY_WATCHDOG_WINDOW_MS);
      // THE CONTROL: evicted ~10 s after its call; the watchdog's alarm woke a fresh incarnation
      // that appended nothing — the read's incarnation is two past the first, with no record.
      const controlIncarnations = incarnations(controlEvents);
      expect(controlIncarnations).toEqual([controlIncarnations[0], controlIncarnations[0]! + 2]);
      expect(controlEvents.filter((event) => event.type === HELD)).toEqual([]);
    } finally {
      clearInterval(keepalive);
      socket.close(1000, "done");
    }
  },
);
