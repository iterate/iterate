// iterate-context-durable-object.ts — `IterateContextDurableObject`: THE CONTEXT, one DO per
// `{projectId, path}` (codec-named `{projectId}.iterate{path}`), the parent of everything a context
// holds: the stream with its core reduce (stream/stream.ts), subscription delivery
// (stream/subscription-delivery.ts), the facets (context/facet-host.ts over `ctx.facets` and
// context/worker-loader.ts), the rpc stubs (context/rpc-stubs.ts), what ends its residency when
// nothing should hold it (context/residency.ts), and `fetch()` (the pager upgrade, HTTP requests,
// egress). Each module's header says what it does; this file is the wiring and the entry points.
//   egress — `#egress`: a `getSecret("/secrets/NAME")` request is forwarded to the context at that path, whose `secret` facet substitutes and dispatches (secret/durable-object.ts)
//
// PURE WORKERS-RPC: capnweb never terminates here — the stateless `/api` worker relays. Dispatch is
// ONE method, `invoke(call)`; every OTHER change to this context is an appended event (the edge's
// `provide`/`subscribe` and the `processors` root build one and call `append`; a lent stub's rule or
// row rides its pager upgrade and is appended as the pager is accepted) — there are no
// configuration verbs here. The events this class appends on its own initiative: the birth and wake
// records (Stream.appendBirthRecord / appendWakeRecord — the wake record also settles, `interrupted`,
// every run the last incarnation left open), a due schedule's batch (`alarm`), a requested run's
// settlement (`#executeRun` — the runner section) and the un-set of whatever named an rpc stub whose
// last pager closed (onPresence); alarm diagnostics are ephemeral traces. The effects it runs off a
// fresh commit (`#appendAndRunCommittedEffects`): deleting the facet a removed subscription hosted and
// refreshing the startup memo of the facet a hosting subscription configures; off every commit
// (`onCommit`) delivery, the requested runs, and un-setting what names an rpc stub a woken or
// resumed stream finds dead.

import { AsyncLocalStorage } from "node:async_hooks";
import {
  codedError,
  errorCode,
  ITERATE_CAUSE_HEADER,
  releaseRpcSessions,
  reportIssue,
} from "iterate/lib";
import { DurableObject } from "cloudflare:workers";
import type { StreamEvent, StreamEventInput } from "iterate/stream/processor";
import {
  canonicalItxExpressionPrefix,
  itxExpressionStepName,
  print,
  type ItxExpression,
  type ItxExpressionInput,
  type ItxExpressionPrefix,
  InvokeHandle,
  normalizedItxExpression,
} from "iterate/expression";
import { ITX_PRINCIPAL_HEADER, type Principal } from "iterate/principal";
import type { RewriteRuleListEntry, StreamPage, SubscriptionListEntry } from "iterate/api";
import { ITERATE_ROUTING_SLUG_HEADER } from "iterate/project-ingress";
import { RunRequested, type RunSettlement } from "iterate/stream/run";
import { failureKind, isPlatformFailureKind, logPlatformFailure } from "iterate/platform-retry";
import { causeOfDelivery, deepestCause, newChain, parseCause, type Cause } from "./cause.ts";
import {
  ITX_APP_HEADER,
  ITX_CALLER_PATH_HEADER,
  ITX_GRANT_HEADER,
  refuseNonPlatformWrites,
  sha256Hex,
  stampCaller,
  type Caller,
} from "./caller.ts";
import { RpcStubHandle, itxAnswerDetachedFromSession } from "./context/dispatch.ts";
import { mintOnBehalfOf, type OnBehalfOf } from "./on-behalf-of.ts";
import { normalizeControlEvent, type CoreState } from "./stream/core-processor.ts";
import {
  ITX_EXPRESSION_FETCH_HEADER,
  parseFetchExpression,
  ITX_PLATFORM_ORIGIN_HEADER,
  itxExpressionEndingInFetch,
  RpcStubDirectory,
  RPC_STUB_PAGER_KEEPALIVE_REQUEST,
  RPC_STUB_PAGER_KEEPALIVE_RESPONSE,
  type BorrowedRpcStub,
} from "./context/rpc-stubs.ts";
import { RpcStubFetchServer } from "./context/fetch-upgrade.ts";
import {
  buildLibrary,
  executeScript,
  runSettlementOf,
  ScriptRunRequested,
  settlementOfScriptRun,
  type LibraryItx,
} from "./library.ts";
import { waitForEventOnContext } from "./context-stub.ts";
import { Stream, type ReachableContext } from "./stream/stream.ts";
import { ALARM_MAX_REARMS, AlarmCoordinator } from "./alarm-coordinator.ts";
import { itxAiFor } from "./itx-ai.ts";
import {
  ancestorPathsOf,
  CONTEXT_DESTROYED,
  DurableObjectNameCodec,
  GLOBAL_PROJECT_ID,
  pathUnderOwner,
  PROJECT_DELETED,
  resourceScope,
} from "./context/paths.ts";
import { LEND_USE_HEADER, LENT_AS_HEADER, verifyLendUse } from "./secrets.ts";
import { expressionFetchErrorAnswer } from "./unavailable.ts";
import {
  appConfigOf,
  iterateAppScopesOf,
  sessionSigningSecretOf,
  type AppConfigEnv,
} from "./app-config.ts";
import {
  ItxExpressionResolver,
  describeRewriteRules,
  rowsNamingRpcStub,
  refuseLiftingAJail,
  rpcStubKeysNamed,
  implicitRootsAt,
  namesTakenAway,
  rulesChangeNeedsCommitWait,
  type ItxExpressionRewriteRule,
} from "./context/itx-expression-rewriting.ts";
import { ControlPlane } from "./control-plane/edge.ts";
import { buildBuiltIns, projectConfigDeps } from "./context/built-ins.ts";
import { contextReach, itxEntrypointFor } from "./context/stateless-context.ts";
import { FacetHost } from "./context/facet-host.ts";
import type { NamedWorker } from "./context/worker-loader.ts";
import { firstPartyFacetClassOf } from "./first-party-facets.ts";
import type { ArtifactsNamespace } from "./context/cf-artifacts.ts";
import { Residency } from "./context/residency.ts";
import { egress } from "./context/egress.ts";
import { SNAPSHOT_TTL_MS, type RulesSnapshotAnswer } from "./context/rule-snapshots.ts";
import { SubscriptionDelivery, type DeliveryDeadline } from "./stream/subscription-delivery.ts";

/** WHO THIS CONTEXT IS: its name, when it was reached by name (every caller but one); reached by
 *  id alone — the context sweep (scripts/ci/context-sweep.ts), which knows only the ids Cloudflare
 *  lists — its own birth record, `itx/created { projectId, path }` at offset 1. A context with no
 *  birth record and no name is nobody: refused, so no id alone ever mints one. That refusal is the
 *  sweep's expected answer for an object emptied moments ago, which Cloudflare still lists: it is
 *  logged at info, `context.unborn-by-id`, before the throw the runtime logs as an error line
 *  (`#abort` says how the prd fault alarm reads the pair). */
function iterateContextAddressOf(ctx: DurableObjectState) {
  if (ctx.id.name) return DurableObjectNameCodec.parse(ctx.id.name);
  let body: string | undefined;
  try {
    body = ctx.storage.sql
      .exec<{ body: string }>("SELECT body FROM events WHERE offset = 1")
      .toArray()[0]?.body;
  } catch {
    // no events table: an empty store
  }
  const born = body
    ? (JSON.parse(body) as { type?: string; payload?: { projectId?: string; path?: string } })
    : undefined;
  if (
    born?.type !== "events.iterate.com/itx/created" ||
    !born.payload?.projectId ||
    !born.payload.path
  ) {
    const message =
      "IterateContextDurableObject must be addressed by name (reach it via getByName); by id, only a context that was born answers.";
    console.info({ event: "context.unborn-by-id", message });
    throw new Error(message);
  }
  return DurableObjectNameCodec.address({
    projectId: born.payload.projectId,
    path: born.payload.path,
  });
}

/** ONE ALARM PASS, as the DO saw it — the payload of the ephemeral `itx/alarm-trace` event,
 *  appended as the pass starts (`alarm-fired`, with what was armed and every deadline it found)
 *  and as it ends (`alarm-pass` with what it armed next, or `alarm-abandoned` with what it threw).
 *  Only a pass traces: a reconcile outside one — a commit, a claim, a delivery settling —
 *  consumes no offset, so an incarnation that never
 *  wakes by alarm leaves offsets exactly as its own events placed them. An ordinary ephemeral:
 *  `waitForEvent` sees it live, `readEvents(…, { includeEphemeral: true })` reads it back from the
 *  stream's recent-ephemerals ring. NEVER an input: the DO's commit
 *  hook hands no trace to subscription delivery, and appending one moves no clock — either would
 *  trace the tracing. Gone with the incarnation, as every ephemeral is (its `itx/woken` names
 *  the incarnation). */
export type AlarmTrace = {
  at: number;
  reason: "alarm-fired" | "alarm-pass" | "alarm-abandoned";
  /** What an abandoned pass threw. */
  error?: string;
  /** The physical alarm as this incarnation knew it when the pass started (`before` — null when
   *  the alarm itself woke this incarnation: workerd hides a firing alarm) and now (`after`). */
  alarm: { before: number | null; after: number | null };
  deadlines: {
    schedule: number | null;
    /** The cursor rows holding a claim, earliest first, at most 32. */
    delivery: DeliveryDeadline[];
    deliveryOmitted: number;
    /** The hosted processors holding a claim (`processors.claim`): a revive owed by `at`. */
    claims: { name: string; at: number }[];
    /** The unclaimed-facet sweep's deadline — in memory, so null in a fresh incarnation. */
    unclaimedFacetSweep: number | null;
  };
  durableHead: number;
  /** On `alarm-fired`: how many schedules this pass will append. */
  dueSchedules?: number;
  /** On `alarm-fired`: how many runs a processor requested this pass started. */
  runs?: number;
  facetWorkInFlight: number;
  /** Names, at most 32. */
  liveFacets: string[];
  borrowedRpcStubs: boolean;
  /** The library holds an open capnweb socket (an MCP/OpenAPI client holds nothing). */
  libraryHoldsSocket: boolean;
};

/** The bindings THE DO reads (Vite's built Wrangler config): the DO namespace, the Worker Loader, the kv namespaces,
 *  Workers AI, Browser Run, Artifacts, Email Sending — and, from `AppConfigEnv`, the version-metadata binding and the `APP_CONFIG_*`
 *  vars worker.ts's `parseAppConfig` parses. env.ts's `Env` extends this with the issuer's own
 *  (OAuth KV, the browser sessions, the page files): the one worker's env. */
export interface Env extends AppConfigEnv {
  ITERATE_CONTEXT: DurableObjectNamespace<IterateContextDurableObject>;
  /** THE CONTROL PLANE'S D1: the deployment's users, identities, organizations, memberships,
   *  projects, invitations, custom hostnames and the OAuth provider's grants
   *  (control-plane/db/definitions.sql), read and written through control-plane/edge.ts — here, a
   *  context's own project's slug. */
  DB: D1Database;
  LOADER: WorkerLoader;
  ITX_KV: KVNamespace;
  /** Workers AI — read only by the stateless `ItxAi` (itx-ai.ts), the built-in root `itx.ai`. */
  AI: Ai;
  /** Browser Run — the built-in root `itx.browser` (context/built-ins.ts). */
  BROWSER: BrowserRun;
  /** The one R2 bucket — the built-in root `itx.r2`, every owner under its own prefix (context/built-ins.ts). */
  FILES: R2Bucket;
  /** Cloudflare Artifacts (beta) — the ONE bound namespace behind `itx.cfArtifacts`, project-scoped. */
  ARTIFACTS: ArtifactsNamespace;
  /** Email Sending (wrangler `send_email`) — the sign-in code (password-and-code-sign-in.ts) and
   *  `itx.email` (context/built-ins.ts). Simulated by wrangler dev and the test configs; absent where
   *  a deployment has no mailbox. */
  EMAIL?: SendEmail;
}

/** How far the clock of the machine a context wakes on may be from the one it last ran on: a wake
 *  takes the lease of everything the last incarnation served as ending this much later. */
const SNAPSHOT_CLOCK_SLACK_MS = 250;

/** A revocation fence (`#takeRevocationFence`): until when a rule write waits, on this context's
 *  clock, and the names the commits behind it took away. */
type RevocationFence = { until: number; takenAway: ItxExpressionPrefix[] };

/** A call as its wake record names it: the names of its steps, never their arguments
 *  (`itx.repos.get.modules`). */
const verbPathOf = (call: ItxExpressionInput): string =>
  normalizedItxExpression(call).map(itxExpressionStepName).join(".").slice(0, 200);

/** The events that write what a rule snapshot carries: a repeat of one waits a pending fence out. */
const SNAPSHOT_ROW_TYPES: ReadonlySet<string> = new Set([
  "events.iterate.com/itx/rewrite-rule-configured",
  "events.iterate.com/itx/fetch-route-configured",
  "events.iterate.com/itx/ingress-configured",
]);

export class IterateContextDurableObject extends DurableObject<Env> {
  /** Native operator RPC only. Bypass every project rewrite so no project code can observe
   * the admin credential. The first-party secret facet independently verifies it. */
  async exportSecretForProjectSeed(adminSecret: string): Promise<unknown> {
    if (this.#unborn) throw this.#unborn;
    return this.#facetHost.callFacetAsPlatform("secret", [["exportForProjectSeed", adminSecret]]);
  }

  /** The version this context runs (`CF_VERSION_METADATA.id`), for `session.versions`. Native RPC
   *  only. */
  version() {
    return this.#appConfig.deployId;
  }

  /** WHO THIS DO IS: the DO name parsed ONCE into `{ name, projectId, path }`. A context is only
   *  ever reached `getByName`; an id-addressed instance fails right here, before it can touch anything. */
  readonly #durableObjectAddress = iterateContextAddressOf(this.ctx);
  /** The roots with an implicit row HERE (itx-expression-rewriting.ts `implicitRootsAt`): every built-in at the
   *  resource owner's root, the context roots anywhere else. Fixed for the DO's life — a path is. */
  readonly #implicitRoots = implicitRootsAt(
    this.#durableObjectAddress.projectId,
    this.#durableObjectAddress.path,
  );
  /** THE PLATFORM ORIGIN this context is reached on — what the edge stamped on its callers
   *  (`Caller.platformOrigin`), PERSISTED here (`ctx.storage.kv`) the moment a caller says it, so a
   *  call that carries none (a loaded worker's `env.ITX`, an alarm, a commit's fan-out) composes URLs
   *  at the same origin the people do — across evictions. Null until the first stamped call. */
  #platformOrigin: string | null = null;
  /** The `env.ITX` / `globalOutbound` stub every worker this context loads receives, minted with the
   *  origin this context is reached on (so loaded code's hops carry it) — re-minted when that origin
   *  is first learned or changes; a stub minted for the current origin is reused. */
  #itxEntrypointStub: { origin: string | null; stub: Fetcher } | null = null;
  get #itxEntrypoint(): Fetcher {
    if (!this.#itxEntrypointStub || this.#itxEntrypointStub.origin !== this.#platformOrigin)
      this.#itxEntrypointStub = {
        origin: this.#platformOrigin,
        stub: itxEntrypointFor(this.ctx, this.#durableObjectAddress.name, this.#platformOrigin),
      };
    return this.#itxEntrypointStub.stub;
  }
  /** This deployment's configuration (worker.ts `appConfigOf`) — a malformed var throws here, naming it. */
  readonly #appConfig = appConfigOf(this.env);
  /** This context's reach into its project (context/stateless-context.ts `contextReach`). */
  readonly #reach = contextReach({
    env: this.env,
    namespace: this.env.ITERATE_CONTEXT,
    projectId: this.#durableObjectAddress.projectId,
    platformOrigin: () => this.#platformOrigin,
    ctx: this.ctx,
    ambient: () => this.#caller,
    // a run this context sends on is its caller's to read, or its runner's (`#scriptExecution`)
    readsRunSettlements: false,
  });
  /** context/fetch-upgrade.ts — wired to `fetch` and the two WebSocket handlers below. */
  readonly #rpcStubFetch = new RpcStubFetchServer(this.ctx, {
    deployId: this.#appConfig.deployId,
    path: this.#durableObjectAddress.path,
    contextAbortedOffset: () =>
      this.#stream.coreReducedState.wokenAfterContextAbortedOffset ?? null,
  });
  readonly #rpcStubs = new RpcStubDirectory({
    rpcStubFetch: this.#rpcStubFetch,
    ctx: this.ctx,
    // The SET half of "the DO owns both ends of a lent stub's rule": the events a pager attach
    // carries are committed like any append, in the turn the pager is accepted (the
    // un-set half is `#unsetWhatNamesRpcStub`). They are a client's events: their `source` is the
    // DO's — this context's own, and a lent stub's rule is unattributed.
    appendEvents: (events) =>
      void this.#appendAndRunCommittedEffects(
        events.map((event) =>
          stampCaller(event, { principal: null }, this.#durableObjectAddress.path),
        ),
      ),
    // PRESENCE is physical (`itx.rpcStubs.list()`); its changes are EPHEMERAL facts, never durable
    // rows — the log must never claim a socket is open. A refusal (a paused stream) is nothing to
    // report: a watcher re-seeds from list().
    onPresence: (kind, rpcStubKey) => {
      void this.append({
        type: `events.iterate.com/itx/rpc-stub-${kind}`,
        ephemeral: true,
        payload: { rpcStubKey },
      }).catch(() => undefined);
      // THE STUB IS GONE, SO IS WHAT NAMED IT: a key's LAST pager closing un-sets every rule and
      // row whose target RESOLVES to `itx.builtins.rpcStubs.get('<key>')`. Decided HERE and not in
      // the lender's session teardown because only this side knows the truth: a reconnect REPLACES
      // the pager (never a detach), so the reconnected session's rule survives a late-dying old
      // session, while a genuine last close un-sets it exactly once.
      if (kind === "detached") this.#unsetWhatNamesRpcStub(rpcStubKey);
    },
  });

  #unsetWhatNamesRpcStub(rpcStubKey: string): void {
    // ONE frozen census BEFORE any append (`rowsNamingRpcStub`): the answer never depends on the
    // order the rows were configured in or on a row removed a moment earlier. Then appended one by
    // one, each catching its own async refusal so one failure stops none of the others. A rule is
    // REMOVED (back to the platform row beneath, if any — a dead fake `itx.ai` restores the real
    // one), never masked: `null` is the caller's deliberate deny.
    const { ruleUnsets, subscriptionNames, fetchRouteNames } = rowsNamingRpcStub({
      rpcStubKey,
      ...this.#rowsForRpcStubCensus(),
    });
    // Each commits in this turn and answers no one, so it waits out no fence: the owner's live table
    // refuses the stub's name from the commit on, and no timer keeps this context resident.
    const unset = (event: StreamEventInput) => {
      try {
        this.#appendAndRunCommittedEffects([event]);
      } catch {
        // refused (a paused stream): the next wake's census un-sets it (`#unsetWhatNamesDeadRpcStubs`)
      }
    };
    // Compare-and-set: each removal carries `ifTarget` (the target the census saw), so a `provide` that
    // re-claims the same match during this detach window is not clobbered — the reduce skips a stale undo.
    for (const { match, ifTarget } of ruleUnsets)
      unset({
        type: "events.iterate.com/itx/rewrite-rule-configured",
        payload: { match, target: null, ifTarget },
      });
    for (const name of subscriptionNames)
      unset({
        type: "events.iterate.com/itx/subscription-configured",
        payload: { name, target: null },
      });
    for (const fetchRouteName of fetchRouteNames)
      unset({
        type: "events.iterate.com/itx/fetch-route-configured",
        payload: { fetchRouteName, requestMatcher: null },
      });
  }

  /** The three tables as the pure census functions read them: every rule, every subscription's
   *  target, every fetch route's target. */
  #rowsForRpcStubCensus(): {
    rules: ItxExpressionRewriteRule[];
    subscriptionTargets: Record<string, ItxExpression>;
    fetchRouteTargets: Record<string, ItxExpression>;
    implicitRoots: ReadonlySet<string>;
  } {
    const { itxExpressionRewriteRules, subscriptions, fetchRoutes } = this.#stream.coreReducedState;
    return {
      implicitRoots: this.#implicitRoots,
      rules: Object.values(itxExpressionRewriteRules),
      subscriptionTargets: Object.fromEntries(
        Object.entries(subscriptions).map(([name, row]) => [name, row.target]),
      ),
      fetchRouteTargets: Object.fromEntries(
        Object.entries(fetchRoutes).map(([fetchRouteName, route]) => [
          fetchRouteName,
          route.target,
        ]),
      ),
    };
  }

  /** A stub whose last pager closed with no close handler run never had what named it un-set: a DO
   *  reset (every deploy) kills every hibernatable socket silently, and a stub whose last pager
   *  closed DURING a pause had its un-set refused (`itx/paused` refuses ordinary appends). So on the
   *  `woken` commit (a fresh incarnation) and the `resumed` one, every key a row names that has NO
   *  transport (neither borrowed nor pager-backed) is un-set — a lender still alive re-dials, and its
   *  attach re-appends the row. Safe across hibernation: the pager sockets that rode it rehydrate with
   *  their attachments before any handler runs, so `listRpcStubKeys()` is exact on the wake. The
   *  census is taken now, the un-sets are appends of their own off the commit's turn, and a key
   *  whose pager attached in between (a re-dial is the wake) is present by then and kept. */
  #unsetWhatNamesDeadRpcStubs(committedEvents: StreamEvent[]): void {
    const sweep = committedEvents.some(
      (event) =>
        event.type === "events.iterate.com/itx/woken" ||
        event.type === "events.iterate.com/itx/resumed",
    );
    if (!sweep) return;
    const named = rpcStubKeysNamed(this.#rowsForRpcStubCensus());
    queueMicrotask(() => {
      const present = new Set(this.#rpcStubs.listRpcStubKeys());
      for (const rpcStubKey of named)
        if (!present.has(rpcStubKey)) this.#unsetWhatNamesRpcStub(rpcStubKey);
    });
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The edge relay's pager keepalive (every 500 ms) is answered at the RUNTIME level WITHOUT waking
    // this DO: the relay's liveness check (a reset stops the answers) and what keeps the pager past
    // the ~100s idle-close. DO-wide and persisted, so it also covers
    // fetch-upgrade EYEBALL sockets — which is why the literal is deliberately distinctive: a plain
    // "ping" would silently hijack any client frame that equals it (ws-fetch-live-101 caught that).
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(
        RPC_STUB_PAGER_KEEPALIVE_REQUEST,
        RPC_STUB_PAGER_KEEPALIVE_RESPONSE,
      ),
    );
    // The stored alarm is read BEFORE the first commit can reconcile: the coordinator's dedupe seed
    // (alarm-coordinator.ts — every reason to wake is derived again below, so a due one is armed at
    // the same time, no write, and a stale one is superseded). Null while an alarm is being
    // delivered (workerd hides a firing alarm for the whole run), so the wake record — and a birth —
    // is NOT written here: the first entry point to run names the wake and its cause
    // (`appendWakeRecord` — `alarm()` says "alarm"), and a call past the loop limit wakes nothing.
    // Not awaited: a constructor cannot, and the runtime holds every event until this settles.
    void this.ctx.blockConcurrencyWhile(async () => {
      if (await this.#refuseBirthOfDeletedProjectRoot()) return;
      this.#alarmCoordinator.restore(await this.ctx.storage.getAlarm());
      // A deployment that names its origin (`urls.os`: prd, the previews — anything with more than one
      // hostname) knows it outright; one that does not (a self-host on workers.dev) learns it from the
      // first stamped caller and keeps it here across evictions.
      this.#platformOrigin =
        this.#appConfig.urls.os ||
        ((this.ctx.storage.kv.get("platform-origin") as string | undefined) ?? null);
      // Before this incarnation writes anything: the facets the last one ran are started (and the
      // unclaimed loaded ones reset) — a facet evicted mid-write meets no commit of it stopped.
      await this.#residency.resetUnclaimedFacetsAtBirth();
      this.#stream.storage.countIncarnation();
      if (this.#stream.highestDurableOffset() > 0)
        this.#snapshotLeaseUntil = Date.now() + SNAPSHOT_TTL_MS + SNAPSHOT_CLOCK_SLACK_MS;
      // THE OVERDUE WATCH at birth (alarm-coordinator.ts): a stored alarm well past its time that a
      // source still wants is one the runtime held — an idle actor has no timer watching it; one no
      // source wants (the last incarnation's sweep) is superseded instead.
      // Not for a context reached by id alone (the context sweep's `identity`, `readForSweep`): an
      // orphan's held alarm brought forward would wake it, and a wake announces it to the ancestors
      // its deleted project lost. An alarm the runtime delivers on its own still runs.
      if (this.ctx.id.name) this.#alarmCoordinator.rearmIfOverdue(Date.now());
    });
  }

  /** A DELETED PROJECT'S ROOT IS NEVER BORN AGAIN: a request that read the project's row before it
   *  was deleted (an isolate's memo) still reaches the root by name, as the operator may with any
   *  `prj_…` id, and a root born then would hold storage for a project that is gone. So a root's
   *  birth — a store with no durable row — asks the control plane first (catalog.ts
   *  `deletedProject`). A deleted project's root is not born: the tables the stream opened as this
   *  instance was built go, and every entry point answers `#unborn` first (`#unbornStill`), nothing
   *  run and nothing written — a refusal like any other, where a reset would log an error for
   *  every request that reaches it. A question that failed fails the birth, the store left as
   *  empty, and resets this instance, so the next request asks again. Answers whether the birth
   *  was refused. */
  async #refuseBirthOfDeletedProjectRoot(): Promise<boolean> {
    const { projectId, path } = this.#durableObjectAddress;
    if (path !== "/" || projectId === GLOBAL_PROJECT_ID) return false;
    if (this.#stream.highestDurableOffset() !== 0) return false;
    const answer = await this.#controlPlane.deletedProject(projectId).then(
      (deleted) => ({ deleted }),
      (error: unknown) => ({ error }),
    );
    if ("deleted" in answer && !answer.deleted) return false;
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.sync();
    if ("error" in answer) throw answer.error;
    this.#unborn = codedError("FORBIDDEN", `project ${projectId} ${PROJECT_DELETED}`);
    return true;
  }
  /** What every entry point answers first on a deleted project's root it refused to bear. */
  #unborn: Error | null = null;
  /** `unborn`, asked again (the async entry points `invoke` and `fetch`, which every session call
   *  and project-host request arrives by): kept as long as it holds, while the project restored
   *  under its id since (a seed's `restoreProjectId`) resets this instance, failing this one
   *  request, so the next bears the root. A question that failed keeps the refusal. */
  async #unbornStill(unborn: Error): Promise<Error> {
    const { projectId } = this.#durableObjectAddress;
    if (!(await this.#controlPlane.deletedProject(projectId).catch(() => true)))
      this.#abort(
        "context.root-restored",
        `project ${projectId} was restored: its root is born on the next request`,
      );
    return unborn;
  }

  /** A RESET THIS CONTEXT ASKS FOR, an expected outcome: `ctx.abort`, whose `message` the runtime
   *  logs as an error line nothing can catch, in this invocation and in every other call in flight
   *  here, which it rejects (https://developers.cloudflare.com/durable-objects/api/state/#abort). So
   *  the outcome is logged first, at info, with that `message`: `event`. The prd fault alarm
   *  (scripts/ci/prd-fault-alarm.ts `ANNOUNCED`) reads an error line with a message this Durable
   *  Object announced as that outcome, and pages none of them. */
  #abort(
    event: "context.destroyed" | "context.aborted" | "context.root-restored",
    message: string,
    options?: { retryAlarm: boolean },
  ): void {
    console.info({ event, message });
    this.ctx.abort(message, options);
  }

  /** THE STREAM (stream/stream.ts): the commit pipeline and the core reduce. Its one callback,
   *  `onCommit`, is the post-commit fan-out — the delivery loop, run as THE KERNEL: under
   *  `{ principal: null }` explicitly, whatever the committing call's caller was. The commit lands
   *  inside that call's `#callerStorage.run`, and the async store would otherwise ride every
   *  continuation the loop schedules. Delivery must not inherit the initiating caller's identity. Then the alarm: a commit may have changed the
   *  schedules or queued a delivery. */
  readonly #stream = new Stream({
    storage: this.ctx.storage,
    deployId: this.#appConfig.deployId,
    incarnationCountedByHost: true,
    path: this.#durableObjectAddress.path,
    projectId: this.#durableObjectAddress.projectId,
    // the deployment's stack of what every PROJECT context is born with; a global one, none
    birthEvents:
      this.#durableObjectAddress.projectId === GLOBAL_PROJECT_ID
        ? []
        : this.#appConfig.contextBirthEvents,
    wakeRecordDetail: () => this.#residency.wakeRecordDetail(),
    cause: () => this.#callerStorage.getStore()?.cause,
    onCommit: (freshEvents, afterOffset, throughOffset) => {
      // An alarm trace answers waitForEvent, never a subscription (AlarmTrace says why).
      const events = freshEvents.filter(
        (event) => event.type !== "events.iterate.com/itx/alarm-trace",
      );
      if (events.length === 0) return;
      this.#callerStorage.run(this.#withPlatformOrigin({ principal: null }), () => {
        this.#subscriptionDelivery.onCommit(events, afterOffset, throughOffset);
        this.#startRequestedRuns(events);
      });
      const woken = events.find((event) => event.type === "events.iterate.com/itx/woken");
      if (woken) this.#announceToAncestors(woken.source?.cause);
      this.#unsetWhatNamesDeadRpcStubs(events);
      this.#alarmCoordinator.reconcile();
    },
  });

  /** Tell every ancestor up to `/` (`ancestorPathsOf`) that this context exists: on each wake until
   *  every ancestor has it (the `ancestors-announced` kv flag), so a failed announcement heals on the
   *  next wake and a landed one is never sent again (a context that wakes often would otherwise wake
   *  its ancestors each time). Keyed per child, so a repeat lands nothing. Fire-and-forget: a parent
   *  may be mid-call into this child, so waiting on its answer here could deadlock. A receipt of the
   *  wake: caused by what woke this context. */
  #announceToAncestors(cause: Cause | undefined): void {
    const { path } = this.#durableObjectAddress;
    const ancestorPaths = ancestorPathsOf(path);
    if (ancestorPaths.length === 0 || this.ctx.storage.kv.get("ancestors-announced")) return;
    const announced = Promise.all(
      ancestorPaths.map((ancestorPath) =>
        this.#reach.contextOf(ancestorPath).append({
          type: "events.iterate.com/itx/child-created",
          idempotencyKey: `itx/child-created:${path}`,
          payload: { childPath: path },
          source: { origin: path, cause },
        }),
      ),
    ).then(
      () => {
        // a context destroyed meanwhile writes nothing back: its storage stays empty
        if (!this.#destroyed) this.ctx.storage.kv.put("ancestors-announced", true);
      },
      (error: unknown) => {
        // a context of a deleted project, born again by a request that reached it (a handle an open
        // session kept): its root is not, so it stays unannounced, for the context sweep
        if (String(error).includes(PROJECT_DELETED))
          return console.log({ event: "context.announce-to-deleted-project", path });
        console.error({
          event: "context.announce-to-ancestors-failed",
          path,
          error: String(error),
        });
      },
    );
    this.ctx.waitUntil(announced);
  }

  #destroyed = false;

  /** WHO THIS CONTEXT IS, for the context sweep, which reaches it by id: its project and path.
   *  Records no wake, so it announces nothing: an orphan asked must not re-create the ancestors its
   *  deleted project lost. */
  identity(): { projectId: string; path: string } {
    const { projectId, path } = this.#durableObjectAddress;
    return { projectId, path };
  }

  /** ONE PAGE OF THIS CONTEXT'S LOG, for the context sweep, which reaches it by id and backs an
   *  orphan up before destroying it: `read`'s page, and like `identity` it records no wake. */
  readForSweep(afterOffset: number): StreamPage {
    return this.#stream.read(afterOffset);
  }

  /** DESTROY THIS CONTEXT (the project deletion saga, project/processor.ts): every byte it holds
   *  goes — its log, its kv, its alarm, and every facet's storage with it (`deleteAll` deletes the
   *  facets' databases too) — and the instance is reset in the SAME hold, so no call ever runs on an
   *  instance whose storage is gone (it would read tables that are not there, or write them back).
   *  The reset rejects this call too, with `CONTEXT_DESTROYED`: the caller reads that rejection as
   *  done. A context with no storage stops existing once it shuts down. Called again on a destroyed
   *  context, it is born empty (and announces itself) and destroyed again; a deleted project's root
   *  is not born (`#refuseBirthOfDeletedProjectRoot`). */
  async destroy(): Promise<void> {
    this.#destroyed = true;
    await this.ctx.blockConcurrencyWhile(async () => {
      await this.ctx.storage.deleteAll();
      // An abort breaks the output gate, and a write not yet confirmed goes with it: without this
      // sync the deletion itself is rolled back (prd, 2026-09-25: every context of a deleted project
      // kept its data, and its root woke on its alarm every 40 s). Local workerd confirms at once,
      // so only a deployed worker shows it. `#abortAfterTheAnswer` syncs for the same reason.
      await this.ctx.storage.sync();
      // an alarm this reset interrupts must not run again: it would wake the destroyed context
      this.#abort("context.destroyed", CONTEXT_DESTROYED, { retryAlarm: false });
    });
  }

  /** Inbound append: an inbound call and a `call` wake, then the commit and the committed-event
   *  effects. */
  async append(...events: StreamEventInput[]): Promise<StreamEvent[]> {
    this.#inboundRequestInOneTurn(
      "append",
      deepestCause(events.map((event) => event.source?.cause)),
    );
    return this.#appendWaitingOutOlderSnapshots(events);
  }

  /** An append whose writer is answered by the fence rule of context/rule-snapshots.ts. */
  async #appendWaitingOutOlderSnapshots(events: StreamEventInput[]): Promise<StreamEvent[]> {
    const before = this.#stream.coreReducedState;
    const committed = this.#appendAndRunCommittedEffects(events);
    await this.#waitOutOlderSnapshots(
      before,
      events.some((event) => SNAPSHOT_ROW_TYPES.has(event.type)),
    );
    return committed;
  }

  /** A write of what a snapshot carries answers its writer once the fence it must wait out has
   *  passed on this clock: the one its commit took (`#takeRevocationFence`), or — for a write that
   *  changes nothing (a repeat, an idempotent replay of a commit a reset interrupted) — the one
   *  still pending. One that only adds a name does not wait. */
  async #waitOutOlderSnapshots(before: CoreState, writesSnapshotRows: boolean): Promise<void> {
    const after = this.#stream.coreReducedState;
    const fence = this.#pendingFence();
    if (!fence) return;
    const waits =
      before.snapshotVersion === after.snapshotVersion
        ? writesSnapshotRows
        : this.#snapshotChangeNeedsCommitWait(before, after, fence.takenAway);
    for (let wait; waits && (wait = fence.until - Date.now()) > 0;)
      await new Promise((resolve) => setTimeout(resolve, wait));
  }

  /** THE REVOCATION FENCE (context/rule-snapshots.ts), taken in the commit's own turn by every
   *  commit alike, a schedule's too: the lease as it finds it, with the names it took away — a new
   *  row judged against what the pending fence took away as well. */
  #takeRevocationFence(before: CoreState): void {
    const after = this.#stream.coreReducedState;
    const pending = this.#pendingFence();
    if (!this.#snapshotChangeNeedsCommitWait(before, after, pending?.takenAway)) return;
    const until = Math.max(pending?.until ?? 0, this.#snapshotLeaseUntil);
    if (until <= Date.now()) return; // nothing served that could still be used
    this.ctx.storage.kv.put<RevocationFence>("rule-revocation-fence", {
      until,
      takenAway: [
        ...(pending?.takenAway || []),
        ...namesTakenAway(before.itxExpressionRewriteRules, after.itxExpressionRewriteRules),
      ],
    });
  }

  /** Does a commit change a snapshot in a way that waits (context/rule-snapshots.ts)? A rule change
   *  that takes a name away, any routing change, and any rule the platform writes. */
  #snapshotChangeNeedsCommitWait(
    before: CoreState,
    after: CoreState,
    takenAway: readonly ItxExpressionPrefix[] | undefined,
  ): boolean {
    return (
      before.fetchRoutes !== after.fetchRoutes ||
      before.ingressTarget !== after.ingressTarget ||
      (!!this.#caller.platform &&
        before.itxExpressionRewriteRules !== after.itxExpressionRewriteRules) ||
      rulesChangeNeedsCommitWait(
        before.itxExpressionRewriteRules,
        after.itxExpressionRewriteRules,
        this.#implicitRoots,
        takenAway,
      )
    );
  }

  /** The fence a commit took that has not passed yet. */
  #pendingFence(): RevocationFence | undefined {
    const fence = this.ctx.storage.kv.get<RevocationFence>("rule-revocation-fence");
    return fence && fence.until > Date.now() ? fence : undefined;
  }

  /** THE LEASE on this context's rule snapshots (context/rule-snapshots.ts), in memory: none at a
   *  birth. */
  #snapshotLeaseUntil = 0;

  /** THE SNAPSHOT another context resolves through (context/rule-snapshots.ts): this table's
   *  version, and its rows unless the reader holds that version. A version is this life's and the
   *  table's offset in it — a context destroyed and born again counts its offsets from 1, and no
   *  reader of its last life holds a version of this one. Each read extends the lease a write that
   *  takes something away waits out. A DO-only Workers-RPC verb, off the itx surface: the rows are
   *  the addressing every context of the project may already resolve through. A READ RECORDS
   *  NOTHING (cause.ts): no wake of a context that slept, no birth of one never born, which answers
   *  its empty table as `unborn`. */
  rulesSnapshot(ifVersion?: string): RulesSnapshotAnswer {
    // A read of this context's rules on another's behalf: counted, and no wake of this context's —
    // the root is read by every context of the project, and a wake is an event delivered to each
    // of its rows.
    if (this.#unborn) throw this.#unborn;
    this.#residency.inboundCallInOneTurn();
    this.#snapshotLeaseUntil = Math.max(this.#snapshotLeaseUntil, Date.now() + SNAPSHOT_TTL_MS);
    const { snapshotVersion, itxExpressionRewriteRules, fetchRoutes, ingressTarget } =
      this.#stream.coreReducedState;
    let life = this.ctx.storage.kv.get<string>("life"); // `destroy`'s `deleteAll` takes it
    if (!life && this.#stream.highestDurableOffset() > 0)
      this.ctx.storage.kv.put("life", (life = crypto.randomUUID()));
    const version = `${life || "unborn"}:${snapshotVersion}`;
    if (ifVersion === version) return { version };
    return {
      version,
      rules: Object.values(itxExpressionRewriteRules),
      routing: { fetchRoutes, ingressTarget },
    };
  }

  /** The bookkeeping of an entry point that runs in ONE synchronous turn (`append`, `read`, a lend,
   *  a socket event): an inbound call begun and ended (context/residency.ts), then the incarnation's
   *  `call` wake record, of the census's kind, naming the entry point `call`, caused by `cause` when
   *  the call names one. */
  #inboundRequestInOneTurn(call: string, cause?: Cause): void {
    if (this.#unborn) throw this.#unborn;
    this.#residency.inboundCallInOneTurn();
    this.#stream.appendWakeRecord({ cause: "call", caller: "other", call }, cause);
  }

  /** SYNCHRONOUS end to end (Stream.append is): the commit, the committed-event effects. Two
   *  callers: `append`, and the pager attach (rpc-stubs.ts), which needs the refusal in the same
   *  turn it accepted the socket. */
  #appendAndRunCommittedEffects(events: StreamEventInput[]): StreamEvent[] {
    const stateBeforeCommit = this.#stream.coreReducedState;
    const { subscriptions: subscriptionsBeforeCommit } = stateBeforeCommit;
    const headBeforeCommit = this.#stream.highestAssignedOffset();
    // THE APPEND BOUNDARY: every event is validated + normalized here (core-processor's
    // `normalizeControlEvent`), so a control command's itx-expression fields are checked and stored
    // in parsed form — call sites append LITERAL `{ type, payload }`, never an event-builder helper.
    const normalized = events.map((event) =>
      normalizeControlEvent(event, this.#durableObjectAddress.path),
    );
    refuseLiftingAJail(
      normalized,
      this.#stream.coreReducedState.itxExpressionRewriteRules,
      this.#caller,
    );
    refuseNonPlatformWrites(normalized, this.#caller);
    const committedEvents = this.#stream.append(...normalized);
    this.#takeRevocationFence(stateBeforeCommit);
    // Effects run on FRESH commits only. An idempotency retry ECHOES the historical event (its offset
    // is <= the pre-append head), and re-running an effect on an echo could revert state a later event
    // already moved on — configure A, replace with B, retry A would restore A's facet startup memo.
    const freshEvents = committedEvents.filter((event) => event.offset > headBeforeCommit);
    this.#facetHost.deleteFacetsWhoseHostingSubscriptionWasRemoved(
      freshEvents,
      subscriptionsBeforeCommit,
    );
    this.#facetHost.refreshFacetStartupMemosFromHostingConfigurations(freshEvents);
    return committedEvents;
  }

  /** One BUDGETED page of the log (Stream.read), the ring's ephemerals merged in on request. */
  async read(
    afterOffset = 0,
    limit = 500,
    options: { includeEphemeral?: boolean } = {},
  ): Promise<StreamPage> {
    this.#inboundRequestInOneTurn("read");
    return this.#stream.read(afterOffset, limit, options); // sync on the Stream, a promise over Workers RPC
  }

  /** THE EFFECTIVE table at `path`, DESCRIBED (itx-expression-rewriting.ts `describeRewriteRules`):
   *  this context's own rows live, and the table behind a bare link, hop by hop, from its snapshot
   *  (context/rule-snapshots.ts) — a list calls no other context. */
  async #rewriteRuleListAt(
    depth: number,
    path = this.#durableObjectAddress.path,
  ): Promise<RewriteRuleListEntry[]> {
    return describeRewriteRules({
      rules: await this.#rulesAt(path),
      implicitRoots: implicitRootsAt(this.#durableObjectAddress.projectId, path),
      path,
      depth,
      inherit: (there, hopsLeft) => this.#rewriteRuleListAt(hopsLeft, there),
    });
  }

  /** The rule table of this project's context at `path`: this context's own live, any other's its
   *  snapshot. */
  async #rulesAt(path: string): Promise<readonly ItxExpressionRewriteRule[]> {
    if (path === this.#durableObjectAddress.path)
      return Object.values(this.#stream.coreReducedState.itxExpressionRewriteRules);
    return (await this.#reach.snapshotOf(path)).rules;
  }

  /** THE LIBRARY's itx (library.ts): a genuine InvokeHandle over `invoke`, so a library call's
   *  `itx.fetch(...)` resolves through THIS context's rules (a test may shadow `itx.fetch`) with
   *  zero hops. The CALLER crosses with it — its principal, its grant, its originating path — so an
   *  event a library verb appends (`itx.run`'s request, a creation) is attributed to whoever called,
   *  and a relative path means the caller's; NOT its `app` bit: the library's own hops (`cd('/')` for
   *  the catalog, the fixed point for a mint) are the platform's act, and what a context may reach OF
   *  the library its table already says (a naked child has no `itx.repos` row to get here through).
   *  The handle's dotted surface IS the library's itx — `itx.append(...)`, `itx.workers.get(...)`
   *  reduce into steps (the prototype fallback, iterate-context.ts) and land in the callback — which
   *  is why it is cast: InvokeHandle's declared type has none of those members. */
  readonly #libraryItx = new InvokeHandle((steps) => {
    // Every call the library makes (a connection opening, a call through it) is a use of the
    // library's pin: the quiet period runs from the call's end.
    this.#residency.pinCallStarted();
    const { app: _loadedCode, ...caller } = this.#caller;
    return this.#invokeInProcess(["itx", ...steps], [], caller).finally(() =>
      this.#residency.pinCallEnded(),
    );
  }) as unknown as LibraryItx;
  /** THE LIBRARY: its verbs closed over `#libraryItx`. An open capnweb socket it holds pins this
   *  actor awake; the pins' timer closes it. */
  readonly #library = buildLibrary(this.#libraryItx, {
    // WHO is asking, and from which context: a create path links a new context to its creator, and
    // a relative `./x` answered here through a hop is the caller's.
    caller: () => this.#caller,
    path: this.#durableObjectAddress.path,
  });

  // ── the runner: `itx/run-requested` → the script in a confined isolate → `run-settled` ──

  /** The script runs THIS incarnation is executing, by the request's offset, so a commit's fan-out
   *  never starts one twice. The durable ground is core state `scriptRuns`; a run a dead
   *  incarnation left open is not here, and the wake record settles it `interrupted` (stream.ts) —
   *  a run is never re-run. */
  readonly #scriptRunsInFlight = new Set<number>();
  /** Runs a PROCESSOR requested (`source.processor`, the engine's stamp), owed to the next alarm
   *  pass, by the request's offset: the code, and when it was requested — the coordinator's
   *  deadline, so re-deriving it writes nothing. In memory: a run a dead incarnation still owed is
   *  open in `scriptRuns`, and the next wake record settles it `interrupted`, as it does a run cut
   *  off mid-flight. */
  readonly #runsOwedToTheAlarm = new Map<
    number,
    { code: string; requestedAt: number; requester: Requester | undefined }
  >();

  /** THE RUNNER, for every `run-requested` committed — whoever appended it: `itx.run` (library.ts:
   *  this request, then a wait for its settlement), a client's literal append, a schedule's
   *  occurrence, the agent's loop. The request's OFFSET is the run's identity: the settlement names
   *  it. A caller's request starts at its commit, as deep as the caller. A PROCESSOR's starts in
   *  the next alarm pass (`#startRunsOwedToTheAlarm`), because an alarm is a fresh invocation.
   *  Cloudflare refuses a call too many hops below the request it descends from ("Subrequest depth
   *  limit exceeded"; not configurable — wrangler's `limits` are `cpu_ms` and `subrequests`, a
   *  count), and a Durable Object's outgoing calls descend from one of its incoming requests
   *  (workerd `IoContext::getCurrentIncomingRequest`). A loop of processor turns reaches this
   *  context through ever deeper requests, so a run started at its commit ran out of hops: on a
   *  preview (2026-09-25) an agent's script had 8 hops left at its first turn and 0 by its twelfth;
   *  started from the alarm, 13 at every turn. */
  #startRequestedRuns(committedEvents: StreamEvent[]): void {
    for (const event of committedEvents) {
      if (event.type !== "events.iterate.com/itx/run-requested") continue;
      const { code } = event.payload as RunRequested; // parsed at the append boundary (normalizeControlEvent)
      const requester = requesterOf(event);
      if (event.source?.processor)
        this.#runsOwedToTheAlarm.set(event.offset, { code, requestedAt: Date.now(), requester });
      else this.#startRun(event.offset, code, requester);
    }
  }

  /** THE ALARM PASS'S FIRST JOB: every run a processor requested, started inside the alarm's own
   *  invocation. Not awaited — the settlement is the run's end, as for any run. Answers how many. */
  #startRunsOwedToTheAlarm(): number {
    const owed = [...this.#runsOwedToTheAlarm];
    this.#runsOwedToTheAlarm.clear();
    return owed.filter(([offset, { code, requester }]) => this.#startRun(offset, code, requester))
      .length;
  }

  /** Runs as the kernel: the loaded script's own `env.ITX` calls are principal-less anyway (loaded
   *  code speaks for the project), and the request event carries who asked. Not awaited — the
   *  settlement is the run's end, on the log, whether or not the requester is still listening.
   *  Answers whether it started: never a run already in flight or one already settled. */
  #startRun(requestOffset: number, code: string, requester: Requester | undefined): boolean {
    if (
      this.#scriptRunsInFlight.has(requestOffset) ||
      !this.#stream.coreReducedState.scriptRuns[requestOffset]
    )
      return false;
    this.#scriptRunsInFlight.add(requestOffset);
    void this.#executeRun(requestOffset, code, requester);
    return true;
  }

  async #executeRun(
    requestOffset: number,
    code: string,
    requester: Requester | undefined,
  ): Promise<void> {
    // WHY IT RUNS: the request's cause; the script one deeper, its settlement a receipt (cause.ts).
    const cause = this.#stream.coreReducedState.scriptRuns[requestOffset]?.cause;
    // The platform's own record (core-processor.ts `STREAM_RECORD_TYPES`), straight onto the
    // stream as the wake record's `interrupted` settlements are: no writer can append one.
    const settle = (settlement: RunSettlement) =>
      this.#stream.append({
        type: "events.iterate.com/itx/run-settled",
        idempotencyKey: `itx/run-settled:${requestOffset}`,
        payload: { requestOffset, settlement },
        source: cause && { cause },
      });
    try {
      // WHO IT RUNS FOR: the requester, signed into the script's cause (on-behalf-of.ts), so what it
      // writes is theirs as attribution while it still calls as loaded code. Never the settlement's.
      const scriptCause =
        cause && requester
          ? {
              ...cause,
              onBehalfOf: await mintOnBehalfOf(
                { ...requester, run: `${this.#durableObjectAddress.path}@${requestOffset}` },
                this.#durableObjectAddress.projectId,
                await sessionSigningSecretOf(this.#appConfig),
                Date.now(),
              ),
            }
          : cause;
      // Settled within RUN_DEADLINE_MS, its value released (library.ts `runSettlementOf`).
      const settlement = await runSettlementOf(
        this.#callerStorage.run(
          this.#withPlatformOrigin({ principal: null, cause: scriptCause }),
          () => this.#scriptExecution(code),
        ),
      );
      try {
        settle(settlement);
      } catch (error) {
        // A result the log refuses (EVENT_TOO_LARGE) fails the run; the refusal is the settlement.
        if (errorCode(error) !== "EVENT_TOO_LARGE") throw error;
        settle({
          status: "failed",
          error: `${error instanceof Error ? error.message : String(error)} — write a large result to itx.files and return its path`,
          failureKind: "runtime",
        });
      }
    } catch (error) {
      // An instance Cloudflare replaced mid-run can no longer write. The instance that replaced it
      // settles the run `interrupted` at its wake (stream.ts `appendWakeRecord`), and a caller's
      // next read of the settlement is a call that wakes it.
      const kind = failureKind(error);
      if (isPlatformFailureKind(kind))
        logPlatformFailure("iterate-context", "run-settle", kind, {
          name: "run-settled",
          message: String(error),
          requestOffset,
        });
      else reportIssue("iterate-context.run-settle", error, { requestOffset });
    } finally {
      this.#scriptRunsInFlight.delete(requestOffset);
    }
  }

  /** A requested script's execution. WHERE it runs is this context's own `itx.run` row: here by
   *  default (the implicit row), elsewhere when a row REDIRECTS it — `itx.run ⇒
   *  itx.builtins.cd('<child>').builtins.run` sends its scripts to a child whose table is the
   *  scripts' alone. A redirect is one more request-and-settle
   *  there. A mask on `run` (a jail's bare null) says what code HERE may spell — never where a
   *  request already on this log executes: it runs here. */
  async #scriptExecution(code: string): Promise<unknown> {
    let redirect: ItxExpression | undefined;
    try {
      const resolvedRun = this.#itxExpressionResolver.resolve(["itx", ["run", code]]).at(-1)!;
      const runsHere =
        resolvedRun.length === 3 &&
        resolvedRun[1] === "builtins" &&
        itxExpressionStepName(resolvedRun[2]) === "run";
      if (!runsHere) redirect = resolvedRun;
    } catch (error) {
      if (errorCode(error) !== "NO_ITX_EXPRESSION_MATCH") throw error;
    }
    // code run because of its request: one hand-off deeper (cause.ts)
    if (!redirect) {
      // one deeper, still for whoever the run is for
      const cause = {
        ...causeOfDelivery([{ source: { cause: this.#caller.cause } }]),
        onBehalfOf: this.#caller.cause?.onBehalfOf,
      };
      return this.#callerStorage.run({ ...this.#caller, cause }, () =>
        executeScript(this.#libraryItx, code),
      );
    }
    // The row's context answers with the request (library.ts `ScriptRunRequested`); its settlement
    // is read from here, in slices of fresh calls, so an instance of that context Cloudflare
    // replaces mid-run costs a slice and settles the run `interrupted`, never a call held on it.
    const answer = await this.#itxExpressionResolver.invoke(redirect);
    const requested = ScriptRunRequested.safeParse(answer);
    if (!requested.success) return answer;
    releaseRpcSessions([answer]); // parsed into a copy of its own
    return settlementOfScriptRun(
      requested.data,
      waitForEventOnContext(this.env.ITERATE_CONTEXT, this.#durableObjectAddress.projectId),
    );
  }

  /** The own-context adapter used by built-ins: a loopback (`itx.cd(<own path>)`, the config
   *  delivery) keeps caller attribution and committed effects and records no wake (it runs inside
   *  an incarnation a request or alarm already woke) — nor is it an inbound call to the residency
   *  clocks; the caller defaults to the one already in AsyncLocalStorage, so a loopback's
   *  appends stay attributed. */
  readonly #localContext: ReachableContext = {
    fetch: (request) => this.#serveFetch(request),
    append: (...events) => this.#appendWaitingOutOlderSnapshots(events),
    read: async (afterOffset, limit, options) => this.#stream.read(afterOffset, limit, options),
    reserveSend: async (key) => this.reserveSend(key),
    releaseSend: async (key) => this.releaseSend(key),
    invoke: (call, args = [], caller = this.#caller) =>
      this.#callerStorage.run(this.#withPlatformOrigin(caller), () =>
        this.#itxExpressionResolver.invoke(call, ...args),
      ),
  };

  /** The control plane as this context reads it: its own project's slug, once (`#projectSlug`). */
  readonly #controlPlane = new ControlPlane(this.env);

  /** This context's project's slug; null for a global context (a user's, an organization's). A
   *  project's slug never changes — catalog.ts inserts a project's row and nothing updates one,
   *  and deleting the project or an erase destroys this storage with the row — so the control plane's
   *  answer is kept in this context's own storage: read once in its life, not once per isolate (a
   *  config worker asks `whoami` on every request). */
  async #projectSlug() {
    const { projectId } = this.#durableObjectAddress;
    if (projectId === GLOBAL_PROJECT_ID) return null;
    const kept = this.ctx.storage.kv.get<string>("project-slug");
    if (kept) return kept;
    const project = await this.#controlPlane.getProject(projectId);
    if (!project) return null;
    this.ctx.storage.kv.put("project-slug", project.slug);
    return project.slug;
  }

  /** `itx.builtins` — the physical scope this context resolves against (context/built-ins.ts). */
  readonly #builtIns = buildBuiltIns({
    ...projectConfigDeps(this.#appConfig, () => this.#projectSlug()),
    primaryHostname: async () =>
      (await this.#controlPlane.getProject(this.#durableObjectAddress.projectId))
        ?.primaryHostname ?? null,
    projectId: this.#durableObjectAddress.projectId,
    path: this.#durableObjectAddress.path,
    otherOwnerContext: (name) => this.env.ITERATE_CONTEXT.getByName(name),
    iterateContextName: this.#durableObjectAddress.name,
    ai: itxAiFor(this.ctx, this.#durableObjectAddress.projectId),
    env: this.env,
    deployId: this.#appConfig.deployId,
    dashOrigin: this.#appConfig.urls.dash,
    platformAdmins: () => this.#appConfig.admins,
    iterateAppScopes: () => iterateAppScopesOf(this.#appConfig),
    platformOrigin: () => this.#platformOrigin,
    // A producer is loaded code's word: walled on its input and on every row it appends.
    invoke: (call) =>
      this.#invokeInProcess(call, [], { principal: null, app: true, cause: this.#caller.cause }),
    namedWorker: (source) => this.#namedWorker(source),
    // a sibling context by path; the own path is this DO itself — a ReachableContext structurally (stream.ts)
    context: (p) =>
      p === this.#durableObjectAddress.path ? this.#localContext : this.#reach.contextOf(p),
    egress: (request) => this.#egress(request),
    // The caller a hop hands a sibling (`cd`, a fan-out): the store's, or nobody — either way with
    // this context's origin filled in, so the sibling composes URLs at the origin the people use even
    // when the store did not survive to the step (a pipelined chain resolved outside the run scope).
    caller: () => this.#withPlatformOrigin(this.#caller),
    invokeAs: (caller, call) => this.#invokeInProcess(call, [], caller),
    // `get(key)` is a GENUINE RpcTarget so `itx.rpcStubs.get('k').hello()` pipelines the mid-chain
    // `.hello()` over every transport (workerd's classifier rejects a Proxy, #6873), branded RpcStubHandle
    // for the delivery loop.
    rpcStubs: {
      // A BORROW IS A USE: the quiet period runs from the call's end (this invoke may have borrowed
      // the stub, and a borrowed stub is exactly what the release exists to return).
      get: (rpcStubKey) =>
        new RpcStubHandle((itxExpressionSteps) => {
          this.#residency.pinCallStarted();
          return this.#rpcStubs
            .invokeRpcStub(rpcStubKey, itxExpressionSteps)
            .finally(() => this.#residency.pinCallEnded());
        }),
      list: () => this.#rpcStubs.listRpcStubKeys(),
    },
    // The facets (context/facet-host.ts): the handle every `itx.facets.get` call walks, the
    // platform's own call past the facets' lists (the `itx.secrets` verbs), and the claim a hosted
    // processor makes on this context's alarm.
    claimFacetAlarm: (name, at) => {
      this.#residency.outsideActivityEnded(); // a claim restarts the sweep's quiet clock
      this.#facetHost.claim(name, at, this.#caller.cause);
      // A RELEASE is the last thing the facet's work did: its instance is unclaimed from here, and
      // the sweep may have run (and disarmed) while the claim held it — so a loaded facet's release
      // arms it. The sweep never resets a first-party facet, so that release arms nothing.
      if (at === null && !firstPartyFacetClassOf(name)) this.#residency.armUnclaimedFacetSweep();
    },
    facets: {
      get: (name, spec) => this.#facetHost.handle(name, spec),
      abort: (name, reason) => this.#facetHost.abort(name, reason),
    },
    callFacetAsPlatform: (name, itxExpressionSteps) =>
      this.#facetHost.callFacetAsPlatform(name, itxExpressionSteps),
    abortAfterTheAnswer: (message) => this.#abortAfterTheAnswer(message),
    schedules: {
      list: () => Object.values(this.#stream.coreReducedState.schedules),
      get: (key) => this.#stream.coreReducedState.schedules[key] ?? null,
    },
    subscriptions: {
      list: () => this.#subscriptionList(),
      get: (name) => this.#subscriptionList().find((s) => s.name === name) ?? null,
    },
    fetchRoutes: () => this.#stream.coreReducedState.fetchRoutes,
    rewriteRules: {
      list: (depth = 3) => this.#rewriteRuleListAt(depth),
      // Canonicalized the same way `provide` canonicalized the match; an unparseable one is no row.
      get: async (match) => {
        let key: string;
        try {
          key = canonicalItxExpressionPrefix(match);
        } catch {
          return null;
        }
        // THIS context's table — its own rows and the implicit rows here — never a hop: `get` asks
        // what this context says about a name, `list()` what it can spell.
        return (await this.#rewriteRuleListAt(0)).find((row) => row.match === key) ?? null;
      },
      // PURE: the chain of rewrites, printed — nothing dispatched, nothing noted as activity.
      resolve: (call) => this.#itxExpressionResolver.resolve(call).map((step) => print(step)),
    },
    // A WAIT_TIMEOUT tells the story of the one alarm: the awaited event is often a scheduled one,
    // and "no event" alone cannot tell a deadline not yet due from one the runtime held.
    waitForEvent: (filter) =>
      this.#stream.waitForEvent(filter).catch((error: unknown) => {
        if (errorCode(error) !== "WAIT_TIMEOUT") throw error;
        throw codedError(
          "WAIT_TIMEOUT",
          `${(error as Error).message} — ${this.#alarmStory(Date.now())}`,
        );
      }),
    itxEntrypoint: () => this.#itxEntrypoint,
    library: this.#library.roots,
  });

  /** THE DISPATCHER (context/itx-expression-rewriting.ts) over `#builtIns` — declared ABOVE, since a
   *  class field initializes in order. Every built-in closes over this context's identity, so
   *  cross-project access is unspellable. */
  readonly #itxExpressionResolver = new ItxExpressionResolver({
    // a refusal met here: the chain's one fact on this log (cause.ts)
    reach: {
      ...this.#reach,
      recordLoopLimit: (_path, cause, message) => this.#stream.recordLoopLimit(cause, message),
    },
    rewriteRules: () => Object.values(this.#stream.coreReducedState.itxExpressionRewriteRules),
    builtIns: this.#builtIns,
    path: this.#durableObjectAddress.path,
    caller: () => this.#caller,
  });

  /** THE RESET `itx.abort` asked for (built-ins.ts — its fact already appended), after the answer
   *  left. `ctx.abort` rejects every request still in the actor with `message`, an answer the output
   *  gate still holds included, and the gate holds an RPC answer until every write made before it
   *  waits there is confirmed — another call's too (a fresh child's `ancestors-announced` flag). So
   *  a critical section from the answer's own turn: no other event runs code here, so nothing
   *  writes before the answer waits at the gate, and `sync()` waits for every write it waits on and
   *  makes the fact durable (an abort discards unconfirmed writes). The reset is one zero-delay turn
   *  after, when the gate has let the answer out. Nor can the timer keep an idle actor resident: the
   *  actor it fires in is the one it resets. Every OTHER call in flight here rejects with
   *  `message`. */
  #abortAfterTheAnswer(message: string) {
    void this.ctx.blockConcurrencyWhile(async () => {
      await this.ctx.storage.sync();
      setTimeout(() => this.#abort("context.aborted", message), 0);
    });
  }

  // ── SUBSCRIPTION DELIVERY: the one loop (subscription-delivery.ts), wired to this DO ──

  readonly #subscriptionDelivery = new SubscriptionDelivery({
    stream: this.#stream,
    // The RESOLVER's `evaluate`, not this class's `invoke`: the loop's evaluation is the kernel's own
    // call — never with delivery authority, whatever the store holds (`runAsDelivery` below).
    evaluateItxExpression: (itxExpression) =>
      this.#callerStorage.run(this.#withPlatformOrigin({ principal: null }), () =>
        this.#itxExpressionResolver.evaluate(itxExpression),
      ),
    // A facet row's push and catch-up: the facet host's platform entries, past the facet's list.
    pushEventBatchToFacet: (facetHandle, events, range) =>
      this.#facetHost.callFacetAsPlatform(facetHandle, [["processEventBatch", events, range]]),
    catchUpFacetFromLog: (facetHandle, cause) =>
      this.#facetHost.callFacetAsPlatform(facetHandle, [["catchUpFromLog"]], cause),
    reconcileAlarm: () => this.#alarmCoordinator.reconcile(),
    // A delivery runs one hand-off deeper than what it delivers (cause.ts), and a fan-out call as
    // the delivery loop's own caller for its one event (caller.ts `Caller.delivery`).
    runAsDelivery: async (events, call, delivery) => {
      const caller: Caller = { principal: null, cause: causeOfDelivery(events) };
      if (delivery) {
        caller.cause = { ...caller.cause!, writeKey: delivery };
        caller.delivery = await sha256Hex(JSON.stringify(events[0]));
      }
      return this.#callerStorage.run(this.#withPlatformOrigin(caller), call);
    },
    abortIncarnation: (reason) => this.#abortAfterTheAnswer(reason),
  });

  // ── THE ONE ALARM (alarm-coordinator.ts): derived from five deadline sources, traced ──

  readonly #alarmCoordinator = new AlarmCoordinator({
    setAlarm: (at) => this.ctx.storage.setAlarm(at),
    deleteAlarm: () => this.ctx.storage.deleteAlarm(),
    deadlines: () => [
      ...this.#durableAlarmDeadlines(),
      ...Object.values(this.#residency.deadlines()),
      // The runs a processor requested: due since the earliest was requested.
      ...[...this.#runsOwedToTheAlarm.values()].map(({ requestedAt }) => requestedAt),
    ],
    // A run owed to the alarm holds the watch too: a held alarm would otherwise hold the run.
    held: () => this.#residency.holdsResident() || this.#runsOwedToTheAlarm.size > 0,
    // The platform fault the watch works around (alarm-coordinator.ts): a re-arm is a warn the prd
    // fault alarm counts, and its telemetry pin (PINNED_WORKAROUNDS) waits out; a give-up is an
    // error — nothing here acts again for it.
    onOverdue: ({ armedAt, overdueMs, action, rearms }) => {
      const detail = {
        name: this.#durableObjectAddress.name,
        armedAt: new Date(armedAt).toISOString(),
        overdueMs,
        rearms,
      };
      if (action === "give-up")
        reportIssue(
          "iterate-context.alarm-overdue",
          new Error(
            `the alarm armed for ${detail.armedAt} is still due ${overdueMs} ms past its time after ${ALARM_MAX_REARMS} re-arms of the overdue watch`,
          ),
          detail,
        );
      else
        console.warn({
          event: "iterate-context.platform-failure-alarm-rearm",
          namespace: "iterate-context",
          message: "the runtime held an armed alarm past its time; re-armed it for now",
          ...detail,
        });
    },
  });

  /** The three sources a fresh incarnation derives again — schedules, cursor-row claims, facet
   *  claims; the unclaimed-facet sweep and the runs owed to the alarm are this incarnation's alone. */
  #durableAlarmDeadlines(): (number | null)[] {
    return [
      this.#stream.nextScheduledAppendAt(),
      this.#subscriptionDelivery.deadlines()[0]?.at ?? null,
      this.#facetHost.deadlines()[0]?.at ?? null,
    ];
  }

  // ── THE FACETS (context/facet-host.ts): the hosted classes' lifecycle and their alarm claims, wired to this DO ──

  readonly #facetHost = new FacetHost({
    ctx: this.ctx,
    env: () => this.env,
    deployId: this.#appConfig.deployId,
    iterateContextName: this.#durableObjectAddress.name,
    projectId: this.#durableObjectAddress.projectId,
    path: this.#durableObjectAddress.path,
    platformOrigin: () => this.#platformOrigin,
    itxEntrypoint: () => this.#itxEntrypoint,
    // A producer is loaded code's word: walled on its input and on every row it appends.
    invoke: (call) =>
      this.#invokeInProcess(call, [], { principal: null, app: true, cause: this.#caller.cause }),
    namedWorker: (source) => this.#namedWorker(source),
    resolveItxExpression: (expression) => this.#itxExpressionResolver.resolve(expression),
    stream: this.#stream,
    reconcileAlarm: () => this.#alarmCoordinator.reconcile(),
    loadedFacetMaterialized: () => this.#residency.armUnclaimedFacetSweep(),
    deliveriesQueuedFor: (name) => this.#subscriptionDelivery.deliveriesQueuedFor(name),
    cause: () => this.#caller.cause,
  });

  // ── RESIDENCY (context/residency.ts): the pins' release, the sweep, the birth reset ──

  // Annotated because TypeScript cannot infer it: its `facetHost` holds `#stream`, whose
  // `wakeRecordDetail` reads this field back (TS7022).
  readonly #residency = new Residency({
    name: this.#durableObjectAddress.name,
    facetHost: this.#facetHost,
    rpcStubs: this.#rpcStubs,
    library: this.#library,
    scriptRunsInFlight: () => this.#scriptRunsInFlight.size + this.#runsOwedToTheAlarm.size,
    reconcileAlarm: () => this.#alarmCoordinator.reconcile(),
    inboundCallsHeldChanged: () => this.#alarmCoordinator.watch(),
  });

  #traceAlarm(
    reason: AlarmTrace["reason"],
    before: number | null,
    extra: Pick<AlarmTrace, "error" | "dueSchedules" | "runs"> = {},
  ) {
    const delivery = this.#subscriptionDelivery.deadlines();
    const facets = this.#facetHost.snapshot();
    const trace: AlarmTrace = {
      at: Date.now(),
      reason,
      ...extra,
      alarm: { before, after: this.#alarmCoordinator.snapshot().armedAt },
      deadlines: {
        schedule: this.#stream.nextScheduledAppendAt(),
        delivery: delivery.slice(0, 32),
        deliveryOmitted: Math.max(0, delivery.length - 32),
        claims: this.#facetHost.deadlines(),
        ...this.#residency.deadlines(),
      },
      durableHead: this.#stream.highestDurableOffset(),
      facetWorkInFlight: facets.facetWorkInFlight,
      liveFacets: facets.liveFacetNames.slice(0, 32),
      borrowedRpcStubs: this.#rpcStubs.hasBorrowedRpcStubs(),
      libraryHoldsSocket: this.#library.holdsOpenSocket(),
    };
    // Straight onto the stream, not through `append` (a trace is not activity); a trace
    // must never fail an alarm pass.
    try {
      this.#stream.append({
        type: "events.iterate.com/itx/alarm-trace",
        ephemeral: true,
        payload: trace,
      });
    } catch (error) {
      reportIssue("iterate-context.alarm-trace", error, { reason });
    }
  }

  /** The one alarm in a line, for a WAIT_TIMEOUT: what is armed and how overdue, the overdue watch's
   *  re-arms, this incarnation's last pass, and each durable source's earliest deadline. */
  #alarmStory(now: number): string {
    const { armedAt, passInProgress, lastPassStartedAt } = this.#alarmCoordinator.snapshot();
    const when = (at: number | null | undefined) =>
      at === null || at === undefined
        ? "none"
        : `${new Date(at).toISOString()} (${at <= now ? `${now - at} ms ago` : `in ${at - now} ms`})`;
    return [
      `alarm armed for ${when(armedAt)}`,
      `${passInProgress ? "a pass running since" : "this incarnation's last pass"} ${when(lastPassStartedAt)}`,
      `next schedule ${when(this.#stream.nextScheduledAppendAt())}`,
      `delivery claim ${when(this.#subscriptionDelivery.deadlines()[0]?.at)}`,
      `facet claim ${when(this.#facetHost.deadlines()[0]?.at)}`,
    ].join("; ");
  }

  /** The `itx.subscriptions` view: the reduced table joined with the delivery loop's cursors. */
  #subscriptionList(): SubscriptionListEntry[] {
    return Object.entries(this.#stream.coreReducedState.subscriptions).map(([name, s]) => {
      const cursor = this.#subscriptionDelivery.cursor(name);
      return {
        name,
        target: print(s.target),
        // oxlint-disable-next-line iterate/simple-truthiness-check -- the `itx.subscriptions` wire view: an absent optional field must stay ABSENT, not `field: undefined` (capnweb / Workers RPC serialize an undefined-valued key as present, and readers test presence)
        ...(s.consumes && { consumes: s.consumes }),
        configuredAtOffset: s.configuredAtOffset,
        // oxlint-disable-next-line iterate/simple-truthiness-check -- the `itx.subscriptions` wire view: an absent optional field must stay ABSENT, not `field: undefined` (capnweb / Workers RPC serialize an undefined-valued key as present, and readers test presence)
        ...(s.afterOffset !== undefined && { afterOffset: s.afterOffset }),
        ...(s.ordered === false && { ordered: false as const }),
        ...this.#subscriptionDelivery.fanOutView(name),
        // an absent facet stays ABSENT on the wire, like the fields around it
        ...(s.hostedFacet && {
          hostedFacet: { ...s.hostedFacet, restarts: this.#facetHost.restarts(s.hostedFacet.name) },
        }),
        ...(cursor && {
          cursor: {
            confirmedOffset: cursor.confirmedOffset,
            attempt: cursor.attempt,
            // oxlint-disable-next-line iterate/simple-truthiness-check -- the `itx.subscriptions` wire view: an absent optional field must stay ABSENT, not `field: undefined` (capnweb / Workers RPC serialize an undefined-valued key as present, and readers test presence)
            ...(cursor.nextAttemptAtMs !== undefined && {
              nextAttemptAtMs: cursor.nextAttemptAtMs,
            }),
          },
        }),
        // oxlint-disable-next-line iterate/simple-truthiness-check -- the `itx.subscriptions` wire view: an absent optional field must stay ABSENT, not `field: undefined` (capnweb / Workers RPC serialize an undefined-valued key as present, and readers test presence)
        ...(s.halted && { halted: s.halted }),
      };
    });
  }

  /** THE ALARM PASS, four jobs in order, under the coordinator's hold (nothing re-arms until it
   *  completes; a pass that dies is retried by the runtime): the runs processors requested
   *  (`#startRunsOwedToTheAlarm`), the due schedules, the stream-kept cursors' owed deliveries, the
   *  due claims of hosted processors (each spent, then the facet's `revive()` — a facet still busy
   *  claims again from there). Then the next deadline is derived from what is left. The
   *  unclaimed-facet sweep is decided first in every pass; a wake with nothing owed is the sweep's
   *  alone and does nothing else. */
  async alarm(): Promise<void> {
    const { armedAt: fired } = this.#alarmCoordinator.snapshot();
    // THE SWEEP'S OWN WAKE: no wake record, no trace, no delivery — in a fresh
    // incarnation (its armer was evicted, the normal end) nothing at all but re-deriving the alarm;
    // its birth already reset the unclaimed loaded facets.
    const wokeAt = Date.now();
    // A run a dead incarnation left open, one it owed this very alarm included, is settled
    // `interrupted` by this incarnation's wake record, so a wake that finds one takes the full pass,
    // whose wake record that is. Once the wake is recorded, every open run is this incarnation's.
    const wakeRecordSettlesARun =
      !this.#stream.wakeRecorded() &&
      Object.keys(this.#stream.coreReducedState.scriptRuns).length > 0;
    const [schedule, delivery, facetClaim] = this.#durableAlarmDeadlines().map(
      (at) => at !== null && at <= wokeAt,
    );
    if (
      this.#runsOwedToTheAlarm.size === 0 &&
      !wakeRecordSettlesARun &&
      !(schedule || delivery || facetClaim)
    ) {
      await this.#alarmCoordinator.pass(async () => this.#residency.alarmPassStarted(wokeAt));
      return;
    }
    try {
      await this.#alarmCoordinator.pass(async () => {
        await this.#residency.alarmPassStarted(wokeAt);
        // An incarnation the alarm woke records its wake HERE, inside the hold — the one entry point
        // that knows the reason, and what it came back for. Its delivery (every "*" row's) runs and
        // acks within this pass, so an alarm wake that finds nothing else owed ends with no alarm and
        // no alarm write at all. Its cause is the deepest of what is due as it fires (cause.ts).
        const { schedules, scriptRuns } = this.#stream.coreReducedState;
        this.#stream.appendWakeRecord(
          {
            cause: "alarm",
            due: [
              ...(schedule ? ["schedule" as const] : []),
              ...(delivery ? ["retry" as const] : []),
              ...(facetClaim ? ["claim" as const] : []),
              ...(this.#runsOwedToTheAlarm.size > 0 || wakeRecordSettlesARun
                ? ["run" as const]
                : []),
            ],
          },
          deepestCause([
            ...Object.values(schedules)
              .filter((row) => !row.failure && Date.parse(row.nextAt) <= wokeAt)
              .map((row) => row.source?.cause),
            this.#subscriptionDelivery.owedCause(wokeAt),
            this.#facetHost.owedCause(wokeAt),
            ...Object.values(scriptRuns).map((run) => run.cause),
          ]),
        );
        const runs = this.#startRunsOwedToTheAlarm();
        // Append each occurrence locally before awaiting subscriber RPC. A completion in the SAME
        // transaction removes the obligation, so eviction or duplicate alarm delivery cannot repeat it.
        const now = Date.now();
        const due = Object.values(this.#stream.coreReducedState.schedules)
          .filter((row) => !row.failure && Date.parse(row.nextAt) <= now)
          .sort(
            (a, b) =>
              Date.parse(a.nextAt) - Date.parse(b.nextAt) ||
              a.scheduledAtOffset - b.scheduledAtOffset,
          )
          .slice(0, 32);
        this.#traceAlarm("alarm-fired", fired, { dueSchedules: due.length, runs });
        for (const row of due) {
          if (this.#stream.coreReducedState.paused) break;
          if (
            this.#stream.coreReducedState.schedules[row.key]?.scheduledAtOffset !==
            row.scheduledAtOffset
          )
            continue;
          const payload = {
            key: row.key,
            scheduledAtOffset: row.scheduledAtOffset,
            at: row.nextAt,
          };
          // A firing is caused by what set its schedule, at that depth, every time (cause.ts).
          const cause = row.source?.cause;
          try {
            this.#appendAndRunCommittedEffects([
              ...row.events.map((event) => ({
                ...event,
                source: {
                  cause,
                  // Where the definition came from: a schedule set here from another context
                  // fires as that context's words, never as this one's.
                  ...(row.source?.origin && { origin: row.source.origin }),
                  schedule: {
                    ...payload,
                    ...((row.source?.processor || row.source?.principal) && {
                      definedBy: {
                        ...(row.source?.processor && { processor: row.source.processor }),
                        ...(row.source?.principal && { principal: row.source.principal }),
                      },
                    }),
                  },
                },
              })),
              { type: "events.iterate.com/itx/schedule-fired", payload, source: { cause } },
            ]);
            console.log({
              event: "scheduled-append.completed",
              namespace: "iterate-context",
              ...payload,
              count: row.events.length,
              latenessMs: now - Date.parse(row.nextAt),
            });
          } catch (error) {
            // If the commit succeeded but a subsequent effect threw, preserve the completion and let
            // the platform retry recovery. Otherwise park this definition visibly, without a loop.
            if (
              this.#stream.coreReducedState.schedules[row.key]?.nextAt !== row.nextAt ||
              this.#stream.coreReducedState.schedules[row.key]?.scheduledAtOffset !==
                row.scheduledAtOffset
            ) {
              reportIssue("scheduled-append.effect-failed", error, payload);
              throw error;
            }
            this.#appendAndRunCommittedEffects([
              {
                type: "events.iterate.com/itx/schedule-failed",
                payload: { ...payload, error: String(error).slice(0, 2000) },
                source: { cause },
              },
            ]);
            reportIssue("scheduled-append.failed", error, payload);
          }
        }
        // The stream-kept cursors' due retries, and anything an eviction left mid-delivery — AWAITED so
        // the deadline it leaves is the one derived below.
        await this.#subscriptionDelivery.deliverEveryCursorSubscription();
        // THE DUE CLAIMS of hosted processors (context/facet-host.ts) — AWAITED, so the claim a
        // revive may make is the one derived below.
        await this.#facetHost.reviveDueClaims();
      });
    } catch (error) {
      this.#traceAlarm("alarm-abandoned", fired, { error: String(error).slice(0, 256) });
      throw error;
    }
    this.#traceAlarm("alarm-pass", fired);
    this.#residency.outsideActivityEnded(); // a pass that did durable work restarts the sweep's quiet clock
  }

  /** DO-only, for the tests that run inside workerd (`test/vitest/os-workers/support.ts` `owedAlarm`): the
   *  deadline on the one alarm that is this incarnation's alone and owes nothing — the
   *  unclaimed-facet sweep's. */
  inMemoryAlarmDeadlines(): (number | null)[] {
    return Object.values(this.#residency.deadlines());
  }

  /** DO-only, for the tests that run inside workerd (`test/vitest/os-workers`): the release, plus every
   *  live facet aborted — workerd's harness keeps a facet-pinned actor resident (workerd#6800), so
   *  a test that must evict a facet-hosting context runs this first (`releasePins` in
   *  test/vitest/os-workers/support.ts). Never a facet mid-call (a
   *  reduce aborted midway is the stall its gap repair would have to heal). Aborted facets
   *  re-materialize from their startup memo on their next call. */
  releasePins(): void {
    this.#facetHost.abortLiveFacetsWhenIdle("released for the test's eviction");
    this.#residency.releasePinsNow();
  }

  // ── dispatch: ONE method, the rewrite rules ──

  /** THE ONE DISPATCH: resolve + run one call through the current rewrite rules. The ARRAY form
   *  carries call args a dotted STRING never could (callbacks, Dates, bytes:
   *  `["itx","tools",["transform",21,cb]]`); `args`, when given, are LIVE args applied to the value
   *  the expression denotes (`invoke("itx.kv.get", "k")` ≡ `itx.kv.get("k")`; an `x-itx-expression`
   *  fetch's Request rides the same way). `caller` is WHO is calling (and, later, what they may
   *  reach) — carried for the whole call so every append it makes stamps `source.principal`, and
   *  threaded across each sibling `cd` hop. A DO-only Workers-RPC verb (never capnweb-exposed), so a
   *  client cannot forge the caller. `args`/`caller` default, so a bare `invoke(call)` is an
   *  anonymous probe. What READS the caller: `append` (the stamp — `source.platform` too, which an
   *  account's and an organization's facts need to be folded). */
  async invoke(
    call: ItxExpressionInput,
    args: unknown[] = [],
    caller: Caller = { principal: null },
  ): Promise<unknown> {
    if (this.#unborn) throw await this.#unbornStill(this.#unborn);
    const kind = caller.app ? "loaded" : caller.path ? "context" : "other";
    // A call that names no cause — a person's, an outside request's — begins a chain (cause.ts).
    if (!caller.cause) caller = { ...caller, cause: newChain("a call") };
    // the call's name only for the incarnation's first call: every later one skips the formatting
    if (!this.#stream.wakeRecorded())
      this.#stream.appendWakeRecord(
        { cause: "call", caller: kind, call: verbPathOf(call) },
        caller.cause,
      );
    this.#residency.inboundCallStarted(kind);
    const result = await this.#invokeInProcess(call, args, caller).finally(() =>
      this.#residency.inboundCallEnded(caller.app === true),
    );
    // THE CALLER'S SESSION ENDS WITH THE CALL, WHATEVER IT KEEPS (context/dispatch.ts
    // `itxAnswerDetachedFromSession`): every Workers-RPC caller of this actor — the edge (capnweb
    // /api, a loaded worker's or a facet's `env.ITX`), /mcp, a sibling's `cd` — arrives through this
    // method, so this actor enforces it here, whatever the caller disposes: a live answer leaves as
    // the expression that names it, data a hop below answered with leaves as a copy.
    return itxAnswerDetachedFromSession(result, normalizedItxExpression(call), args);
  }

  /** A DELIVERY'S SEND, AT MOST ONCE (integrations/email.ts): the event this log already recorded
   *  under `key` — what the send came to — or whether this attempt reserved it now; neither when an
   *  earlier attempt reserved it and recorded nothing. A DO-only verb. */
  reserveSend(key: string): { recorded?: StreamEvent; reserved: boolean } {
    const row = this.#stream.storage.readEventByIdempotencyKey(key);
    if (row)
      return {
        recorded: {
          ...(JSON.parse(row.body) as object),
          offset: row.offset,
          path: this.#durableObjectAddress.path,
        } as StreamEvent,
        reserved: false,
      };
    if (this.ctx.storage.kv.get(`send:${key}`)) return { reserved: false };
    this.ctx.storage.kv.put(`send:${key}`, true);
    return { reserved: true };
  }
  /** A reservation's release: its send was refused, so nothing went out (`reserveSend`). */
  releaseSend(key: string): void {
    this.ctx.storage.kv.delete(`send:${key}`);
  }

  /** THE ONE REFUSAL HANDLER's reach from where this context's loaded code runs statelessly
   *  (iterate-context.ts `ItxEntrypoint`, cause.ts `recordRefusal`): the chain's one fact here. A
   *  DO-only Workers-RPC verb; a context never born records nothing. */
  recordLoopLimit(cause: unknown, message: string): void {
    const refused = parseCause(cause);
    if (!refused || this.#stream.highestDurableOffset() === 0) return;
    this.#inboundRequestInOneTurn("recordLoopLimit");
    this.#stream.recordLoopLimit(refused, String(message));
  }

  /** The same call for THIS isolate's own callers — the library's itx, a facet's or a loaded worker's
   *  deps — who hold a handle in process, where it pins nothing and its liveness is the point. */
  /** THE WORKER A NAME PUBLISHES, from this context: what a facet's source or a `workers.get`
   *  source with no cacheKey loads. A name is resolved as the platform: it only reads the project's
   *  rules. Its producer runs as the loaded code of the context whose rule named it, as
   *  `workers.get` reached through another context's rule loads (built-ins.ts `workersRoot`) —
   *  resolved here, so a portable root it reads is walked in this isolate and the cold load relays
   *  nothing through that context. The contexts its route crosses count toward the call's hops
   *  (cause.ts). */
  async #namedWorker(source: ItxExpressionInput): Promise<NamedWorker> {
    const { at, spec, vouched } = await this.#callerStorage.run(
      this.#withPlatformOrigin({ principal: null, cause: this.#caller.cause }),
      () => this.#itxExpressionResolver.namedWorker(source),
    );
    const { cause } = this.#caller;
    return {
      spec,
      vouched,
      invoke: (call) =>
        at === this.#durableObjectAddress.path
          ? this.#invokeInProcess(call, [], { principal: null, app: true, cause })
          : this.#reach.loadedCodeAt(at, cause)(call),
    };
  }

  #invokeInProcess(call: ItxExpressionInput, args: unknown[], caller: Caller): Promise<unknown> {
    return this.#callerStorage.run(this.#withPlatformOrigin(caller), () =>
      this.#itxExpressionResolver.invoke(call, ...args),
    );
  }
  readonly #callerStorage = new AsyncLocalStorage<Caller>();
  /** WHO is calling right now: the caller of the call this DO is running, or nobody (an alarm, a
   *  commit's fan-out, a loaded worker). */
  get #caller(): Caller {
    return this.#callerStorage.getStore() ?? { principal: null };
  }
  /** THE CALLER THIS CALL RUNS UNDER: what arrived, its origin kept when it names one, else the
   *  persisted origin filled in — so the caller in ALS ALWAYS carries the effective origin and a hop to
   *  a sibling context (`deps.caller()`, a `cd`, a fan-out) hands it on; a sibling never reached from
   *  the edge still composes URLs at the origin the people use. */
  #withPlatformOrigin(caller: Caller): Caller {
    if (caller.platformOrigin) {
      if (caller.platformOrigin !== this.#platformOrigin) {
        this.#platformOrigin = caller.platformOrigin;
        this.ctx.storage.kv.put("platform-origin", caller.platformOrigin);
      }
      return caller;
    }
    return this.#platformOrigin ? { ...caller, platformOrigin: this.#platformOrigin } : caller;
  }

  // ── native fetch: the rpc-stub pager, an `x-itx-expression` fetch, egress ──

  /** Ends when the Response is handed back — a body still streaming after that is not counted. */
  async fetch(request: Request): Promise<Response> {
    // a project host's answer for a project it does not serve, as the edge's admission gives it
    if (this.#unborn) {
      const { message } = await this.#unbornStill(this.#unborn);
      return new Response(`421: ${message}\n`, { status: 421 });
    }
    const fromLoadedCode = request.headers.get(ITX_APP_HEADER) !== null;
    const kind = fromLoadedCode ? "loaded" : "other";
    this.#stream.appendWakeRecord(
      { cause: "call", caller: kind, call: "fetch" },
      parseCause(request.headers.get(ITERATE_CAUSE_HEADER)),
    );
    this.#residency.inboundCallStarted(kind);
    return this.#serveFetch(request).finally(() =>
      this.#residency.inboundCallEnded(fromLoadedCode),
    );
  }

  /** Every fetch this context serves — an inbound one (`fetch`, which recorded the wake) or its own
   *  loopback (`#localContext`, inside an incarnation already woken). */
  async #serveFetch(request: Request): Promise<Response> {
    // A BORROWED SECRET'S USE (secret/durable-object.ts `fetch`): the lend, signed by the
    // borrower's facet; anything else carrying the header is refused, never served as egress.
    const lendUse = request.headers.get(LEND_USE_HEADER);
    if (lendUse) {
      const lend = await verifyLendUse(
        lendUse,
        await sessionSigningSecretOf(this.#appConfig),
        this.#durableObjectAddress.name,
      );
      if (!lend)
        return new Response("itx.fetch: a lend use this lender cannot verify\n", { status: 502 });
      const headers = new Headers(request.headers);
      headers.delete(LEND_USE_HEADER);
      return this.#lentFetch(new Request(request, { headers }), lend);
    }
    // The handlers, in order — each answers or declines: the rpc-stub pager and the rpc-stub fetch
    // upgrade leg; AN ITX-EXPRESSION FETCH (`x-itx-expression` names an itx expression — JSON from a session's
    // terminal `fetch(request)` or a located hop, "" for the project's ingress target, or dotted text
    // or JSON from a loaded worker's own `env.ITX.fetch` — resolved as a terminal-fetch call with the live Request
    // as its one runtime arg (`itxExpressionEndingInFetch`); the routing header is stripped so it never reaches the capability or
    // egress); everything else is EGRESS.
    // LOADED CODE's fetch (`ItxEntrypoint.fetch` set the header): neither the rpc-stub pager
    // WebSocket nor the rpc-stub fetch upgrade — both append rows past every table — and the
    // expression runs as app code.
    const app = request.headers.get(ITX_APP_HEADER) !== null;
    if (!app) {
      // A lend's row rides its pager: the attach is answered like a rule write (a re-dial's rule is
      // a repeat, and a lent callback's row waits a pending fence out with it — at most once).
      const before = this.#stream.coreReducedState;
      const pager = this.#rpcStubs.acceptRpcStubPagerWebSocket(request);
      if (pager) {
        await this.#waitOutOlderSnapshots(before, true);
        return pager;
      }
      const upgradeLeg = this.#rpcStubFetch.acceptFetchUpgradeLeg(request);
      if (upgradeLeg) return upgradeLeg;
    }
    const itxExpressionHeader = request.headers.get(ITX_EXPRESSION_FETCH_HEADER);
    // oxlint-disable-next-line iterate/simple-truthiness-check -- an untrusted HTTP header: present (even empty) selects an itx-expression fetch, absent (null) routes to egress — that distinction must not collapse
    if (itxExpressionHeader !== null) {
      try {
        // The header is UNTRUSTED (rpc-stubs.ts `parseFetchExpression`); the edge serves a
        // project's hosts itself (worker.ts `serveProjectHost`).
        const itxExpression = parseFetchExpression(itxExpressionHeader);
        const headers = new Headers(request.headers);
        headers.delete(ITX_EXPRESSION_FETCH_HEADER);
        headers.delete(ITX_APP_HEADER);
        // THE ROUTING SLUG (`x-iterate-routing-slug`) is the EDGE's alone: it rides only the Request
        // the edge hands the project's config worker (worker.ts `serveProjectHost`), which never
        // comes here, so it is deleted from every expression fetch — loaded code can never forge
        // one.
        headers.delete(ITERATE_ROUTING_SLUG_HEADER);
        // The edge's stamp (ingress after the cookie check, a session's terminal fetch): the call runs
        // under that principal, and the header stays on the Request the app receives. Trusted here —
        // the edge sets it and ItxEntrypoint strips a loaded worker's, so it is the edge's JSON or absent.
        // Asserted, not parsed: the header is the platform's own JSON of a Principal — the edge
        // writes it after admission and every other source of it is stripped (above), so its shape
        // is the edge's, and a parse here would only re-check the platform against itself.
        const principal = JSON.parse(
          headers.get(ITX_PRINCIPAL_HEADER) ?? "null",
        ) as Principal | null;
        const grant = headers.get(ITX_GRANT_HEADER) || undefined;
        // The platform origin the caller reached the platform on (app-config.ts `platformAddressesOf`): the edge's
        // stamp, stripped before the app sees the Request (an app composes URLs through `itx.url`).
        const platformOrigin = headers.get(ITX_PLATFORM_ORIGIN_HEADER);
        headers.delete(ITX_PLATFORM_ORIGIN_HEADER);
        const callerPath = headers.get(ITX_CALLER_PATH_HEADER) || undefined;
        headers.delete(ITX_CALLER_PATH_HEADER);
        // WHY: the cause the forwarding hop carried, or a request's own new chain (cause.ts).
        const cause = parseCause(headers.get(ITERATE_CAUSE_HEADER)) ?? newChain("a request");
        headers.delete(ITERATE_CAUSE_HEADER);
        const forwarded = new Request(request, {
          headers,
          body: this.#expressionFetchBody(request),
        });
        const caller = this.#withPlatformOrigin({
          principal,
          grant,
          path: callerPath,
          platformOrigin,
          cause,
          ...(app && { app: true as const }),
        });
        const result = await this.#callerStorage.run(caller, () =>
          this.#itxExpressionResolver.invoke(itxExpressionEndingInFetch(itxExpression), forwarded),
        );
        return result instanceof Response
          ? result
          : new Response(`expression fetch: ${JSON.stringify(result)}\n`);
      } catch (error) {
        return expressionFetchErrorAnswer(error, itxExpressionHeader);
      }
    }
    // Bare egress is the PLATFORM's (a first-party facet's raw `fetch(url)`); loaded code's fetch
    // always names an expression (`ItxEntrypoint.fetch`), so an app Request without one is refused.
    if (app) return new Response("loaded code's fetch names no expression\n", { status: 404 });
    return this.#egress(request);
  }

  /** AN ITX-EXPRESSION FETCH'S BODY: the visitor's body, streamed to the app through a pipe this DO owns. A
   *  Durable Object that responds while a body is still unread gets its request stream shut after
   *  the response is sent, and a read left pending then surfaces as an uncaught
   *  `TypeError: Can't read from request stream after response has been sent.` — the client got its
   *  response; the runtime logs an error anyway (workerd bug, open:
   *  https://github.com/cloudflare/workerd/issues/918; https://github.com/cloudflare/workerd/issues/1730;
   *  Cloudflare's own advice is to drain the body: https://github.com/cloudflare/workers-sdk/issues/5095).
   *  An app may ignore its body (a scanner POSTing to a static site, prd 2026-09-23), so the pending
   *  read is this pipe's, and its end is recorded here instead of thrown uncaught. Streamed, never
   *  buffered: an app that proxies uploads or echoes the body still streams. A GET or HEAD gets
   *  none, even one that arrived with a body (`content-length: 0` is enough): `new Request` refuses
   *  a body on either method. */
  #expressionFetchBody(request: Request): ReadableStream | null {
    if (!request.body || request.method === "GET" || request.method === "HEAD") return null;
    const { readable, writable } = new IdentityTransformStream();
    request.body.pipeTo(writable).catch((error: unknown) => {
      console.info({
        event: "expression-fetch.request-body-unread",
        namespace: "iterate-context",
        name: this.#durableObjectAddress.name,
        message: error instanceof Error ? error.message : String(error),
      });
    });
    return readable;
  }

  /** IN-MEMORY TRANSPORT FACTS for the hibernation/release probes — a DO-only Workers-RPC verb,
   *  deliberately OFF the itx surface: socket facts, not event-derivable state. */
  rpcStubTransportState(): ReturnType<RpcStubDirectory["rpcStubTransportState"]> {
    return this.#rpcStubs.rpcStubTransportState();
  }

  /** THE CENSUS: this incarnation's inbound calls by kind (context/residency.ts), and which
   *  incarnation counted them — a DO-only Workers-RPC verb, off the itx surface. A reader compares
   *  two reads of the same incarnation: a fresh one counts from zero. */
  inboundCallCensus(): { incarnation: number; calls: ReturnType<Residency["inboundCalls"]> } {
    return { incarnation: this.#stream.storage.incarnation, calls: this.#residency.inboundCalls() };
  }

  /** EGRESS (context/egress.ts), from this context: a secret that is this context's own is its
   *  `secret` facet's to dial — hosted on demand, row or no row: a secret never set refuses inside
   *  the facet ("no stored project secret"), a 502 — and another context's is that context's
   *  `fetch`, which lands in ITS egress, here. */
  #egress(request: Request): Promise<Response> {
    const { projectId, path } = this.#durableObjectAddress;
    // why it is sent: the caller's, or the mark a context forwarding it here stamped (a secret's)
    const cause = this.#caller.cause ?? parseCause(request.headers.get(ITERATE_CAUSE_HEADER));
    return egress(request, {
      projectId,
      path,
      cause,
      secretFetch: (secretPath, outbound) =>
        secretPath === path
          ? // A facet call answers `unknown`; the secret facet's `fetch` answers its Response.
            (this.#facetHost.callFacetAsPlatform("secret", [
              ["fetch", outbound],
            ]) as Promise<Response>)
          : this.#reach.contextOf(secretPath).fetch(outbound),
    });
  }

  /** A BORROWED SECRET'S USE, from the borrower's `secret` facet (secret/durable-object.ts `fetch`)
   *  over this DO's `fetch` — a fetch channel, so an upgrade's 101 crosses it — with the lend signed
   *  in `LEND_USE_HEADER` (secrets.ts), which only platform code holding the deployment's key can
   *  mint and every egress strips: this context is the lender's secret, whose facet admits the lend
   *  — live, lent to `borrower`, the lender still in that project — and dispatches the request
   *  itself. A lend refused because its lender left the project ends here
   *  (`secret/lend-revoked { reason: "membership-ended" }` on both sides); every refusal is a 502. */
  async #lentFetch(
    request: Request,
    lend: { lendId: string; borrower: string },
  ): Promise<Response> {
    // The facet's own answers (secret/durable-object.ts `admitLend`).
    const verdict = (await this.#facetHost.callFacetAsPlatform("secret", [["admitLend", lend]])) as
      | { as: string }
      | { refused: string; revoke?: "membership-ended" };
    if ("refused" in verdict) {
      if (verdict.revoke) {
        const { projectId, path } = this.#durableObjectAddress;
        await this.invoke(
          [
            "itx",
            "builtins",
            "secrets",
            [
              "revokeLend",
              pathUnderOwner(resourceScope(projectId, path), path),
              lend.lendId,
              { reason: verdict.revoke },
            ],
          ],
          [],
          { principal: null, platform: true },
        );
      }
      return new Response(`itx.fetch: ${verdict.refused}\n`, { status: 502 });
    }
    // The facet's fetch channel, the path it is lent as beside the request: only this DO sets it
    // (every egress strips `x-itx-lend*` before a request reaches the facet).
    const headers = new Headers(request.headers);
    headers.set(LENT_AS_HEADER, JSON.stringify({ as: verdict.as, borrower: lend.borrower }));
    return this.#facetHost.callFacetAsPlatform("secret", [
      ["fetch", new Request(request, { headers })],
    ]) as Promise<Response>;
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    this.#inboundRequestInOneTurn("webSocketMessage");
    // Fetch-upgrade frames only (eyeball ⇄ upgrade leg); a pager socket's inbound payloads carry
    // nothing this DO acts on.
    this.#rpcStubFetch.handleWebSocketMessage(ws, message);
  }
  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    this.#inboundRequestInOneTurn("webSocketClose");
    if (this.#rpcStubFetch.handleWebSocketClose(ws, code, reason)) return;
    this.#rpcStubs.rpcStubPagerClosed(ws);
  }
  webSocketError(ws: WebSocket): void {
    this.webSocketClose(ws, 1006, "transport error");
  }

  // ── the rpc-stub Workers-RPC verb — transport plumbing, OFF the itx surface (rpc-stubs.ts) ──

  /** Lend a stub under an opaque key — anyone with a route to this DO may. `stub` is a Workers-RPC
   *  stub, a callable Proxy on the wire: structural validation is impossible by design, so it rides
   *  permissively and the directory types it. (The pager has no verb: it is the
   *  `x-itx-rpc-stub-pager` upgrade at `fetch`.) */
  lendRpcStub(input: { rpcStubKey: string; stub: unknown }): void {
    this.#inboundRequestInOneTurn("lendRpcStub");
    this.#rpcStubs.lendRpcStub({
      rpcStubKey: input.rpcStubKey,
      stub: input.stub as BorrowedRpcStub, // unvalidatable by design (the docstring above)
    });
  }
}

/** Who asked for a run: the person and grant it is written for (on-behalf-of.ts). */
type Requester = Omit<OnBehalfOf, "run">;

/** Who asked for the run `event` requests. A person's request carries their stamped principal and
 *  grant. A request a running script makes carries `source.onBehalfOf` instead: the script's own
 *  `itx.cd(path).run(code)`, or a redirect of its run (`#scriptExecution`). The append stamped it
 *  after verifying the script's token, so the new run is for the same person, with a token of its
 *  own. None for a run no person asked for: an agent's loop, a schedule. */
function requesterOf(event: StreamEvent): Requester | undefined {
  const { principal, grant, onBehalfOf } = event.source;
  if (principal) return { principal, grant };
  if (onBehalfOf) return { principal: onBehalfOf.principal, grant: onBehalfOf.grant };
  return undefined;
}
