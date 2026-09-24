// context/residency.ts — `Residency`: the context's own mechanisms that end its residency when
// nothing should hold it. On the edge an actor is evicted ~10 s after its last call and hibernates
// when it holds only hibernatable sockets; everything here exists because something can keep it
// resident, billed, past that. The DO forwards its entry points here (an inbound call, a pin's use,
// a claim, an alarm pass, its birth) and reads two deadlines back for its one alarm
// (alarm-coordinator.ts). Four mechanisms, each in memory on purpose — it watches the incarnation
// that armed it, and a fresh one has nothing to watch:
//   - THE PINS' RELEASE: a borrowed rpc stub or the library's open socket, unused for
//     `PIN_RELEASE_AFTER_IDLE_MS`, is returned or closed by a timer (workerd#6800).
//   - THE RESIDENCY WATCHDOG: a context still resident a whole window after its last inbound call,
//     with nothing in flight, is recorded — log-only (context/residency-watchdog.ts).
//   - THE UNCLAIMED-FACET SWEEP: a loaded facet left running without a claim is reset once the
//     context has been quiet from OUTSIDE its loaded code (FacetHost `resetUnclaimedLoadedFacets`).
//   - THE BIRTH RESET: the same reset, run as an incarnation is born, for the facets the last one
//     left running — and a start of every facet it called, before the birth writes anything
//     (FacetHost `startFacetsTheLastIncarnationRan`).
// The two quiet deadlines share one pure rule (`decideQuietDeadline`), each with its own window and
// its own clock. How these four relate to the three session-release mechanisms in the SDK and the
// step walk: apps/os/docs/residency.md.

import { reportIssue } from "iterate/lib";
import type { StreamEventInput } from "iterate/stream/processor";
import type { buildLibrary } from "../library.ts";
import { UNCLAIMED_FACET_SWEEP_AFTER_QUIET_MS, type FacetHost } from "./facet-host.ts";
import { RESIDENCY_WATCHDOG_WINDOW_MS, decideQuietDeadline } from "./residency-watchdog.ts";
import type { RpcStubDirectory } from "./rpc-stubs.ts";

/** How long a context's PINS stay unused — no borrowed rpc stub called, no open socket used —
 *  before a timer returns the stubs and closes the sockets so the actor can hibernate. A pin lives
 *  and dies in memory, so its release needs no durable alarm: the timer dies with the actor, and so
 *  do the pins. */
const PIN_RELEASE_AFTER_IDLE_MS = 30_000;

type ResidencyDeps = {
  /** The DO's name, on every log line. */
  name: string;
  /** `id` names the held actor on the watchdog's warn; `getWebSockets` counts its sockets. */
  ctx: Pick<DurableObjectState, "id" | "getWebSockets">;
  /** The facets' work in flight and live names; the reset the sweep and the birth run. */
  facetHost: Pick<
    FacetHost,
    "snapshot" | "resetUnclaimedLoadedFacets" | "startFacetsTheLastIncarnationRan"
  >;
  /** The borrowed stubs: a pin, and what the release returns. */
  rpcStubs: Pick<
    RpcStubDirectory,
    "hasBorrowedRpcStubs" | "returnBorrowedRpcStubs" | "rpcStubTransportState"
  >;
  /** The library's open sockets: a pin, and what the release closes. */
  library: Pick<ReturnType<typeof buildLibrary>, "holdsOpenSocket" | "releaseConnections">;
  /** The script runs this incarnation is executing (the DO's runner): work in flight. */
  scriptRunsInFlight: () => number;
  /** The stream's incarnation, named on the watchdog's record. */
  incarnation: () => number;
  /** The DO's commit with its committed-event effects: how the watchdog's record is appended. */
  append: (events: StreamEventInput[]) => void;
  /** A deadline here changed: the DO reconciles its alarm, which reads `deadlines()`. */
  reconcileAlarm: () => void;
  /** The first inbound call began or the last one settled (`holdsResident`): the alarm's overdue
   *  watch (alarm-coordinator.ts) runs its timer only while one is in flight. */
  inboundCallsHeldChanged: () => void;
};

export class Residency {
  readonly #deps: ResidencyDeps;

  constructor(deps: ResidencyDeps) {
    this.#deps = deps;
  }

  // ── inbound calls: the watchdog's clock, the sweep's clock, the watchdog's arming ──

  /** Inbound calls — Workers RPC, fetch, socket events; never the alarm — in flight, and when the
   *  last one ended: the watchdog's quiet window runs from there. */
  #inboundCallsInFlight = 0;
  #lastInboundCallEndedAt: number | null = null;
  /** THE UNCLAIMED-FACET SWEEP'S QUIET CLOCK: when the last inbound call from OUTSIDE the project's
   *  loaded code ended (an edge session, HTTP, MCP, a sibling's hop, a socket event), a claim was
   *  made, or an alarm pass did durable work. A call from loaded code — `caller.app`, a loaded
   *  worker's fetch — counts as work while in flight, but does not restart it: a facet that calls its
   *  own context more often than the context would evict would otherwise never be quiet, and never
   *  reset. */
  #lastOutsideActivityEndedAt: number | null = null;

  /** An inbound call begins, and arms the watchdog when none is armed: one alarm write per quiet
   *  window, not per call. Before the call's wake record, so a fresh incarnation's first commit
   *  supersedes the alarm its predecessor's watchdog left in one write, not a delete and a set. */
  inboundCallStarted(): void {
    this.#inboundCallsInFlight += 1;
    if (this.#inboundCallsInFlight === 1) this.#deps.inboundCallsHeldChanged();
    if (this.#residencyWatchdogArmedFor !== null || this.#residencyWatchdogRecorded) return;
    this.#residencyWatchdogArmedFor = Date.now() + RESIDENCY_WATCHDOG_WINDOW_MS;
    this.#deps.reconcileAlarm();
  }

  inboundCallEnded(fromLoadedCode: boolean): void {
    this.#inboundCallsInFlight -= 1;
    this.#lastInboundCallEndedAt = Date.now();
    if (!fromLoadedCode) this.#lastOutsideActivityEndedAt = this.#lastInboundCallEndedAt;
    if (this.#inboundCallsInFlight === 0) this.#deps.inboundCallsHeldChanged();
  }

  /** An inbound call is in flight: the actor is held resident whatever else it does. */
  holdsResident(): boolean {
    return this.#inboundCallsInFlight > 0;
  }

  /** An inbound call that runs in ONE synchronous turn (`append`, `read`, a lend, a socket event):
   *  begun and ended at once — the clock does not move inside a turn. */
  inboundCallInOneTurn(): void {
    this.inboundCallStarted();
    this.inboundCallEnded(false);
  }

  /** Activity that is no inbound call but restarts the sweep's quiet clock: a claim, an alarm pass
   *  that did durable work. */
  outsideActivityEnded(): void {
    this.#lastOutsideActivityEndedAt = Date.now();
  }

  // ── THE PINS' RELEASE: borrowed stubs returned and sockets closed by a timer, so this actor can hibernate (workerd#6800) ──

  /** THE PINS' TIMER: a pin's use — a borrowed stub called, the library's socket used (the two
   *  things that keep an actor resident on the edge, both measured) — starts the quiet period over
   *  when the call ENDS; a call in flight holds it off (a stub is never returned out from under a
   *  call); its end releases every pin (`#releasePins`). In memory on purpose: the pins are, and
   *  the pin itself keeps the actor resident until the timer fires. A pending timer holds off
   *  eviction AND hibernation, billed, for its whole length (measured 2026-09-23) — harmless only
   *  because this one is armed while a pin already holds the actor, and for 30 s; nothing pinned
   *  means nothing to release. A live facet is not a pin: it does not hold this actor — it runs on
   *  after the actor is evicted, and the next incarnation's birth resets it unless it is claimed. */
  #pinReleaseTimer: ReturnType<typeof setTimeout> | undefined;
  #pinCallsInFlight = 0;

  pinCallStarted(): void {
    this.#pinCallsInFlight += 1;
    clearTimeout(this.#pinReleaseTimer);
    this.#pinReleaseTimer = undefined;
  }

  pinCallEnded(): void {
    this.#pinCallsInFlight -= 1;
    if (this.#pinCallsInFlight > 0) return;
    // A call that ends with nothing pinned (an HTTP client's, a stub returned mid-call) starts no
    // timer: a pending timer holds off eviction and hibernation, and there would be nothing to release.
    if (!this.#deps.rpcStubs.hasBorrowedRpcStubs() && !this.#deps.library.holdsOpenSocket()) return;
    this.#pinReleaseTimer = setTimeout(() => {
      this.#pinReleaseTimer = undefined;
      this.#releasePins();
    }, PIN_RELEASE_AFTER_IDLE_MS);
  }

  /** The release now, the timer cleared — the DO's test-only `releasePins`, which aborts the live
   *  facets first. */
  releasePinsNow(): void {
    clearTimeout(this.#pinReleaseTimer);
    this.#pinReleaseTimer = undefined;
    this.#releasePins();
  }

  /** THE RELEASE: every borrowed stub returned, every library connection closed — the pins. Never a
   *  facet: a facet is not a pin (it does not hold this actor), and one may be mid-attempt — an LLM
   *  call in its background — that an abort would kill for nothing; the claimed ones outlive this
   *  incarnation on purpose. */
  #releasePins(): void {
    this.#deps.rpcStubs.returnBorrowedRpcStubs();
    this.#deps.library.releaseConnections();
  }

  // ── the two quiet deadlines on the one alarm ──

  /** The watchdog's deadline, epoch ms — in memory on purpose: a fresh incarnation has none, so the
   *  alarm an evicted one left wakes it for nothing. */
  #residencyWatchdogArmedFor: number | null = null;
  /** Once per incarnation: a recorded incarnation is never armed again. */
  #residencyWatchdogRecorded = false;
  /** The sweep's deadline, epoch ms — in memory on purpose, like the watchdog's: a fresh incarnation
   *  has none, so the alarm an evicted one left wakes it only for its birth, which did the reset. */
  #unclaimedFacetSweepArmedFor: number | null = null;

  /** This incarnation's two deadlines on the one alarm; neither is an obligation a fresh
   *  incarnation derives again. */
  deadlines(): { residencyWatchdog: number | null; unclaimedFacetSweep: number | null } {
    return {
      residencyWatchdog: this.#residencyWatchdogArmedFor,
      unclaimedFacetSweep: this.#unclaimedFacetSweepArmedFor,
    };
  }

  /** A loaded facet was materialized, or a claim released: the sweep is owed once this context has
   *  been quiet for `UNCLAIMED_FACET_SWEEP_AFTER_QUIET_MS`. Armed when none is: one alarm write per
   *  quiet period. */
  armUnclaimedFacetSweep(): void {
    if (this.#unclaimedFacetSweepArmedFor !== null) return;
    this.#unclaimedFacetSweepArmedFor = Date.now() + UNCLAIMED_FACET_SWEEP_AFTER_QUIET_MS;
    this.#deps.reconcileAlarm();
  }

  /** The first thing every alarm pass does, inside the coordinator's hold: the watchdog's
   *  decision, then the sweep's. A wake with nothing durable due is theirs alone. */
  async alarmPassStarted(now: number): Promise<void> {
    this.#checkResidencyWatchdog(now);
    await this.#checkUnclaimedFacetSweep(now);
  }

  /** Inbound calls, facet work, script runs and pin calls in flight right now — what keeps both quiet
   *  deadlines from coming due. */
  #workInFlight(facetWorkInFlight: number): number {
    return (
      this.#inboundCallsInFlight +
      facetWorkInFlight +
      this.#deps.scriptRunsInFlight() +
      this.#pinCallsInFlight
    );
  }

  /** The watchdog's decision: nothing, a later deadline, or THE RECORD — one appended fact and one
   *  structured `console.warn`, whose `durableObjectId` finds the held session's still-open
   *  invocation in Workers Logs. Nothing pages on it yet: scripts/ci/prd-fault-alarm.ts pages on
   *  5xx, platform-failure heals and errors. Never an abort, and never a failed pass. */
  #checkResidencyWatchdog(now: number): void {
    const facets = this.#deps.facetHost.snapshot();
    const decision = decideQuietDeadline({
      armedFor: this.#residencyWatchdogArmedFor,
      now,
      lastCallEndedAt: this.#lastInboundCallEndedAt,
      workInFlight: this.#workInFlight(facets.facetWorkInFlight),
      windowMs: RESIDENCY_WATCHDOG_WINDOW_MS,
    });
    if (decision.action === "none") return;
    if (decision.action === "rearm") {
      this.#residencyWatchdogArmedFor = decision.at;
      return;
    }
    this.#residencyWatchdogArmedFor = null;
    this.#residencyWatchdogRecorded = true;
    const transport = this.#deps.rpcStubs.rpcStubTransportState();
    const payload = {
      incarnation: this.#deps.incarnation(),
      idleSince: new Date(decision.idleSince).toISOString(),
      idleForMs: now - decision.idleSince,
      liveFacets: facets.liveFacetNames.slice(0, 32),
      borrowedRpcStubs: transport.borrowedRpcStubs,
      rpcStubPagers: transport.rpcStubPagers,
      webSockets: this.#deps.ctx.getWebSockets().length,
      libraryHoldsSocket: this.#deps.library.holdsOpenSocket(),
    };
    console.warn({
      event: "context.held-resident-while-idle",
      namespace: "iterate-context",
      name: this.#deps.name,
      durableObjectId: this.#deps.ctx.id.toString(),
      ...payload,
    });
    try {
      this.#deps.append([{ type: "events.iterate.com/context/held-resident-while-idle", payload }]);
    } catch (error) {
      reportIssue("iterate-context.residency-watchdog", error, {
        incarnation: payload.incarnation,
      });
    }
  }

  /** The sweep's decision, by the watchdog's rule with its own window and its own clock
   *  (`#lastOutsideActivityEndedAt`): nothing, a later deadline while a call or facet work is in
   *  flight or the quiet period is young, or THE SWEEP — this still-resident incarnation's unclaimed
   *  loaded facets reset in place. An incarnation that evicted on time never gets here: the alarm
   *  wakes a fresh one, whose birth reset them. */
  async #checkUnclaimedFacetSweep(now: number): Promise<void> {
    const decision = decideQuietDeadline({
      armedFor: this.#unclaimedFacetSweepArmedFor,
      now,
      workInFlight: this.#workInFlight(this.#deps.facetHost.snapshot().facetWorkInFlight),
      lastCallEndedAt: this.#lastOutsideActivityEndedAt,
      windowMs: UNCLAIMED_FACET_SWEEP_AFTER_QUIET_MS,
    });
    if (decision.action === "none") return;
    if (decision.action === "rearm") {
      this.#unclaimedFacetSweepArmedFor = decision.at;
      return;
    }
    this.#unclaimedFacetSweepArmedFor = null;
    const facets = await this.#deps.facetHost.resetUnclaimedLoadedFacets();
    if (facets.length > 0)
      console.log({
        event: "context.facets-reset-when-quiet",
        namespace: "iterate-context",
        name: this.#deps.name,
        facets,
      });
  }

  // ── THE BIRTH RESET (FacetHost `startFacetsTheLastIncarnationRan`): what the last incarnation left running unclaimed ──

  /** The loaded facets this incarnation's birth reset — named on its wake record. */
  #facetsResetAtBirth: string[] = [];

  /** THE BIRTH RESET, run once in the DO's constructor before it serves anything or writes
   *  anything: every facet the last incarnation called is started, and a loaded one it left
   *  running without a claim is reset first — it ends here, before this incarnation reaches it.
   *  Named on this incarnation's wake record, and logged: the watchdog's and the sweep's own wake
   *  writes no record. */
  async resetUnclaimedFacetsAtBirth(): Promise<void> {
    this.#facetsResetAtBirth = await this.#deps.facetHost.startFacetsTheLastIncarnationRan();
    if (this.#facetsResetAtBirth.length > 0)
      console.log({
        event: "context.facets-reset-at-birth",
        namespace: "iterate-context",
        name: this.#deps.name,
        facets: this.#facetsResetAtBirth,
      });
  }

  /** What this incarnation's wake record adds (Stream `wakeRecordDetail`). */
  wakeRecordDetail(): { facetsReset?: string[] } {
    return this.#facetsResetAtBirth.length > 0 ? { facetsReset: this.#facetsResetAtBirth } : {};
  }
}
