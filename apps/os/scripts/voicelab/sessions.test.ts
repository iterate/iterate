// The rule that decides whether a call ending was this harness's doing.
//
// It earns a test because both earlier shapes of it were wrong on real
// hardware, in opposite directions.
//
// Counting ends against a count of asks failed a startup cycle whose audio was
// flawless — 12.7s sent, 12.7s played, zero lost frames — because teardown hung
// up a call that was still live and the allowance came from which plan cases
// were scheduled rather than from what the harness asked for.
//
// Excusing every end that named an asked call fixed that by being loose: it
// would equally excuse a third report, or one arriving a minute later from
// something else. One transition is reported twice BY DESIGN — the device and
// the worker bridge each append their own call-ended for the same callId — and
// that specific pair is what must reconcile, not "any number of ends for a call
// somebody hung up".
import { describe, expect, it } from "vitest";

import { callStartProblems, reconcileCallEnds } from "./sessions.ts";

const asked = [{ callId: "call-a", issuedAtMs: 40_000 }];

describe("reconcileCallEnds", () => {
  it("reconciles the two expected reports of one hang-up", () => {
    /*
     * The device appends call-ended with its own reason; the bridge, watching the
     * same stream, appends its own about a second later. Two reports, one
     * transition, both inside the window after the hang-up went out.
     */
    const ends = [
      { atMs: 40_400, callId: "call-a", reason: "button" },
      { atMs: 41_500, callId: "call-a", reason: "worker bridge: call-ended event" },
    ];
    expect(reconcileCallEnds(ends, asked)).toEqual([]);
  });

  it("fails a third report of the same call", () => {
    /* Two observers, two reports. A third means something reported an end twice,
     * and the loose version of this rule waved it through. */
    const ends = [
      { atMs: 40_400, callId: "call-a", reason: "button" },
      { atMs: 41_500, callId: "call-a", reason: "worker bridge: call-ended event" },
      { atMs: 42_000, callId: "call-a", reason: "worker bridge: call-ended event" },
    ];
    const problems = reconcileCallEnds(ends, asked);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.end.atMs).toBe(42_000);
    expect(problems[0]!.why).toContain("twice");
  });

  it("fails an end naming another call", () => {
    /*
     * THE NEGATIVE THAT MATTERS. Hanging up call A must never absorb call B
     * dying of a provider fault — which is exactly what a count-based allowance
     * of one did.
     */
    const ends = [
      { atMs: 40_400, callId: "call-a", reason: "button" },
      { atMs: 41_000, callId: "call-b", reason: "provider socket closed" },
    ];
    const problems = reconcileCallEnds(ends, asked);
    expect(problems.map((problem) => problem.end.callId)).toEqual(["call-b"]);
    expect(problems[0]!.why).toContain("no hang-up was asked");
  });

  it("fails an end that arrives after the window", () => {
    /* A hang-up explains the reports it caused, not a call that died later. */
    const ends = [{ atMs: 56_000, callId: "call-a", reason: "provider socket closed" }];
    const problems = reconcileCallEnds(ends, asked);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.why).toContain("outside the 10s window");
  });

  it("fails an end that does not name its call", () => {
    /* Every end this harness asks for names its call, so an anonymous one came
     * from somewhere this accounting cannot vouch for. */
    const ends = [{ atMs: 40_400, callId: null, reason: "button" }];
    expect(reconcileCallEnds(ends, asked)).toHaveLength(1);
  });

  it("grants no allowance at all when no hang-up succeeded against a live call", () => {
    /*
     * The allowance is granted after the device accepts a hang-up aimed at a
     * call the stream said was up. With the full plan, teardown's hang-ups find
     * nothing live and grant nothing — so an end still fails. A hang-up that
     * threw grants nothing either.
     */
    const ends = [
      { atMs: 40_400, callId: "call-a", reason: "button" },
      { atMs: 41_500, callId: "call-a", reason: "worker bridge: call-ended event" },
    ];
    expect(reconcileCallEnds(ends, [])).toHaveLength(2);
  });

  it("does not let a report predate the hang-up that would explain it", () => {
    /* Causality as a bound: an end observed before the request went out was
     * caused by something else, whatever call it names. */
    const ends = [{ atMs: 39_000, callId: "call-a", reason: "button" }];
    expect(reconcileCallEnds(ends, asked)).toHaveLength(1);
  });
});

describe("callStartProblems", () => {
  it("passes one call accepted once", () => {
    /* What a warm bridge produces: the request is served, nothing races it. */
    expect(callStartProblems([{ atMs: 8_000, callId: "wsdev" }], [])).toEqual([]);
  });

  it("fails the double-start a cold bridge caused", () => {
    /*
     * MEASURED, on deployed preview_3: call-requested at 01:14:20.573 got no
     * bridge, the device re-asked at 01:14:28.573, both bridges entered at
     * ~01:14:29.1, and the older one appended "superseded by a newer bridge".
     * The session passed everything except the 15s time-to-live, so on a
     * quicker day this defect would have gone unrecorded.
     */
    const problems = callStartProblems(
      [{ atMs: 9_800, callId: "wsdev" }],
      [{ atMs: 9_838, callId: "wsdev", reason: "superseded by a newer bridge" }],
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("superseded by a newer bridge");
  });

  it("fails two acceptances of one request", () => {
    /* Two bridges that both believe they own the call. */
    const problems = callStartProblems(
      [
        { atMs: 9_000, callId: "wsdev" },
        { atMs: 9_900, callId: "wsdev" },
      ],
      [],
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("accepted 2 times");
  });
});

describe("callStartProblems: one request per call", () => {
  it("passes one request answered once", () => {
    expect(
      callStartProblems([{ atMs: 8_000, callId: "wsdev" }], [], [{ atMs: 5_000, callId: "wsdev" }]),
    ).toEqual([]);
  });

  it("fails the device's re-ask, which is how a lost request shows up", () => {
    /*
     * The device re-asks every 8s while a call is pending and is right to. But
     * the re-ask means the first request went unanswered — measured at
     * 01:14:20.573 and 01:14:28.573, exactly 8.000s apart, while the bridge
     * worker built. Recovering from it is not the same as not needing to.
     */
    const problems = callStartProblems(
      [{ atMs: 9_800, callId: "wsdev" }],
      [],
      [
        { atMs: 1_573, callId: "wsdev" },
        { atMs: 9_573, callId: "wsdev" },
      ],
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("took 2 requests");
  });
});
