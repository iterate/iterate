// e2e/scheduled-appends-dormant.e2e.test.ts — the one row that must outwait the real scheduler's idle
// eviction of the actor, in a file of its own so the wait runs beside the suite instead of adding to it.
// No pins are involved: the client's sockets are disposed (PIN_RELEASE_AFTER_IDLE_MS is for borrowed
// stubs and the library's own connections), so the actor is idle the moment the sessions close.
import { createFlake } from "@iterate-com/shared/test-support/flake-test";
import { expect, test } from "vitest";
import { disposeSessions, freshCtx, openItx, readAll, sleep } from "./support/client.ts";
import { scheduledAppendFacetSource } from "./support/scheduled-append-facet.ts";

// Crosses the real idle eviction without a client or waitForEvent keeping the actor active. Measured on
// a deployed preview 2026-09-22 (deadline → alarm woke a NEW incarnation): 10 s never (0/6, the alarm
// fired in the first incarnation), 12 s always (16/16), 15 s always (22/22), 20 s always (22/22). The
// edge is Cloudflare's ~10 s idle eviction; 20 s keeps twice that. 22 s sleep.
//
// KNOWN FLAKE, THE PLATFORM'S: the runtime sometimes holds an armed alarm past its time
// (src/alarm-coordinator.ts, the overdue watch; 2026-09-24 on PR #2950's preview this row's deadline
// fired 20.7 s late, and in soak qvs7pzv6rq 3.6 s late, delivered the instant the reconnect arrived).
// A resident actor's watch passes it within 5 s; this row's actor is evicted on purpose, so nothing
// watches its alarm until the reconnect, and a batch the reconnect's own incarnation commits voids
// the proof of dormancy. The pattern is exactly that case, proven, not presumed: the batch committed
// at or after the reconnect (or 3 s or more past its deadline — normal delivery is p99 4 ms) by a
// pass whose alarm trace says it was armed for exactly this deadline. A pass armed for anything
// else, or no batch at all, is a real failure.
// 70 s: the 22 s sleep and the checks, plus a stall BEFORE the first call reaches the context — a
// fresh project's creation took ~23 s in 2 of 105 soak runs (cxqxfzpv5f, pd5152kz34, 2026-09-24;
// the residual-timeouts cause, measured by its own rows), which is not this row's subject.
const platformHeldTheAlarm = createFlake(
  test,
  /the platform held this deadline's alarm \d+ ms past its time/,
  { timeoutMs: 70_000 },
);

platformHeldTheAlarm(
  "a disconnected userspace facet's deadline fires after the pins' release without another request",
  async () => {
    const ctx = freshCtx("schedule_dormant");
    const itx = openItx(ctx);
    await itx.processors.enable("deadlines", {
      source: scheduledAppendFacetSource,
      className: "DeadlinesDurableObject",
    });
    const at = new Date(Date.now() + 20_000).toISOString();
    const receipt = await itx.facets.get("deadlines").start("dormant", { at });
    disposeSessions();
    await sleep(22_000);
    const reconnectedAt = Date.now();
    const reconnected = openItx(ctx);
    // Committed already — or, when the platform held the alarm, by the reconnected actor.
    const first = await reconnected.waitForEvent({
      type: "job/timed-out",
      afterOffset: receipt.scheduledAtOffset,
      timeoutMs: 15_000,
    });
    const heldMs = Date.parse(first.createdAt) - Date.parse(at);
    if (Date.parse(first.createdAt) >= reconnectedAt || heldMs >= 3_000) {
      // The pass that committed it ran in the incarnation this reconnect reached: its trace is in
      // that incarnation's ring, and says what the alarm was armed for.
      const { events: ring } = await reconnected.readEvents(receipt.scheduledAtOffset, 500, {
        includeEphemeral: true,
      });
      const armedFor = ring.find(
        (event: { type: string; payload: { reason?: string; dueSchedules?: number } }) =>
          event.type === "events.iterate.com/stream/trace/alarm" &&
          event.payload.reason === "alarm-fired" &&
          (event.payload.dueSchedules ?? 0) > 0,
      )?.payload.alarm.before;
      if (armedFor === Date.parse(at))
        throw new Error(`the platform held this deadline's alarm ${heldMs} ms past its time`);
      throw new Error(
        `the deadline's batch committed ${heldMs} ms past ${at} by a pass armed for ${armedFor}`,
      );
    }
    const events = await readAll(reconnected);
    const due = events.filter((event) => event.type === "job/timed-out");
    expect(due).toEqual([first]);
    expect(heldMs).toBeGreaterThanOrEqual(0);
    // THE DIRECT PROOF OF DORMANCY: before the deadline's event the DO woke exactly twice — born by
    // our request, then by its alarm as a new incarnation (never by a request of ours: the sessions
    // were disposed). The reconnect's own wake comes after `due` and is not counted.
    const wakesBeforeDue = events
      .filter(
        (event) => event.type === "events.iterate.com/stream/woken" && event.offset < due[0].offset,
      )
      .map((event) => event.payload.reason);
    expect(wakesBeforeDue).toEqual(["request", "alarm"]);
    expect(await reconnected.schedules.list()).toEqual([]);
    await reconnected.facets.get("deadlines").waitUntilProcessed({ offset: due[0].offset });
    expect(await reconnected.facets.get("deadlines").snapshot()).toMatchObject({
      state: { timedOut: ["dormant"] },
    });
  },
);
