// iterate-context-durable-object.ts — `IterateContextDurableObject`: THE CONTEXT, one DO per
// `{projectId, path}` (codec-named `{projectId}.iterate{path}`), the parent of everything a context
// holds: the stream with its core reduce (stream/stream.ts), subscription delivery
// (stream/subscription-delivery.ts), the facets (`ctx.facets`, context/worker-loader.ts), the rpc
// stubs (context/rpc-stubs.ts), and the fetch door (the pager upgrade, the fetch lane,
// egress). Each module's header says what it does; this file is the wiring and the doors.
//   egress — `#egress`: a `getSecret("/secrets/NAME")` request is forwarded to the context at that path, whose `secret` facet substitutes and dispatches (secret/durable-object.ts)
//
// PURE WORKERS-RPC: capnweb never terminates here — the stateless `/api` worker relays. Dispatch is
// ONE door, `invoke(call)`; every OTHER change to this context is an appended event (the edge's
// `provide`/`subscribe` and the `processors` root build one and call `append`; a lent stub's rule or
// row rides its pager upgrade and is appended as the pager is accepted) — there are no
// configuration verbs here. The events this class appends on its own initiative: the birth and wake
// records (Stream.appendBirthRecord / appendWakeRecord — the wake record also settles, `interrupted`,
// every run the last incarnation left open), a due schedule's batch (`alarm`), a requested run's
// settlement (`#executeRun` — the runner section) and the un-set of whatever named an rpc stub whose
// last pager closed (onPresence); alarm diagnostics are ephemeral traces. The two effects it runs off a committed
// event: deleting the facet a removed subscription hosted, and refreshing the startup memo of the
// facet a hosting subscription configures.

import { AsyncLocalStorage } from "node:async_hooks";
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { codedError, errorCode, reportIssue, withTimeout } from "iterate/next/lib";
import {
  REVIVE_AFTER_MAX_MS,
  REVIVE_AFTER_MS,
  type StreamEvent,
  type StreamEventInput,
} from "iterate/next/stream/processor";
import {
  normalizedItxExpression,
  canonicalItxExpressionPrefix,
  itxExpressionStepName,
  parse,
  print,
  type ItxExpression,
  type ItxExpressionInput,
  walkSteps,
  FacetHandle,
  InvokeHandle,
  RpcStubHandle,
} from "iterate/next/expression";
import {
  ITX_PRINCIPAL_HEADER,
  ITX_GRANT_HEADER,
  stampCaller,
  type Caller,
  type Principal,
} from "iterate/next/principal";
import { projectUrlOf } from "iterate/next/project-ingress";
import {
  assertFacetSourceWithinCeiling,
  facetLoaderOwner,
  facetSpecOf,
  prepareConfinedWorker,
  type FacetSpec,
} from "./context/worker-loader.ts";
import {
  CoreContract,
  facetSpecFromHostingTarget,
  type CoreState,
  normalizeControlEvent,
  RunRequested,
  type RunSettlement,
} from "./stream/core-processor.ts";
import { firstPartyFacetClassOf } from "./first-party-facets.ts";
import {
  ITX_EXPRESSION_FETCH_HEADER,
  itxExpressionEndingInFetch,
  RpcStubFetchServer,
  RpcStubDirectory,
  RPC_STUB_PAGER_KEEPALIVE_REQUEST,
  RPC_STUB_PAGER_KEEPALIVE_RESPONSE,
  type BorrowedRpcStub,
} from "./context/rpc-stubs.ts";
import { buildLibrary, executeScript, type LibraryItx } from "./library.ts";
import {
  STREAM_ALARM_TRACE_EVENT,
  Stream,
  type ReachableContext,
  type StreamPage,
} from "./stream/stream.ts";
import { AlarmCoordinator } from "./alarm-coordinator.ts";
import {
  DurableObjectNameCodec,
  itxEntrypointFor,
  resolveContextPath,
  resourceScope,
  ITX_PLATFORM_ORIGIN_HEADER,
} from "./iterate-context.ts";
import { secretPathsReferenced } from "./secrets.ts";
import { appConfigOf, sessionSigningSecretOf, type AppConfigEnv } from "./app-config.ts";
import {
  ItxExpressionResolver,
  restoreRuleTarget,
  rowsNamingRpcStub,
  rpcStubKeysNamed,
  type ItxExpressionRewriteRule,
  BUILT_IN_ROOTS,
} from "./context/itx-expression-rewriting.ts";
import { signedFileUrl } from "./context/file-urls.ts";
import { directory, ensureDirectorySchema } from "./directory.ts";
import {
  buildBuiltIns,
  type RewriteRuleListEntry,
  type SubscriptionListEntry,
} from "./context/built-ins.ts";
import type { ArtifactsNamespace } from "./context/repos.ts";
import { SubscriptionDelivery, type DeliveryDeadline } from "./stream/subscription-delivery.ts";

function parseIterateContextDurableObjectName(name: string | undefined) {
  if (!name)
    throw new Error(
      "IterateContextDurableObject must be addressed by name (reach it via getByName).",
    );
  return DurableObjectNameCodec.parse(name);
}

/** How long a context's PINS stay unused — no borrowed rpc stub called, no open socket used —
 *  before a timer returns the stubs and closes the sockets so the actor can hibernate. A pin lives
 *  and dies in memory, so its release needs no durable alarm: the timer dies with the actor, and so
 *  do the pins. */
const PIN_RELEASE_AFTER_IDLE_MS = 30_000;
/** WORKAROUND for a platform defect — https://github.com/iterate/alarm-loader-facet-repro (the
 *  reproduction, what was measured, what was ruled out). On prd (never in local workerd) a call into
 *  a LOADED facet started inside an alarm-woken incarnation can reject at facet start, in windows
 *  that hit every such facet on a machine for a second to a few minutes: V8's clone-version text
 *  when the loaded worker's env carries a stub (every facet here does), a bare "internal error;
 *  reference = …" when it does not. The facet container is then unusable for the incarnation (a
 *  live facet never re-runs its startup) and the loader's cached entry is too (a fresh loader id
 *  heals at once) — so the recovery is a restart of both and ONE more attempt (`#invokeFacet`),
 *  counted per facet (`facet:<name>:restarts`, shown on `processors.list()`). apps/os carries the
 *  same recovery for its dynamic workers (issue #2288). Remove when the platform is fixed. */
const isFacetStartPlatformFailure = (error: unknown): error is Error =>
  error instanceof Error &&
  (error.message.includes("Unable to deserialize cloned data") ||
    error.message.startsWith("internal error; reference = "));
/** How long one facet call may take before the facet is aborted (a call that never answers would
 *  hold the pins' release, and with it this actor, forever). */
const FACET_CALL_WATCHDOG_MS = 60_000;
/** ONE ALARM PASS, as the DO saw it — the payload of the ephemeral `stream/trace/alarm` event,
 *  appended as the pass starts (`alarm-fired`, with what was armed and every deadline it found)
 *  and as it ends (`alarm-pass` with what it armed next, or `alarm-abandoned` with what it threw).
 *  Only a pass traces: a reconcile outside one — a commit, a claim, a delivery settling —
 *  consumes no offset, so an incarnation that never
 *  wakes by alarm leaves offsets exactly as its own events placed them. An ordinary ephemeral:
 *  `waitForEvent` sees it live, `readEvents(…, { includeEphemeral: true })` reads it back from the
 *  stream's recent-ephemerals ring. NEVER an input: the DO's commit
 *  hook hands no trace to subscription delivery, and appending one moves no clock — either would
 *  trace the tracing. Gone with the incarnation, as every ephemeral is (its `stream/woken` names
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
  };
  durableHead: number;
  /** On `alarm-fired`: how many schedules this pass will append. */
  dueSchedules?: number;
  facetWorkInFlight: number;
  /** Names, at most 32. */
  liveFacets: string[];
  borrowedRpcStubs: boolean;
  /** The library holds an open capnweb socket (an MCP/OpenAPI client holds nothing). */
  libraryHoldsSocket: boolean;
};

/** The bindings THE DO reads (wrangler.jsonc): the DO namespace, the Worker Loader, the kv namespaces,
 *  Workers AI, Browser Run, Artifacts — and, from `AppConfigEnv`, the version-metadata binding and the `APP_CONFIG_*`
 *  vars worker.ts's `parseAppConfig` parses. control-plane.ts's `Env` extends this with the
 *  in-process control plane's own (D1, OAuth KV, …): the one worker's env. */
export interface Env extends AppConfigEnv {
  ITERATE_CONTEXT: DurableObjectNamespace<IterateContextDurableObject>;
  LOADER: WorkerLoader;
  ITX_KV: KVNamespace;
  /** Workers AI — the built-in root `itx.ai`, the binding verbatim (context/built-ins.ts). */
  AI: Ai;
  /** Browser Run — the built-in root `itx.browser` (context/built-ins.ts). */
  BROWSER: BrowserRun;
  /** The one R2 bucket — the built-in root `itx.r2`, every owner under its own prefix (context/built-ins.ts). */
  FILES: R2Bucket;
  /** The directory (directory.ts) — read for a project's slug, the host a signed file URL hangs under. */
  DB: D1Database;
  /** Cloudflare Artifacts (beta) — the ONE bound namespace behind `itx.cfArtifacts`, project-scoped. */
  ARTIFACTS: ArtifactsNamespace;
}

/** The app label an app sees — apps/os's header. Written at the fetch lane alone (`fetch` below),
 *  from the expression: the label of `itx.apps.<label>…`, deleted for any other expression — so
 *  neither a visitor on a project host nor loaded code on `env.ITX.fetch` can pick an app the
 *  expression did not. */
const ITERATE_APP_HEADER = "x-iterate-app";

/** WHO is calling, as this DO runs a call: the SDK's `Caller` (the principal) plus THE PLATFORM
 *  ORIGIN the caller reached the platform on (iterate-context.ts; the fetch lane's header) — what a
 *  public URL is composed from (`itx.url`, a signed file URL), because a DO isolate knows no origin
 *  of its own. Null/absent for a caller with none (a loaded worker, the delivery loop, an alarm). */

export class IterateContextDurableObject extends DurableObject<Env> {
  /** WHO THIS DO IS: the DO name parsed ONCE into `{ name, projectId, path }`. A context is only
   *  ever reached `getByName`; an id-addressed instance fails right here, before it can touch anything. */
  readonly #durableObjectAddress = parseIterateContextDurableObjectName(this.ctx.id.name);
  /** The `env.ITX` / `globalOutbound` stub every worker this context loads receives (iterate-context.ts `ItxEntrypoint`).
   *  Minted once: it names the context, not an incarnation, and a warm loader never re-reads it. */
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
  /** context/rpc-stubs.ts — wired to the fetch door and the two WebSocket handlers below. */
  readonly #rpcStubFetch = new RpcStubFetchServer(this.ctx);
  readonly #rpcStubs = new RpcStubDirectory({
    rpcStubFetch: this.#rpcStubFetch,
    ctx: this.ctx,
    // The SET half of "the DO owns both ends of a lent stub's rule": the events a pager attach
    // carries land through the same door as any append, in the turn the pager is accepted (the
    // un-set half is `#unsetWhatNamesRpcStub`). They are a client's events: `source.principal` is
    // dropped — the DO owns that field, and a lent stub's rule is unattributed.
    appendEvents: (events) =>
      void this.#appendAndRunCommittedEffects(
        events.map((event) => stampCaller(event, { principal: null })),
      ),
    // PRESENCE is physical (`itx.rpcStubs.list()`); its changes are EPHEMERAL facts, never durable
    // rows — the log must never claim a socket is open. A refusal (a paused stream) is nothing to
    // report: a watcher re-seeds from list().
    onPresence: (kind, rpcStubKey) => {
      void this.append({
        type: `events.iterate.com/rpc-stub/${kind}`,
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
    const { ruleUnsets, subscriptionNames } = rowsNamingRpcStub({
      rpcStubKey,
      ...this.#rowsForRpcStubCensus(),
    });
    // Compare-and-set: each removal carries `ifTarget` (the target the census saw), so a `provide` that
    // re-claims the same match during this detach window is not clobbered — the reduce skips a stale undo.
    for (const { match, ifTarget } of ruleUnsets)
      void this.append({
        type: "events.iterate.com/itx/rewrite-rule-configured",
        payload: { match, target: restoreRuleTarget(match), ifTarget },
      }).catch(() => undefined);
    for (const name of subscriptionNames)
      void this.append({
        type: "events.iterate.com/stream/subscription-configured",
        payload: { name, target: null },
      }).catch(() => undefined);
  }

  /** The two tables as the pure census functions read them: every rule, every subscription's target. */
  #rowsForRpcStubCensus(): {
    rules: ItxExpressionRewriteRule[];
    subscriptionTargets: Record<string, ItxExpression>;
  } {
    const { itxExpressionRewriteRules, subscriptions } = this.#stream.coreReducedState;
    return {
      rules: Object.values(itxExpressionRewriteRules),
      subscriptionTargets: Object.fromEntries(
        Object.entries(subscriptions).map(([name, row]) => [name, row.target]),
      ),
    };
  }

  /** A stub whose LAST pager closed DURING a pause had its un-set refused — the un-set is an ordinary
   *  append and `stream/paused` refuses ordinary appends — so on the `resumed` commit every key a row
   *  still names that has NO transport right now (neither borrowed nor pager-backed) is un-set then.
   *  Scheduled off the commit's own turn: the un-sets are appends of their own. */
  #unsetWhatNamesDeadRpcStubsOnResume(committedEvents: StreamEvent[]): void {
    if (!committedEvents.some((event) => event.type === "events.iterate.com/stream/resumed"))
      return;
    const present = new Set(this.#rpcStubs.listRpcStubKeys());
    for (const rpcStubKey of rpcStubKeysNamed(this.#rowsForRpcStubCensus()))
      if (!present.has(rpcStubKey)) queueMicrotask(() => this.#unsetWhatNamesRpcStub(rpcStubKey));
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The edge relay's 30s keepalive is answered at the RUNTIME level: the pager sockets stay warm
    // (past the ~100s idle-close) WITHOUT waking this DO. DO-wide and persisted, so it also covers
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
    // delivered (workerd hides a firing alarm for the whole run), so the wake record is NOT written
    // here: the first door to open names the wake (`appendWakeRecord` — `alarm()` says "alarm").
    this.ctx.blockConcurrencyWhile(async () => {
      this.#alarmCoordinator.restore(await this.ctx.storage.getAlarm());
      // A deployment that names its origin (`urls.os`: prd, the previews — anything with more than one
      // hostname) knows it outright; one that does not (a self-host on workers.dev) learns it from the
      // first stamped caller and keeps it here across evictions.
      this.#platformOrigin =
        this.#appConfig.urls.os ||
        ((this.ctx.storage.kv.get("platform-origin") as string | undefined) ?? null);
      // A claim row's value is the epoch-ms `at` this DO wrote in `#claimFacetAlarm` (kv types it
      // as unknown): read back as the number it was stored as.
      for (const [key, at] of this.ctx.storage.kv.list({ prefix: "facet-claim:" }))
        this.#facetClaims.set(key.slice("facet-claim:".length), at as number);
      // Same for the revive-failure ladder (`#facetReviveFailed` wrote it as a number).
      for (const [key, n] of this.ctx.storage.kv.list({ prefix: "facet-claim-failures:" }))
        this.#facetReviveFailures.set(key.slice("facet-claim-failures:".length), n as number);
      this.#stream.appendBirthRecord();
      // Retire only the subscription installed by older runtime versions. This durable
      // removal runs once per existing context; explicit user subscriptions are preserved.
      const config = this.#stream.coreReducedState.subscriptions.config;
      const retiredTarget = ["itx", ["cd", "/"], "worker", "processEventBatch"];
      if (config && JSON.stringify(config.target) === JSON.stringify(retiredTarget)) {
        this.#stream.append(
          normalizeControlEvent({
            type: "events.iterate.com/stream/subscription-configured",
            payload: { name: "config", target: null },
            idempotencyKey: "migration:explicit-ingress:remove-default-subscription",
          }),
        );
      }
    });
  }

  /** THE STREAM (stream/stream.ts): the commit pipeline and the core reduce. Its one callback,
   *  `onCommit`, is the post-commit fan-out — the delivery loop, run as THE KERNEL: under
   *  `{ principal: null }` explicitly, whatever the committing call's caller was. The commit lands
   *  inside that call's `#callerStorage.run`, and the async store would otherwise ride every
   *  continuation the loop schedules. Delivery must not inherit the initiating caller's identity. Then the alarm: a commit may have changed the
   *  schedules or queued a delivery. */
  readonly #stream = new Stream({
    storage: this.ctx.storage,
    path: this.#durableObjectAddress.path,
    projectId: this.#durableObjectAddress.projectId,
    onCommit: (freshEvents, afterOffset, throughOffset) => {
      // An alarm trace answers waitForEvent, never a subscription (AlarmTrace says why).
      const events = freshEvents.filter((event) => event.type !== STREAM_ALARM_TRACE_EVENT);
      if (events.length === 0) return;
      this.#callerStorage.run(this.#withPlatformOrigin({ principal: null }), () => {
        this.#subscriptionDelivery.onCommit(events, afterOffset, throughOffset);
        this.#startRequestedRuns(events);
      });
      this.#alarmCoordinator.reconcile();
    },
  });

  /** The append door — a thin wrapper over Stream.append. */
  async append(...events: StreamEventInput[]): Promise<StreamEvent[]> {
    this.#stream.appendWakeRecord("request");
    return this.#appendAndRunCommittedEffects(events);
  }

  /** SYNCHRONOUS end to end (Stream.append is): the commit, the committed-event effects. Two
   *  callers: `append`, and the pager attach (rpc-stubs.ts), which needs the refusal in the same
   *  turn it accepted the socket. */
  #appendAndRunCommittedEffects(events: StreamEventInput[]): StreamEvent[] {
    const subscriptionsBeforeCommit = this.#stream.coreReducedState.subscriptions;
    const headBeforeCommit = this.#stream.highestAssignedOffset();
    // THE APPEND BOUNDARY: every event is validated + normalized here (core-processor's
    // `normalizeControlEvent`), so a control command's itx-expression fields are checked and stored
    // in parsed form — call sites append LITERAL `{ type, payload }`, never an event-builder helper.
    const committedEvents = this.#stream.append(...events.map(normalizeControlEvent));
    // Effects run on FRESH commits only. An idempotency retry ECHOES the historical event (its offset
    // is <= the pre-append head), and re-running an effect on an echo could revert state a later event
    // already moved on — configure A, replace with B, retry A would restore A's facet startup memo.
    const freshEvents = committedEvents.filter((event) => event.offset > headBeforeCommit);
    this.#deleteFacetsWhoseHostingSubscriptionWasRemoved(freshEvents, subscriptionsBeforeCommit);
    this.#refreshFacetStartupMemosFromHostingConfigurations(freshEvents);
    this.#unsetWhatNamesDeadRpcStubsOnResume(freshEvents);
    return committedEvents;
  }

  /** THE ONE EFFECT of a hosting configuration: the facet's startup memo is refreshed from the
   *  event that configured it, source and all (the reduced row has none — M1). The memo is the ONLY
   *  place a materialization reads the source from, so a re-enable with NEW source under the same
   *  name and class is a new loader identity on the facet's next call (#invokeFacet restarts it in
   *  place, storage preserved) — without this the old memo kept running the old code. A target that
   *  cannot resolve right now is left to the next call's recovery. */
  #refreshFacetStartupMemosFromHostingConfigurations(committedEvents: StreamEvent[]): void {
    for (const event of committedEvents) {
      if (event.type !== "events.iterate.com/stream/subscription-configured") continue;
      const { name, target } = event.payload as {
        name: string;
        target: ItxExpressionInput | null;
      };
      if (!target || !this.#stream.coreReducedState.subscriptions[name]?.hostedFacet) continue;
      try {
        const spec = facetSpecFromHostingTarget(
          this.#itxExpressionResolver.resolve(normalizedItxExpression(target)).at(-1)!,
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
  #deleteFacetsWhoseHostingSubscriptionWasRemoved(
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
      const stillHosted = Object.values(this.#stream.coreReducedState.subscriptions).some(
        (row) => row.hostedFacet?.name === facetName,
      );
      if (!stillHosted) this.#deleteFacet(facetName);
    }
  }

  /** One BUDGETED page of the log (Stream.read), the ring's ephemerals merged in on request. */
  async read(
    afterOffset = 0,
    limit = 500,
    options: { includeEphemeral?: boolean } = {},
  ): Promise<StreamPage> {
    this.#stream.appendWakeRecord("request");
    return this.#stream.read(afterOffset, limit, options); // sync on the Stream, a promise over Workers RPC
  }

  /** THE EFFECTIVE rule table, read: the context's own rows (masks as `target: null`, a template's
   *  `@` spelled) plus the implicit platform rows the context has not re-set — one per built-in root
   *  — none at all under a bare
   *  `itx` row, which claims every call before a platform row could. */
  #rewriteRuleList(): RewriteRuleListEntry[] {
    const contextRows = Object.values(this.#stream.coreReducedState.itxExpressionRewriteRules).map(
      (rule): RewriteRuleListEntry => ({
        match: print(rule.match),
        target: rule.target && print(rule.target, { holes: true }),
        origin: "context",
      }),
    );
    const reset = new Set(contextRows.map((row) => row.match));
    if (reset.has("itx")) return contextRows;
    const platformRows: RewriteRuleListEntry[] = [
      ...BUILT_IN_ROOTS.map(
        (root): RewriteRuleListEntry => ({
          match: `itx.${root}`,
          target: `itx.builtins.${root}`,
          origin: "platform",
        }),
      ),
    ].filter((row) => !reset.has(row.match));
    return [...contextRows, ...platformRows];
  }

  /** THE LIBRARY's itx (library.ts): a genuine InvokeHandle over `invoke`, so a library call's
   *  `itx.fetch(...)` resolves through THIS context's rules (a test may shadow `itx.fetch`) with
   *  zero hops. The CALLER crosses with it: a library verb runs inside the caller's own dispatch,
   *  so an event it appends — `itx.run`'s request, `chat.sendMessage` — is attributed to whoever
   *  called (the ambient store; the kernel's null outside any call). */
  readonly #libraryItx = new InvokeHandle((steps) => {
    // Every call the library makes (a connection opening, a call through it) is a use of the
    // library's pin: the quiet period runs from the call's end.
    this.#pinCallStarted();
    return this.invoke(
      ["itx", ...steps],
      [],
      this.#callerStorage.getStore() ?? { principal: null },
    ).finally(() => this.#pinCallEnded());
    // The handle's dotted surface IS the library's itx: `itx.append(...)`, `itx.workers.get(...)`
    // reduce into steps (the prototype fallback, iterate-context.ts) and land in the callback above.
  }) as unknown as LibraryItx;
  /** THE LIBRARY: its verbs closed over `#libraryItx`. An open capnweb socket it holds pins this
   *  actor awake; the pins' timer closes it. */
  readonly #library = buildLibrary(this.#libraryItx);

  // ── the runner: `context/run-requested` → the script in a confined isolate → `run-settled` ──

  /** The script runs THIS incarnation is executing, by the request's offset, so a commit's fan-out
   *  never starts one twice. The durable ground is core state `scriptRuns`; a run a dead
   *  incarnation left open is not here, and the wake record settles it `interrupted` (stream.ts) —
   *  a run is never re-run. */
  readonly #scriptRunsInFlight = new Set<number>();

  /** THE RUNNER, started at the commit of every `run-requested` — whoever appended it:
   *  `itx.run` (library.ts: this request, then a wait for its settlement), a client's literal
   *  append, the agent's loop, a schedule's occurrence. The request's OFFSET is the run's identity:
   *  the settlement names it. Runs as the kernel: the loaded script's own `env.ITX` calls are
   *  principal-less anyway (loaded code speaks for the project), and the request event carries who
   *  asked. Not awaited — the settlement is the run's end, on the log, whether or not the requester
   *  is still listening. */
  #startRequestedRuns(committedEvents: StreamEvent[]): void {
    for (const event of committedEvents) {
      if (event.type !== "events.iterate.com/context/run-requested") continue;
      const { code } = RunRequested.parse(event.payload); // normalized at the append boundary
      if (
        this.#scriptRunsInFlight.has(event.offset) ||
        !this.#stream.coreReducedState.scriptRuns[event.offset]
      )
        continue;
      this.#scriptRunsInFlight.add(event.offset);
      void this.#executeRun(event.offset, code);
    }
  }

  async #executeRun(requestOffset: number, code: string): Promise<void> {
    const settle = (settlement: RunSettlement) =>
      this.#appendAndRunCommittedEffects([
        {
          type: "events.iterate.com/context/run-settled",
          idempotencyKey: `context/run-settled:${requestOffset}`,
          payload: { requestOffset, settlement },
        },
      ]);
    try {
      let settlement: RunSettlement;
      try {
        // THE JSON BOUNDARY: the value crossed Workers RPC; a round trip keeps what the log carries
        // (undefined and functions drop; a bigint or a cycle throws — a runtime failure like any other).
        const json = JSON.stringify(await executeScript(this.#libraryItx, code));
        // `json` is absent only for a value JSON has no text for (undefined, a function): the log
        // then carries no result. (An empty STRING result serializes to `""`, two chars — truthy.)
        const result: unknown = json ? JSON.parse(json) : undefined;
        settlement = { status: "succeeded", result };
      } catch (error) {
        settlement = {
          status: "failed",
          error: String(error instanceof Error ? error.message : error).slice(0, 8_000),
          failureKind: "runtime",
        };
      }
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
      reportIssue("iterate-context.run-settle", error, { requestOffset });
    } finally {
      this.#scriptRunsInFlight.delete(requestOffset);
    }
  }

  /** The own-context adapter used by built-ins: a loopback (`itx.cd(<own path>)`, the config
   *  delivery) keeps caller attribution and committed effects and records no wake (it runs inside
   *  an incarnation a request or alarm already woke); the caller defaults to the one already in
   *  AsyncLocalStorage, so a loopback's appends stay attributed. */
  readonly #localContext: ReachableContext = {
    append: async (...events) => this.#appendAndRunCommittedEffects(events),
    read: async (afterOffset, limit, options) => this.#stream.read(afterOffset, limit, options),
    invoke: (call, args = [], caller = this.#callerStorage.getStore() ?? { principal: null }) =>
      this.#callerStorage.run(this.#withPlatformOrigin(caller), () =>
        this.#itxExpressionResolver.invoke(call, ...args),
      ),
  };

  /** `itx.builtins` — the physical scope this context resolves against (context/built-ins.ts). */
  readonly #builtIns: Record<string, unknown> = buildBuiltIns({
    projectInfo: async () => {
      if (this.#durableObjectAddress.projectId === "global") return {};
      await ensureDirectorySchema(this.env.DB);
      const row = await this.env.DB.prepare("SELECT * FROM projects WHERE id = ?")
        .bind(this.#durableObjectAddress.projectId)
        .first();
      if (!row) return {};
      const project = z.object({ id: z.string(), slug: z.string().optional() }).parse(row);
      const projectSlug = project.slug || project.id;
      // the apex URL, when the caller carries the platform origin to compose it with
      const platformOrigin = this.#platformOriginNow();
      const url = platformOrigin
        ? projectUrlOf(this.#appConfig.urls.ingressRouting, platformOrigin, {
            project: projectSlug,
          })
        : null;
      return { projectSlug, ...(url && { projectUrl: url.href }) };
    },
    projectId: this.#durableObjectAddress.projectId,
    path: this.#durableObjectAddress.path,
    iterateContextName: this.#durableObjectAddress.name,
    env: this.env,
    deployId: this.#appConfig.deployId,
    ingressRouting: this.#appConfig.urls.ingressRouting,
    platformOrigin: () => this.#platformOriginNow(),
    signFileUrl: async (input) => {
      const platformOrigin = this.#platformOriginNow();
      if (!platformOrigin)
        throw new Error(
          "files: a signed URL is composed from the platform origin the caller reached the platform on — this call carries none (call it from a session)",
        );
      // the URL carries the project's slug (the edge admits a project by it); the claim carries
      // the id — a global context (a user's, an organization's) has no URL
      await ensureDirectorySchema(this.env.DB);
      const project = await directory(this.env.DB).getProject(input.project);
      if (!project)
        throw new Error("files: only a project's context can sign a file URL — it has the host");
      return signedFileUrl({
        ...input,
        host: project.slug,
        secret: await sessionSigningSecretOf(this.#appConfig),
        routing: this.#appConfig.urls.ingressRouting,
        platformOrigin,
      });
    },
    invoke: (call) => this.invoke(call),
    // a sibling context by path; the own path is this DO itself — a ReachableContext structurally (stream.ts)
    context: (p) =>
      p === this.#durableObjectAddress.path
        ? this.#localContext
        : this.env.ITERATE_CONTEXT.getByName(
            DurableObjectNameCodec.stringify({
              projectId: this.#durableObjectAddress.projectId,
              path: p,
            }),
          ),
    egress: (request) => this.#egress(request),
    // The caller a hop hands a sibling (`cd`, a fan-out): the store's, or nobody — either way with
    // this context's origin filled in, so the sibling composes URLs at the origin the people use even
    // when the store did not survive to the step (a pipelined chain resolved outside the run scope).
    caller: () => this.#withPlatformOrigin(this.#callerStorage.getStore() ?? { principal: null }),
    // `get(key)` is a GENUINE RpcTarget so `itx.rpcStubs.get('k').hello()` pipelines the mid-chain
    // `.hello()` on every lane (workerd's classifier rejects a Proxy, #6873), branded RpcStubHandle
    // for the delivery loop.
    rpcStubs: {
      // A BORROW IS A USE: the quiet period runs from the call's end (this invoke may have borrowed
      // the stub, and a borrowed stub is exactly what the release exists to return).
      get: (rpcStubKey) =>
        new RpcStubHandle((itxExpressionSteps) => {
          this.#pinCallStarted();
          return this.#rpcStubs
            .invokeRpcStub(rpcStubKey, itxExpressionSteps)
            .finally(() => this.#pinCallEnded());
        }),
      list: () => this.#rpcStubs.listRpcStubKeys(),
    },
    // The facets view is PARENT-LOCAL — the facets live here and can never move (workerd#6702:
    // sockets never leave the parent). Branded FacetHandle for the delivery loop.
    claimFacetAlarm: (name, at) => {
      this.#facetRevived(name); // the facet's engine is reachable: its ladder of failed revives is over
      this.#claimFacetAlarm(name, at);
    },
    facets: {
      get: (name, spec) =>
        new FacetHandle((itxExpressionSteps) => {
          // A FACET REACHED BY ITX EXPRESSION ANSWERS RPC AND PLAIN HTTP — NEVER A WEBSOCKET. A
          // socket terminates at the edge (a session's /api pager socket on this DO, a project host's
          // lent-stub upgrade leg), and the facet behind it is reached by itx expression; a socket a
          // facet HELD would die with it, unseen by the parent (1006, measured 2026-09-13). Refused
          // BEFORE the memo: an upgrade aimed at a facet materializes nothing. The one facet that
          // PROXIES a socket — the `secret` facet, dialling a pinned host for egress and handing the
          // 101 straight back — is reached by `#egress`, never by expression.
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
          return this.#invokeFacet(name, spec, itxExpressionSteps);
        }),
    },
    schedules: {
      list: () => Object.values(this.#stream.coreReducedState.schedules),
      get: (key) => this.#stream.coreReducedState.schedules[key] ?? null,
    },
    subscriptions: {
      list: () => this.#subscriptionList(),
      get: (name) => this.#subscriptionList().find((s) => s.name === name) ?? null,
    },
    rewriteRules: {
      list: () => this.#rewriteRuleList(),
      // Canonicalized the same way `provide` canonicalized the match; an unparseable one is no row.
      get: (match) => {
        let key: string;
        try {
          key = canonicalItxExpressionPrefix(match);
        } catch {
          return null;
        }
        return this.#rewriteRuleList().find((row) => row.match === key) ?? null;
      },
      // PURE: the chain of rewrites, printed — nothing dispatched, nothing noted as activity.
      resolve: (call) => this.#itxExpressionResolver.resolve(call).map((step) => print(step)),
    },
    waitForEvent: (filter) => this.#stream.waitForEvent(filter),
    itxEntrypoint: () => this.#itxEntrypoint,
    library: this.#library.roots,
  });

  /** THE DISPATCHER (context/itx-expression-rewriting.ts) over `#builtIns` — declared ABOVE, since a
   *  class field initializes in order. Every built-in closes over this context's identity, so
   *  cross-project access is unspellable. */
  readonly #itxExpressionResolver = new ItxExpressionResolver({
    rewriteRules: () => Object.values(this.#stream.coreReducedState.itxExpressionRewriteRules),
    builtIns: this.#builtIns,
  });

  // ── SUBSCRIPTION DELIVERY: the one loop (subscription-delivery.ts), wired to this DO ──

  readonly #subscriptionDelivery = new SubscriptionDelivery({
    stream: this.#stream,
    // The RESOLVER's door, not this class's `invoke`: the loop's evaluation is the kernel's own call.
    evaluateItxExpression: (itxExpression) => this.#itxExpressionResolver.invoke(itxExpression),
    reconcileAlarm: () => this.#alarmCoordinator.reconcile(),
  });

  // ── THE ONE ALARM (alarm-coordinator.ts): derived from three deadline sources, traced ──

  readonly #alarmCoordinator = new AlarmCoordinator({
    setAlarm: (at) => this.ctx.storage.setAlarm(at),
    deleteAlarm: () => this.ctx.storage.deleteAlarm(),
    deadlines: () => [
      this.#stream.nextScheduledAppendAt(),
      this.#subscriptionDelivery.deadlines()[0]?.at ?? null,
      this.#facetClaims.size === 0 ? null : Math.min(...this.#facetClaims.values()),
    ],
  });

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
  #facetReviveFailed(name: string) {
    const failures = (this.#facetReviveFailures.get(name) ?? 0) + 1;
    this.#facetReviveFailures.set(name, failures);
    this.ctx.storage.kv.put(`facet-claim-failures:${name}`, failures);
    return failures;
  }
  #facetRevived(name: string) {
    this.#facetReviveFailures.delete(name);
    this.ctx.storage.kv.delete(`facet-claim-failures:${name}`);
  }
  #claimFacetAlarm(name: string, at: number | null): void {
    // oxlint-disable-next-line iterate/simple-truthiness-check -- null releases a claim; epoch 0 is a valid due alarm
    if (at === null) {
      this.#facetClaims.delete(name);
      this.ctx.storage.kv.delete(`facet-claim:${name}`);
    } else {
      this.#facetClaims.set(name, at);
      this.ctx.storage.kv.put(`facet-claim:${name}`, at);
    }
    this.#alarmCoordinator.reconcile();
  }

  #traceAlarm(
    reason: AlarmTrace["reason"],
    before: number | null,
    extra: Pick<AlarmTrace, "error" | "dueSchedules"> = {},
  ) {
    const delivery = this.#subscriptionDelivery.deadlines();
    const trace: AlarmTrace = {
      at: Date.now(),
      reason,
      ...extra,
      alarm: { before, after: this.#alarmCoordinator.snapshot().armedAt },
      deadlines: {
        schedule: this.#stream.nextScheduledAppendAt(),
        delivery: delivery.slice(0, 32),
        deliveryOmitted: Math.max(0, delivery.length - 32),
        claims: [...this.#facetClaims].map(([name, at]) => ({ name, at })),
      },
      durableHead: this.#stream.highestDurableOffset(),
      facetWorkInFlight: this.#facetWorkInFlight,
      liveFacets: [...this.#liveFacetNames].slice(0, 32),
      borrowedRpcStubs: this.#rpcStubs.hasBorrowedRpcStubs(),
      libraryHoldsSocket: this.#library.holdsOpenSocket(),
    };
    // Straight onto the stream, not through `append` (a trace is not activity); a trace
    // must never fail an alarm pass.
    try {
      this.#stream.append({ type: STREAM_ALARM_TRACE_EVENT, ephemeral: true, payload: trace });
    } catch (error) {
      reportIssue("iterate-context.alarm-trace", error, { reason });
    }
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
        // oxlint-disable-next-line iterate/simple-truthiness-check -- the `itx.subscriptions` wire view: an absent optional field must stay ABSENT, not `field: undefined` (capnweb / Workers RPC serialize an undefined-valued key as present, and readers test presence)
        ...(s.hostedFacet && {
          hostedFacet: { ...s.hostedFacet, restarts: this.#facetRestarts(s.hostedFacet.name) },
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

  // ── THE PINS' RELEASE: borrowed stubs returned and sockets closed by a timer, so this actor can hibernate (workerd#6800) ──

  /** THE PINS' TIMER: a pin's use — a borrowed stub called, the library's socket used (the two
   *  things that keep an actor resident on the edge, both measured) — starts the quiet period over
   *  when the call ENDS; a call in flight holds it off (a stub is never returned out from under a
   *  call); its end releases every pin (`#releasePins`). In memory on purpose: the pins are, and
   *  the pin itself keeps the actor resident until the timer fires (a pending timer holds off
   *  hibernation, not eviction — and nothing pinned means nothing to release). A live facet is not
   *  a pin: on the edge it dies with the actor. */
  #pinReleaseTimer: ReturnType<typeof setTimeout> | undefined;
  #pinCallsInFlight = 0;
  #pinCallStarted(): void {
    this.#pinCallsInFlight += 1;
    clearTimeout(this.#pinReleaseTimer);
    this.#pinReleaseTimer = undefined;
  }
  #pinCallEnded(): void {
    this.#pinCallsInFlight -= 1;
    if (this.#pinCallsInFlight > 0) return;
    // A call that ends with nothing pinned (an HTTP client's, a stub returned mid-call) starts no
    // timer: a pending timer holds off hibernation, and there would be nothing to release.
    if (!this.#rpcStubs.hasBorrowedRpcStubs() && !this.#library.holdsOpenSocket()) return;
    this.#pinReleaseTimer = setTimeout(() => {
      this.#pinReleaseTimer = undefined;
      this.#releasePins();
    }, PIN_RELEASE_AFTER_IDLE_MS);
  }

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

  /** THE ALARM PASS, three jobs in order, under the coordinator's hold (nothing re-arms until it
   *  completes; a pass that dies is retried by the runtime): the due schedules, the stream-kept
   *  cursors' owed deliveries, the due claims of hosted processors (each spent, then the facet's
   *  `revive()` — a facet still busy claims again from there). Then the next deadline is derived
   *  from what is left. */
  async alarm(): Promise<void> {
    const { armedAt: fired } = this.#alarmCoordinator.snapshot();
    try {
      await this.#alarmCoordinator.pass(async () => {
        // An incarnation the alarm woke records its wake HERE, inside the hold — the one door that
        // knows the reason. Its delivery (every "*" row's) runs and acks within this pass, so an
        // alarm wake that finds nothing else owed ends with no alarm and no alarm write at all.
        this.#stream.appendWakeRecord("alarm");
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
        this.#traceAlarm("alarm-fired", fired, { dueSchedules: due.length });
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
          try {
            this.#appendAndRunCommittedEffects([
              ...row.events.map((event) => ({
                ...event,
                source: {
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
              { type: "events.iterate.com/stream/append-schedule-completed", payload },
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
                type: "events.iterate.com/stream/append-schedule-failed",
                payload: { ...payload, error: String(error).slice(0, 2000) },
              },
            ]);
            reportIssue("scheduled-append.failed", error, payload);
          }
        }
        // The stream-kept cursors' due retries, and anything an eviction left mid-delivery — AWAITED so
        // the deadline it leaves is the one derived below.
        await this.#subscriptionDelivery.deliverEveryCursorSubscription();
        // THE DUE CLAIMS: each is spent first (a claim is one revive, never a standing order — a
        // facet with an attempt still in flight claims again from its revive, later each time),
        // then the facet is revived: materialized if the last incarnation died with it, caught up,
        // its at-head pass run. AWAITED, so the claim it may make is the one derived below.
        for (const [name, at] of [...this.#facetClaims]) {
          if (at > Date.now()) continue;
          this.#claimFacetAlarm(name, null);
          try {
            await this.#invokeFacet(name, undefined, [["revive"]]);
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
      });
    } catch (error) {
      this.#traceAlarm("alarm-abandoned", fired, { error: String(error).slice(0, 256) });
      throw error;
    }
    this.#traceAlarm("alarm-pass", fired);
  }

  /** THE RELEASE (the pins' timer, `#pinCallEnded`): every borrowed stub returned, every library
   *  connection closed — the pins. Never a facet: on the edge a facet is not a pin (it dies with the
   *  actor), and one may be mid-attempt — an LLM call in its background — that an abort would kill
   *  for nothing. */
  #releasePins(): void {
    this.#rpcStubs.returnBorrowedRpcStubs();
    this.#library.releaseConnections();
  }

  /** DO-only, for the tests that run inside workerd (`__workers-tests__`): the release, plus every
   *  live facet aborted — workerd's harness keeps a facet-pinned actor resident (workerd#6800), so
   *  a test that must evict a facet-hosting context runs this first (`releasePins` in
   *  __workers-tests__/support.ts). Never a facet mid-call (a
   *  reduce aborted midway is the stall its gap repair would have to heal). Aborted facets
   *  re-materialize from their startup memo on their next call. */
  releasePins(): void {
    if (this.#facetWorkInFlight === 0) {
      for (const facetName of this.#liveFacetNames)
        this.#abortFacetIfRunning(facetName, "released for the test's eviction");
      this.#liveFacetNames.clear();
    }
    clearTimeout(this.#pinReleaseTimer);
    this.#pinReleaseTimer = undefined;
    this.#releasePins();
  }

  // ── FACETS: loaded DurableObject classes hosted here ──

  /** THE facet door — `itx.facets.get(name).m()` (address a running facet) and
   *  `itx.facets.get(name, { source, className }).m()` (load and host) both land here; facet stubs
   *  are non-transferable, so the walk happens where the stub lives. Top to bottom: the startup memo
   *  → the loaded identity (resolved, not loaded) → the racing-delete/reconfigure check → the restart
   *  marker → the facet, its class minted only when it STARTS (a running one never touches the
   *  loader) → the call under the watchdog → copy + dispose the answer. */
  async #invokeFacet(
    name: string,
    spec: FacetSpec | undefined,
    itxExpressionSteps: ItxExpression,
    retriedAfterPlatformFailure = false,
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
              snapshot: () => this.#stream.coreReducedStateSnapshot(),
              liveSnapshot: () => this.#stream.coreLiveStateSnapshot(),
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
      const props = { iterateContextName: this.#durableObjectAddress.name, name };
      let mintClass: () => DurableObjectClass;
      let retireLoadedIdentity: (() => void) | undefined;
      if (firstPartyClassName) {
        // `ctx.exports.<Class>({ props })` mints the class (__workers-tests__/facet-from-exports.test.ts).
        const exportsOf = this.ctx.exports as unknown as Record<
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
          env: this.env,
          deployId: this.#appConfig.deployId,
          platformOrigin: this.#platformOrigin,
          itxEntrypoint: this.#itxEntrypoint,
          kind: "facet",
          owner: facetLoaderOwner(this.#durableObjectAddress.name, memo.className),
          source: memo.source,
          cacheKey: memo.cacheKey,
          invoke: (call) => this.invoke(call),
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
        const previousLoaderId = this.ctx.storage.kv.get(`facet:${name}:loader-id`) as
          | string
          | undefined;
        if (previousLoaderId && previousLoaderId !== loaderId) {
          this.#abortFacetIfRunning(name, "loaded identity changed");
          this.#liveFacetNames.delete(name); // cold from here: it starts afresh below
        }
        if (previousLoaderId !== loaderId)
          this.ctx.storage.kv.put(`facet:${name}:loader-id`, loaderId);
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
      // (a constructor that threw is erased by workerd) — and a throw there is aborted in the catch
      // below, so the next call starts cold and clean.
      let startupClass = mintClass; // live: the callback mints, if it ever runs
      if (!this.#liveFacetNames.has(name)) {
        const minted = mintClass(); // cold: minted now
        startupClass = () => minted;
      }
      let startupFailed = false;
      const facet = this.ctx.facets.get(name, () => {
        try {
          return { class: startupClass() };
        } catch (error) {
          startupFailed = true;
          throw error;
        }
      });
      this.#liveFacetNames.add(name); // live from here
      // The call walks the steps receiver-preservingly — a `.fetch(request)` included (plain HTTP
      // by expression, the upgrade refused at the `facets.get` door; a WebSocket upgrade from
      // `#egress` to the `secret` facet, whose 101 rides the fetch channel back). The watchdog (FACET_CALL_WATCHDOG_MS) aborts a facet that
      // never answers: its pending call rejects, the counter drains, the next call re-materializes it.
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
        } else if (startupFailed) {
          this.#abortFacetIfRunning(name, "startup failed");
          this.#liveFacetNames.delete(name);
        } else if (isFacetStartPlatformFailure(error) && !retriedAfterPlatformFailure) {
          // The platform failure (the predicate's doc): restart the facet AND retire its loaded
          // identity (the cached entry is what stays broken), then the call once more, cold. One
          // extra attempt, never a loop — a second failure is the caller's. The retry re-delivers a
          // pushed batch: durables are offset-guarded by the engine, ephemerals are not (a duplicate
          // beats a lost batch; at-least-once is the facet contract). Counted on the facet's row and
          // logged, never swallowed, so the platform condition stays queryable without a log grep.
          this.#abortFacetIfRunning(name, "platform failure at facet start — restarting");
          this.#liveFacetNames.delete(name);
          retireLoadedIdentity?.();
          const restarts = this.#facetRestarts(name) + 1;
          this.ctx.storage.kv.put(`facet:${name}:restarts`, restarts);
          console.warn({
            event: "facet.platform-failure-retry",
            namespace: "iterate-context",
            name,
            restarts,
            message: error.message,
          });
          return await this.#invokeFacet(name, spec, itxExpressionSteps, true);
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
    } finally {
      this.#facetWorkInFlight--;
    }
  }

  /** THE STARTUP MEMO `facet:<name>` (the FacetSpec in this DO's kv) for one call: a hosting `spec`
   *  writes it (when it changed) BEFORE the load, so `itx.facets.get(name)` alone re-materializes the
   *  facet after an eviction; a bare name reads it; a name with neither is recovered from the durable
   *  log (M1, below); an unknown name is NO_FACET. Synchronous, so nothing slips in between the checks. */
  #facetStartupMemoFor(name: string, spec: FacetSpec | undefined): FacetSpec {
    let facetStartupMemo =
      this.#facetStartupMemoByName.get(name) ??
      (this.ctx.storage.kv.get(`facet:${name}`) as FacetSpec | undefined);
    if (spec) {
      assertFacetSourceWithinCeiling(spec, `facet "${name}"`);
      const storedSpec = facetSpecOf(spec);
      // Replaced only when it CHANGED: an unchanged spec keeps the memo object, and with it the
      // loader's identity-keyed content hash.
      if (!facetStartupMemo || JSON.stringify(facetStartupMemo) !== JSON.stringify(storedSpec)) {
        this.ctx.storage.kv.put(`facet:${name}`, storedSpec);
        facetStartupMemo = storedSpec;
      }
    }
    if (!facetStartupMemo) {
      // M1: a hosting row keeps NO source in core state — recover it from the DURABLE log event that
      // configured it and write the memo once. The memo survives eviction (kv), so this log read
      // happens at most once per facet per deployment, never per push. The hosting row's marker
      // names the facet (the subscription's own name may differ).
      const row = Object.values(this.#stream.coreReducedState.subscriptions).find(
        (candidate) => candidate.hostedFacet?.name === name,
      );
      if (row?.hostedFacet) {
        const [configuredEvent] = this.#stream.read(row.configuredAtOffset - 1, 1).events;
        const configuredTarget = (
          configuredEvent?.payload as { target?: ItxExpressionInput } | undefined
        )?.target;
        // RESOLVED before reading the spec off it, as the reduce did when it marked the row.
        const recoveredSpec = configuredTarget
          ? facetSpecFromHostingTarget(
              this.#itxExpressionResolver
                .resolve(normalizedItxExpression(configuredTarget))
                .at(-1)!,
            )
          : undefined;
        if (recoveredSpec) {
          const recovered = facetSpecOf(recoveredSpec as FacetSpec);
          this.ctx.storage.kv.put(`facet:${name}`, recovered);
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
      this.ctx.facets.abort(name, reason);
    } catch {
      /* facet not running */
    }
  }

  /** Delete a facet, storage included (there is no delete verb: a removed hosting row ends here). A
   *  re-load into the same name is a clean rebuild, never a resume from orphaned state. */
  /** How many times this facet was restarted after a platform failure at its start (the predicate
   *  `isFacetStartPlatformFailure`), over the facet's whole life on this context. */
  #facetRestarts(name: string) {
    // The row's value is the count this DO wrote in `#invokeFacet` (kv types it `unknown`); absent
    // until the first restart.
    return (this.ctx.storage.kv.get(`facet:${name}:restarts`) as number | undefined) ?? 0;
  }

  #deleteFacet(name: string): void {
    if (name === CoreContract.slug)
      throw new Error(`"${name}" is the core reduce — always on, never a facet`);
    this.ctx.facets.delete(name);
    this.#claimFacetAlarm(name, null);
    this.#facetRevived(name);
    this.ctx.storage.kv.delete(`facet:${name}`);
    this.ctx.storage.kv.delete(`facet:${name}:loader-id`);
    this.ctx.storage.kv.delete(`facet:${name}:restarts`);
    this.#facetStartupMemoByName.delete(name);
    this.#liveFacetNames.delete(name);
  }

  // ── dispatch: ONE door, the rewrite rules ──

  /** Resolve + run one call through the current rewrite rules. The ARRAY form carries call args a
   *  dotted STRING never could (callbacks, Dates, bytes: `["itx","tools",["transform",21,cb]]`);
   *  `args`, when given, are LIVE args applied to the value the expression denotes
   *  (`invoke("itx.kv.get", "k")` ≡ `itx.kv.get("k")`; the fetch lane's Request is the same door). */
  /** THE ONE DISPATCH DOOR. `caller` is WHO is calling (and, later, what they may reach) — carried
   *  for the whole call so every append it makes stamps `source.principal`, and threaded across each
   *  sibling `cd` hop. A DO-only Workers-RPC verb (never capnweb-exposed), so a client cannot forge
   *  the caller. `args`/`caller` default, so a bare `invoke(call)` is an anonymous probe. What READS
   *  the caller: `append` (the stamp) and, in the global namespace, `cd` (built-ins.ts — a person's
   *  path hop is refused there; the append type-gate is the security spec's remaining expected-fail). */
  async invoke(
    call: ItxExpressionInput,
    args: unknown[] = [],
    caller: Caller = { principal: null },
  ): Promise<unknown> {
    this.#stream.appendWakeRecord("request");
    return this.#callerStorage.run(this.#withPlatformOrigin(caller), () =>
      this.#itxExpressionResolver.invoke(call, ...args),
    );
  }
  readonly #callerStorage = new AsyncLocalStorage<Caller>();
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
  /** The origin for THIS call: the caller's (the persisted one filled in above), else nothing yet. */
  #platformOriginNow(): string | null {
    return this.#callerStorage.getStore()?.platformOrigin || this.#platformOrigin;
  }

  // ── native fetch: the rpc-stub pager door, the fetch lane, egress ──

  async fetch(request: Request): Promise<Response> {
    this.#stream.appendWakeRecord("request");
    // The doors, in order — each answers or declines: the rpc-stub pager and the rpc-stub fetch
    // upgrade leg; THE FETCH LANE (`x-itx-expression` names an itx expression — JSON from a session's
    // terminal `fetch(request)`, dotted text from a project host (`itx.apps.<app>` or an explicit worker expression) or
    // a loaded worker's own `env.ITX.fetch` — resolved as a terminal-fetch call with the live Request
    // as its one runtime arg; the routing header is stripped so it never reaches the capability or
    // egress); everything else is EGRESS.
    const pager = this.#rpcStubs.acceptRpcStubPagerWebSocket(request);
    if (pager) return pager;
    const upgradeLeg = this.#rpcStubFetch.acceptFetchUpgradeLeg(request);
    if (upgradeLeg) return upgradeLeg;
    const itxExpressionHeader = request.headers.get(ITX_EXPRESSION_FETCH_HEADER);
    // oxlint-disable-next-line iterate/simple-truthiness-check -- an untrusted HTTP header: present (even empty) selects the fetch lane, absent (null) routes to egress — that distinction must not collapse
    if (itxExpressionHeader !== null) {
      try {
        // The JSON form is an edge-set (worker.ts) or self-addressed (env.ITX.fetch) expression; the
        // resolver below canonicalizes it and rejects a malformed shape, so this parse trusts the JSON.
        if (itxExpressionHeader === "" && !this.#stream.coreReducedState.ingressTarget)
          return new Response(
            "This project has no site yet: its config worker's fetch serves this page once the project defines one\n",
            { status: 404 },
          );
        const itxExpression =
          itxExpressionHeader === ""
            ? this.#stream.coreReducedState.ingressTarget!
            : itxExpressionHeader.trimStart().startsWith("[")
              ? (JSON.parse(itxExpressionHeader) as ItxExpression)
              : parse(itxExpressionHeader);
        const headers = new Headers(request.headers);
        headers.delete(ITX_EXPRESSION_FETCH_HEADER);
        // THE APP LABEL the app sees (`x-iterate-app`, apps/os's header) is derived HERE, from the
        // expression, on every fetch-lane Request — a project host's, a session's terminal fetch, a
        // loaded worker's `env.ITX.fetch` — so whatever a visitor or loaded code wrote is overwritten
        // (set to the label of `itx.apps.<label>…`, deleted for any other expression).
        const appLabel =
          itxExpression[0] === "itx" && itxExpression[1] === "apps"
            ? itxExpressionStepName(itxExpression[2])
            : undefined;
        // oxlint-disable-next-line iterate/simple-truthiness-check -- undefined means the expression is not `itx.apps.*` (delete the header); an app label from the untrusted expression, even empty, still sets it
        if (appLabel === undefined) headers.delete(ITERATE_APP_HEADER);
        else headers.set(ITERATE_APP_HEADER, appLabel);
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
        // The platform origin the caller reached the platform on (app-config.ts `platformOriginOf`): the edge's
        // stamp, stripped before the app sees the Request (an app composes URLs through `itx.url`).
        const platformOrigin = headers.get(ITX_PLATFORM_ORIGIN_HEADER);
        headers.delete(ITX_PLATFORM_ORIGIN_HEADER);
        const forwarded = new Request(request, { headers });
        const caller = this.#withPlatformOrigin({ principal, grant, platformOrigin });
        const result = await this.#callerStorage.run(caller, () =>
          this.#itxExpressionResolver.invoke(itxExpressionEndingInFetch(itxExpression), forwarded),
        );
        return result instanceof Response
          ? result
          : new Response(`fetch lane: ${JSON.stringify(result)}\n`);
      } catch (error) {
        // A project host makes this lane public: default-deny is a 404 (a visitor's "no such app" is
        // no issue), a WebSocket upgrade aimed at a facet-hosted app is the caller's 400 (#invokeFacet),
        // anything else a 500 — the message alone every way, the stack REPORTED, never served.
        const code = errorCode(error);
        const status =
          code === "NO_ITX_EXPRESSION_MATCH" ? 404 : code === "FACET_NO_UPGRADE" ? 400 : 500;
        if (status === 500)
          reportIssue("iterate-context.fetch-lane", error, { itxExpression: itxExpressionHeader });
        const message = error instanceof Error ? error.message : String(error);
        return new Response(`fetch lane error: ${message}\n`, { status });
      }
    }
    return this.#egress(request);
  }

  /** IN-MEMORY TRANSPORT FACTS for the hibernation/release probes — a DO-only Workers-RPC verb,
   *  deliberately OFF the itx surface: socket facts, not event-derivable state. */
  rpcStubTransportState(): ReturnType<RpcStubDirectory["rpcStubTransportState"]> {
    return this.#rpcStubs.rpcStubTransportState();
  }

  /** EGRESS: a request that names a secret — `getSecret("/secrets/NAME")` in its URL or headers —
   *  is FORWARDED to the context at that path under the RESOURCE OWNER's root (iterate-context.ts
   *  `resourceScope`: a project's `/secrets/NAME`, a user's `/users/<id>/secrets/NAME` — so a user's
   *  placeholder reaches the user's own secret, never a shared one), and there to its `secret` facet
   *  (secret/durable-object.ts), which substitutes, pins, dispatches, and refreshes on a 401; one
   *  request, one secret (a second name is a 502 — no cross-secret chaining). A request naming none
   *  goes straight to the terminal fetch. Either way the platform's own headers never leave: the
   *  principal stamp (actor + email) and the expression would ride whatever an app forwards
   *  outbound. The hop counter stays — the edge's re-entry guard reads it when an app fetches its
   *  own host. WS-safe: only the headers are rewritten, and every hop is a fetch channel — the
   *  other context's `fetch` door, then `ctx.facets.get(name).fetch` — so a 101 flows straight back
   *  either way (measured: __workers-tests__/secret-facet-proxies-a-socket.test.ts). */
  #egress(request: Request): Promise<Response> {
    const headers = new Headers(request.headers);
    headers.delete(ITX_PRINCIPAL_HEADER);
    headers.delete(ITX_GRANT_HEADER);
    headers.delete(ITX_EXPRESSION_FETCH_HEADER);
    const outbound = new Request(request, { headers });
    const paths = secretPathsReferenced(outbound);
    if (paths.length === 0) return fetch(outbound);
    if (paths.length > 1)
      return Promise.resolve(
        new Response(
          `itx.fetch: one request, one secret — this one names ${paths.map((path) => JSON.stringify(path)).join(", ")}\n`,
          { status: 502 },
        ),
      );
    const { projectId, path } = this.#durableObjectAddress;
    const secretPath = resolveContextPath(resourceScope(projectId, path).rootPath, `.${paths[0]}`);
    // This context IS the secret's: its facet dials. Hosted on demand, row or no row — a secret
    // never set refuses inside the facet ("no stored project secret"), the same 502 as before.
    if (secretPath === path)
      return this.#invokeFacet("secret", undefined, [["fetch", outbound]]) as Promise<Response>;
    // Another context's: its own `fetch` door lands in ITS `#egress`, the branch above.
    return this.env.ITERATE_CONTEXT.getByName(
      DurableObjectNameCodec.stringify({ projectId, path: secretPath }),
    ).fetch(outbound);
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    this.#stream.appendWakeRecord("request");
    // Fetch-upgrade frames only (eyeball ⇄ upgrade leg); a pager socket's inbound payloads carry
    // nothing this DO acts on.
    this.#rpcStubFetch.handleWebSocketMessage(ws, message);
  }
  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    this.#stream.appendWakeRecord("request");
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
    this.#stream.appendWakeRecord("request");
    this.#rpcStubs.lendRpcStub({
      rpcStubKey: input.rpcStubKey,
      stub: input.stub as BorrowedRpcStub,
    });
  }
}
