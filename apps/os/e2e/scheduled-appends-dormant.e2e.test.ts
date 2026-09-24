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
// edge is Cloudflare's ~10 s idle eviction; 20 s keeps twice that. 22 s sleep; 45 seconds bound the
// deadline plus reconnect and assertions.
//
// KNOWN FLAKE, THE PLATFORM'S: the runtime sometimes holds an armed alarm 20–60 s past its time
// (src/alarm-coordinator.ts, the overdue watch; 2026-09-24 on PR #2950's preview: this row's deadline
// fired 20.7 s late). A resident actor's watch re-arms it within 5 s; this row's actor is evicted on
// purpose, so nothing watches its alarm until the reconnect — and the reconnect waking it would void
// the proof of dormancy. The pattern is exactly that case: no due event at the reconnect while the
// context's alarm is armed for an instant already past (the WAIT_TIMEOUT's alarm story). An alarm
// never armed ("armed for none") or not yet due ("in N ms") is a real failure.
const platformHeldTheAlarm = createFlake(
  test,
  /waitForEvent: no "job\/timed-out" event after offset \d+ within 1ms — alarm armed for \S+ \(\d+ ms ago\)/,
  { timeoutMs: 44_000 },
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
    // Committed already, or the WAIT_TIMEOUT's alarm story (the flake's pattern, or a real failure).
    const first = await reconnected.waitForEvent({
      type: "job/timed-out",
      afterOffset: receipt.scheduledAtOffset,
      timeoutMs: 1,
    });
    const events = await readAll(reconnected);
    const due = events.filter((event) => event.type === "job/timed-out");
    expect(due).toEqual([first]);
    expect(Date.parse(due[0].createdAt)).toBeGreaterThanOrEqual(Date.parse(at));
    expect(Date.parse(due[0].createdAt)).toBeLessThan(reconnectedAt);
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
