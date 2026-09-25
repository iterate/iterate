// context/facet-host.ts — `FacetHost`: how a loaded DurableObject class lives inside a context's DO.
// A facet is materialized from its startup memo (`facet:<name>` in kv) under a loaded identity whose
// change restarts it in place, called under a watchdog, its answer copied out and the result object
// disposed. The claims hosted processors make on the context's alarm (`processors.claim`) live here
// with the backoff ladder of failed revives, and a birth makes the first-party ones it inherits
// due; the DO's alarm pass calls `reviveDueClaims`. A facet the platform stops is started again at
// once, and a birth starts the ones the last incarnation called (FACET_START_WATCHDOG_MS). The DO
// wires the deps and forwards; nothing here reaches past `ctx.facets`, `ctx.storage.kv`,
// `ctx.exports`, `ctx.blockConcurrencyWhile` and what it is handed.
//
// TWO WAYS INTO A FACET, one call beneath both. A caller's itx expression reaches one only through
// `handle` — what `itx.facets.get` hands out — whose every walk is checked against the methods the
// facet's class lists (context/facet-public-methods.ts). The platform's own calls take
// `callFacetAsPlatform`, which no walk can land on, and are checked against nothing.

import { z } from "zod";
import { codedError, errorCode, releaseRpcSessions, reportIssue, withTimeout } from "iterate/lib";
import { REVIVE_AFTER_MAX_MS, REVIVE_AFTER_MS, type StreamEvent } from "iterate/stream/processor";
import {
  normalizedItxExpression,
  print,
  type ItxExpression,
  type ItxExpressionInput,
} from "iterate/expression";
import type { FacetProps } from "iterate/sdk";
import {
  CoreContract,
  facetIsPushedByARow,
  facetSpecFromHostingTarget,
  type CoreState,
} from "../stream/core-processor.ts";
import { AccountDurableObject } from "../account/durable-object.ts";
import { InstanceDurableObject } from "../instance/durable-object.ts";
import { type FIRST_PARTY_FACET_CLASSES, firstPartyFacetClassOf } from "../first-party-facets.ts";
import { OrganizationDurableObject } from "../organization/durable-object.ts";
import { ProjectDurableObject } from "../project/durable-object.ts";
import { RepoDurableObject } from "../repo/durable-object.ts";
import { SecretDurableObject } from "../secret/durable-object.ts";
import type { Stream } from "../stream/stream.ts";
import { WorkspaceDurableObject } from "../workspace/durable-object.ts";
import { walkSteps, awaitAnswerReleasedIfRejected, FacetHandle } from "./dispatch.ts";
import { assertFacetMethodIsPublic } from "./facet-public-methods.ts";
import { assertFacetPlacement } from "./first-party-facet-placement.ts";
import {
  assertFacetSourceWithinCeiling,
  facetSpecOf,
  prepareConfinedWorker,
  type FacetSpec,
} from "./worker-loader.ts";

/** WORKAROUND for a platform defect — https://github.com/iterate/alarm-loader-facet-repro (the
 *  reproduction, what was measured, what was ruled out). On prd (never in local workerd) a call into
 *  a LOADED facet started inside an alarm-woken incarnation can reject at facet start, in windows
 *  that hit every such facet on a machine for a second to a few minutes: V8's clone-version text
 *  when the loaded worker's env carries a stub (every facet here does), a bare "internal error;
 *  reference = …" when it does not. The facet container is then unusable for the incarnation (a
 *  live facet never re-runs its startup) and the loader's cached entry is too (a fresh loader id
 *  heals at once) — so the recovery (`#recover`) is a restart of both and ONE more attempt,
 *  counted per facet (`facet:<name>:restarts`, shown on `processors.list()`). worker-loader.ts
 *  `loaderIdGenerations` applies the same recovery to dynamic workers (#2288). Remove when the
 *  platform is fixed. */
const isFacetStartPlatformFailure = (error: unknown): error is Error =>
  error instanceof Error &&
  (error.message.includes("Unable to deserialize cloned data") ||
    error.message.startsWith("internal error; reference = "));
/** How long one facet call may take before the facet is aborted (a call that never answers would
 *  hold the pins' release, and with it this actor, forever). */
const FACET_CALL_WATCHDOG_MS = 60_000;
/** WORKAROUND for a platform defect — e2e/facet-abort-storage-reset.e2e.test.ts (the pin and the
 *  measurements).
 *  On the edge (never in local workerd), a facet whose SQLite database took a few dozen pages of
 *  writes and then STOPS — aborted (`ctx.facets.abort`), or evicted with its context — makes one of
 *  the context's next storage commits fail with "Internal error in Durable Object storage caused
 *  object to be reset": the whole object resets, and every call in flight on it fails. Measured on
 *  an os-preview preview: 40 rows of 2 KB, then an abort, 47 of 48 runs; the same facet evicted
 *  with its context, then the next incarnation's calls, 48 of 48. The facet STARTED AGAIN before the
 *  context commits anything more avoids it: after an abort, a start right after it and before any
 *  other event (`#restart`); after an eviction, a start in the next incarnation's birth before its
 *  first write (`startFacetsTheLastIncarnationRan`) — a start after that write does not. So the
 *  platform never stops a facet without starting it again: every abort of its own is a `#restart`,
 *  and a birth starts every facet the last incarnation ran (`facet-ran:<name>` rows). A start is
 *  one call, `listPublicMethods`, under its own watchdog (a birth waits on it, and a birth that
 *  outlasts 30 s resets the object); a start that fails is logged, never thrown, and its row stays
 *  for the next birth or sweep. Remove when that file's pin, a `createFailing` tagged `slow`,
 *  goes red because the raw fault no longer reproduces. */
const FACET_START_WATCHDOG_MS = 10_000;
/** What a call's watchdog does to a facet that never answered: every call but a platform start
 *  restarts it; a platform start leaves it alone — the start gave up under its own bound and
 *  logged, and an abort then would stop the facet outside the start's `blockConcurrencyWhile`. */
type FacetCallWatchdog = { watchdogMs: number; onTimeout: "restart" | "leave" };
const FACET_CALL_WATCHDOG: FacetCallWatchdog = {
  watchdogMs: FACET_CALL_WATCHDOG_MS,
  onTimeout: "restart",
};
/** How long a context that materialized a loaded facet must go without activity from OUTSIDE the
 *  project's loaded code — an edge session, HTTP, MCP, a sibling's hop, a claim, an alarm pass that
 *  did work — with no call, facet call, run or pin in flight, before its unclaimed loaded facets are
 *  reset (`resetUnclaimedLoadedFacets`). A call from loaded code counts while in flight but never
 *  restarts the wait, so a facet calling its own context more often than it would evict is still
 *  reset. The deadline is in memory on the context's one alarm (context/residency.ts): a
 *  context that evicted on time (~10 s) is woken fresh by it, and that birth does the reset; a
 *  context still resident does it in place. Past the ~10 s eviction and the pins' 30 s release, so a
 *  used context costs ONE extra alarm wake per quiet period — and a facet the last call left running
 *  is billed about a minute, not until its context's next wake (measured 2026-09-23: a careless
 *  loaded facet billed 60 s of every minute until then). */
export const UNCLAIMED_FACET_SWEEP_AFTER_QUIET_MS = 60_000;

/** Each first-party facet's `publicMethods`, read off its class (the class is minted from
 *  `ctx.exports` by name, first-party-facets.ts). A first-party name without its list fails to
 *  typecheck. */
const FIRST_PARTY_FACET_PUBLIC_METHODS = {
  account: AccountDurableObject.publicMethods,
  instance: InstanceDurableObject.publicMethods,
  organization: OrganizationDurableObject.publicMethods,
  project: ProjectDurableObject.publicMethods,
  repo: RepoDurableObject.publicMethods,
  secret: SecretDurableObject.publicMethods,
  workspace: WorkspaceDurableObject.publicMethods,
} satisfies Record<keyof typeof FIRST_PARTY_FACET_CLASSES, readonly string[]>;

type FacetHostDeps = {
  /** `ctx.facets` (the containers), `ctx.storage.kv` (memos, restart markers, restart counts,
   *  claims, what ran), `ctx.exports` (the first-party classes), `ctx.blockConcurrencyWhile` (a
   *  restart, `#restart`). */
  ctx: Pick<DurableObjectState, "facets" | "storage" | "exports" | "blockConcurrencyWhile">;
  /** What `prepareConfinedWorker` reads of the env: the Worker Loader. Read at call time, off the
   *  DO's own `env` field — a workerd test swaps that field for a counting loader
   *  (__workers-tests__/facet-class-loads-at-startup.test.ts). */
  env: () => { LOADER: WorkerLoader; ITX_KV: KVNamespace };
  deployId: string;
  /** The DO's name: a facet's props and the owner half of its loader identity. */
  iterateContextName: string;
  /** The context's project and canonical path — whether a facet may be hosted here is read off
   *  them (first-party-facet-placement.ts). */
  projectId: string;
  path: string;
  /** The origin this context is reached on, folded into the loader id (worker-loader.ts). */
  platformOrigin: () => string | null;
  /** The `env.ITX` stub every worker this context loads receives (the DO's `#itxEntrypoint`). */
  itxEntrypoint: () => Fetcher;
  /** The DO's dispatch: a source expression's producer runs through it (worker-loader.ts). */
  invoke: (call: ItxExpressionInput) => Promise<unknown>;
  /** The chain of rewrites for an expression (the resolver's `resolve`): how a hosting target is
   *  read for the spec it names. */
  resolveItxExpression: (expression: ItxExpressionInput) => ItxExpression[];
  /** The stream: its rows (`coreReducedState.subscriptions`), its log (a memo recovered from the
   *  event that configured the row), its snapshots (the core reduce's facet-shaped address). */
  stream: Stream;
  /** A claim changed: the DO reconciles its alarm against `deadlines()`. */
  reconcileAlarm: () => void;
  /** A LOADED facet was materialized: the context arms its sweep (context/residency.ts). */
  loadedFacetMaterialized: () => void;
};

/** What `#materialize` hands `#call`: the container, the retirement of the loaded identity it was
 *  minted under (a loaded facet's; a first-party one has none) and whether the startup callback
 *  threw — read after a call fails, since the callback may run during it. */
type MaterializedFacet = {
  facet: Fetcher;
  retireLoadedIdentity?: () => void;
  startupFailed: () => boolean;
  generation: number;
  /** The `facet:<name>:loader-id` row owed once the facet started under a new identity: a platform
   *  start's (`#start`, `#recover`), or a call's whose restart did not start it (`#callFacet`). */
  recordLoadedIdentity?: () => void;
};

export class FacetHost {
  readonly #deps: FacetHostDeps;
  /** EVERY facet materialized this incarnation — what a release aborts. In memory on purpose: a
   *  facet this incarnation did not start is not its to count. One the last incarnation left
   *  running is reset at birth when it is loaded and unclaimed (`resetUnclaimedLoadedFacets`); a
   *  claimed one stays running and is reached again through the same `facets.get`. */
  readonly #liveFacetNames = new Set<string>();
  /** Each facet's startup memo (`facet:<name>` in kv), read ONCE per incarnation: every push then
   *  hands the loader the SAME object, so its identity-keyed content hash (worker-loader.ts) runs once
   *  per source per incarnation, not once per push. */
  readonly #facetStartupMemoByName = new Map<string, FacetSpec>();
  /** A late failure may only retire the container it called, never its replacement. */
  readonly #facetGenerationByName = new Map<string, number>();
  /** The generation `itx.facets.abort` ended, per facet, and why: a call in flight on it rejects
   *  FACET_ABORTED (`#call`) — an outcome asked for, not a failure to report or a row to halt. */
  readonly #abortedOnRequest = new Map<string, { generation: number; reason?: string }>();
  /** The generation the platform restarted under the calls in flight on it, per facet, and why: a
   *  new loaded identity (`#materialize`) or another call on it timing out (`#call`). A call in
   *  flight on it rejects FACET_RESTARTED (`#call`) — owed again on the new instance, not a failure
   *  to report. */
  readonly #restartedUnderInFlightCalls = new Map<string, { generation: number; reason: string }>();
  /** Each facet's latest recovery (`#recover`), settled either way: the next one starts after it,
   *  so no restart aborts another recovery's retry mid-call. */
  readonly #facetRecoveryByName = new Map<string, Promise<void>>();
  /** Facet work in flight: the test-only release (`abortLiveFacetsWhenIdle`) respects it — aborting a
   *  facet mid-REDUCE is exactly the stall a reduce would have to repair from the log, never cause it —
   *  and the unclaimed-facet sweep reads it through `snapshot()`. */
  #facetWorkInFlight = 0;
  /** THE CLAIMS of hosted processors on this context's alarm (`processors.claim`): name → the time
   *  a `revive()` is owed by. A kv row each, so a claim outlives the incarnation that made it —
   *  that is the whole point. Restored in the constructor; spent by the pass that serves it. */
  readonly #facetClaims = new Map<string, number>();
  /** Consecutive revives of a facet that THREW (a load failure, a timeout): the backoff of the
   *  claim the pass puts back. A kv row beside the claim (`facet-claim-failures:<name>`), so the
   *  backoff survives the eviction between two passes — else every fresh incarnation would start
   *  the ladder over and a facet that cannot be revived would cost a wake every 40 s for good.
   *  Cleared by the facet's own next claim (its engine reached it) and by a revive that returned. */
  readonly #facetReviveFailures = new Map<string, number>();
  /** What each handle `handle` minted names — read only by `callFacetAsPlatform` (the delivery loop
   *  hands it a row target's handle), never by a walk: the handle carries nothing but its walk. */
  readonly #facetAddressByFacetHandle = new WeakMap<
    FacetHandle,
    { name: string; spec: FacetSpec | undefined }
  >();
  /** A loaded facet's `publicMethods`, by the startup memo it was asked under: the list belongs to
   *  the code the memo names, and a reconfigure or a removal replaces the memo. */
  readonly #publicMethodsByLoadedFacetStartupMemo = new WeakMap<FacetSpec, readonly string[]>();
  /** Each loaded facet's identity as this incarnation last materialized it — ahead of its
   *  `facet:<name>:loader-id` row while a restart under a new identity is starting it. */
  readonly #loaderIdByName = new Map<string, string>();
  /** The facets this incarnation called: each has its `facet-ran:<name>` row, written on its first
   *  call — what the next birth starts before its first write, and what the sweep resets. */
  readonly #ranThisIncarnation = new Set<string>();
  /** The generation `#deleteFacet` ended, per facet: a call in flight on it rejects with the
   *  runtime's "Facet was deleted.", answered NO_FACET (`#call`) — the outcome a removal is. */
  readonly #deletedGeneration = new Map<string, number>();

  constructor(deps: FacetHostDeps) {
    this.#deps = deps;
    // The revive-failure ladder (`#facetReviveFailed` wrote each rung as a number).
    for (const [key, n] of deps.ctx.storage.kv.list({ prefix: "facet-claim-failures:" }))
      this.#facetReviveFailures.set(key.slice("facet-claim-failures:".length), n as number);
    // A claim row's value is the epoch-ms `at` this host wrote in `#claimFacetAlarm` (kv types it as
    // unknown). A FIRST-PARTY facet's claim the last incarnation left is DUE AT THIS BIRTH: those
    // facets are SDK engines, whose claim always covers an attempt in flight, and that attempt ran in
    // an incarnation that is over — evicted, or replaced under its calls by the platform
    // (project/collection.ts TERMINAL_WAIT_SLICE_MS) — so work that died with it would wait out the
    // rest of REVIVE_AFTER_MS for nothing. A revive that finds the attempt still running (a facet can
    // outlive its context's incarnation) claims again, later (the engine's rule 3). A loaded facet's
    // claim is its author's "revive me by `at`", kept as written (a careless one claims to stay
    // running and answers no revive), and so is a claim on the ladder of failed revives, which keeps
    // its backoff. In memory only: the birth writes nothing before it has started its facets, and
    // its first reconcile arms the alarm.
    const bornAt = Date.now();
    for (const [key, at] of deps.ctx.storage.kv.list({ prefix: "facet-claim:" })) {
      const name = key.slice("facet-claim:".length);
      const dueAtBirth = firstPartyFacetClassOf(name) && !this.#facetReviveFailures.has(name);
      this.#facetClaims.set(name, dueAtBirth ? Math.min(at as number, bornAt) : (at as number));
    }
  }

  /** The claims on the context's alarm, earliest first: the coordinator's third deadline source
   *  and the alarm trace's `claims`. */
  deadlines(): { name: string; at: number }[] {
    return [...this.#facetClaims].map(([name, at]) => ({ name, at })).sort((a, b) => a.at - b.at);
  }

  /** The alarm trace's facts about the facets this incarnation holds. */
  snapshot(): { facetWorkInFlight: number; liveFacetNames: string[] } {
    return {
      facetWorkInFlight: this.#facetWorkInFlight,
      liveFacetNames: [...this.#liveFacetNames],
    };
  }

  /** How many times this facet was restarted after a platform failure at its start (the predicate
   *  `isFacetStartPlatformFailure`), over the facet's whole life on this context. */
  restarts(name: string): number {
    // The row's value is the count this host wrote in `#recover` (kv types it `unknown`); absent
    // until the first restart.
    return (this.#deps.ctx.storage.kv.get(`facet:${name}:restarts`) as number | undefined) ?? 0;
  }

  /** `processors.claim` (built-ins.ts): the facet's engine is reachable, so its ladder of failed
   *  revives is over; `at` is when a `revive()` is owed by, `null` releases the claim. */
  claim(name: string, at: number | null): void {
    this.#facetRevived(name);
    this.#claimFacetAlarm(name, at);
    // A facet that claims, or releases, is running — unless it is gone: a release can land after
    // the facet's deletion took its memo.
    if (
      firstPartyFacetClassOf(name) ||
      this.#deps.ctx.storage.kv.get(`facet:${name}`) !== undefined
    )
      this.#markRan(name);
  }

  /** The alarm pass's third job — THE DUE CLAIMS: each is spent first (a claim is one revive, never
   *  a standing order — a facet with an attempt still in flight claims again from its revive, later
   *  each time), then the facet is revived: materialized if the last incarnation died with it,
   *  caught up, its at-head pass run. Awaited by the pass, so the claim a revive makes is the one
   *  the next deadline is derived from. */
  async reviveDueClaims(): Promise<void> {
    for (const [name, at] of [...this.#facetClaims]) {
      if (at > Date.now()) continue;
      this.#claimFacetAlarm(name, null);
      try {
        await this.callFacetAsPlatform(name, [["revive"]]);
        this.#facetRevived(name);
      } catch (error) {
        // A revive `itx.facets.abort` cut off (FACET_ABORTED), or a platform restart (a new loaded
        // identity, another call's timeout: FACET_RESTARTED), failed at nothing: the fresh instance is owed the same revive
        // — due now, the next pass's, with no backoff and no issue.
        const code = errorCode(error);
        if (code === "FACET_ABORTED" || code === "FACET_RESTARTED") {
          this.#claimFacetAlarm(name, Date.now());
          continue;
        }
        reportIssue("iterate-context.revive", error, { name });
        // A revive that threw (a load failure, a timeout) spent nothing: the claim is put back,
        // later each time, so the attempt is still owed and a facet that cannot load costs a
        // few wakes an hour. A facet that is GONE (its row removed) is owed nothing.
        if (errorCode(error) === "NO_FACET") continue;
        const failures = this.#facetReviveFailed(name);
        this.#claimFacetAlarm(
          name,
          Date.now() + Math.min(REVIVE_AFTER_MS * 2 ** failures, REVIVE_AFTER_MAX_MS),
        );
      }
    }
  }

  /** `itx.facets.abort(name, reason)` (built-ins.ts, which records the fact right after): the facet
   *  RESET from here, the host — `ctx.facets.abort` needs nothing from the facet, so a class that is
   *  no SDK host and one that would never answer a call reset alike — and started again at once
   *  (`#restart`). Its instance goes, and every call in flight on it rejects FACET_ABORTED
   *  (`#call`); its storage and startup memo stay. A facet not running this incarnation has nothing
   *  to reset — it is started all the same, and the fact still lands. The core reduce is no facet; a
   *  name never hosted here is NO_FACET. */
  async abort(name: string, reason: string | undefined): Promise<void> {
    // oxlint-disable-next-line iterate/simple-truthiness-check -- name arrives as a client-authored itx expression argument; the static string type is the API contract, not a runtime guarantee
    if (typeof name !== "string")
      throw new Error("itx.facets.abort(name, reason?): name the facet");
    if (name === CoreContract.slug)
      throw new Error(`"${name}" is the core reduce — never a facet, nothing to abort`);
    // A first-party name is hostable where it is placed; any other must have been hosted here (its
    // memo, or the row that hosts it) — else NO_FACET, before anything is recorded.
    if (firstPartyFacetClassOf(name))
      assertFacetPlacement(name, { projectId: this.#deps.projectId, path: this.#deps.path });
    else this.#facetStartupMemoFor(name, undefined);
    await this.#restart(name, () => {
      const generation = this.#facetGeneration(name);
      this.#abortFacetIfRunning(name, `facet "${name}" aborted${reason ? `: ${reason}` : ""}`);
      this.#liveFacetNames.delete(name);
      if (this.#facetGeneration(name) !== generation)
        this.#abortedOnRequest.set(name, { generation, reason });
    });
  }

  /** THE BIRTH'S FIRST ACT, before this incarnation writes anything (the DO counts the incarnation
   *  after it): every facet the last incarnation called (its `facet-ran:<name>` row) is STARTED, so
   *  one it left evicted mid-write never meets this incarnation's first commit stopped (the platform
   *  defect, FACET_START_WATCHDOG_MS). A loaded one holding no claim is RESET first — a facet does
   *  NOT die with the incarnation that started it: one that keeps any Workers-RPC value from its
   *  `env.ITX` (a stub, an answer, plain data included) keeps running after its context is
   *  evicted, billed per instance under the context's object, and the next incarnation's
   *  `facets.get` lands on that same instance (measured on a deployed preview, 2026-09-23). Work that
   *  must outlive the call that started it runs through the processor's `runInBackground`, whose
   *  claim on this context's alarm (`processors.claim`) keeps the facet running — so a claimed one,
   *  and a FIRST-PARTY one (the platform's own classes release every round trip, `withItx`; the
   *  `secret` facet pumps a proxied socket with no claim), is started without a reset: the start
   *  lands on the instance if it still runs. A facet no incarnation called since its last start is
   *  not running and holds no write, and is left alone. Returns the names reset. */
  async startFacetsTheLastIncarnationRan(): Promise<string[]> {
    const ran = Array.from(this.#deps.ctx.storage.kv.list({ prefix: "facet-ran:" }), ([key]) =>
      key.slice("facet-ran:".length),
    );
    const reset = ran.filter(
      (name) => !firstPartyFacetClassOf(name) && !this.#facetClaims.has(name),
    );
    const started = await this.#restartAll(
      ran.map((name) => ({
        name,
        abort: reset.includes(name)
          ? () =>
              this.#abortFacetIfRunning(name, "reset: loaded, unclaimed, and its context reborn")
          : null,
      })),
    );
    // A claimed one still runs, and one whose start failed is owed a start by the next birth or
    // sweep: their rows stay.
    ran.forEach((name, i) => {
      if (started[i] && !this.#facetClaims.has(name))
        this.#deps.ctx.storage.kv.delete(`facet-ran:${name}`);
    });
    return reset;
  }

  /** THE SWEEP'S RESET, in place, when a context that materialized a loaded facet has been quiet for
   *  `UNCLAIMED_FACET_SWEEP_AFTER_QUIET_MS` (context/residency.ts): what the birth reset does for a
   *  context that evicted on time (`startFacetsTheLastIncarnationRan`), for one still resident —
   *  every LOADED facet called since its last start and holding no claim is restarted, its instance
   *  and its billing ended; a fresh one holds nothing. Returns the names reset. */
  async resetUnclaimedLoadedFacets(): Promise<string[]> {
    const reset = Array.from(this.#deps.ctx.storage.kv.list({ prefix: "facet-ran:" }), ([key]) =>
      key.slice("facet-ran:".length),
    ).filter((name) => !firstPartyFacetClassOf(name) && !this.#facetClaims.has(name));
    const started = await this.#restartAll(
      reset.map((name) => ({
        name,
        abort: () =>
          this.#abortFacetIfRunning(name, "reset: loaded, unclaimed, and its context quiet"),
      })),
    );
    reset.forEach((name, i) => {
      if (!started[i]) return; // its start failed: its row stays, a start still owed
      this.#deps.ctx.storage.kv.delete(`facet-ran:${name}`);
      this.#ranThisIncarnation.delete(name);
    });
    return reset;
  }

  /** For the test-only release (the DO's `releasePins`): every live facet aborted, so a
   *  facet-pinned actor can be evicted — unless a call is in flight (a reduce aborted midway is
   *  the stall its gap repair would have to heal). Aborted facets re-materialize from their
   *  startup memo on their next call. */
  abortLiveFacetsWhenIdle(reason: string): void {
    if (this.#facetWorkInFlight !== 0) return;
    for (const facetName of this.#liveFacetNames) this.#abortFacetIfRunning(facetName, reason);
    this.#liveFacetNames.clear();
  }

  /** THE PLATFORM'S ABORT, always this: `abort` (a `#abortFacetIfRunning`, and what the caller
   *  books beside it) and a `#start` right after it (`#restartAll`). */
  async #restart(name: string, abort: () => void): Promise<boolean> {
    const [started] = await this.#restartAll([{ name, abort }]);
    return started!;
  }

  /** Every facet's `abort` (none for one only started), then every start, and only once every
   *  start settled what the starts owe written (a new loaded identity, a restart count) — all under
   *  `blockConcurrencyWhile`, so no commit, this context's own or another event's, lands between a
   *  facet's stop and its start (FACET_START_WATCHDOG_MS). Answers whether each facet started.
   *  Never throws: a callback that throws there resets the object. */
  #restartAll(restarts: { name: string; abort: (() => void) | null }[]): Promise<boolean[]> {
    return this.#deps.ctx.blockConcurrencyWhile(async () => {
      for (const { name, abort } of restarts) {
        if (!abort) continue;
        abort();
        this.#liveFacetNames.delete(name);
      }
      const owed: (() => void)[] = [];
      const started = await Promise.all(restarts.map(({ name }) => this.#start(name, owed)));
      for (const write of owed) write();
      return started;
    });
  }

  /** THE PLATFORM'S START of a facet: materialized — a loaded one's new identity recorded only once
   *  it started, so nothing is written before — and called once, `listPublicMethods`, which a class
   *  that is no SDK shell refuses only after it started. Arms no sweep: the platform's start is no
   *  use. The platform defect at facet start (`isFacetStartPlatformFailure`) is recovered as a
   *  call's is. A start that still fails leaves the facet stopped, is logged, and answers false:
   *  its `facet-ran` row stays for the next birth or sweep to start it. Never throws. */
  async #start(name: string, owed: (() => void)[]): Promise<boolean> {
    const steps: ItxExpression = [["listPublicMethods"]];
    const watchdog: FacetCallWatchdog = { watchdogMs: FACET_START_WATCHDOG_MS, onTimeout: "leave" };
    const startedIfRefused = (error: unknown) => {
      if (!(error instanceof TypeError && error.message.includes("does not implement the method")))
        throw error;
    };
    const start = async () => {
      const firstPartyClassName = firstPartyFacetClassOf(name);
      const facetStartupMemo = firstPartyClassName
        ? undefined
        : this.#facetStartupMemoFor(name, undefined);
      const started = await this.#materialize(name, firstPartyClassName, facetStartupMemo, {
        platformStart: true,
      });
      try {
        await this.#call(started, name, steps, watchdog).catch(startedIfRefused);
        if (started.recordLoadedIdentity) owed.push(started.recordLoadedIdentity);
      } catch (error) {
        // The platform defect at facet start is recovered as a call's is — a fresh loaded identity
        // and one more start — but NOT queued behind a call's recovery of the same facet: this
        // start holds `blockConcurrencyWhile`, which that recovery would wait on.
        if (!this.#isRecoverableFacetFailure(name, error, started)) throw error;
        await this.#recover(
          name,
          firstPartyClassName,
          facetStartupMemo,
          steps,
          { failedOn: started, error },
          watchdog,
          owed,
        ).catch(startedIfRefused);
      }
    };
    try {
      // The whole start, its source resolved included, under the watchdog: a birth waits on it (a
      // start the watchdog gave up on runs on, and is not counted as a start).
      await withTimeout(start(), FACET_START_WATCHDOG_MS, `facet "${name}" start`);
      return true;
    } catch (error) {
      // A facet no longer hosted here (its memo gone with a deletion) is owed no start.
      if (errorCode(error) === "NO_FACET") return true;
      console.warn({
        event: isFacetStartPlatformFailure(error)
          ? "facet.platform-failure-start"
          : "facet.start-failed",
        namespace: "iterate-context",
        name,
        message: String(error instanceof Error ? error.message : error).slice(0, 512),
      });
      return false;
    }
  }

  /** The facet was called this incarnation: its `facet-ran:<name>` row, once per incarnation. */
  #markRan(name: string): void {
    if (this.#ranThisIncarnation.has(name)) return;
    this.#ranThisIncarnation.add(name);
    this.#deps.ctx.storage.kv.put(`facet-ran:${name}`, true);
  }

  #facetReviveFailed(name: string) {
    const failures = (this.#facetReviveFailures.get(name) ?? 0) + 1;
    this.#facetReviveFailures.set(name, failures);
    this.#deps.ctx.storage.kv.put(`facet-claim-failures:${name}`, failures);
    return failures;
  }
  #facetRevived(name: string) {
    this.#facetReviveFailures.delete(name);
    this.#deps.ctx.storage.kv.delete(`facet-claim-failures:${name}`);
  }
  #claimFacetAlarm(name: string, at: number | null): void {
    // null releases a claim; epoch 0 is a valid due alarm
    if (at === null) {
      this.#facetClaims.delete(name);
      this.#deps.ctx.storage.kv.delete(`facet-claim:${name}`);
    } else {
      this.#facetClaims.set(name, at);
      this.#deps.ctx.storage.kv.put(`facet-claim:${name}`, at);
    }
    this.#deps.reconcileAlarm();
  }

  // ── the two committed-event effects the DO runs off a fresh commit ──

  /** THE ONE EFFECT of a hosting configuration: the facet's startup memo is refreshed from the
   *  event that configured it, source and all (the reduced row is source-less, core-processor.ts `hostedFacet`). The memo is the ONLY
   *  place a materialization reads the source from, so a re-enable with NEW source under the same
   *  name and class is a new loader identity on the facet's next call (`invoke` restarts it in
   *  place, storage preserved) — without this the old memo kept running the old code. A target that
   *  cannot resolve right now is left to the next call's recovery. */
  refreshFacetStartupMemosFromHostingConfigurations(committedEvents: StreamEvent[]): void {
    for (const event of committedEvents) {
      if (event.type !== "events.iterate.com/itx/subscription-configured") continue;
      const { name, target } = event.payload as SubscriptionConfiguredPayload;
      if (!target || !this.#deps.stream.coreReducedState.subscriptions[name]?.hostedFacet) continue;
      try {
        const spec = facetSpecFromHostingTarget(
          this.#deps.resolveItxExpression(normalizedItxExpression(target)).at(-1)!,
        );
        // A first-party facet keeps no memo: its class is this worker's code (first-party-facets.ts).
        if (!spec || firstPartyFacetClassOf(spec.name)) continue;
        // The same normalize → compare → persist materialization does — reuse it so ONE method writes
        // the memo (it no-ops when unchanged, keeping the loader's identity-keyed hash).
        this.#facetStartupMemoFor(spec.name, spec as FacetSpec);
      } catch (error) {
        // The row landed; a memo that cannot be written now (a source over the cell cap, a target
        // that does not resolve yet) is the next call's to recover or refuse — never the append's.
        reportIssue("iterate-context.facet-startup-memo", error, { name });
      }
    }
  }

  /** THE ONE EFFECT of a subscription removal: a row that HOSTED a facet (`hostedFacet` set) takes
   *  the facet with it, storage included — `subscription-configured { name, target: null }` IS the
   *  disablement, raw event or verb alike, and a re-enable rebuilds from the log. A row that only
   *  ADDRESSED a running facet deletes nothing: it never owned it. Done after the commit and before
   *  the append returns, because only the pre-commit state knows what the removed row targeted. */
  deleteFacetsWhoseHostingSubscriptionWasRemoved(
    committedEvents: StreamEvent[],
    subscriptionsBeforeCommit: CoreState["subscriptions"],
  ): void {
    for (const event of committedEvents) {
      if (event.type !== "events.iterate.com/itx/subscription-configured") continue;
      const { name, target } = event.payload as SubscriptionConfiguredPayload;
      const removedRow = !target ? subscriptionsBeforeCommit[name] : undefined;
      // The marker, not the (source-less) target, says which facet a row hosts.
      const facetName = removedRow?.hostedFacet?.name;
      if (!facetName) continue;
      // Another row still hosts it (a mirror, an audit): the facet is theirs now, not gone.
      const stillHosted = Object.values(this.#deps.stream.coreReducedState.subscriptions).some(
        (row) => row.hostedFacet?.name === facetName,
      );
      if (!stillHosted) this.#deleteFacet(facetName);
    }
  }

  // ── the facets: two ways in; admit, materialize, call, retry once ──

  /** `itx.facets.get(name, spec?)`, as the built-in hands it out — THE ONE WAY IN AN ITX EXPRESSION
   *  REACHES: a branded FacetHandle whose every walk is checked against the facet class's
   *  `publicMethods`. What it names is kept beside it (`#facetAddressByFacetHandle`) for the delivery
   *  loop, which evaluates a row's target to this handle and calls the facet through
   *  `callFacetAsPlatform` — never through the handle's walk. The facets view is PARENT-LOCAL — the
   *  facets live here and can never move (workerd#6702: sockets never leave the parent). */
  handle(name: string, spec?: FacetSpec): FacetHandle {
    const facetHandle = new FacetHandle((itxExpressionSteps) => {
      // A FACET REACHED BY ITX EXPRESSION ANSWERS RPC AND PLAIN HTTP — NEVER A WEBSOCKET. A
      // socket terminates at the edge (a session's /api pager socket on this DO, a project host's
      // lent-stub upgrade leg), and the facet behind it is reached by itx expression; a socket a
      // facet HELD would die with it, unseen by the parent (1006, measured 2026-09-13). Refused
      // BEFORE the memo: an upgrade aimed at a facet materializes nothing. The one facet that
      // PROXIES a socket — the `secret` facet, dialling a pinned host for egress and handing the
      // 101 straight back — is reached by the DO's egress, never by expression.
      const [first] = itxExpressionSteps;
      if (
        Array.isArray(first) &&
        first[0] === "fetch" &&
        first[1] instanceof Request &&
        first[1].headers.get("Upgrade")?.toLowerCase() === "websocket"
      )
        throw codedError(
          "FACET_NO_UPGRADE",
          `facet "${name}": a facet answers RPC and plain HTTP, never a WebSocket — a socket terminates at the edge; reach the facet by itx expression`,
        );
      return this.#callFacet(name, spec, itxExpressionSteps, { byItxExpression: true });
    });
    this.#facetAddressByFacetHandle.set(facetHandle, { name, spec });
    return facetHandle;
  }

  /** THE PLATFORM'S WAY IN, checked against no list, which no walk can land on: the facet `name`, or
   *  the one a FacetHandle names — the delivery loop's row target, pushed `processEventBatch(events,
   *  range)` and caught up with `catchUpFromLog()`. Also the alarm's revive, the `itx.secrets`
   *  built-ins, egress and the operator's export. */
  async callFacetAsPlatform(
    facet: string | FacetHandle,
    itxExpressionSteps: ItxExpression,
  ): Promise<unknown> {
    if (typeof facet === "string") return this.#callFacet(facet, undefined, itxExpressionSteps);
    const facetAddress = this.#facetAddressByFacetHandle.get(facet);
    if (!facetAddress)
      throw new Error("facet: a FacetHandle this context's facet host never minted");
    return this.#callFacet(facetAddress.name, facetAddress.spec, itxExpressionSteps);
  }

  /** THE facet call — `itx.facets.get(name).m()` (address a running facet) and
   *  `itx.facets.get(name, { source, className }).m()` (load and host) both land here; facet stubs
   *  are non-transferable, so the walk happens where the stub lives. Top to bottom: the startup memo
   *  → for a caller's walk, the class's `publicMethods` (context/facet-public-methods.ts) →
   *  `#materialize` (the loaded identity, resolved not loaded; the racing-delete/reconfigure check;
   *  the restart marker; the facet, its class minted only when it STARTS) → `#call` (the watchdog,
   *  copy + dispose the answer) — and on the platform failure at facet start, a restart and the same
   *  two steps once more. */
  async #callFacet(
    name: string,
    spec: FacetSpec | undefined,
    itxExpressionSteps: ItxExpression,
    { byItxExpression } = { byItxExpression: false },
  ): Promise<unknown> {
    // oxlint-disable-next-line iterate/simple-truthiness-check -- name arrives as a client-authored itx expression argument; the static string type is the API contract, not a runtime guarantee, so a non-string is rejected with a usage error
    if (typeof name !== "string")
      throw new Error(
        "itx.facets.get(name, spec?): name the facet; pass { source, className } to load and host it",
      );
    if (itxExpressionSteps.length === 0) throw new Error(`facet: name a method`);
    // The core reduce answers at its facet-shaped address with a synthesized view — it is not a
    // facet, pins nothing, needs no watchdog, lists nothing, and can never be hosted.
    if (name === CoreContract.slug) {
      if (spec) throw new Error(`"${name}" is the core reduce — never a facet name`);
      return (
        await walkSteps(
          {
            value: { snapshot: () => this.#deps.stream.coreReducedStateSnapshot() },
            receiver: undefined,
          },
          itxExpressionSteps,
        )
      ).value;
    }
    // A FIRST-PARTY facet (first-party-facets.ts) is this worker's own class: no memo, no loader,
    // no loaded identity to watch — it changes with the deploy — and never a spec.
    const firstPartyClassName = firstPartyFacetClassOf(name);
    if (firstPartyClassName && spec)
      throw new Error(
        `facet "${name}" is first-party — hosted from this worker's own ${firstPartyClassName}, never a loaded source; call itx.facets.get("${name}") without a spec`,
      );
    // WHERE it may be hosted (first-party-facet-placement.ts): a first-party class runs with the
    // worker's real env on this context, so only where the platform hosts it; loaded code only
    // inside a project. Every facet is created here, so this is where that holds.
    assertFacetPlacement(name, {
      projectId: this.#deps.projectId,
      path: this.#deps.path,
    });
    const facetStartupMemo = firstPartyClassName
      ? undefined
      : this.#facetStartupMemoFor(name, spec);
    if (byItxExpression)
      assertFacetMethodIsPublic(
        name,
        facetStartupMemo
          ? await this.#loadedFacetPublicMethods(name, facetStartupMemo)
          : // `name` hosts a first-party class, so it is one of the table's keys; the type system cannot see it.
            FIRST_PARTY_FACET_PUBLIC_METHODS[name as keyof typeof FIRST_PARTY_FACET_PUBLIC_METHODS],
        itxExpressionSteps,
      );
    this.#markRan(name);
    this.#facetWorkInFlight++;
    try {
      const materialized = await this.#materialize(name, firstPartyClassName, facetStartupMemo, {
        platformStart: false,
      });
      try {
        const answer = await this.#call(
          materialized,
          name,
          itxExpressionSteps,
          FACET_CALL_WATCHDOG,
        );
        materialized.recordLoadedIdentity?.();
        return answer;
      } catch (error) {
        if (!this.#isRecoverableFacetFailure(name, error, materialized)) throw error;
        // The platform failure (the predicate's doc), or a restart for one: recovered below, one
        // recovery of this facet at a time.
        const owed: (() => void)[] = [];
        try {
          return await this.#afterEarlierRecoveries(name, () =>
            this.#recover(
              name,
              firstPartyClassName,
              facetStartupMemo,
              itxExpressionSteps,
              { failedOn: materialized, error },
              FACET_CALL_WATCHDOG,
              owed,
            ),
          );
        } finally {
          for (const write of owed) write();
        }
      }
    } finally {
      this.#facetWorkInFlight--;
    }
  }

  /** A LOADED facet's `publicMethods`, asked of the facet once per startup memo —
   *  `listPublicMethods()`, which the SDK's facet shells answer (a static does not cross the
   *  isolate). A class that extends neither shell has no such method (workerd's TypeError), and
   *  lists nothing. */
  async #loadedFacetPublicMethods(name: string, facetStartupMemo: FacetSpec) {
    let publicMethods = this.#publicMethodsByLoadedFacetStartupMemo.get(facetStartupMemo);
    if (publicMethods) return publicMethods;
    try {
      publicMethods = z
        .array(z.string())
        .parse(await this.#callFacet(name, undefined, [["listPublicMethods"]]));
    } catch (error) {
      if (!(error instanceof TypeError && error.message.includes("does not implement the method")))
        throw error;
      publicMethods = [];
    }
    this.#publicMethodsByLoadedFacetStartupMemo.set(facetStartupMemo, publicMethods);
    return publicMethods;
  }

  /** A failed call's recovery, bounded: at most ONE retry on a start a peer already put in place,
   *  and at most ONE restart of the facet for this call — a later failure is the caller's. A call
   *  that failed on the start still running restarts it, retiring the loaded identity it broke
   *  under (the cached entry is what stays broken), and retries cold; one whose start is already
   *  gone — a peer restarted it, the platform failure or the abort text alike — retries on the
   *  replacement without touching it, so a single failure never turns into a restart per call in
   *  flight. A replacement can be good for exactly ONE call (prd 2026-09-23: first-party starts
   *  rejected every call after their first with "internal error; reference = …"), so the second
   *  attempt may fail the same way; that one gets the call's restart. Recoveries run one at a time
   *  (`#afterEarlierRecoveries`) so no restart aborts another's retry mid-call; a retry that calls
   *  back into this same facet and fails waits behind itself until the watchdog ends it. A retry
   *  re-delivers a pushed batch: durables are offset-guarded by the engine, ephemerals are not (a
   *  duplicate beats a lost batch; at-least-once is the facet contract). Each restart is counted on
   *  the facet's row and logged, never swallowed, so the platform condition stays queryable
   *  without a log grep. */
  async #recover(
    name: string,
    firstPartyClassName: string | undefined,
    facetStartupMemo: FacetSpec | undefined,
    itxExpressionSteps: ItxExpression,
    failure: { failedOn: MaterializedFacet; error: unknown },
    watchdog: FacetCallWatchdog,
    owed: (() => void)[],
  ): Promise<unknown> {
    let { failedOn, error } = failure;
    let retriedOnReplacement = false;
    let restarted = false;
    for (;;) {
      // Removed or reconfigured while this waited: never abort the newer facet (#materialize's check).
      if (facetStartupMemo && this.#facetStartupMemoByName.get(name) !== facetStartupMemo)
        throw codedError(
          "NO_FACET",
          `facet "${name}" was deleted or reconfigured while it recovered`,
        );
      if (this.#facetGeneration(name) !== failedOn.generation) {
        if (retriedOnReplacement) throw error;
        retriedOnReplacement = true;
      } else {
        if (restarted || !isFacetStartPlatformFailure(error)) throw error;
        restarted = true;
        this.#abortFacetIfRunning(
          name,
          "platform failure at facet start — restarting",
          failedOn.generation,
        );
        this.#liveFacetNames.delete(name);
        failedOn.retireLoadedIdentity?.();
        const restarts = this.restarts(name) + 1;
        // Written once the attempt ran (`owed`), as its loaded identity is: nothing between the
        // abort and the start.
        owed.push(() => this.#deps.ctx.storage.kv.put(`facet:${name}:restarts`, restarts));
        console.warn({
          event: "facet.platform-failure-retry",
          namespace: "iterate-context",
          name,
          restarts,
          message: error.message,
        });
      }
      // The attempt IS the start after this recovery's abort: no restart of its own, and the loaded
      // identity recorded once it ran.
      const attempt = await this.#materialize(name, firstPartyClassName, facetStartupMemo, {
        platformStart: true,
      });
      try {
        return await this.#call(attempt, name, itxExpressionSteps, watchdog);
      } catch (attemptError) {
        if (!this.#isRecoverableFacetFailure(name, attemptError, attempt)) throw attemptError;
        failedOn = attempt;
        error = attemptError;
      } finally {
        if (attempt.recordLoadedIdentity) owed.push(attempt.recordLoadedIdentity);
      }
    }
  }

  /** The platform failure at facet start (the predicate), or the abort a restart for one sends to
   *  the calls in flight on the start it retires — never a start whose own startup threw. */
  #isRecoverableFacetFailure(
    name: string,
    error: unknown,
    attempt: MaterializedFacet,
  ): error is Error {
    if (attempt.startupFailed()) return false;
    if (isFacetStartPlatformFailure(error)) return true;
    return (
      error instanceof Error &&
      error.message === "platform failure at facet start — restarting" &&
      this.#facetGeneration(name) !== attempt.generation
    );
  }

  /** The container to call, live or cold: the loaded identity (resolved, not loaded) → the
   *  racing-delete/reconfigure check → the restart marker → the facet, its class minted only when
   *  it STARTS (a running one never touches the loader). A first-party facet's class comes from
   *  `ctx.exports`; `facetStartupMemo` is a loaded facet's. */
  async #materialize(
    name: string,
    firstPartyClassName: string | undefined,
    facetStartupMemo: FacetSpec | undefined,
    { platformStart }: { platformStart: boolean },
  ): Promise<MaterializedFacet> {
    // THE PROPS, read as the class is minted — only for a facet that starts: its identity, and
    // whether a row pushes it right now (`fedByPushes`, iterate/sdk FacetProps), so its engine trusts
    // the head a catch-up read until the next push. A row enabled after the start earns the same
    // trust from its first push. The word is never taken back while the facet runs: a hosting row's
    // removal deletes the facet (deleteFacetsWhoseHostingSubscriptionWasRemoved), but a row replaced
    // or re-pointed by a rule leaves it running unpushed, trusting what it last read — as a facet
    // pushed once already trusts its last push, word or no word.
    const propsAtStart = () =>
      ({
        iterateContextName: this.#deps.iterateContextName,
        name,
        ...(facetIsPushedByARow(this.#deps.stream.coreReducedState, name) && {
          fedByPushes: true,
        }),
      }) satisfies FacetProps;
    let mintClass: () => DurableObjectClass;
    let retireLoadedIdentity: (() => void) | undefined;
    let recordLoadedIdentity: (() => void) | undefined;
    if (firstPartyClassName) {
      // `ctx.exports.<Class>({ props })` mints the class (__workers-tests__/facet-from-exports.test.ts).
      const exportsOf = this.#deps.ctx.exports as unknown as Record<
        string,
        (options: { props: FacetProps }) => DurableObjectClass
      >;
      mintClass = () => exportsOf[firstPartyClassName]!({ props: propsAtStart() });
    } else {
      const memo = facetStartupMemo!;
      // THE LOADED IDENTITY, resolved — not loaded: `load` runs only for a facet that starts (below;
      // __workers-tests__/facet-class-loads-at-startup.test.ts). The one await is a dead id's
      // recovery (worker-loader.ts).
      const { loaderId, load, retire } = await prepareConfinedWorker({
        env: this.#deps.env(),
        deployId: this.#deps.deployId,
        platformOrigin: this.#deps.platformOrigin(),
        itxEntrypoint: this.#deps.itxEntrypoint(),
        kind: "facet",
        owner: [this.#deps.iterateContextName, memo.className],
        source: memo.source,
        cacheKey: memo.cacheKey,
        invoke: (call) => this.#deps.invoke(call),
        where: `facet "${name}"`,
      });
      // A removal or a RECONFIGURE may have landed while that awaited: this name's memo is then gone
      // (#deleteFacet) or a newer object (#facetStartupMemoFor replaces a changed spec). Bail — a
      // stale call must neither resurrect a deleted facet as an orphan this actor never releases, nor
      // abort the newer facet to install old code. The memo object's identity IS the check: the memo
      // is per incarnation, and so is this await.
      if (this.#facetStartupMemoByName.get(name) !== memo)
        throw codedError(
          "NO_FACET",
          `facet "${name}" was deleted or reconfigured while its source resolved`,
        );
      // `facet:<name>:loader-id`, the restart marker: when the identity moves — a source change, a
      // deploy, a workaround generation after a dead load (worker-loader.ts) — the facet restarts in
      // place, its storage surviving. The abort matters for the dead-load case too: workerd hands
      // back the SAME facet container on every `facets.get`, even one whose startup callback
      // rejected, and only an abort clears it. The row is read once per incarnation and written
      // once the facet started under the new identity (a write between the abort and the start is
      // what the platform defect needs); this incarnation's own view is `#loaderIdByName`.
      const recordedLoaderId = this.#deps.ctx.storage.kv.get(`facet:${name}:loader-id`) as
        | string
        | undefined;
      const previousLoaderId = this.#loaderIdByName.get(name) ?? recordedLoaderId;
      this.#loaderIdByName.set(name, loaderId);
      // Whether the facet runs under this identity already: a restart whose start failed leaves it
      // stopped, and this call is its start.
      let started = true;
      if (previousLoaderId && previousLoaderId !== loaderId) {
        // A platform start (`#start`, `#recover`) is itself the start that follows; a call restarts
        // it first — abort and start with nothing between (`#restart`), the identity recorded there.
        if (platformStart) {
          this.#abortForRestart(name, "loaded identity changed");
          this.#liveFacetNames.delete(name); // cold from here: it starts afresh below
        } else {
          started = await this.#restart(name, () =>
            this.#abortForRestart(name, "loaded identity changed"),
          );
          if (this.#facetStartupMemoByName.get(name) !== memo)
            throw codedError(
              "NO_FACET",
              `facet "${name}" was deleted or reconfigured while it restarted`,
            );
        }
      }
      if (this.#deps.ctx.storage.kv.get(`facet:${name}:loader-id`) !== loaderId)
        recordLoadedIdentity = () =>
          this.#deps.ctx.storage.kv.put(`facet:${name}:loader-id`, loaderId);
      if (!platformStart && started) {
        recordLoadedIdentity?.();
        recordLoadedIdentity = undefined;
      }
      mintClass = () => load().getDurableObjectClass(memo.className, { props: propsAtStart() });
      retireLoadedIdentity = retire;
    }
    // THE CLASS. A facet this actor holds LIVE (#liveFacetNames) is running: `facets.get` reuses
    // its container and never runs the startup callback — no loader lookup, no class minted for
    // nothing, and a loader hiccup cannot fail the call. A COLD facet's class is minted here,
    // before `facets.get`: a loader that refuses is then this call's own rejection, with no
    // container left behind (a startup callback that throws leaves workerd's container broken
    // until an abort, and the runtime logs the throw as uncaught). The callback still mints for
    // the one gap between the two — a container the runtime dropped under a name still held live
    // (a constructor that threw is erased by workerd) — and a throw there is aborted by `#call`,
    // so the next call starts cold and clean.
    let startupClass = mintClass; // live: the callback mints, if it ever runs
    if (!this.#liveFacetNames.has(name)) {
      const minted = mintClass(); // cold: minted now
      startupClass = () => minted;
    }
    let startupFailed = false;
    const facet = this.#deps.ctx.facets.get(name, () => {
      try {
        return { class: startupClass() };
      } catch (error) {
        startupFailed = true;
        throw error;
      }
    });
    this.#liveFacetNames.add(name); // live from here
    if (!firstPartyClassName && !platformStart) this.#deps.loadedFacetMaterialized();
    return {
      facet,
      retireLoadedIdentity,
      startupFailed: () => startupFailed,
      generation: this.#facetGenerationByName.get(name) ?? 0,
      recordLoadedIdentity,
    };
  }

  /** One call on the container under the watchdog: the steps walked receiver-preservingly — a
   *  `.fetch(request)` included (plain HTTP by expression, the upgrade refused in `handle`; a
   *  WebSocket upgrade from the DO's egress to the `secret` facet, whose 101 rides the fetch
   *  channel back) — then the answer copied out. A facet that never answers (FACET_CALL_WATCHDOG_MS)
   *  is restarted (`#restart`) — unless the call was a platform start, which leaves it — and one
   *  whose startup threw is aborted and starts on its next call: its pending call rejects, the
   *  counter drains. A call on an instance `abort` reset rejects FACET_ABORTED; one on an instance a
   *  new loaded identity or another call's timeout restarted, FACET_RESTARTED; one on an instance
   *  `#deleteFacet` deleted, NO_FACET. */
  async #call(
    { facet, startupFailed, generation }: MaterializedFacet,
    name: string,
    itxExpressionSteps: ItxExpression,
    { watchdogMs, onTimeout }: FacetCallWatchdog,
  ): Promise<unknown> {
    // Every step the walk went PAST (`repos()` in `repos().create(path)`, when one call walks several
    // steps on the facet — a subscription target's, a handle's own `invoke`) holds a session onto the
    // facet, and so this actor, until disposed: released once the call settles, below. So does the
    // call itself when the facet THROWS (a deleted workspace's refusal): released as it rejects.
    const rpcSessionsSteppedPast: unknown[] = [];
    const call = walkSteps(
      { value: facet, receiver: undefined },
      itxExpressionSteps,
      rpcSessionsSteppedPast,
    ).then((walked) => awaitAnswerReleasedIfRejected(walked.value));
    let result: unknown;
    try {
      // The label PRINTS the whole pushed batch (JSON5 + key-sort) — built lazily, so a facet
      // push pays it only if the watchdog actually fires, never on the green path.
      result = await withTimeout(
        call,
        watchdogMs,
        // Secret calls can carry material or operator credentials. Never include their arguments
        // in a timeout message, which is observable through both logs and rejected RPCs.
        () =>
          name === "secret" ? 'facet "secret"' : `facet "${name}" ${print(itxExpressionSteps)}`,
      );
    } catch (error) {
      if (errorCode(error) === "TIMEOUT") {
        if (onTimeout === "leave")
          // Left to answer: a late answer is a Workers-RPC result whose disposer references the facet
          // (the copy-out below says why), so it is disposed when it comes.
          void call.then(
            (answer) => (answer as Partial<Disposable> | undefined)?.[Symbol.dispose]?.(),
            () => {},
          );
        else if (this.#facetGeneration(name) === generation)
          await this.#restart(name, () =>
            this.#abortForRestart(name, "call timed out", generation),
          );
      } else if (startupFailed()) {
        if (this.#facetGeneration(name) === generation) {
          this.#abortFacetIfRunning(name, "startup failed", generation);
          this.#liveFacetNames.delete(name);
        }
      }
      const aborted = this.#abortedOnRequest.get(name);
      if (aborted?.generation === generation)
        throw codedError(
          "FACET_ABORTED",
          `facet "${name}" was aborted${aborted.reason ? `: ${aborted.reason}` : ""} — its next call starts it fresh`,
        );
      // A call the watchdog timed out stays TIMEOUT: only the restart's rejection of the calls it
      // cut off is re-coded.
      const restarted = this.#restartedUnderInFlightCalls.get(name);
      if (restarted?.generation === generation && errorCode(error) !== "TIMEOUT")
        throw codedError(
          "FACET_RESTARTED",
          `facet "${name}" was restarted (${restarted.reason}) — its next call runs on the new instance`,
        );
      // The runtime's own words for a call in flight on a facet `ctx.facets.delete` took
      // (workerd server.c++ `deleteFacet`): the removal this call raced, not a failure of it.
      if (
        this.#deletedGeneration.get(name) === generation &&
        error instanceof Error &&
        error.message === "Facet was deleted."
      )
        throw codedError("NO_FACET", `facet "${name}" was deleted while this call was in flight`);
      throw error;
    } finally {
      releaseRpcSessions(rpcSessionsSteppedPast);
    }
    // A Workers-RPC RESULT object carries a disposer that references the FACET until disposed or
    // GC'd — and GC is too late for the release: an aborted facet stayed referenced through every
    // `snapshot()` result left behind, and this actor could not be evicted (pinned, billed). So
    // copy the DATA out and release the result at once; an answer that cannot be cloned (a stub,
    // a stream, a Response) is handed through as is and is the caller's to dispose.
    // `in` requires an object operand: a facet call may return any value, and this typeof/object guard is what makes `Symbol.dispose in result` safe to evaluate
    if (typeof result === "object" && result && Symbol.dispose in result) {
      let copy: unknown;
      try {
        copy = structuredClone(result);
      } catch {
        return result;
      }
      (result as Disposable)[Symbol.dispose](); // `Symbol.dispose in result`, checked above
      return copy;
    }
    return result;
  }

  /** THE STARTUP MEMO `facet:<name>` (the FacetSpec in this DO's kv) for one call: a hosting `spec`
   *  writes it (when it changed) BEFORE the load, so `itx.facets.get(name)` alone re-materializes the
   *  facet after an eviction; a bare name reads it; a name with neither is recovered from the durable
   *  log (the source-less hosting row, below); an unknown name is NO_FACET. Synchronous, so nothing slips in between the checks. */
  #facetStartupMemoFor(name: string, spec: FacetSpec | undefined): FacetSpec {
    let facetStartupMemo =
      this.#facetStartupMemoByName.get(name) ??
      // kv answers `unknown`; this method is the only writer of `facet:<name>`.
      (this.#deps.ctx.storage.kv.get(`facet:${name}`) as FacetSpec | undefined);
    if (spec) {
      assertFacetSourceWithinCeiling(spec, `facet "${name}"`);
      const storedSpec = facetSpecOf(spec);
      // Replaced only when it CHANGED: an unchanged spec keeps the memo object, and with it the
      // loader's identity-keyed content hash.
      if (!facetStartupMemo || JSON.stringify(facetStartupMemo) !== JSON.stringify(storedSpec)) {
        this.#deps.ctx.storage.kv.put(`facet:${name}`, storedSpec);
        facetStartupMemo = storedSpec;
      }
    }
    if (!facetStartupMemo) {
      // A hosting row keeps NO source in core state — recover it from the DURABLE log event that
      // configured it and write the memo once. The memo survives eviction (kv), so this log read
      // happens at most once per facet per deployment, never per push. The hosting row's marker
      // names the facet (the subscription's own name may differ).
      const row = Object.values(this.#deps.stream.coreReducedState.subscriptions).find(
        (candidate) => candidate.hostedFacet?.name === name,
      );
      if (row?.hostedFacet) {
        const [configuredEvent] = this.#deps.stream.read(row.configuredAtOffset - 1, 1).events;
        const configuredTarget = (
          configuredEvent?.payload as SubscriptionConfiguredPayload | undefined
        )?.target;
        // RESOLVED before reading the spec off it, as the reduce did when it marked the row.
        const recoveredSpec = configuredTarget
          ? facetSpecFromHostingTarget(
              this.#deps.resolveItxExpression(normalizedItxExpression(configuredTarget)).at(-1)!,
            )
          : undefined;
        if (recoveredSpec) {
          const recovered = facetSpecOf(recoveredSpec as FacetSpec);
          this.#deps.ctx.storage.kv.put(`facet:${name}`, recovered);
          facetStartupMemo = recovered;
        }
      }
    }
    if (!facetStartupMemo)
      throw codedError("NO_FACET", `no facet "${name}" — load a class into it first`);
    this.#facetStartupMemoByName.set(name, facetStartupMemo);
    return facetStartupMemo;
  }

  /** `recover` once this facet's earlier recoveries settled, its own outcome handed back. */
  #afterEarlierRecoveries<T>(name: string, recover: () => Promise<T>): Promise<T> {
    const recovery = (this.#facetRecoveryByName.get(name) ?? Promise.resolve()).then(recover);
    const settled = recovery.then(
      () => {},
      () => {},
    );
    this.#facetRecoveryByName.set(name, settled);
    void settled.then(() => {
      if (this.#facetRecoveryByName.get(name) === settled) this.#facetRecoveryByName.delete(name);
    });
    return recovery;
  }

  /** Abort a facet that is running; one that is not (already released, never started) is nothing. */
  #abortFacetIfRunning(name: string, reason: string, expectedGeneration?: number): void {
    const generation = this.#facetGeneration(name);
    if (expectedGeneration !== undefined && expectedGeneration !== generation) return;
    try {
      this.#deps.ctx.facets.abort(name, reason);
      this.#facetGenerationByName.set(name, generation + 1);
    } catch {
      /* facet not running */
    }
  }
  /** A platform restart's abort (a new loaded identity, a call timed out), the generation it ended
   *  recorded so every other call in flight on it rejects FACET_RESTARTED (`#call`). */
  #abortForRestart(name: string, reason: string, expectedGeneration?: number): void {
    const generation = this.#facetGeneration(name);
    this.#abortFacetIfRunning(name, reason, expectedGeneration);
    if (this.#facetGeneration(name) !== generation)
      this.#restartedUnderInFlightCalls.set(name, { generation, reason });
  }
  #facetGeneration(name: string): number {
    return this.#facetGenerationByName.get(name) ?? 0;
  }

  /** Delete a facet, storage included (there is no delete verb: a removed hosting row ends here). A
   *  re-load into the same name is a clean rebuild, never a resume from orphaned state. */
  #deleteFacet(name: string): void {
    if (name === CoreContract.slug)
      throw new Error(`"${name}" is the core reduce — always on, never a facet`);
    this.#deps.ctx.facets.delete(name);
    this.#deletedGeneration.set(name, this.#facetGeneration(name));
    this.#facetGenerationByName.set(name, this.#facetGeneration(name) + 1);
    this.#claimFacetAlarm(name, null);
    this.#facetRevived(name);
    this.#deps.ctx.storage.kv.delete(`facet:${name}`);
    this.#deps.ctx.storage.kv.delete(`facet:${name}:loader-id`);
    this.#deps.ctx.storage.kv.delete(`facet:${name}:restarts`);
    this.#deps.ctx.storage.kv.delete(`facet-ran:${name}`);
    this.#facetStartupMemoByName.delete(name);
    this.#loaderIdByName.delete(name);
    this.#ranThisIncarnation.delete(name);
    this.#liveFacetNames.delete(name);
  }
}

/** A `subscription-configured` payload as the log holds it: `normalizeControlEvent`
 *  (stream/core-processor.ts `normalizeSubscriptionConfigured`) parses the target to its
 *  `ItxExpression` at the append boundary, so every committed event, fresh or read back, has it. */
type SubscriptionConfiguredPayload = { name: string; target: ItxExpression | null };
