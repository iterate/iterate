// context/residency.test.ts — `Residency` against fake deps and a fake clock: which activity moves
// which quiet clock, what the alarm pass then does, and when the pins' timer releases. The one
// decision both quiet deadlines share is tabled on its own (residency-watchdog.test.ts); the same
// mechanisms inside workerd: __workers-tests__/residency-watchdog.test.ts, facet-birth-reset.test.ts,
// alarm-and-pins.test.ts.

import { expect, onTestFinished, test, vi } from "vitest";
import { UNCLAIMED_FACET_SWEEP_AFTER_QUIET_MS as SWEEP } from "./facet-host.ts";
import { Residency } from "./residency.ts";
import { RESIDENCY_WATCHDOG_WINDOW_MS as W } from "./residency-watchdog.ts";

const T = Date.parse("2030-01-01T00:00:00Z");

test.for<{
  name: string;
  /** What happens half a sweep window after a loaded facet armed the sweep at T. */
  midway: (fixture: ReturnType<typeof residencyFixture>) => void;
  expected: {
    resets: number;
    deadlines: { residencyWatchdog: number | null; unclaimedFacetSweep: number | null };
  };
}>([
  {
    name: "sweep: nothing since the facet was materialized — reset at the deadline, disarmed",
    midway: () => {},
    expected: { resets: 1, deadlines: { residencyWatchdog: null, unclaimedFacetSweep: null } },
  },
  {
    name: "sweep: a call from outside ended midway — re-armed a window after it",
    midway: ({ residency }) => {
      residency.inboundCallStarted();
      residency.inboundCallEnded(false);
    },
    expected: {
      resets: 0,
      deadlines: {
        residencyWatchdog: T + SWEEP / 2 + W,
        unclaimedFacetSweep: T + SWEEP / 2 + SWEEP,
      },
    },
  },
  {
    name: "sweep: a call from loaded code ended midway — reset anyway (#2922)",
    midway: ({ residency }) => {
      residency.inboundCallStarted();
      residency.inboundCallEnded(true);
    },
    expected: {
      resets: 1,
      deadlines: { residencyWatchdog: T + SWEEP / 2 + W, unclaimedFacetSweep: null },
    },
  },
  {
    name: "sweep: a claim or a working alarm pass midway — re-armed a window after it",
    midway: ({ residency }) => residency.outsideActivityEnded(),
    expected: {
      resets: 0,
      deadlines: { residencyWatchdog: null, unclaimedFacetSweep: T + SWEEP / 2 + SWEEP },
    },
  },
  {
    name: "sweep: an inbound call still in flight — a whole window from the pass",
    midway: ({ residency }) => residency.inboundCallStarted(),
    expected: {
      resets: 0,
      deadlines: { residencyWatchdog: T + SWEEP / 2 + W, unclaimedFacetSweep: T + 2 * SWEEP },
    },
  },
  {
    name: "sweep: a pin call still in flight — a whole window from the pass",
    midway: ({ residency }) => residency.pinCallStarted(),
    expected: {
      resets: 0,
      deadlines: { residencyWatchdog: null, unclaimedFacetSweep: T + 2 * SWEEP },
    },
  },
  {
    name: "sweep: a script run still in flight — a whole window from the pass",
    midway: ({ state }) => {
      state.scriptRunsInFlight = 1;
    },
    expected: {
      resets: 0,
      deadlines: { residencyWatchdog: null, unclaimedFacetSweep: T + 2 * SWEEP },
    },
  },
])("$name", async ({ midway, expected }) => {
  const fixture = residencyFixture();
  fixture.residency.armUnclaimedFacetSweep();
  vi.setSystemTime(T + SWEEP / 2);
  midway(fixture);
  vi.setSystemTime(T + SWEEP);
  await fixture.residency.alarmPassStarted(Date.now());
  expect({
    resets: fixture.facetResets.length,
    deadlines: fixture.residency.deadlines(),
  }).toEqual(expected);
});

test("watchdog: armed by the first inbound call, one alarm write per window", () => {
  const fixture = residencyFixture();
  fixture.residency.inboundCallInOneTurn();
  vi.setSystemTime(T + 1_000);
  fixture.residency.inboundCallInOneTurn();
  expect({
    reconciles: fixture.reconciles.count,
    deadlines: fixture.residency.deadlines(),
  }).toEqual({
    reconciles: 1,
    deadlines: { residencyWatchdog: T + W, unclaimedFacetSweep: null },
  });
});

test("the alarm's overdue watch hears when the first inbound call starts and the last one settles, never between", () => {
  const fixture = residencyFixture();
  fixture.residency.inboundCallStarted();
  fixture.residency.inboundCallStarted();
  fixture.residency.inboundCallEnded(false);
  expect(fixture.residency.holdsResident()).toBe(true);
  fixture.residency.inboundCallEnded(true);
  fixture.residency.inboundCallInOneTurn();
  expect({ heldChanges: fixture.heldChanges, held: fixture.residency.holdsResident() }).toEqual({
    heldChanges: [true, false, true, false],
    held: false,
  });
});

test("watchdog: a quiet window records the incarnation once, and never arms again", async () => {
  const fixture = residencyFixture();
  fixture.state.liveFacetNames = ["agent"];
  fixture.residency.inboundCallInOneTurn();
  vi.setSystemTime(T + W);
  await fixture.residency.alarmPassStarted(Date.now());
  fixture.residency.inboundCallInOneTurn();
  expect({
    appended: fixture.appended,
    warned: fixture.warn.mock.calls,
    deadlines: fixture.residency.deadlines(),
  }).toEqual({
    appended: [
      [
        {
          type: "events.iterate.com/context/held-resident-while-idle",
          payload: {
            incarnation: 7,
            idleSince: new Date(T).toISOString(),
            idleForMs: W,
            liveFacets: ["agent"],
            borrowedRpcStubs: 0,
            rpcStubPagers: 0,
            webSockets: 0,
            libraryHoldsSocket: false,
          },
        },
      ],
    ],
    warned: [
      [
        {
          event: "context.held-resident-while-idle",
          namespace: "iterate-context",
          name: "project.iterate/",
          durableObjectId: "context-id",
          incarnation: 7,
          idleSince: new Date(T).toISOString(),
          idleForMs: W,
          liveFacets: ["agent"],
          borrowedRpcStubs: 0,
          rpcStubPagers: 0,
          webSockets: 0,
          libraryHoldsSocket: false,
        },
      ],
    ],
    deadlines: { residencyWatchdog: null, unclaimedFacetSweep: null },
  });
});

test.for([
  {
    name: "pins: a call that ends with a stub borrowed releases it 30 s later",
    borrowed: true,
    releasedAt: { justBefore: 0, at: 1 },
  },
  {
    name: "pins: a call that ends with nothing pinned starts no timer",
    borrowed: false,
    releasedAt: { justBefore: 0, at: 0 },
  },
])("$name", ({ borrowed, releasedAt }) => {
  const fixture = residencyFixture();
  fixture.state.borrowed = borrowed;
  fixture.residency.pinCallStarted();
  fixture.residency.pinCallEnded();
  vi.advanceTimersByTime(30_000 - 1);
  const justBefore = fixture.released.count;
  vi.advanceTimersByTime(1);
  expect({ justBefore, at: fixture.released.count }).toEqual(releasedAt);
});

test("pins: a call started before the timer fires holds it off until that call ends", () => {
  const fixture = residencyFixture();
  fixture.state.borrowed = true;
  fixture.residency.pinCallStarted();
  fixture.residency.pinCallEnded();
  vi.advanceTimersByTime(20_000);
  fixture.residency.pinCallStarted();
  vi.advanceTimersByTime(60_000);
  const whileInFlight = fixture.released.count;
  fixture.residency.pinCallEnded();
  vi.advanceTimersByTime(30_000);
  expect({ whileInFlight, afterQuiet: fixture.released.count }).toEqual({
    whileInFlight: 0,
    afterQuiet: 1,
  });
});

test("pins: the test-only release runs now and cancels the pending timer", () => {
  const fixture = residencyFixture();
  fixture.state.borrowed = true;
  fixture.residency.pinCallStarted();
  fixture.residency.pinCallEnded();
  fixture.residency.releasePinsNow();
  vi.advanceTimersByTime(60_000);
  expect(fixture).toMatchObject({ released: { count: 1 } });
});

test("birth reset: the facets it reset are named on the wake record, and logged", async () => {
  const fixture = residencyFixture();
  fixture.state.unclaimedLoadedFacets = ["site"];
  await fixture.residency.resetUnclaimedFacetsAtBirth();
  expect({
    wakeRecordDetail: fixture.residency.wakeRecordDetail(),
    logged: fixture.log.mock.calls,
  }).toEqual({
    wakeRecordDetail: { facetsReset: ["site"] },
    logged: [
      [
        {
          event: "context.facets-reset-at-birth",
          namespace: "iterate-context",
          name: "project.iterate/",
          facets: ["site"],
        },
      ],
    ],
  });
});

test("birth reset: nothing reset adds nothing to the wake record", async () => {
  const fixture = residencyFixture();
  fixture.state.unclaimedLoadedFacets = [];
  await fixture.residency.resetUnclaimedFacetsAtBirth();
  expect({
    wakeRecordDetail: fixture.residency.wakeRecordDetail(),
    logged: fixture.log.mock.calls,
  }).toEqual({ wakeRecordDetail: {}, logged: [] });
});

/** A `Residency` over fakes, the clock faked at T and restored when the test ends. */
function residencyFixture() {
  vi.useFakeTimers({ now: T });
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  onTestFinished(() => {
    vi.useRealTimers();
    log.mockRestore();
    warn.mockRestore();
  });
  const state = {
    borrowed: false,
    scriptRunsInFlight: 0,
    liveFacetNames: [] as string[],
    unclaimedLoadedFacets: ["site"],
  };
  const facetResets: string[][] = [];
  const appended: unknown[] = [];
  const reconciles = { count: 0 };
  const released = { count: 0 };
  const heldChanges: boolean[] = [];
  const residency = new Residency({
    name: "project.iterate/",
    ctx: {
      id: { toString: () => "context-id" },
      getWebSockets: () => [],
    } as unknown as DurableObjectState,
    facetHost: {
      snapshot: () => ({ facetWorkInFlight: 0, liveFacetNames: state.liveFacetNames }),
      resetUnclaimedLoadedFacets: async () => {
        facetResets.push(state.unclaimedLoadedFacets);
        return state.unclaimedLoadedFacets;
      },
      startFacetsTheLastIncarnationRan: async () => state.unclaimedLoadedFacets,
    },
    rpcStubs: {
      hasBorrowedRpcStubs: () => state.borrowed,
      returnBorrowedRpcStubs: () => {
        released.count += 1;
      },
      rpcStubTransportState: () => ({
        borrowedRpcStubs: 0,
        rpcStubPagers: 0,
        rpcStubPagesInFlight: 0,
        dormant: true,
      }),
    },
    library: { holdsOpenSocket: () => false, releaseConnections: () => {} },
    scriptRunsInFlight: () => state.scriptRunsInFlight,
    incarnation: () => 7,
    append: (events) => {
      appended.push(events);
    },
    reconcileAlarm: () => {
      reconciles.count += 1;
    },
    inboundCallsHeldChanged: () => {
      heldChanges.push(residency.holdsResident());
    },
  });
  return { residency, state, facetResets, appended, reconciles, released, heldChanges, log, warn };
}
