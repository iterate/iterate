// iterate-context-durable-object.ts — `IterateContextDurableObject`: THE CONTEXT, one DO per
// `{projectId, path}` (codec-named `{projectId}.iterate{path}`), the parent of everything a context
// holds: the stream with its core reduce (stream/stream.ts), subscription delivery
// (stream/subscription-delivery.ts), the facets (context/facet-host.ts over `ctx.facets` and
// context/worker-loader.ts), the rpc stubs (context/rpc-stubs.ts), and `fetch()` (the pager
// upgrade, HTTP requests, egress). Each module's header says what it does; this file is the wiring and the entry points.
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
import { errorCode, reportIssue, resolveContextPath } from "iterate/next/lib";
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import type { StreamEvent, StreamEventInput } from "iterate/next/stream/processor";
import {
  canonicalItxExpressionPrefix,
  itxExpressionStepName,
  parse,
  print,
  type ItxExpression,
  type ItxExpressionInput,
  InvokeHandle,
  RpcStubHandle,
  itxAnswerDetachedFromSession,
  normalizedItxExpression,
} from "iterate/next/expression";
import {
  ITX_APP_HEADER,
  ITX_CALLER_PATH_HEADER,
  ITX_PRINCIPAL_HEADER,
  ITX_GRANT_HEADER,
  stampCaller,
  type Caller,
  type Principal,
} from "iterate/next/principal";
import type { RewriteRuleListEntry, StreamPage } from "iterate/next/api";
import { projectUrlOf } from "iterate/next/project-ingress";
import {
  normalizeControlEvent,
  RunRequested,
  type RunSettlement,
} from "./stream/core-processor.ts";
import {
  ITX_EXPRESSION_FETCH_HEADER,
  itxExpressionEndingInFetch,
  RpcStubFetchServer,
  RpcStubDirectory,
  RPC_STUB_PAGER_KEEPALIVE_REQUEST,
  RPC_STUB_PAGER_KEEPALIVE_RESPONSE,
  type BorrowedRpcStub,
} from "./context/rpc-stubs.ts";
import { buildLibrary, executeScript, runSettlementOf, type LibraryItx } from "./library.ts";
import { STREAM_ALARM_TRACE_EVENT, Stream, type ReachableContext } from "./stream/stream.ts";
import { AlarmCoordinator } from "./alarm-coordinator.ts";
import {
  DurableObjectNameCodec,
  itxEntrypointFor,
  ITX_PLATFORM_ORIGIN_HEADER,
} from "./iterate-context.ts";
import { resourceScope } from "./context/paths.ts";
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
import { directory, ensureDirectorySchema } from "./directory.ts";
import { buildBuiltIns, type SubscriptionListEntry } from "./context/built-ins.ts";
import { FacetHost } from "./context/facet-host.ts";
import type { ArtifactsNamespace } from "./context/repos.ts";
import {
  RESIDENCY_WATCHDOG_WINDOW_MS,
  decideResidencyWatchdog,
} from "./context/residency-watchdog.ts";
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
    /** The residency watchdog's deadline — in memory, so null in a fresh incarnation. */
    residencyWatchdog: number | null;
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
 *  vars worker.ts's `parseAppConfig` parses, plus the in-process control plane's own D1 and OAuth
 *  KV bindings. */
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

/** The app label an app sees. Written only by `fetch` below,
 *  from the expression: the label of `itx.apps.<label>…`, deleted for any other expression — so
 *  neither a visitor on a project host nor loaded code on `env.ITX.fetch` can pick an app the
 *  expression did not. */
const ITERATE_APP_HEADER = "x-iterate-app";

export class IterateContextDurableObject extends DurableObject<Env> {
  /** Native operator RPC only. Bypass every project rewrite so no project code can observe
   * the admin credential. The first-party secret facet independently verifies it. */
  async exportSecretForProjectSeed(adminSecret: string): Promise<unknown> {
    return this.#facetHost.invoke("secret", undefined, [["exportForProjectSeed", adminSecret]]);
  }

  /** WHO THIS DO IS: the DO name parsed ONCE into `{ name, projectId, path }`. A context is only
   *  ever reached `getByName`; an id-addressed instance fails right here, before it can touch anything. */
  readonly #durableObjectAddress = parseIterateContextDurableObjectName(this.ctx.id.name);
  /** The `env.ITX` / `globalOutbound` stub every worker this context loads receives (iterate-context.ts `ItxEntrypoint`).
   *  Minted once: it names the context, not an incarnation, and a warm loader never re-reads it. */
  /** The roots with an implicit row HERE (itx-expression-rewriting.ts rule 3): every built-in at the
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
    // here: the first door to open names the wake (`appendWakeRecord` — `alarm()` says "alarm").
    this.ctx.blockConcurrencyWhile(async () => {
      this.#alarmCoordinator.restore(await this.ctx.storage.getAlarm());
      // A deployment that names its origin (`urls.os`: prd, the previews — anything with more than one
      // hostname) knows it outright; one that does not (a self-host on workers.dev) learns it from the
      // first stamped caller and keeps it here across evictions.
      this.#platformOrigin =
        this.#appConfig.urls.os ||
        ((this.ctx.storage.kv.get("platform-origin") as string | undefined) ?? null);
      this.#stream.appendBirthRecord();
      // Retire only the subscription installed by older runtime versions. This durable
      // removal runs once per existing context; explicit user subscriptions are preserved.
      const config = this.#stream.coreReducedState.subscriptions.config;
      const retiredTarget = ["itx", ["cd", "/"], "worker", "processEventBatch"];
      if (config && JSON.stringify(config.target) === JSON.stringify(retiredTarget)) {
        this.#stream.append(
          normalizeControlEvent(
            {
              type: "events.iterate.com/stream/subscription-configured",
              payload: { name: "config", target: null },
              idempotencyKey: "migration:explicit-ingress:remove-default-subscription",
            },
            this.#durableObjectAddress.path,
          ),
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
    this.#inboundCallInOneTurn();
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
    this.#inboundCallInOneTurn();
    this.#stream.appendWakeRecord("request");
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
   *  the library its table already says (a naked child has no `itx.repos` row to get here through). */
  readonly #libraryItx = new InvokeHandle((steps) => {
    // Every call the library makes (a connection opening, a call through it) is a use of the
    // library's pin: the quiet period runs from the call's end.
    this.#pinCallStarted();
    const { app: _loadedCode, ...caller } = this.#caller;
    return this.#invokeInProcess(["itx", ...steps], [], caller).finally(() => this.#pinCallEnded());
    // The handle's dotted surface IS the library's itx: `itx.append(...)`, `itx.workers.get(...)`
    // reduce into steps (the prototype fallback, iterate-context.ts) and land in the callback above.
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
   *  watchdog; the caller defaults to the one already in AsyncLocalStorage, so a loopback's
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
      const platformOrigin = this.#platformOrigin;
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
    invoke: (call) => this.#invokeInProcess(call, [], { principal: null }),
    // a sibling context by path; the own path is this DO itself — a ReachableContext structurally (stream.ts)
    context: (p) => (p === this.#durableObjectAddress.path ? this.#localContext : this.#sibling(p)),
    egress: (request) => this.#egress(request),
    // The caller a hop hands a sibling (`cd`, a fan-out): the store's, or nobody — either way with
    // this context's origin filled in, so the sibling composes URLs at the origin the people use even
    // when the store did not survive to the step (a pipelined chain resolved outside the run scope).
    caller: () => this.#withPlatformOrigin(this.#caller),
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
    // The facets (context/facet-host.ts): the handle every `itx.facets.get` call walks, and the
    // claim a hosted processor makes on this context's alarm.
    claimFacetAlarm: (name, at) => this.#facetHost.claim(name, at),
    facets: { get: (name, spec) => this.#facetHost.handle(name, spec) },
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
    implicitRoots: this.#implicitRoots,
    path: this.#durableObjectAddress.path,
    caller: () => this.#caller,
  });

  // ── SUBSCRIPTION DELIVERY: the one loop (subscription-delivery.ts), wired to this DO ──

  readonly #subscriptionDelivery = new SubscriptionDelivery({
    stream: this.#stream,
    // The RESOLVER's door, not this class's `invoke`: the loop's evaluation is the kernel's own call.
    evaluateItxExpression: (itxExpression) => this.#itxExpressionResolver.invoke(itxExpression),
    reconcileAlarm: () => this.#alarmCoordinator.reconcile(),
  });

  // ── THE ONE ALARM (alarm-coordinator.ts): derived from four deadline sources, traced ──

  readonly #alarmCoordinator = new AlarmCoordinator({
    setAlarm: (at) => this.ctx.storage.setAlarm(at),
    deleteAlarm: () => this.ctx.storage.deleteAlarm(),
    deadlines: () => [...this.#durableAlarmDeadlines(), this.#residencyWatchdogArmedFor],
  });

  /** The three sources a fresh incarnation derives again — schedules, cursor-row claims, facet
   *  claims; the fourth, the residency watchdog, is this incarnation's alone. */
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
    platformOrigin: () => this.#platformOrigin,
    itxEntrypoint: () => this.#itxEntrypoint,
    invoke: (call) => this.#invokeInProcess(call, [], { principal: null }),
    resolveItxExpression: (expression) => this.#itxExpressionResolver.resolve(expression),
    stream: this.#stream,
    reconcileAlarm: () => this.#alarmCoordinator.reconcile(),
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
        residencyWatchdog: this.#residencyWatchdogArmedFor,
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

  // ── THE PINS' RELEASE: borrowed stubs returned and sockets closed by a timer, so this actor can hibernate (workerd#6800) ──

  /** THE PINS' TIMER: a pin's use — a borrowed stub called, the library's socket used (the two
   *  things that keep an actor resident on the edge, both measured) — starts the quiet period over
   *  when the call ENDS; a call in flight holds it off (a stub is never returned out from under a
   *  call); its end releases every pin (`#releasePins`). In memory on purpose: the pins are, and
   *  the pin itself keeps the actor resident until the timer fires. A pending timer holds off
   *  eviction AND hibernation, billed, for its whole length (measured 2026-09-23) — harmless only
   *  because this one is armed while a pin already holds the actor, and for 30 s; nothing pinned
   *  means nothing to release. A live facet is not a pin: on the edge it dies with the actor. */
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
    // timer: a pending timer holds off eviction and hibernation, and there would be nothing to release.
    if (!this.#rpcStubs.hasBorrowedRpcStubs() && !this.#library.holdsOpenSocket()) return;
    this.#pinReleaseTimer = setTimeout(() => {
      this.#pinReleaseTimer = undefined;
      this.#releasePins();
    }, PIN_RELEASE_AFTER_IDLE_MS);
  }

  /** THE ALARM PASS, three jobs in order, under the coordinator's hold (nothing re-arms until it
   *  completes; a pass that dies is retried by the runtime): the due schedules, the stream-kept
   *  cursors' owed deliveries, the due claims of hosted processors (each spent, then the facet's
   *  `revive()` — a facet still busy claims again from there). Then the next deadline is derived
   *  from what is left. The residency watchdog is decided first in every pass; a wake with nothing
   *  durable due is the watchdog's alone and does nothing else. */
  async alarm(): Promise<void> {
    const { armedAt: fired } = this.#alarmCoordinator.snapshot();
    // THE WATCHDOG'S OWN WAKE: no wake record, no trace, no delivery — in a fresh incarnation (its
    // armer was evicted, the normal end) nothing at all but re-deriving the alarm.
    const wokeAt = Date.now();
    if (!this.#durableAlarmDeadlines().some((at) => at !== null && at <= wokeAt)) {
      await this.#alarmCoordinator.pass(async () => this.#checkResidencyWatchdog(wokeAt));
      return;
    }
    try {
      await this.#alarmCoordinator.pass(async () => {
        this.#checkResidencyWatchdog(wokeAt);
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
        // THE DUE CLAIMS of hosted processors (context/facet-host.ts) — AWAITED, so the claim a
        // revive may make is the one derived below.
        await this.#facetHost.reviveDueClaims();
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

  // ── THE RESIDENCY WATCHDOG (context/residency-watchdog.ts): an actor held resident with nothing to do, recorded ──

  /** The watchdog's deadline, epoch ms — in memory on purpose: a fresh incarnation has none, so the
   *  alarm an evicted one left wakes it for nothing. */
  #residencyWatchdogArmedFor: number | null = null;
  /** Once per incarnation: a recorded incarnation is never armed again. */
  #residencyWatchdogRecorded = false;
  /** Inbound calls — Workers RPC, fetch, socket events; never the alarm — in flight, and when the
   *  last one ended: the quiet window runs from there. */
  #inboundCallsInFlight = 0;
  #lastInboundCallEndedAt: number | null = null;

  /** An inbound call begins, and arms the watchdog when none is armed: one alarm write per quiet
   *  window, not per call. Before the call's wake record, so a fresh incarnation's first commit
   *  supersedes the alarm its predecessor's watchdog left in one write, not a delete and a set. */
  #inboundCallStarted(): void {
    this.#inboundCallsInFlight += 1;
    if (this.#residencyWatchdogArmedFor !== null || this.#residencyWatchdogRecorded) return;
    this.#residencyWatchdogArmedFor = Date.now() + RESIDENCY_WATCHDOG_WINDOW_MS;
    this.#alarmCoordinator.reconcile();
  }
  #inboundCallEnded(): void {
    this.#inboundCallsInFlight -= 1;
    this.#lastInboundCallEndedAt = Date.now();
  }
  /** An inbound call that runs in ONE synchronous turn (`append`, `read`, a lend, a socket event):
   *  begun and ended at once — the clock does not move inside a turn. */
  #inboundCallInOneTurn(): void {
    this.#inboundCallStarted();
    this.#inboundCallEnded();
  }

  /** The watchdog's decision, applied at the start of every alarm pass: nothing, a later deadline,
   *  or THE RECORD — one appended fact and one structured `console.warn` (the line Workers Logs
   *  alerts on; `durableObjectId` finds the held session's still-open invocation there). Never an
   *  abort, and never a failed pass. */
  #checkResidencyWatchdog(now: number): void {
    const facets = this.#facetHost.snapshot();
    const decision = decideResidencyWatchdog({
      armedFor: this.#residencyWatchdogArmedFor,
      now,
      lastCallEndedAt: this.#lastInboundCallEndedAt,
      workInFlight:
        this.#inboundCallsInFlight +
        facets.facetWorkInFlight +
        this.#scriptRunsInFlight.size +
        this.#pinCallsInFlight,
      windowMs: RESIDENCY_WATCHDOG_WINDOW_MS,
    });
    if (decision.action === "none") return;
    if (decision.action === "rearm") {
      this.#residencyWatchdogArmedFor = decision.at;
      return;
    }
    this.#residencyWatchdogArmedFor = null;
    this.#residencyWatchdogRecorded = true;
    const transport = this.#rpcStubs.rpcStubTransportState();
    const payload = {
      incarnation: this.#stream.storage.incarnation,
      idleSince: new Date(decision.idleSince).toISOString(),
      idleForMs: now - decision.idleSince,
      liveFacets: facets.liveFacetNames.slice(0, 32),
      borrowedRpcStubs: transport.borrowedRpcStubs,
      rpcStubPagers: transport.rpcStubPagers,
      webSockets: this.ctx.getWebSockets().length,
      libraryHoldsSocket: this.#library.holdsOpenSocket(),
    };
    console.warn({
      event: "context.held-resident-while-idle",
      namespace: "iterate-context",
      name: this.#durableObjectAddress.name,
      durableObjectId: this.ctx.id.toString(),
      ...payload,
    });
    try {
      this.#appendAndRunCommittedEffects([
        { type: "events.iterate.com/context/held-resident-while-idle", payload },
      ]);
    } catch (error) {
      reportIssue("iterate-context.residency-watchdog", error, {
        incarnation: payload.incarnation,
      });
    }
  }

  /** DO-only, for the tests that run inside workerd (`__workers-tests__`): the release, plus every
   *  live facet aborted — workerd's harness keeps a facet-pinned actor resident (workerd#6800), so
   *  a test that must evict a facet-hosting context runs this first (`releasePins` in
   *  __workers-tests__/support.ts). Never a facet mid-call (a
   *  reduce aborted midway is the stall its gap repair would have to heal). Aborted facets
   *  re-materialize from their startup memo on their next call. */
  releasePins(): void {
    this.#facetHost.abortLiveFacetsWhenIdle("released for the test's eviction");
    clearTimeout(this.#pinReleaseTimer);
    this.#pinReleaseTimer = undefined;
    this.#releasePins();
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
    this.#inboundCallStarted();
    this.#stream.appendWakeRecord("request");
    const result = await this.#invokeInProcess(call, args, caller).finally(() =>
      this.#inboundCallEnded(),
    );
    // THE CALLER'S SESSION ENDS WITH THE CALL, WHATEVER IT KEEPS (expression.ts
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

  // ── native fetch: the rpc-stub pager door, the fetch lane, egress ──

  /** Ends when the Response is handed back — a body still streaming after that is not counted, so
   *  a stream longer than the watchdog's window is recorded as held. */
  async fetch(request: Request): Promise<Response> {
    this.#inboundCallStarted();
    return this.#serveFetch(request).finally(() => this.#inboundCallEnded());
  }

  async #serveFetch(request: Request): Promise<Response> {
    this.#stream.appendWakeRecord("request");
    // The doors, in order — each answers or declines: the rpc-stub pager and the rpc-stub fetch
    // upgrade leg; THE FETCH LANE (`x-itx-expression` names an itx expression — JSON from a session's
    // terminal `fetch(request)`, dotted text from a project host (`itx.apps.<app>` or an explicit worker expression) or
    // a loaded worker's own `env.ITX.fetch` — resolved as a terminal-fetch call with the live Request
    // as its one runtime arg; the routing header is stripped so it never reaches the capability or
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
        headers.delete(ITX_APP_HEADER);
        // THE APP LABEL the app sees (`x-iterate-app`) is derived HERE from the
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
        const callerPath = headers.get(ITX_CALLER_PATH_HEADER) || undefined;
        headers.delete(ITX_CALLER_PATH_HEADER);
        const forwarded = new Request(request, { headers });
        const caller = this.#withPlatformOrigin({
          principal,
          grant,
          path: callerPath,
          platformOrigin,
          ...(app && { app: true as const }),
        });
        const result = await this.#callerStorage.run(caller, () =>
          this.#itxExpressionResolver.invoke(itxExpressionEndingInFetch(itxExpression), forwarded),
        );
        return result instanceof Response
          ? result
          : new Response(`fetch lane: ${JSON.stringify(result)}\n`);
      } catch (error) {
        // A project host makes this lane public: default-deny is a 404 (a visitor's "no such app" is
        // no issue), a WebSocket upgrade aimed at a facet-hosted app is the caller's 400 (context/facet-host.ts),
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
    // Bare egress is the PLATFORM's (a first-party facet's raw `fetch(url)`); loaded code's fetch
    // always names an expression (`ItxEntrypoint.fetch`), so an app Request without one is refused.
    if (app) return new Response("loaded code's fetch names no expression\n", { status: 404 });
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
    headers.delete(ITX_CALLER_PATH_HEADER);
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
      return this.#facetHost.invoke("secret", undefined, [
        ["fetch", outbound],
      ]) as Promise<Response>;
    // Another context's: its own `fetch` door lands in ITS `#egress`, the branch above.
    return this.#sibling(secretPath).fetch(outbound);
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    this.#inboundCallInOneTurn();
    this.#stream.appendWakeRecord("request");
    // Fetch-upgrade frames only (eyeball ⇄ upgrade leg); a pager socket's inbound payloads carry
    // nothing this DO acts on.
    this.#rpcStubFetch.handleWebSocketMessage(ws, message);
  }
  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    this.#inboundCallInOneTurn();
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
    this.#inboundCallInOneTurn();
    this.#stream.appendWakeRecord("request");
    this.#rpcStubs.lendRpcStub({
      rpcStubKey: input.rpcStubKey,
      stub: input.stub as BorrowedRpcStub,
    });
  }
}
