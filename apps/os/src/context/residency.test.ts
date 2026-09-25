// context/residency.test.ts — `Residency` against fake deps and a fake clock: the sweep's one
// decision as a table, which activity moves its quiet clock, what the alarm pass then does, and when
// the pins' timer releases. The same mechanisms inside workerd: __workers-tests__/facet-birth-reset.test.ts,
// alarm-and-pins.test.ts.

import { expect, onTestFinished, test, vi } from "vitest";
import { UNCLAIMED_FACET_SWEEP_AFTER_QUIET_MS as SWEEP } from "./facet-host.ts";
import { Residency, decideQuietDeadline, type QuietDeadlineDecision } from "./residency.ts";

const T = Date.parse("2030-01-01T00:00:00Z");

test.for<{
  row: string;
  armedFor: number | null;
  now: number;
  lastCallEndedAt: number | null;
  workInFlight: number;
  expected: QuietDeadlineDecision;
}>([
  {
    row: "a fresh incarnation armed nothing: its armer was evicted, the wake does nothing",
    armedFor: null,
    now: T + SWEEP,
    lastCallEndedAt: null,
    workInFlight: 0,
    expected: { action: "none" },
  },
  {
    row: "a fresh incarnation with a call in flight still does nothing",
    armedFor: null,
    now: T + SWEEP,
    lastCallEndedAt: T,
    workInFlight: 3,
    expected: { action: "none" },
  },
  {
    row: "not yet due (an earlier deadline woke the alarm): the deadline stands",
    armedFor: T + SWEEP,
    now: T + SWEEP - 1,
    lastCallEndedAt: T,
    workInFlight: 0,
    expected: { action: "none" },
  },
  {
    row: "work in flight at the deadline: a whole window from now",
    armedFor: T + SWEEP,
    now: T + SWEEP,
    lastCallEndedAt: T,
    workInFlight: 1,
    expected: { action: "rearm", at: T + 2 * SWEEP },
  },
  {
    row: "activity ended inside the window: re-armed a window after it",
    armedFor: T + SWEEP,
    now: T + SWEEP,
    lastCallEndedAt: T + 20_000,
    workInFlight: 0,
    expected: { action: "rearm", at: T + 20_000 + SWEEP },
  },
  {
    row: "activity ended one millisecond inside the window: still re-armed",
    armedFor: T + SWEEP,
    now: T + SWEEP,
    lastCallEndedAt: T + 1,
    workInFlight: 0,
    expected: { action: "rearm", at: T + 1 + SWEEP },
  },
  {
    row: "quiet exactly one window, nothing in flight: due",
    armedFor: T + SWEEP,
    now: T + SWEEP,
    lastCallEndedAt: T,
    workInFlight: 0,
    expected: { action: "due", idleSince: T },
  },
  {
    row: "a late alarm (retries, a busy machine): due from the last activity's end",
    armedFor: T + SWEEP,
    now: T + 3 * SWEEP,
    lastCallEndedAt: T + 10_000,
    workInFlight: 0,
    expected: { action: "due", idleSince: T + 10_000 },
  },
  {
    row: "no activity has ended and none is in flight: the arming instant starts the quiet window",
    armedFor: T + SWEEP,
    now: T + SWEEP,
    lastCallEndedAt: null,
    workInFlight: 0,
    expected: { action: "due", idleSince: T },
  },
])("the sweep's rule: $row", ({ expected, ...input }) => {
  expect(decideQuietDeadline({ ...input, windowMs: SWEEP })).toEqual(expected);
});

test.for<{
  name: string;
  /** What happens half a sweep window after a loaded facet armed the sweep at T. */
  midway: (fixture: ReturnType<typeof residencyFixture>) => void;
  expected: {
    resets: number;
    deadlines: { unclaimedFacetSweep: number | null };
  };
}>([
  {
    name: "sweep: nothing since the facet was materialized — reset at the deadline, disarmed",
    midway: () => {},
    expected: { resets: 1, deadlines: { unclaimedFacetSweep: null } },
  },
  {
    name: "sweep: a call from outside ended midway — re-armed a window after it",
    midway: ({ residency }) => {
      residency.inboundCallStarted();
      residency.inboundCallEnded(false);
    },
    expected: { resets: 0, deadlines: { unclaimedFacetSweep: T + SWEEP / 2 + SWEEP } },
  },
  {
    name: "sweep: a call from loaded code ended midway — reset anyway (#2922)",
    midway: ({ residency }) => {
      residency.inboundCallStarted();
      residency.inboundCallEnded(true);
    },
    expected: { resets: 1, deadlines: { unclaimedFacetSweep: null } },
  },
  {
    name: "sweep: a claim or a working alarm pass midway — re-armed a window after it",
    midway: ({ residency }) => residency.outsideActivityEnded(),
    expected: { resets: 0, deadlines: { unclaimedFacetSweep: T + SWEEP / 2 + SWEEP } },
  },
  {
    name: "sweep: an inbound call still in flight — a whole window from the pass",
    midway: ({ residency }) => residency.inboundCallStarted(),
    expected: { resets: 0, deadlines: { unclaimedFacetSweep: T + 2 * SWEEP } },
  },
  {
    name: "sweep: a pin call still in flight — a whole window from the pass",
    midway: ({ residency }) => residency.pinCallStarted(),
    expected: { resets: 0, deadlines: { unclaimedFacetSweep: T + 2 * SWEEP } },
  },
  {
    name: "sweep: a script run still in flight — a whole window from the pass",
    midway: ({ state }) => {
      state.scriptRunsInFlight = 1;
    },
    expected: { resets: 0, deadlines: { unclaimedFacetSweep: T + 2 * SWEEP } },
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

test("sweep: armed when a loaded facet is materialized, one alarm write per quiet period; an inbound call arms nothing", () => {
  const fixture = residencyFixture();
  fixture.residency.inboundCallInOneTurn();
  fixture.residency.armUnclaimedFacetSweep();
  vi.setSystemTime(T + 1_000);
  fixture.residency.armUnclaimedFacetSweep();
  fixture.residency.inboundCallInOneTurn();
  expect({
    reconciles: fixture.reconciles.count,
    deadlines: fixture.residency.deadlines(),
  }).toEqual({ reconciles: 1, deadlines: { unclaimedFacetSweep: T + SWEEP } });
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
  onTestFinished(() => {
    vi.useRealTimers();
    log.mockRestore();
  });
  const state = {
    borrowed: false,
    scriptRunsInFlight: 0,
    unclaimedLoadedFacets: ["site"],
  };
  const facetResets: string[][] = [];
  const reconciles = { count: 0 };
  const released = { count: 0 };
  const heldChanges: boolean[] = [];
  const residency = new Residency({
    name: "project.iterate/",
    facetHost: {
      snapshot: () => ({ facetWorkInFlight: 0, liveFacetNames: [] }),
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
    },
    library: { holdsOpenSocket: () => false, releaseConnections: () => {} },
    scriptRunsInFlight: () => state.scriptRunsInFlight,
    reconcileAlarm: () => {
      reconciles.count += 1;
    },
    inboundCallsHeldChanged: () => {
      heldChanges.push(residency.holdsResident());
    },
  });
  return { residency, state, facetResets, reconciles, released, heldChanges, log };
}
