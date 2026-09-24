// context/residency.ts — `Residency`: the context's own mechanisms that end its residency when
// nothing should hold it. On the edge an actor is evicted ~10 s after its last call and hibernates
// when it holds only hibernatable sockets; everything here exists because something can keep it
// resident, billed, past that. The DO forwards its entry points here (an inbound call, a pin's use,
// a claim, an alarm pass, its birth) and reads the sweep's deadline back for its one alarm
// (alarm-coordinator.ts). Three mechanisms, each in memory on purpose — it watches the incarnation
// that armed it, and a fresh one has nothing to watch:
//   - THE PINS' RELEASE: a borrowed rpc stub or the library's open socket, unused for
//     `PIN_RELEASE_AFTER_IDLE_MS`, is returned or closed by a timer (workerd#6800).
//   - THE UNCLAIMED-FACET SWEEP: a loaded facet left running without a claim is reset once the
//     context has been quiet from OUTSIDE its loaded code (FacetHost `resetUnclaimedLoadedFacets`).
//   - THE BIRTH RESET: the same reset, run as an incarnation is born, for the facets the last one
//     left running — and a start of every facet it called, before the incarnation writes anything
//     (FacetHost `startFacetsTheLastIncarnationRan`). An incarnation only the sweep's alarm woke
//     writes nothing, so it only stops them (`stopUnclaimedLoadedFacetsTheLastIncarnationRan`) and
//     leaves the starts to its first write.
// The sweep's deadline is decided by one pure rule (`decideQuietDeadline`). How these three relate to
// the three session-release mechanisms in the SDK and the step walk: apps/os/docs/residency.md.

import type { buildLibrary } from "../library.ts";
import { UNCLAIMED_FACET_SWEEP_AFTER_QUIET_MS, type FacetHost } from "./facet-host.ts";
import type { RpcStubDirectory } from "./rpc-stubs.ts";

/** How long a context's PINS stay unused — no borrowed rpc stub called, no open socket used —
 *  before a timer returns the stubs and closes the sockets so the actor can hibernate. A pin lives
 *  and dies in memory, so its release needs no durable alarm: the timer dies with the actor, and so
 *  do the pins. */
const PIN_RELEASE_AFTER_IDLE_MS = 30_000;

/** What the alarm does about the sweep's quiet deadline: nothing (none armed, or not yet due), move
 *  it, or it is due, quiet since `idleSince`. */
export type QuietDeadlineDecision =
  | { action: "none" }
  | { action: "rearm"; at: number }
  | { action: "due"; idleSince: number };

/** The sweep's one decision, pure (table-tested in residency.test.ts). */
export function decideQuietDeadline(input: {
  /** The deadline this incarnation armed, epoch ms, or null — a fresh incarnation armed nothing. */
  armedFor: number | null;
  now: number;
  /** When the quiet period's last activity ended, or null while none has. */
  lastCallEndedAt: number | null;
  /** Inbound calls, facet calls, script runs and pin calls in flight right now. */
  workInFlight: number;
  windowMs: number;
}): QuietDeadlineDecision {
  const { armedFor, now, lastCallEndedAt, workInFlight, windowMs } = input;
  if (armedFor === null || now < armedFor) return { action: "none" };
  if (workInFlight > 0) return { action: "rearm", at: now + windowMs };
  // Nothing in flight and no activity since the arming: the arming instant is the fallback.
  const idleSince = lastCallEndedAt ?? armedFor - windowMs;
  if (now - idleSince < windowMs) return { action: "rearm", at: idleSince + windowMs };
  return { action: "due", idleSince };
}

type ResidencyDeps = {
  /** The DO's name, on every log line. */
  name: string;
  /** The facets' work in flight; the reset the sweep and the birth run. */
  facetHost: Pick<
    FacetHost,
    | "snapshot"
    | "resetUnclaimedLoadedFacets"
    | "startFacetsTheLastIncarnationRan"
    | "stopUnclaimedLoadedFacetsTheLastIncarnationRan"
  >;
  /** The borrowed stubs: a pin, and what the release returns. */
  rpcStubs: Pick<RpcStubDirectory, "hasBorrowedRpcStubs" | "returnBorrowedRpcStubs">;
  /** The library's open sockets: a pin, and what the release closes. */
  library: Pick<ReturnType<typeof buildLibrary>, "holdsOpenSocket" | "releaseConnections">;
  /** The script runs this incarnation is executing (the DO's runner): work in flight. */
  scriptRunsInFlight: () => number;
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

  // ── inbound calls: work in flight, and the sweep's clock ──

  /** Inbound calls — Workers RPC, fetch, socket events; never the alarm — in flight. */
  #inboundCallsInFlight = 0;
  /** THE UNCLAIMED-FACET SWEEP'S QUIET CLOCK: when the last inbound call from OUTSIDE the project's
   *  loaded code ended (an edge session, HTTP, MCP, a sibling's hop, a socket event), a claim was
   *  made, or an alarm pass did durable work. A call from loaded code — `caller.app`, a loaded
   *  worker's fetch — counts as work while in flight, but does not restart it: a facet that calls its
   *  own context more often than the context would evict would otherwise never be quiet, and never
   *  reset. */
  #lastOutsideActivityEndedAt: number | null = null;

  inboundCallStarted(): void {
    this.#inboundCallsInFlight += 1;
    if (this.#inboundCallsInFlight === 1) this.#deps.inboundCallsHeldChanged();
  }

  inboundCallEnded(fromLoadedCode: boolean): void {
    this.#inboundCallsInFlight -= 1;
    if (!fromLoadedCode) this.#lastOutsideActivityEndedAt = Date.now();
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

  // ── the sweep's quiet deadline on the one alarm ──

  /** The sweep's deadline, epoch ms — in memory on purpose: a fresh incarnation has none, so the
   *  alarm an evicted one left wakes it only for its birth, which did the reset. */
  #unclaimedFacetSweepArmedFor: number | null = null;

  /** This incarnation's deadline on the one alarm: no obligation a fresh incarnation derives again. */
  deadlines(): { unclaimedFacetSweep: number | null } {
    return { unclaimedFacetSweep: this.#unclaimedFacetSweepArmedFor };
  }

  /** A loaded facet was materialized, or a claim released: the sweep is owed once this context has
   *  been quiet for `UNCLAIMED_FACET_SWEEP_AFTER_QUIET_MS`. Armed when none is: one alarm write per
   *  quiet period. */
  armUnclaimedFacetSweep(): void {
    if (this.#unclaimedFacetSweepArmedFor !== null) return;
    this.#unclaimedFacetSweepArmedFor = Date.now() + UNCLAIMED_FACET_SWEEP_AFTER_QUIET_MS;
    this.#deps.reconcileAlarm();
  }

  /** The first thing every alarm pass does, inside the coordinator's hold: the sweep's decision. A
   *  wake with nothing durable due is the sweep's alone. */
  async alarmPassStarted(now: number): Promise<void> {
    await this.#checkUnclaimedFacetSweep(now);
  }

  /** The sweep's decision (`decideQuietDeadline`, on its clock `#lastOutsideActivityEndedAt`):
   *  nothing, a later deadline while a call, facet work, a run or a pin call is in flight or the
   *  quiet period is young, or THE SWEEP — this still-resident incarnation's unclaimed loaded facets
   *  reset in place. An incarnation that evicted on time never gets here: the alarm wakes a fresh
   *  one, whose birth reset them. */
  async #checkUnclaimedFacetSweep(now: number): Promise<void> {
    const decision = decideQuietDeadline({
      armedFor: this.#unclaimedFacetSweepArmedFor,
      now,
      workInFlight:
        this.#inboundCallsInFlight +
        this.#deps.facetHost.snapshot().facetWorkInFlight +
        this.#deps.scriptRunsInFlight() +
        this.#pinCallsInFlight,
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

  /** THE BIRTH RESET, run once per incarnation before it writes anything (the DO's `#birth`, which
   *  the first entry point that may write awaits): every facet the last incarnation called is
   *  started, and a loaded one it left running without a claim is reset first — it ends here,
   *  before this incarnation reaches it. Named on this incarnation's wake record, and logged: the
   *  sweep's own wake writes no record. */
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

  /** THE BIRTH OF AN INCARNATION ONLY THE SWEEP'S ALARM WOKE, which writes nothing: the loaded
   *  facets the last incarnation left running without a claim are stopped, none is started — the
   *  birth reset above still runs before this incarnation's first write, if it makes one, and
   *  starts them. Logged; no record, as the sweep's wake writes none. */
  stopUnclaimedFacetsAtAlarmBirth(): void {
    const facets = this.#deps.facetHost.stopUnclaimedLoadedFacetsTheLastIncarnationRan();
    if (facets.length > 0)
      console.log({
        event: "context.facets-stopped-at-alarm-birth",
        namespace: "iterate-context",
        name: this.#deps.name,
        facets,
      });
  }

  /** What this incarnation's wake record adds (Stream `wakeRecordDetail`). */
  wakeRecordDetail(): { facetsReset?: string[] } {
    return this.#facetsResetAtBirth.length > 0 ? { facetsReset: this.#facetsResetAtBirth } : {};
  }
}
