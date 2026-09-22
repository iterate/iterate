// context/facet-host.ts — `FacetHost`: how a loaded DurableObject class lives inside a context's DO.
// A facet is materialized from its startup memo (`facet:<name>` in kv) under a loaded identity whose
// change restarts it in place, called under a watchdog, its answer copied out and the result object
// disposed. The claims hosted processors make on the context's alarm (`processors.claim`) live here
// with the backoff ladder of failed revives; the DO's alarm pass calls `reviveDueClaims`. The DO
// wires the deps and forwards; nothing here reaches past `ctx.facets`, `ctx.storage.kv`,
// `ctx.exports` and what it is handed.

import { codedError, errorCode, reportIssue, withTimeout } from "iterate/next/lib";
import {
  REVIVE_AFTER_MAX_MS,
  REVIVE_AFTER_MS,
  type StreamEvent,
} from "iterate/next/stream/processor";
import {
  normalizedItxExpression,
  print,
  type ItxExpression,
  type ItxExpressionInput,
  walkSteps,
  FacetHandle,
} from "iterate/next/expression";
import {
  CoreContract,
  facetSpecFromHostingTarget,
  type CoreState,
} from "../stream/core-processor.ts";
import { firstPartyFacetClassOf } from "../first-party-facets.ts";
import type { Stream } from "../stream/stream.ts";
import {
  assertFacetSourceWithinCeiling,
  facetLoaderOwner,
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
 *  heals at once) — so the recovery is a restart of both and ONE more attempt (`invoke`),
 *  counted per facet (`facet:<name>:restarts`, shown on `processors.list()`). apps/os carries the
 *  same recovery for its dynamic workers (issue #2288). Remove when the platform is fixed. */
const isFacetStartPlatformFailure = (error: unknown): error is Error =>
  error instanceof Error &&
  (error.message.includes("Unable to deserialize cloned data") ||
    error.message.startsWith("internal error; reference = "));
/** How long one facet call may take before the facet is aborted (a call that never answers would
 *  hold the pins' release, and with it this actor, forever). */
const FACET_CALL_WATCHDOG_MS = 60_000;

type FacetHostDeps = {
  /** `ctx.facets` (the containers), `ctx.storage.kv` (memos, restart markers, restart counts,
   *  claims), `ctx.exports` (the first-party classes). */
  ctx: Pick<DurableObjectState, "facets" | "storage" | "exports">;
  /** What `prepareConfinedWorker` reads of the env: the Worker Loader. Read at call time, off the
   *  DO's own `env` field — a workerd test swaps that field for a counting loader
   *  (__workers-tests__/facet-class-loads-at-startup.test.ts). */
  env: () => { LOADER: WorkerLoader };
  deployId: string;
  /** The DO's name: a facet's props and the owner half of its loader identity. */
  iterateContextName: string;
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
};

/** What `#materialize` hands `#call`: the container, the retirement of the loaded identity it was
 *  minted under (a loaded facet's; a first-party one has none) and whether the startup callback
 *  threw — read after a call fails, since the callback may run during it. */
type MaterializedFacet = {
  facet: Fetcher;
  retireLoadedIdentity?: () => void;
  startupFailed: () => boolean;
};

export class FacetHost {
  readonly #deps: FacetHostDeps;
  /** EVERY facet materialized this incarnation — what a release aborts. In memory on purpose:
   *  facets die with the incarnation, and a fresh call re-materializes from the durable startup memo. */
  readonly #liveFacetNames = new Set<string>();
  /** Each facet's startup memo (`facet:<name>` in kv), read ONCE per incarnation: every push then
   *  hands the loader the SAME object, so its identity-keyed content hash (worker-loader.ts) runs once
   *  per source per incarnation, not once per push. */
  readonly #facetStartupMemoByName = new Map<string, FacetSpec>();
  /** The in-flight count the test-only `releasePins` respects: aborting a facet mid-REDUCE is exactly the stall a
   *  reduce would have to repair from the log — never cause it. */
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

  constructor(deps: FacetHostDeps) {
    this.#deps = deps;
    // A claim row's value is the epoch-ms `at` this host wrote in `#claimFacetAlarm` (kv types it
    // as unknown): read back as the number it was stored as.
    for (const [key, at] of deps.ctx.storage.kv.list({ prefix: "facet-claim:" }))
      this.#facetClaims.set(key.slice("facet-claim:".length), at as number);
    // Same for the revive-failure ladder (`#facetReviveFailed` wrote it as a number).
    for (const [key, n] of deps.ctx.storage.kv.list({ prefix: "facet-claim-failures:" }))
      this.#facetReviveFailures.set(key.slice("facet-claim-failures:".length), n as number);
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
    // The row's value is the count this host wrote in `invoke` (kv types it `unknown`); absent
    // until the first restart.
    return (this.#deps.ctx.storage.kv.get(`facet:${name}:restarts`) as number | undefined) ?? 0;
  }

  /** `processors.claim` (built-ins.ts): the facet's engine is reachable, so its ladder of failed
   *  revives is over; `at` is when a `revive()` is owed by, `null` releases the claim. */
  claim(name: string, at: number | null): void {
    this.#facetRevived(name);
    this.#claimFacetAlarm(name, at);
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
        await this.invoke(name, undefined, [["revive"]]);
        this.#facetRevived(name);
      } catch (error) {
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

  /** For the test-only release (the DO's `releasePins`): every live facet aborted, so a
   *  facet-pinned actor can be evicted — unless a call is in flight (a reduce aborted midway is
   *  the stall its gap repair would have to heal). Aborted facets re-materialize from their
   *  startup memo on their next call. */
  abortLiveFacetsWhenIdle(reason: string): void {
    if (this.#facetWorkInFlight !== 0) return;
    for (const facetName of this.#liveFacetNames) this.#abortFacetIfRunning(facetName, reason);
    this.#liveFacetNames.clear();
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
    // oxlint-disable-next-line iterate/simple-truthiness-check -- null releases a claim; epoch 0 is a valid due alarm
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
   *  event that configured it, source and all (the reduced row has none — M1). The memo is the ONLY
   *  place a materialization reads the source from, so a re-enable with NEW source under the same
   *  name and class is a new loader identity on the facet's next call (`invoke` restarts it in
   *  place, storage preserved) — without this the old memo kept running the old code. A target that
   *  cannot resolve right now is left to the next call's recovery. */
  refreshFacetStartupMemosFromHostingConfigurations(committedEvents: StreamEvent[]): void {
    for (const event of committedEvents) {
      if (event.type !== "events.iterate.com/stream/subscription-configured") continue;
      const { name, target } = event.payload as {
        name: string;
        target: ItxExpressionInput | null;
      };
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
      if (event.type !== "events.iterate.com/stream/subscription-configured") continue;
      const { name, target } = event.payload as { name: string; target: string | null };
      const removedRow = !target ? subscriptionsBeforeCommit[name] : undefined;
      // M1: the marker, not the (source-less) target, says which facet a row hosts.
      const facetName = removedRow?.hostedFacet?.name;
      if (!facetName) continue;
      // Another row still hosts it (a mirror, an audit): the facet is theirs now, not gone.
      const stillHosted = Object.values(this.#deps.stream.coreReducedState.subscriptions).some(
        (row) => row.hostedFacet?.name === facetName,
      );
      if (!stillHosted) this.#deleteFacet(facetName);
    }
  }

  // ── the facets: materialize, call, retry once ──

  /** `itx.facets.get(name, spec?)`, as the built-in hands it out: a branded FacetHandle (the
   *  delivery loop reads the brand) whose every call lands in `invoke`. The facets view is
   *  PARENT-LOCAL — the facets live here and can never move (workerd#6702: sockets never leave the
   *  parent). */
  handle(name: string, spec?: FacetSpec): FacetHandle {
    return new FacetHandle((itxExpressionSteps) => {
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
      return this.invoke(name, spec, itxExpressionSteps);
    });
  }

  /** THE facet call — `itx.facets.get(name).m()` (address a running facet) and
   *  `itx.facets.get(name, { source, className }).m()` (load and host) both land here; facet stubs
   *  are non-transferable, so the walk happens where the stub lives. Top to bottom: the startup memo
   *  → `#materialize` (the loaded identity, resolved not loaded; the racing-delete/reconfigure
   *  check; the restart marker; the facet, its class minted only when it STARTS) → `#call` (the
   *  watchdog, copy + dispose the answer) — and on the platform failure at facet start, a restart
   *  and the same two steps once more. */
  async invoke(
    name: string,
    spec: FacetSpec | undefined,
    itxExpressionSteps: ItxExpression,
  ): Promise<unknown> {
    // oxlint-disable-next-line iterate/simple-truthiness-check -- name arrives as a client-authored itx expression argument; the static string type is the API contract, not a runtime guarantee, so a non-string is rejected with a usage error
    if (typeof name !== "string")
      throw new Error(
        "itx.facets.get(name, spec?): name the facet; pass { source, className } to load and host it",
      );
    if (itxExpressionSteps.length === 0) throw new Error(`facet: name a method`);
    // The core reduce answers at its facet-shaped address with a synthesized view — it is not a
    // facet, pins nothing, needs no watchdog, and can never be hosted.
    if (name === CoreContract.slug) {
      if (spec) throw new Error(`"${name}" is the core reduce — never a facet name`);
      return (
        await walkSteps(
          {
            value: {
              snapshot: () => this.#deps.stream.coreReducedStateSnapshot(),
              liveSnapshot: () => this.#deps.stream.coreLiveStateSnapshot(),
            },
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
    const facetStartupMemo = firstPartyClassName
      ? undefined
      : this.#facetStartupMemoFor(name, spec);
    this.#facetWorkInFlight++;
    try {
      const materialized = await this.#materialize(name, firstPartyClassName, facetStartupMemo);
      try {
        return await this.#call(materialized, name, itxExpressionSteps);
      } catch (error) {
        if (!isFacetStartPlatformFailure(error) || materialized.startupFailed()) throw error;
        // The platform failure (the predicate's doc): restart the facet AND retire its loaded
        // identity (the cached entry is what stays broken), then the call once more, cold. One
        // extra attempt, never a loop — a second failure is the caller's. The retry re-delivers a
        // pushed batch: durables are offset-guarded by the engine, ephemerals are not (a duplicate
        // beats a lost batch; at-least-once is the facet contract). Counted on the facet's row and
        // logged, never swallowed, so the platform condition stays queryable without a log grep.
        this.#abortFacetIfRunning(name, "platform failure at facet start — restarting");
        this.#liveFacetNames.delete(name);
        materialized.retireLoadedIdentity?.();
        const restarts = this.restarts(name) + 1;
        this.#deps.ctx.storage.kv.put(`facet:${name}:restarts`, restarts);
        console.warn({
          event: "facet.platform-failure-retry",
          namespace: "iterate-context",
          name,
          restarts,
          message: error.message,
        });
        return await this.#call(
          await this.#materialize(name, firstPartyClassName, facetStartupMemo),
          name,
          itxExpressionSteps,
        );
      }
    } finally {
      this.#facetWorkInFlight--;
    }
  }

  /** The container to call, live or cold: the loaded identity (resolved, not loaded) → the
   *  racing-delete/reconfigure check → the restart marker → the facet, its class minted only when
   *  it STARTS (a running one never touches the loader). A first-party facet's class comes from
   *  `ctx.exports`; `facetStartupMemo` is a loaded facet's. */
  async #materialize(
    name: string,
    firstPartyClassName: string | undefined,
    facetStartupMemo: FacetSpec | undefined,
  ): Promise<MaterializedFacet> {
    const props = { iterateContextName: this.#deps.iterateContextName, name };
    let mintClass: () => DurableObjectClass;
    let retireLoadedIdentity: (() => void) | undefined;
    if (firstPartyClassName) {
      // `ctx.exports.<Class>({ props })` mints the class (__workers-tests__/facet-from-exports.test.ts).
      const exportsOf = this.#deps.ctx.exports as unknown as Record<
        string,
        (options: { props: typeof props }) => DurableObjectClass
      >;
      mintClass = () => exportsOf[firstPartyClassName]!({ props });
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
        owner: facetLoaderOwner(this.#deps.iterateContextName, memo.className),
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
      // rejected, and only an abort clears it.
      const previousLoaderId = this.#deps.ctx.storage.kv.get(`facet:${name}:loader-id`) as
        | string
        | undefined;
      if (previousLoaderId && previousLoaderId !== loaderId) {
        this.#abortFacetIfRunning(name, "loaded identity changed");
        this.#liveFacetNames.delete(name); // cold from here: it starts afresh below
      }
      if (previousLoaderId !== loaderId)
        this.#deps.ctx.storage.kv.put(`facet:${name}:loader-id`, loaderId);
      mintClass = () => load().getDurableObjectClass(memo.className, { props });
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
    return { facet, retireLoadedIdentity, startupFailed: () => startupFailed };
  }

  /** One call on the container under the watchdog: the steps walked receiver-preservingly — a
   *  `.fetch(request)` included (plain HTTP by expression, the upgrade refused in `handle`; a
   *  WebSocket upgrade from the DO's egress to the `secret` facet, whose 101 rides the fetch
   *  channel back) — then the answer copied out. A facet that never answers (FACET_CALL_WATCHDOG_MS)
   *  or whose startup threw is aborted: its pending call rejects, the counter drains, the next call
   *  re-materializes it. */
  async #call(
    { facet, startupFailed }: MaterializedFacet,
    name: string,
    itxExpressionSteps: ItxExpression,
  ): Promise<unknown> {
    const call = walkSteps({ value: facet, receiver: undefined }, itxExpressionSteps).then(
      (walked) => walked.value,
    );
    let result: unknown;
    try {
      // The label PRINTS the whole pushed batch (JSON5 + key-sort) — built lazily, so a facet
      // push pays it only if the watchdog actually fires, never on the green path.
      result = await withTimeout(
        call,
        FACET_CALL_WATCHDOG_MS,
        () => `facet "${name}" ${print(itxExpressionSteps)}`,
      );
    } catch (error) {
      if (errorCode(error) === "TIMEOUT") {
        this.#abortFacetIfRunning(name, "call timed out");
        this.#liveFacetNames.delete(name);
      } else if (startupFailed()) {
        this.#abortFacetIfRunning(name, "startup failed");
        this.#liveFacetNames.delete(name);
      }
      throw error;
    }
    // A Workers-RPC RESULT object carries a disposer that references the FACET until disposed or
    // GC'd — and GC is too late for the release: an aborted facet stayed referenced through every
    // `snapshot()` result left behind, and this actor could not be evicted (pinned, billed). So
    // copy the DATA out and release the result at once; an answer that cannot be cloned (a stub,
    // a stream, a Response) is handed through as is and is the caller's to dispose.
    // oxlint-disable-next-line iterate/simple-truthiness-check -- `in` requires an object operand: a facet call may return any value, and this typeof/object guard is what makes `Symbol.dispose in result` safe to evaluate
    if (typeof result === "object" && result && Symbol.dispose in result) {
      let copy: unknown;
      try {
        copy = structuredClone(result);
      } catch {
        return result;
      }
      (result as Disposable)[Symbol.dispose]();
      return copy;
    }
    return result;
  }

  /** THE STARTUP MEMO `facet:<name>` (the FacetSpec in this DO's kv) for one call: a hosting `spec`
   *  writes it (when it changed) BEFORE the load, so `itx.facets.get(name)` alone re-materializes the
   *  facet after an eviction; a bare name reads it; a name with neither is recovered from the durable
   *  log (M1, below); an unknown name is NO_FACET. Synchronous, so nothing slips in between the checks. */
  #facetStartupMemoFor(name: string, spec: FacetSpec | undefined): FacetSpec {
    let facetStartupMemo =
      this.#facetStartupMemoByName.get(name) ??
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
      // M1: a hosting row keeps NO source in core state — recover it from the DURABLE log event that
      // configured it and write the memo once. The memo survives eviction (kv), so this log read
      // happens at most once per facet per deployment, never per push. The hosting row's marker
      // names the facet (the subscription's own name may differ).
      const row = Object.values(this.#deps.stream.coreReducedState.subscriptions).find(
        (candidate) => candidate.hostedFacet?.name === name,
      );
      if (row?.hostedFacet) {
        const [configuredEvent] = this.#deps.stream.read(row.configuredAtOffset - 1, 1).events;
        const configuredTarget = (
          configuredEvent?.payload as { target?: ItxExpressionInput } | undefined
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

  /** Abort a facet that is running; one that is not (already released, never started) is nothing. */
  #abortFacetIfRunning(name: string, reason: string): void {
    try {
      this.#deps.ctx.facets.abort(name, reason);
    } catch {
      /* facet not running */
    }
  }

  /** Delete a facet, storage included (there is no delete verb: a removed hosting row ends here). A
   *  re-load into the same name is a clean rebuild, never a resume from orphaned state. */
  #deleteFacet(name: string): void {
    if (name === CoreContract.slug)
      throw new Error(`"${name}" is the core reduce — always on, never a facet`);
    this.#deps.ctx.facets.delete(name);
    this.#claimFacetAlarm(name, null);
    this.#facetRevived(name);
    this.#deps.ctx.storage.kv.delete(`facet:${name}`);
    this.#deps.ctx.storage.kv.delete(`facet:${name}:loader-id`);
    this.#deps.ctx.storage.kv.delete(`facet:${name}:restarts`);
    this.#facetStartupMemoByName.delete(name);
    this.#liveFacetNames.delete(name);
  }
}
