import { describe, expect, test } from "vitest";
import type { StreamEventInput } from "./schemas.ts";
import {
  KEEPALIVE_ALARM_LEAD_MS,
  MAX_CONSECUTIVE_BUSY_REFIRES,
  ProcessorKeepalive,
  REVIVAL_BACKOFF_PLATEAU_MS,
  revivalBackoffMs,
  type KeepaliveRecord,
} from "./stream-processor-keepalive.ts";

const T0 = Date.parse("2026-07-09T12:00:00Z");

/**
 * The keepalive is clock/storage/transport-free by construction, so the whole
 * failure matrix runs against a mutable clock and scripted hooks — the same
 * harness shape as scheduler-processor.test.ts and stream-subscribers.test.ts.
 */
function makeHarness(options: { version?: string; revive?: () => Promise<void> } = {}) {
  const clock = { now: T0 };
  const state: {
    record: KeepaliveRecord | undefined;
    armCalls: (number | null)[];
    facts: StreamEventInput[];
    reviveCalls: KeepaliveRecord[];
    kept: Promise<unknown>[];
    version: string;
    revive: () => Promise<void>;
  } = {
    record: undefined,
    armCalls: [],
    facts: [],
    reviveCalls: [],
    kept: [],
    version: options.version ?? "v1",
    revive: options.revive ?? (() => Promise.resolve()),
  };
  const build = () =>
    new ProcessorKeepalive({
      now: () => clock.now,
      readRecord: () => state.record,
      writeRecord: (record) => {
        state.record = record;
      },
      armAlarm: (atMs) => {
        state.armCalls.push(atMs);
      },
      keepAlive: (work) => {
        state.kept.push(work.catch(() => undefined));
      },
      revive: async (record) => {
        state.reviveCalls.push(record);
        await state.revive();
      },
      appendFact: (event) => {
        state.facts.push(event);
      },
      get version() {
        return state.version;
      },
    });
  return { clock, state, build };
}

/** Settle a tracked promise and let the keepalive observe it. */
async function settle(deferred: { resolve?: () => void; reject?: (e: Error) => void }) {
  deferred.resolve?.();
  deferred.reject?.(new Error("work failed"));
  // Two microtask turns: the work promise settles, then track()'s observer runs.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function deferred() {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("arming", () => {
  test("tracking work arms the alarm one lead ahead and persists the armed time", () => {
    const h = makeHarness();
    const keepalive = h.build();
    keepalive.track(deferred().promise);
    expect(keepalive.armedAtMs).toBe(T0 + KEEPALIVE_ALARM_LEAD_MS);
    expect(h.state.armCalls).toEqual([T0 + KEEPALIVE_ALARM_LEAD_MS]);
    expect(h.state.record?.armedAtMs).toBe(T0 + KEEPALIVE_ALARM_LEAD_MS);
  });

  test("more work while armed re-asserts the same desire, never a later one", () => {
    const h = makeHarness();
    const keepalive = h.build();
    keepalive.track(deferred().promise);
    h.clock.now = T0 + 4_000;
    keepalive.track(deferred().promise);
    // The second track re-asserts the EXISTING desire (so a silently-failed
    // platform write self-heals in a warm incarnation) but must never push
    // the alarm later than the first work's protection.
    expect(new Set(h.state.armCalls)).toEqual(new Set([T0 + KEEPALIVE_ALARM_LEAD_MS]));
    expect(keepalive.armedAtMs).toBe(T0 + KEEPALIVE_ALARM_LEAD_MS);
  });

  test("a fire before the armed time (another subsystem's slice) is ignored", async () => {
    const h = makeHarness();
    const keepalive = h.build();
    keepalive.track(deferred().promise);
    h.clock.now = T0 + 1_000;
    await expect(keepalive.onAlarm()).resolves.toBe("not_due");
    expect(h.state.reviveCalls).toEqual([]);
    expect(h.state.armCalls).toEqual([T0 + KEEPALIVE_ALARM_LEAD_MS]);
  });

  test("a fire while disarmed is a no-op", async () => {
    const h = makeHarness();
    const keepalive = h.build();
    await expect(keepalive.onAlarm()).resolves.toBe("not_due");
    expect(h.state.reviveCalls).toEqual([]);
    expect(h.state.armCalls).toEqual([]);
  });
});

describe("the happy lifecycle", () => {
  test("busy fire pushes the alarm ahead; quiet-clean fire disarms and resets", async () => {
    const h = makeHarness();
    const keepalive = h.build();
    const work = deferred();
    keepalive.track(work.promise);

    // Fire mid-work: still busy, alarm pushed ahead of the work again.
    h.clock.now = T0 + KEEPALIVE_ALARM_LEAD_MS;
    await expect(keepalive.onAlarm()).resolves.toBe("busy_rearmed");
    expect(keepalive.armedAtMs).toBe(h.clock.now + KEEPALIVE_ALARM_LEAD_MS);
    expect(h.state.reviveCalls).toEqual([]);

    // Work settles cleanly; the confirmation fire finds quiet and disarms.
    await settle({ resolve: work.resolve });
    h.clock.now = keepalive.armedAtMs!;
    await expect(keepalive.onAlarm()).resolves.toBe("clean_disarmed");
    expect(keepalive.armedAtMs).toBeNull();
    expect(h.state.reviveCalls).toEqual([]);
    expect(h.state.record).toMatchObject({ revivals: 0, armedAtMs: null });
  });
});

describe("revival", () => {
  test("a fresh incarnation's fire revives: mark-before, safety-net arm, pass, confirmation arm", async () => {
    const h = makeHarness();
    const dying = h.build();
    dying.track(deferred().promise); // armed, then the incarnation "dies"

    const revived = h.build(); // fresh instance over the same record
    h.clock.now = T0 + KEEPALIVE_ALARM_LEAD_MS;
    await expect(revived.onAlarm()).resolves.toBe("revived");

    expect(h.state.reviveCalls).toHaveLength(1);
    expect(h.state.reviveCalls[0]).toMatchObject({ revivals: 1, version: "v1" });
    // Safety net at backoff(1) was armed BEFORE the pass; the successful pass
    // then pulled the alarm back to the confirmation lead.
    expect(h.state.armCalls.at(-2)).toBe(h.clock.now + revivalBackoffMs(1));
    expect(h.state.armCalls.at(-1)).toBe(h.clock.now + KEEPALIVE_ALARM_LEAD_MS);
    // Quiet-clean confirmation resets the budget.
    h.clock.now = revived.armedAtMs!;
    await revived.onAlarm();
    expect(h.state.record).toMatchObject({ revivals: 0, armedAtMs: null });
  });

  test("failed tracked work makes the next fire revive even in a warm incarnation", async () => {
    const h = makeHarness();
    const keepalive = h.build();
    const work = deferred();
    keepalive.track(work.promise);
    await settle({ reject: work.reject });

    h.clock.now = T0 + KEEPALIVE_ALARM_LEAD_MS;
    await keepalive.onAlarm();
    expect(h.state.reviveCalls).toHaveLength(1);
  });

  test("one clean settle does not mask a failure in the same window", async () => {
    const h = makeHarness();
    const keepalive = h.build();
    const good = deferred();
    const bad = deferred();
    keepalive.track(good.promise);
    keepalive.track(bad.promise);
    await settle({ resolve: good.resolve });
    await settle({ reject: bad.reject });

    h.clock.now = T0 + KEEPALIVE_ALARM_LEAD_MS;
    await keepalive.onAlarm();
    expect(h.state.reviveCalls).toHaveLength(1);
  });
});

describe("the crash-loop breaker", () => {
  test("failing revivals back off along the table to the plateau, forever", async () => {
    // Each round is a FRESH incarnation over the same durable record: the DO
    // died owing work, the alarm fired, and the revival pass itself fails
    // (stream unreachable). The retry cadence must decay along the table.
    const h = makeHarness({ revive: () => Promise.reject(new Error("stream unreachable")) });
    h.build().track(deferred().promise); // the dying incarnation arms the alarm

    const expected = [1, 2, 3, 4, 5, 6].map((n) => revivalBackoffMs(n));
    expect(expected).toEqual([
      10_000,
      60_000,
      5 * 60_000,
      30 * 60_000,
      REVIVAL_BACKOFF_PLATEAU_MS,
      REVIVAL_BACKOFF_PLATEAU_MS,
    ]);
    for (const backoff of expected) {
      const fresh = h.build();
      h.clock.now = fresh.armedAtMs!;
      const before = h.clock.now;
      await expect(fresh.onAlarm()).resolves.toBe("revival_failed");
      expect(fresh.armedAtMs).toBe(before + backoff);
    }
    expect(h.state.record?.revivals).toBe(6);
  });

  test("a revival pass that resolves does NOT reset the budget; only quiet-clean does", async () => {
    // The dangerous shape: revive() succeeds every time, but work scheduled
    // by the pass keeps failing. A reset-on-pass-success would loop at the
    // short lead forever; the budget must keep growing instead.
    const h = makeHarness();
    const keepalive = h.build();
    keepalive.track(deferred().promise); // dies in flight

    for (let round = 1; round <= 3; round += 1) {
      const fresh = h.build(); // each round: the follow-on work crashed the DO
      h.clock.now = fresh.armedAtMs ?? h.clock.now + KEEPALIVE_ALARM_LEAD_MS;
      await fresh.onAlarm();
      expect(h.state.record?.revivals).toBe(round);
    }
    // Round 4's safety net sits at backoff(4) = 30m, not at the short lead.
    const fresh = h.build();
    h.clock.now = fresh.armedAtMs!;
    await fresh.onAlarm();
    expect(fresh.armedAtMs! - h.clock.now).toBeLessThanOrEqual(KEEPALIVE_ALARM_LEAD_MS);
    expect(h.state.record?.revivals).toBe(4);
  });

  test("crash-loop evidence lands once at the threshold, keyed on version", async () => {
    const h = makeHarness({ revive: () => Promise.reject(new Error("poison")) });
    h.build().track(deferred().promise);
    for (let i = 0; i < 5; i += 1) {
      const fresh = h.build();
      h.clock.now = fresh.armedAtMs!;
      await fresh.onAlarm();
    }
    expect(h.state.facts).toHaveLength(1);
    expect(h.state.facts[0]).toMatchObject({
      type: "events.iterate.com/stream/error-occurred",
      idempotencyKey: "processor-host-crash-loop:v1",
    });
  });

  test("a new worker version resets the budget (the antidote deployed)", async () => {
    const h = makeHarness({ revive: () => Promise.reject(new Error("poison")) });
    h.build().track(deferred().promise);
    for (let i = 0; i < 4; i += 1) {
      const fresh = h.build();
      h.clock.now = fresh.armedAtMs!;
      await fresh.onAlarm();
    }
    expect(h.state.record?.revivals).toBe(4);

    h.state.version = "v2";
    h.state.revive = () => Promise.resolve();
    const fresh = h.build();
    h.clock.now = fresh.armedAtMs!;
    await fresh.onAlarm();
    expect(h.state.record).toMatchObject({ revivals: 1, version: "v2" });
    // And it retries at the FIRST backoff's confirmation lead, not the plateau.
    expect(fresh.armedAtMs! - h.clock.now).toBe(KEEPALIVE_ALARM_LEAD_MS);
  });

  test("work tracked during the revival pass cannot pull the alarm below the safety net", async () => {
    const h = makeHarness();
    let fresh!: ProcessorKeepalive;
    let armCallsDuringPass = -1;
    let armedDuringPass: number | null = null;
    h.state.revive = async () => {
      fresh.track(deferred().promise); // pass-scheduled work that never settles
      armCallsDuringPass = h.state.armCalls.length;
      armedDuringPass = fresh.armedAtMs;
    };
    h.build().track(deferred().promise); // the dying incarnation

    fresh = h.build();
    h.clock.now = fresh.armedAtMs!;
    await fresh.onAlarm();
    // Mid-pass, the tracked work issued NO arm call: the alarm stayed on the
    // safety net written just before the pass started.
    expect(armedDuringPass).toBe(h.clock.now + revivalBackoffMs(1));
    expect(h.state.armCalls).toHaveLength(armCallsDuringPass + 1); // only the post-pass lead
    expect(h.state.armCalls.at(-1)).toBe(h.clock.now + KEEPALIVE_ALARM_LEAD_MS);
  });

  test("wedged work (nothing ever settles) decays to the revival backoff, never the lead", async () => {
    const h = makeHarness();
    const keepalive = h.build();
    keepalive.track(deferred().promise); // hangs forever

    // Busy fires re-arm at the lead until the wedge cap trips…
    for (let i = 0; i < MAX_CONSECUTIVE_BUSY_REFIRES - 1; i += 1) {
      h.clock.now = keepalive.armedAtMs!;
      await keepalive.onAlarm();
      expect(keepalive.armedAtMs).toBe(h.clock.now + KEEPALIVE_ALARM_LEAD_MS);
    }
    expect(h.state.reviveCalls).toEqual([]);

    // …then the window is wedged: fires become revivals whose safety net
    // grows along the table, so a hung DO costs ~4 wakes a day, not 6 a minute.
    for (const expectedBackoff of [1, 2, 3].map((n) => revivalBackoffMs(n))) {
      h.clock.now = keepalive.armedAtMs!;
      await keepalive.onAlarm();
      expect(keepalive.armedAtMs).toBe(h.clock.now + expectedBackoff);
    }
    expect(h.state.record?.revivals).toBe(3);
  });

  test("a hung revival pass backs off instead of starting a second pass", async () => {
    const gate = deferred();
    const h = makeHarness({ revive: () => gate.promise });
    h.build().track(deferred().promise);

    const fresh = h.build();
    h.clock.now = fresh.armedAtMs!;
    const revival = fresh.onAlarm();
    await Promise.resolve();

    for (let i = 0; i < MAX_CONSECUTIVE_BUSY_REFIRES - 1; i += 1) {
      h.clock.now = fresh.armedAtMs!;
      await expect(fresh.onAlarm()).resolves.toBe("busy_rearmed");
    }
    h.clock.now = fresh.armedAtMs!;
    await expect(fresh.onAlarm()).resolves.toBe("revival_hung_backoff");
    expect(fresh.armedAtMs).toBe(h.clock.now + REVIVAL_BACKOFF_PLATEAU_MS);
    expect(h.state.reviveCalls).toHaveLength(1);

    gate.resolve();
    await expect(revival).resolves.toBe("revived");
  });
});
