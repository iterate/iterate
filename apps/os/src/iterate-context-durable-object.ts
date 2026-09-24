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
// fresh commit (`#appendAndRunCommittedEffects`): deleting the facet a removed subscription hosted,
// refreshing the startup memo of the facet a hosting subscription configures, and un-setting what
// names an rpc stub a resumed stream finds dead; and off every commit (`onCommit`) delivery and the
// requested runs.

import { AsyncLocalStorage } from "node:async_hooks";
import { codedError, errorCode, reportIssue, resolveContextPath } from "iterate/lib";
import { DurableObject } from "cloudflare:workers";
import type { StreamEvent, StreamEventInput } from "iterate/stream/processor";
import {
  canonicalItxExpressionPrefix,
  itxExpressionStepName,
  parse,
  print,
  type ItxExpression,
  type ItxExpressionInput,
  InvokeHandle,
  normalizedItxExpression,
} from "iterate/expression";
import { ITX_PRINCIPAL_HEADER, type Principal } from "iterate/principal";
import type { RewriteRuleListEntry, StreamPage } from "iterate/api";
import { ITERATE_ROUTING_SLUG_HEADER, projectUrlOf } from "iterate/project-ingress";
import { RunRequested, type RunSettlement } from "iterate/stream/run";
import {
  ITX_APP_HEADER,
  ITX_CALLER_PATH_HEADER,
  ITX_GRANT_HEADER,
  stampCaller,
  type Caller,
} from "./caller.ts";
import { RpcStubHandle, itxAnswerDetachedFromSession } from "./context/dispatch.ts";
import { normalizeControlEvent, STREAM_ALARM_TRACE_EVENT } from "./stream/core-processor.ts";
import {
  ITX_EXPRESSION_FETCH_HEADER,
  FETCH_UPGRADE_RESUMABLE_HEADER,
  ITX_PLATFORM_ORIGIN_HEADER,
  itxExpressionFetchCall,
  RpcStubFetchServer,
  RpcStubDirectory,
  RPC_STUB_PAGER_KEEPALIVE_REQUEST,
  RPC_STUB_PAGER_KEEPALIVE_RESPONSE,
  stampCallerHeaders,
  type BorrowedRpcStub,
} from "./context/rpc-stubs.ts";
import { buildLibrary, executeScript, runSettlementOf, type LibraryItx } from "./library.ts";
import { Stream, type ReachableContext } from "./stream/stream.ts";
import { ALARM_MAX_REARMS, AlarmCoordinator } from "./alarm-coordinator.ts";
import { itxEntrypointFor } from "./iterate-context.ts";
import { DurableObjectNameCodec, GLOBAL_PROJECT_ID, resourceScope } from "./context/paths.ts";
import { secretPathsReferenced } from "./secrets.ts";
import { appConfigOf, sessionSigningSecretOf, type AppConfigEnv } from "./app-config.ts";
import {
  ItxExpressionResolver,
  describeRewriteRules,
  rowsNamingRpcStub,
  rpcStubKeysNamed,
  implicitRootsAt,
  type ItxExpressionRewriteRule,
} from "./context/itx-expression-rewriting.ts";
import { signedFileUrl } from "./context/file-urls.ts";
import { ControlPlane } from "./control-plane/edge.ts";
import type { ControlPlaneDurableObject } from "./control-plane/durable-object.ts";
import { buildBuiltIns, type SubscriptionListEntry } from "./context/built-ins.ts";
import { FacetHost } from "./context/facet-host.ts";
import type { ArtifactsNamespace } from "./context/cf-artifacts.ts";
import { Residency } from "./context/residency.ts";
import { SubscriptionDelivery, type DeliveryDeadline } from "./stream/subscription-delivery.ts";

function parseIterateContextDurableObjectName(name: string | undefined) {
  if (!name)
    throw new Error(
      "IterateContextDurableObject must be addressed by name (reach it via getByName).",
    );
  return DurableObjectNameCodec.parse(name);
}

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
    /** The unclaimed-facet sweep's deadline — in memory, so null in a fresh incarnation. */
    unclaimedFacetSweep: number | null;
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

/** The bindings THE DO reads (Vite's built Wrangler config): the DO namespace, the Worker Loader, the kv namespaces,
 *  Workers AI, Browser Run, Artifacts — and, from `AppConfigEnv`, the version-metadata binding and the `APP_CONFIG_*`
 *  vars worker.ts's `parseAppConfig` parses. env.ts's `Env` extends this with the issuer's own
 *  (OAuth KV, the browser sessions, the page files, the mailbox): the one worker's env. */
export interface Env extends AppConfigEnv {
  ITERATE_CONTEXT: DurableObjectNamespace<IterateContextDurableObject>;
  /** The control plane singleton — slug/project lookups from inside a context (control-plane/edge.ts). */
  CONTROL_PLANE: DurableObjectNamespace<ControlPlaneDurableObject>;
  LOADER: WorkerLoader;
  ITX_KV: KVNamespace;
  /** Workers AI — the built-in root `itx.ai`, the binding verbatim (context/built-ins.ts). */
  AI: Ai;
  /** Browser Run — the built-in root `itx.browser` (context/built-ins.ts). */
  BROWSER: BrowserRun;
  /** The one R2 bucket — the built-in root `itx.r2`, every owner under its own prefix (context/built-ins.ts). */
  FILES: R2Bucket;
  /** Cloudflare Artifacts (beta) — the ONE bound namespace behind `itx.cfArtifacts`, project-scoped. */
  ARTIFACTS: ArtifactsNamespace;
}

export class IterateContextDurableObject extends DurableObject<Env> {
  /** Native operator RPC only. Bypass every project rewrite so no project code can observe
   * the admin credential. The first-party secret facet independently verifies it. */
  async exportSecretForProjectSeed(adminSecret: string): Promise<unknown> {
    return this.#facetHost.callFacetAsPlatform("secret", [["exportForProjectSeed", adminSecret]]);
  }

  /** WHO THIS DO IS: the DO name parsed ONCE into `{ name, projectId, path }`. A context is only
   *  ever reached `getByName`; an id-addressed instance fails right here, before it can touch anything. */
  readonly #durableObjectAddress = parseIterateContextDurableObjectName(this.ctx.id.name);
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
  /** context/rpc-stubs.ts — wired to `fetch` and the two WebSocket handlers below. */
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
        payload: { match, target: null, ifTarget },
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
    implicitRoots: ReadonlySet<string>;
  } {
    const { itxExpressionRewriteRules, subscriptions } = this.#stream.coreReducedState;
    return {
      implicitRoots: this.#implicitRoots,
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
    // here: the first entry point to run names the wake (`appendWakeRecord` — `alarm()` says "alarm").
    // Not awaited: a constructor cannot, and the runtime holds every event until this settles.
    void this.ctx.blockConcurrencyWhile(async () => {
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
      this.#stream.appendBirthRecord();
      // THE OVERDUE WATCH at birth (alarm-coordinator.ts): a stored alarm well past its time that a
      // source still wants is one the runtime held — an idle actor has no timer watching it; one no
      // source wants (the last incarnation's sweep) is superseded instead.
      this.#alarmCoordinator.rearmIfOverdue(Date.now());
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
    incarnationCountedByHost: true,
    path: this.#durableObjectAddress.path,
    projectId: this.#durableObjectAddress.projectId,
    wakeRecordDetail: () => this.#residency.wakeRecordDetail(),
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

  /** Inbound append: an inbound call and a `request` wake, then the commit and the committed-event
   *  effects. */
  async append(...events: StreamEventInput[]): Promise<StreamEvent[]> {
    this.#inboundRequestInOneTurn();
    return this.#appendAndRunCommittedEffects(events);
  }

  /** The bookkeeping of an entry point that runs in ONE synchronous turn (`append`, `read`, a lend,
   *  a socket event): an inbound call begun and ended (context/residency.ts), then the incarnation's
   *  `request` wake record. */
  #inboundRequestInOneTurn(): void {
    this.#residency.inboundCallInOneTurn();
    this.#stream.appendWakeRecord("request");
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
    const committedEvents = this.#stream.append(
      ...events.map((event) => normalizeControlEvent(event, this.#durableObjectAddress.path)),
    );
    // Effects run on FRESH commits only. An idempotency retry ECHOES the historical event (its offset
    // is <= the pre-append head), and re-running an effect on an echo could revert state a later event
    // already moved on — configure A, replace with B, retry A would restore A's facet startup memo.
    const freshEvents = committedEvents.filter((event) => event.offset > headBeforeCommit);
    this.#facetHost.deleteFacetsWhoseHostingSubscriptionWasRemoved(
      freshEvents,
      subscriptionsBeforeCommit,
    );
    this.#facetHost.refreshFacetStartupMemosFromHostingConfigurations(freshEvents);
    this.#unsetWhatNamesDeadRpcStubsOnResume(freshEvents);
    return committedEvents;
  }

  /** One BUDGETED page of the log (Stream.read), the ring's ephemerals merged in on request. */
  async read(
    afterOffset = 0,
    limit = 500,
    options: { includeEphemeral?: boolean } = {},
  ): Promise<StreamPage> {
    this.#inboundRequestInOneTurn();
    return this.#stream.read(afterOffset, limit, options); // sync on the Stream, a promise over Workers RPC
  }

  /** THE EFFECTIVE table, DESCRIBED (itx-expression-rewriting.ts `describeRewriteRules`); the hop
   *  behind a bare link is the sibling's own `list`. Addressing, so read under no principal. */
  #rewriteRuleList(depth: number): Promise<RewriteRuleListEntry[]> {
    return describeRewriteRules({
      rules: Object.values(this.#stream.coreReducedState.itxExpressionRewriteRules),
      implicitRoots: this.#implicitRoots,
      path: this.#durableObjectAddress.path,
      depth,
      inherit: (path, depth) =>
        this.#sibling(path).invoke(["itx", "builtins", "rewriteRules", ["list", depth]], [], {
          principal: null,
        }) as Promise<RewriteRuleListEntry[]>, // `invoke` is untyped over Workers RPC; the sibling is this same class answering this same method, so its rows are this method's return shape
    });
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
      const { code } = event.payload as RunRequested; // parsed at the append boundary (normalizeControlEvent)
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
      // Settled within RUN_DEADLINE_MS, its value released (library.ts `runSettlementOf`).
      const settlement = await runSettlementOf(this.#scriptExecution(code));
      // An agent's turns nest in the call chain until the runtime refuses a hop (#3019). The failed
      // settlement is on the log only, so this warn is how its rate shows in Workers Logs. A run
      // redirected to another context settles, and warns, on both.
      if (
        settlement.status === "failed" &&
        settlement.error.includes("Subrequest depth limit exceeded")
      )
        console.warn({
          event: "iterate-context.run-subrequest-depth-exceeded",
          namespace: "iterate-context",
          message: "a script run failed: the runtime refused a hop past its subrequest depth limit",
          name: this.#durableObjectAddress.name,
          requestOffset,
        });
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

  /** A requested script's execution. WHERE it runs is this context's own `itx.run` row: here by
   *  default (the implicit row), elsewhere when a row REDIRECTS it — the agent's `itx.run ⇒
   *  itx.builtins.cd('<agent>/sandbox').builtins.run` sends its scripts to a child whose table is the
   *  scripts' alone (configured by the installed app). A redirect is one more request-and-settle
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
    return redirect
      ? this.#itxExpressionResolver.invoke(redirect)
      : executeScript(this.#libraryItx, code);
  }

  /** The own-context adapter used by built-ins: a loopback (`itx.cd(<own path>)`, the config
   *  delivery) keeps caller attribution and committed effects and records no wake (it runs inside
   *  an incarnation a request or alarm already woke) — nor is it an inbound call to the residency
   *  clocks; the caller defaults to the one already in AsyncLocalStorage, so a loopback's
   *  appends stay attributed. */
  readonly #localContext: ReachableContext = {
    fetch: (request) => this.#serveFetch(request),
    append: async (...events) => this.#appendAndRunCommittedEffects(events),
    read: async (afterOffset, limit, options) => this.#stream.read(afterOffset, limit, options),
    invoke: (call, args = [], caller = this.#caller) =>
      this.#callerStorage.run(this.#withPlatformOrigin(caller), () =>
        this.#itxExpressionResolver.invoke(call, ...args),
      ),
  };

  /** The control plane as this context reads it: its own project's row (slug, organization). */
  readonly #controlPlane = new ControlPlane(this.env.CONTROL_PLANE);

  /** `itx.builtins` — the physical scope this context resolves against (context/built-ins.ts). */
  readonly #builtIns: Record<string, unknown> = buildBuiltIns({
    projectInfo: async () => {
      if (this.#durableObjectAddress.projectId === GLOBAL_PROJECT_ID) return {};
      // the control plane's row (control-plane/edge.ts, memoized per isolate: a project's slug never changes)
      const project = await this.#controlPlane.getProject(this.#durableObjectAddress.projectId);
      if (!project) return {};
      // the apex URL, when the caller carries the platform origin to compose it with
      const platformOrigin = this.#platformOrigin;
      const url = platformOrigin
        ? projectUrlOf(this.#appConfig.urls.ingressRouting, platformOrigin, {
            project: project.slug,
          })
        : null;
      return { projectSlug: project.slug, ...(url && { projectUrl: url.href }) };
    },
    projectId: this.#durableObjectAddress.projectId,
    path: this.#durableObjectAddress.path,
    iterateContextName: this.#durableObjectAddress.name,
    env: this.env,
    deployId: this.#appConfig.deployId,
    ingressRouting: this.#appConfig.urls.ingressRouting,
    dashOrigin: this.#appConfig.urls.dash,
    platformOrigin: () => this.#platformOrigin,
    signFileUrl: async (input) => {
      const platformOrigin = this.#platformOrigin;
      if (!platformOrigin)
        throw new Error(
          "files: a signed URL is composed from the platform origin the caller reached the platform on — this call carries none (call it from a session)",
        );
      // the URL carries the project's slug (the edge admits a project by it); the claim carries
      // the id — a global context (a user's, an organization's) has no URL
      const project = await this.#controlPlane.getProject(input.project);
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
    invoke: (call) => this.#invokeInProcess(call, [], { principal: null }),
    // a sibling context by path; the own path is this DO itself — a ReachableContext structurally (stream.ts)
    context: (p) => (p === this.#durableObjectAddress.path ? this.#localContext : this.#sibling(p)),
    egress: (request) => this.#egress(request),
    // The caller a hop hands a sibling (`cd`, a fan-out): the store's, or nobody — either way with
    // this context's origin filled in, so the sibling composes URLs at the origin the people use even
    // when the store did not survive to the step (a pipelined chain resolved outside the run scope).
    caller: () => this.#withPlatformOrigin(this.#caller),
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
      this.#facetHost.claim(name, at);
      // A RELEASE is the last thing the facet's work did: its instance is unclaimed from here, and
      // the sweep may have run (and disarmed) while the claim held it — so the release arms it.
      if (at === null) this.#residency.armUnclaimedFacetSweep();
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
    rewriteRules: {
      list: (depth = 3) => this.#rewriteRuleList(depth),
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
        return (await this.#rewriteRuleList(0)).find((row) => row.match === key) ?? null;
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
    rewriteRules: () => Object.values(this.#stream.coreReducedState.itxExpressionRewriteRules),
    builtIns: this.#builtIns,
    implicitRoots: this.#implicitRoots,
    path: this.#durableObjectAddress.path,
    caller: () => this.#caller,
  });

  /** THE RESET `itx.abort` asked for (built-ins.ts — its fact already appended): every write so far
   *  made durable, then `ctx.abort(message)` one zero-delay turn later, so the call that asked gets
   *  its answer. `ctx.abort` inside the call would reject that very call with `message` — the
   *  runtime aborts every request in flight, and no code can catch it — while a timer fires only
   *  after this turn's microtasks have resolved the answer and the runtime has sent it. Nor can the
   *  timer keep an idle actor resident: the actor it fires in is the one it resets. Every OTHER call
   *  in flight here rejects with `message`. */
  async #abortAfterTheAnswer(message: string): Promise<void> {
    // An abort breaks the output gate: a write not yet confirmed would go with it, the fact included.
    await this.ctx.storage.sync();
    setTimeout(() => this.ctx.abort(message), 0);
  }

  // ── SUBSCRIPTION DELIVERY: the one loop (subscription-delivery.ts), wired to this DO ──

  readonly #subscriptionDelivery = new SubscriptionDelivery({
    stream: this.#stream,
    // The RESOLVER's `invoke`, not this class's: the loop's evaluation is the kernel's own call.
    evaluateItxExpression: (itxExpression) => this.#itxExpressionResolver.invoke(itxExpression),
    // A facet row's push and catch-up: the facet host's platform entries, past the facet's list.
    pushEventBatchToFacet: (facetHandle, events, range) =>
      this.#facetHost.callFacetAsPlatform(facetHandle, [["processEventBatch", events, range]]),
    catchUpFacetFromLog: (facetHandle) =>
      this.#facetHost.callFacetAsPlatform(facetHandle, [["catchUpFromLog"]]),
    reconcileAlarm: () => this.#alarmCoordinator.reconcile(),
  });

  // ── THE ONE ALARM (alarm-coordinator.ts): derived from five deadline sources, traced ──

  readonly #alarmCoordinator = new AlarmCoordinator({
    setAlarm: (at) => this.ctx.storage.setAlarm(at),
    deleteAlarm: () => this.ctx.storage.deleteAlarm(),
    deadlines: () => [
      ...this.#durableAlarmDeadlines(),
      ...Object.values(this.#residency.deadlines()),
    ],
    held: () => this.#residency.holdsResident(),
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
   *  claims; the unclaimed-facet sweep is this incarnation's alone. */
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
    invoke: (call) => this.#invokeInProcess(call, [], { principal: null }),
    resolveItxExpression: (expression) => this.#itxExpressionResolver.resolve(expression),
    stream: this.#stream,
    reconcileAlarm: () => this.#alarmCoordinator.reconcile(),
    loadedFacetMaterialized: () => this.#residency.armUnclaimedFacetSweep(),
  });

  // ── RESIDENCY (context/residency.ts): the pins' release, the sweep, the birth reset ──

  // Annotated because TypeScript cannot infer it: its `facetHost` holds `#stream`, whose
  // `wakeRecordDetail` reads this field back (TS7022).
  readonly #residency: Residency = new Residency({
    name: this.#durableObjectAddress.name,
    facetHost: this.#facetHost,
    rpcStubs: this.#rpcStubs,
    library: this.#library,
    scriptRunsInFlight: () => this.#scriptRunsInFlight.size,
    reconcileAlarm: () => this.#alarmCoordinator.reconcile(),
    inboundCallsHeldChanged: () => this.#alarmCoordinator.watch(),
  });

  #traceAlarm(
    reason: AlarmTrace["reason"],
    before: number | null,
    extra: Pick<AlarmTrace, "error" | "dueSchedules"> = {},
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
      this.#stream.append({ type: STREAM_ALARM_TRACE_EVENT, ephemeral: true, payload: trace });
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

  /** THE ALARM PASS, three jobs in order, under the coordinator's hold (nothing re-arms until it
   *  completes; a pass that dies is retried by the runtime): the due schedules, the stream-kept
   *  cursors' owed deliveries, the due claims of hosted processors (each spent, then the facet's
   *  `revive()` — a facet still busy claims again from there). Then the next deadline is derived
   *  from what is left. The unclaimed-facet sweep is decided first in every pass; a wake with
   *  nothing durable due is the sweep's alone and does nothing else. */
  async alarm(): Promise<void> {
    const { armedAt: fired } = this.#alarmCoordinator.snapshot();
    // THE SWEEP'S OWN WAKE: no wake record, no trace, no delivery — in a fresh
    // incarnation (its armer was evicted, the normal end) nothing at all but re-deriving the alarm;
    // its birth already reset the unclaimed loaded facets.
    const wokeAt = Date.now();
    if (!this.#durableAlarmDeadlines().some((at) => at !== null && at <= wokeAt)) {
      await this.#alarmCoordinator.pass(async () => this.#residency.alarmPassStarted(wokeAt));
      return;
    }
    try {
      await this.#alarmCoordinator.pass(async () => {
        await this.#residency.alarmPassStarted(wokeAt);
        // An incarnation the alarm woke records its wake HERE, inside the hold — the one entry point
        // that knows the reason. Its delivery (every "*" row's) runs and acks within this pass, so an
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

  /** DO-only, for the tests that run inside workerd (`__workers-tests__/support.ts` `owedAlarm`): the
   *  deadline on the one alarm that is this incarnation's alone and owes nothing — the
   *  unclaimed-facet sweep's. */
  inMemoryAlarmDeadlines(): (number | null)[] {
    return Object.values(this.#residency.deadlines());
  }

  /** DO-only, for the tests that run inside workerd (`__workers-tests__`): the release, plus every
   *  live facet aborted — workerd's harness keeps a facet-pinned actor resident (workerd#6800), so
   *  a test that must evict a facet-hosting context runs this first (`releasePins` in
   *  __workers-tests__/support.ts). Never a facet mid-call (a
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
    this.#residency.inboundCallStarted();
    this.#stream.appendWakeRecord("request");
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

  /** The same call for THIS isolate's own callers — the library's itx, a facet's or a loaded worker's
   *  deps — who hold a handle in process, where it pins nothing and its liveness is the point. */
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
  /** A sibling context of this project, by path. */
  #sibling(path: string) {
    return this.env.ITERATE_CONTEXT.getByName(
      DurableObjectNameCodec.stringify({ projectId: this.#durableObjectAddress.projectId, path }),
    );
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
    this.#residency.inboundCallStarted();
    return this.#serveFetch(request).finally(() =>
      this.#residency.inboundCallEnded(request.headers.get(ITX_APP_HEADER) !== null),
    );
  }

  async #serveFetch(request: Request): Promise<Response> {
    this.#stream.appendWakeRecord("request");
    // The handlers, in order — each answers or declines: the rpc-stub pager and the rpc-stub fetch
    // upgrade leg; AN ITX-EXPRESSION FETCH (`x-itx-expression` names an itx expression — JSON from a session's
    // terminal `fetch(request)`, "" from a project host (the project's ingress target) or dotted text
    // or JSON from a loaded worker's own `env.ITX.fetch` — resolved as a terminal-fetch call with the live Request
    // as its last arg (`itxExpressionFetchCall`); the routing header is stripped so it never reaches the capability or
    // egress); everything else is EGRESS.
    // LOADED CODE's fetch (`ItxEntrypoint.fetch` set the header): neither the rpc-stub pager
    // WebSocket nor the rpc-stub fetch upgrade — both append rows past every table — and the
    // expression runs as app code.
    const app = request.headers.get(ITX_APP_HEADER) !== null;
    if (!app) {
      const pager = this.#rpcStubs.acceptRpcStubPagerWebSocket(request);
      if (pager) return pager;
      const upgradeLeg = this.#rpcStubFetch.acceptFetchUpgradeLeg(request);
      if (upgradeLeg) return upgradeLeg;
    }
    const itxExpressionHeader = request.headers.get(ITX_EXPRESSION_FETCH_HEADER);
    // oxlint-disable-next-line iterate/simple-truthiness-check -- an untrusted HTTP header: present (even empty) selects an itx-expression fetch, absent (null) routes to egress — that distinction must not collapse
    if (itxExpressionHeader !== null) {
      try {
        // The header is UNTRUSTED. Its JSON form comes from a session's terminal fetch
        // (`encodeFetchExpression`) or from loaded code's self-addressed `env.ITX.fetch`, which
        // `ItxEntrypoint.fetch` forwards unchanged; the edge (worker.ts) only sets "".
        // The resolver's `normalizedItxExpression` shape-checks it, and for loaded code the app wall
        // (`admitLoadedCodeExpression`) admits it, before anything runs.
        if (itxExpressionHeader === "" && !this.#stream.coreReducedState.ingressTarget)
          return new Response(
            "This project has no site yet: its config worker's fetch serves this page once the project defines one\n",
            { status: 404 },
          );
        const itxExpression =
          itxExpressionHeader === ""
            ? this.#stream.coreReducedState.ingressTarget!
            : itxExpressionHeader.trimStart().startsWith("[")
              ? (JSON.parse(itxExpressionHeader) as ItxExpression) // untrusted: see above
              : parse(itxExpressionHeader);
        const headers = new Headers(request.headers);
        headers.delete(ITX_EXPRESSION_FETCH_HEADER);
        headers.delete(ITX_APP_HEADER);
        // THE ROUTING SLUG (`x-iterate-routing-slug`) is the EDGE's alone: it rides only a
        // project-host Request — the empty expression from outside loaded code, which only the edge
        // sends (worker.ts sets or deletes the header there) — and is deleted from every other
        // expression fetch (a session's terminal fetch, a loaded worker's `env.ITX.fetch`, even one
        // spelling ""), so loaded code can never forge one.
        if (itxExpressionHeader !== "" || app) headers.delete(ITERATE_ROUTING_SLUG_HEADER);
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
        const forwarded = new Request(request, {
          headers,
          body: this.#expressionFetchBody(request),
        });
        const caller = this.#withPlatformOrigin({
          principal,
          grant,
          path: callerPath,
          platformOrigin,
          ...(app && { app: true as const }),
        });
        const result = await this.#callerStorage.run(caller, () =>
          this.#itxExpressionResolver.invoke(itxExpressionFetchCall(itxExpression, forwarded)),
        );
        return result instanceof Response
          ? result
          : new Response(`expression fetch: ${JSON.stringify(result)}\n`);
      } catch (error) {
        // A project host makes this path public: default-deny is a 404 (a visitor's "no such app" is
        // no issue), a WebSocket upgrade aimed at a facet-hosted app is the caller's 400 (context/facet-host.ts),
        // anything else a 500 — the message alone every way, the stack REPORTED, never served.
        const code = errorCode(error);
        // A lent stub that went offline mid-call (a tunnel's laptop asleep) is the upstream's
        // absence, a 502 — the expected outcome, never a platform fault.
        const status =
          code === "NO_ITX_EXPRESSION_MATCH"
            ? 404
            : code === "FACET_NO_UPGRADE"
              ? 400
              : code === "RPC_STUB_OFFLINE"
                ? 502
                : 500;
        if (status === 500)
          reportIssue("iterate-context.expression-fetch", error, {
            itxExpression: itxExpressionHeader,
          });
        const message = error instanceof Error ? error.message : String(error);
        return new Response(`expression fetch error: ${message}\n`, { status });
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
   *  buffered: an app that proxies uploads or echoes the body still streams. */
  #expressionFetchBody(request: Request): ReadableStream | null {
    if (!request.body) return null;
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
   *  other context's `fetch`, then `ctx.facets.get(name).fetch` — so a 101 flows straight back
   *  either way (measured: __workers-tests__/secret-facet-proxies-a-socket.test.ts). */
  #egress(request: Request): Promise<Response> {
    const headers = new Headers(request.headers);
    stampCallerHeaders(headers, null);
    headers.delete(ITX_EXPRESSION_FETCH_HEADER);
    headers.delete(FETCH_UPGRADE_RESUMABLE_HEADER); // the edge's ask of a lent stub, never an origin's
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
      // A facet call answers `unknown`; the secret facet's `fetch` answers its Response.
      return this.#facetHost.callFacetAsPlatform("secret", [
        ["fetch", outbound],
      ]) as Promise<Response>;
    // Another context's: its own `fetch` lands in ITS `#egress`, the branch above.
    return this.#sibling(secretPath).fetch(outbound);
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    this.#inboundRequestInOneTurn();
    // Fetch-upgrade frames only (eyeball ⇄ upgrade leg); a pager socket's inbound payloads carry
    // nothing this DO acts on.
    this.#rpcStubFetch.handleWebSocketMessage(ws, message);
  }
  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    this.#inboundRequestInOneTurn();
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
    this.#inboundRequestInOneTurn();
    this.#rpcStubs.lendRpcStub({
      rpcStubKey: input.rpcStubKey,
      stub: input.stub as BorrowedRpcStub, // unvalidatable by design (the docstring above)
    });
  }
}
