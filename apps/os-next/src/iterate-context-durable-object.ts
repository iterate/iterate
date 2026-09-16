// iterate-context-durable-object.ts — `IterateContextDurableObject`: THE CONTEXT, one DO per
// `{projectId, path}` (codec-named `{projectId}.iterate{path}`), the parent of everything a context
// holds: the stream with its core reduce (stream/stream.ts), subscription delivery
// (stream/subscription-delivery.ts), the facets (`ctx.facets`, context/worker-loader.ts), the rpc
// stubs (context/rpc-stubs.ts), and the fetch door (the pager upgrade, the fetch lane,
// egress). Each module's header says what it does; this file is the wiring and the doors.
//   egress — `#egress`: a `getSecret("/secrets/NAME")` request is forwarded to its secret's own Durable Object (secrets.ts)
//
// PURE WORKERS-RPC: capnweb never terminates here — the stateless `/api` worker relays. Dispatch is
// ONE door, `invoke(call)`; every OTHER change to this context is an appended event (the edge's
// `provide`/`subscribe` and the `processors` root build one and call `append`; a lent stub's rule or
// row rides its pager upgrade and is appended as the pager is accepted) — there are no
// configuration verbs here. The events this class appends on its own initiative: the birth `config`
// subscription (the constructor), the un-set of whatever named an rpc stub whose last pager closed
// (onPresence), and the self-wake-halted fact (alarm); the two effects it runs off a committed
// event: deleting the facet a removed subscription hosted, and refreshing the startup memo of the
// facet a hosting subscription configures.

import { AsyncLocalStorage } from "node:async_hooks";
import { DurableObject } from "cloudflare:workers";
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
} from "./stream/core-processor.ts";
import { codedError, errorCode, reportIssue, withTimeout } from "./lib.ts";
import type { StreamEvent, StreamEventInput } from "./stream/processor.ts";
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
} from "./context/expression.ts";
import {
  ITX_EXPRESSION_FETCH_HEADER,
  itxExpressionEndingInFetch,
  RpcStubFetchServer,
  RpcStubDirectory,
  RPC_STUB_PAGER_KEEPALIVE_REQUEST,
  RPC_STUB_PAGER_KEEPALIVE_RESPONSE,
  type BorrowedRpcStub,
} from "./context/rpc-stubs.ts";
import { buildLibrary, type LibraryItx } from "./library.ts";
import { Stream, type StreamPage } from "./stream/stream.ts";
import { DurableObjectNameCodec, itxEntrypointFor, resourceScope } from "./iterate-context.ts";
import { secretNamesReferenced } from "./secrets.ts";
import type { SecretDurableObject } from "./secret-durable-object.ts";
import { appConfigOf, type AppConfigEnv } from "./app-config.ts";
import {
  CONFIG_WORKER_PLATFORM_ROW,
  ItxExpressionResolver,
  restoreRuleTarget,
  rowsNamingRpcStub,
  rpcStubKeysNamed,
  type ItxExpressionRewriteRule,
  BUILT_IN_ROOTS,
} from "./context/itx-expression-rewriting.ts";
import { ITX_PRINCIPAL_HEADER, stampPrincipal, type Caller, type Principal } from "./principal.ts";
import {
  buildBuiltIns,
  type RewriteRuleListEntry,
  type SubscriptionListEntry,
} from "./context/built-ins.ts";
import type { ArtifactsNamespace } from "./context/repos.ts";
import { SubscriptionDelivery } from "./stream/subscription-delivery.ts";

function parseIterateContextDurableObjectName(name: string | undefined) {
  if (!name)
    throw new Error(
      "IterateContextDurableObject must be addressed by name (reach it via getByName).",
    );
  return DurableObjectNameCodec.parse(name);
}

/** How long a context stays quiet — no call, no delivery, no borrow — before the alarm aborts its
 *  idle facets and returns its borrowed rpc stubs so the actor can hibernate. */
const IDLE_QUIESCE_AFTER_MS = 60_000;
/** How long one facet call may take before the facet is aborted (a call that never answers would
 *  hold the quiesce, and with it this actor, forever). */
const FACET_CALL_WATCHDOG_MS = 60_000;

/** The bindings THE DO reads (wrangler.jsonc): the DO namespace, the Worker Loader, the kv namespaces,
 *  Workers AI, Artifacts — and, from `AppConfigEnv`, the version-metadata binding and the `APP_CONFIG_*`
 *  vars worker.ts's `parseAppConfig` parses. control-plane.ts's `Env` extends this with the
 *  in-process control plane's own (D1, OAuth KV, …): the one worker's env. */
export interface Env extends AppConfigEnv {
  ITERATE_CONTEXT: DurableObjectNamespace<IterateContextDurableObject>;
  LOADER: WorkerLoader;
  ITX_KV: KVNamespace;
  /** Workers AI — the built-in root `itx.ai`, the binding verbatim (context/built-ins.ts). */
  AI: Ai;
  /** Cloudflare Artifacts (beta) — the ONE bound namespace behind `itx.cfArtifacts`, project-scoped. */
  ARTIFACTS: ArtifactsNamespace;
  /** THE SECRETS (secret-durable-object.ts): one Durable Object per secret, `<owner>:<name>` —
   *  egress forwards a placeholder-bearing request to its object. */
  SECRET: DurableObjectNamespace<SecretDurableObject>;
}

/** The app label an app sees — apps/os's header. Written at the fetch lane alone (`fetch` below),
 *  from the expression: the label of `itx.apps.<label>…`, deleted for any other expression — so
 *  neither a visitor on a project host nor loaded code on `env.ITX.fetch` can pick an app the
 *  expression did not. */
const ITERATE_APP_HEADER = "x-iterate-app";

export class IterateContextDurableObject extends DurableObject<Env> {
  /** WHO THIS DO IS: the DO name parsed ONCE into `{ name, projectId, path }`. A context is only
   *  ever reached `getByName`; an id-addressed instance fails right here, before it can touch anything. */
  readonly #durableObjectAddress = parseIterateContextDurableObjectName(this.ctx.id.name);
  /** The `env.ITX` / `globalOutbound` stub every worker this context loads receives (iterate-context.ts `ItxEntrypoint`).
   *  Minted once: it names the context, not an incarnation, and a warm loader never re-reads it. */
  readonly #itxEntrypoint = itxEntrypointFor(this.ctx, this.#durableObjectAddress.name);
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
      void this.#appendAndRunCommittedEffects(events.map((event) => stampPrincipal(event, null))),
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
    // The wake record, before any door opens (Stream.appendCreatedAndWokenEvents).
    this.#stream.appendCreatedAndWokenEvents();
    // EVERY STREAM SUBSCRIBES THE "/" CONTEXT'S CONFIG WORKER: `itx.worker.processEventBatch` is
    // delivered every committed event, cross-context, at-least-once. `consumes: ["*"]` is honest —
    // the config worker sees everything, `woken` included. A DOWN config worker cannot wake-loop
    // forever: the ladder is bounded and the self-wake breaker (stream.ts SELF_WAKE_HALT_STREAK)
    // halts arming regardless; `itx.worker` always resolves (a bundled no-op default,
    // itx-expression-rewriting.ts), so a config-less project never halts. Idempotent — one row per
    // context whatever the incarnation.
    // The birth append bypasses the DO's append boundary, so normalize this literal here.
    this.#stream.append(
      normalizeControlEvent({
        type: "events.iterate.com/stream/subscription-configured",
        payload: {
          name: "config",
          target: "itx.cd('/').worker.processEventBatch",
          consumes: ["*"],
        },
        idempotencyKey: "config-subscription",
      }),
    );
  }

  /** THE STREAM (stream/stream.ts): the commit pipeline and the core reduce. Its one callback,
   *  `onCommit`, is the post-commit fan-out — the delivery loop, run as THE KERNEL: under
   *  `{ principal: null }` explicitly, whatever the committing call's caller was. The commit lands
   *  inside that call's `#callerStorage.run`, and the async store would otherwise ride every
   *  continuation the loop schedules — so a user's append would deliver their config funnel under
   *  THEIR principal, which the global namespace's `cd` (built-ins.ts) rightly refuses. The kernel
   *  hop is told from a person's by exactly this null. */
  readonly #stream = new Stream({
    storage: this.ctx.storage,
    path: this.#durableObjectAddress.path,
    projectId: this.#durableObjectAddress.projectId,
    onCommit: (freshEvents, afterOffset, throughOffset) =>
      this.#callerStorage.run({ principal: null }, () =>
        this.#subscriptionDelivery.onCommit(freshEvents, afterOffset, throughOffset),
      ),
  });

  /** The append door — a thin wrapper over Stream.append. The activity note runs on every LANDED
   *  append; a REFUSED one pays nothing (arming the quiet-clock alarm is a storage write a rejected
   *  probe must not pay). */
  async append(...events: StreamEventInput[]): Promise<StreamEvent[]> {
    this.#notePublicDoor();
    return this.#appendAndRunCommittedEffects(events);
  }

  /** SYNCHRONOUS end to end (Stream.append is): the commit, the activity note, the committed-event
   *  effects. Two callers: `append`, and the pager attach (rpc-stubs.ts), which needs the
   *  refusal in the same turn it accepted the socket. */
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
    this.#recordActivityForQuietClock();
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
        if (!spec) continue;
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

  /** One BUDGETED page of the log (Stream.read). */
  async read(afterOffset = 0, limit = 500): Promise<StreamPage> {
    this.#notePublicDoor();
    return this.#stream.read(afterOffset, limit); // sync on the Stream, async at this cross-hop door
  }

  /** THE EFFECTIVE rule table, read: the context's own rows (masks as `target: null`, a template's
   *  `@` spelled) plus the implicit platform rows the context has not re-set — one per built-in root
   *  and the config worker's (`itx.worker`, itx-expression-rewriting.ts) — none at all under a bare
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
      CONFIG_WORKER_PLATFORM_ROW,
    ].filter((row) => !reset.has(row.match));
    return [...contextRows, ...platformRows];
  }

  /** THE LIBRARY (library.ts): its verbs closed over a genuine InvokeHandle over `invoke`, so a
   *  library call's `itx.fetch(...)` resolves through THIS context's rules (a test may shadow
   *  `itx.fetch`) with zero hops. Its live connections pin this actor awake; the idle quiesce releases them. */
  readonly #library = buildLibrary(
    new InvokeHandle((steps) => this.invoke(["itx", ...steps])) as unknown as LibraryItx,
  );

  /** `itx.builtins` — the physical scope this context resolves against (context/built-ins.ts). */
  readonly #builtIns: Record<string, unknown> = buildBuiltIns({
    projectId: this.#durableObjectAddress.projectId,
    path: this.#durableObjectAddress.path,
    iterateContextName: this.#durableObjectAddress.name,
    env: this.env,
    deployId: this.#appConfig.deployId,
    artifactsAccountId: this.#appConfig.artifactsAccountId,
    artifactsNamespace: this.#appConfig.artifactsNamespace,
    secrets: () =>
      Object.entries(this.#stream.coreReducedState.secrets).map(([name, secret]) => ({
        name,
        ...secret,
      })),
    invoke: (call) => this.invoke(call),
    // a sibling context by path; the own path is this DO itself — a ReachableContext structurally (stream.ts)
    context: (p) =>
      p === this.#durableObjectAddress.path
        ? this
        : this.env.ITERATE_CONTEXT.getByName(
            DurableObjectNameCodec.stringify({
              projectId: this.#durableObjectAddress.projectId,
              path: p,
            }),
          ),
    egress: (request) => this.#egress(request),
    caller: () => this.#callerStorage.getStore() ?? { principal: null },
    // `get(key)` is a GENUINE RpcTarget so `itx.rpcStubs.get('k').hello()` pipelines the mid-chain
    // `.hello()` on every lane (workerd's classifier rejects a Proxy, #6873), branded RpcStubHandle
    // for the delivery loop.
    rpcStubs: {
      // Re-note AFTER the call: this invoke may have borrowed the stub, and a borrowed stub is
      // exactly what the quiet clock exists to return — the arm must not wait for the next call.
      get: (rpcStubKey) =>
        new RpcStubHandle(async (itxExpressionSteps) => {
          try {
            return await this.#rpcStubs.invokeRpcStub(rpcStubKey, itxExpressionSteps);
          } finally {
            this.#recordActivityForQuietClock();
          }
        }),
      list: () => this.#rpcStubs.listRpcStubKeys(),
    },
    // The facets view is PARENT-LOCAL — the facets live here and can never move (workerd#6702:
    // sockets never leave the parent). Branded FacetHandle for the delivery loop.
    facets: {
      get: (name, spec) =>
        new FacetHandle((itxExpressionSteps) => this.#invokeFacet(name, spec, itxExpressionSteps)),
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
    itxEntrypoint: this.#itxEntrypoint,
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
    // The RESOLVER's door, not this class's `invoke`: the loop's own evaluation is not activity (a
    // finished delivery is — the loop records it), so the alarm's row-driven pass, which classifies
    // every row's target once, can never postpone its own quiesce.
    evaluateItxExpression: (itxExpression) => this.#itxExpressionResolver.invoke(itxExpression),
    recordActivityForQuietClock: () => this.#recordActivityForQuietClock(),
  });

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
        ...(s.hostedFacet && { hostedFacet: s.hostedFacet }),
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

  // ── the #6800 quiesce: idle facets un-pinned so this actor can hibernate ──

  #lastActivityMs = 0;
  #recordActivityForQuietClock(): void {
    this.#lastActivityMs = Date.now();
    // NOTHING TO QUIESCE, NO ALARM: with no live facet, no borrowed stub and no library connection,
    // arming is one storage write plus one billed wake for nothing — a bare probe must not pay that.
    // `#lastActivityMs` still updates, so the first materialization / borrow / connection arms with an
    // honest quiet-period start.
    if (
      this.#liveFacetNames.size === 0 &&
      !this.#rpcStubs.hasBorrowedRpcStubs() &&
      !this.#library.hasOpenConnections()
    )
      return;
    this.#stream.armAlarmNoLaterThan(this.#lastActivityMs + IDLE_QUIESCE_AFTER_MS);
  }

  /** The self-wake breaker's other half (stream.ts SELF_WAKE_HALT_STREAK holds the durable streak):
   *  set the moment any RPC into this DO is answered this incarnation, as opposed to an alarm-only
   *  pass. "Any RPC" includes the wake's own facet loopbacks — a processor pushed by the
   *  constructor's `woken` reads or appends through `itx.builtins` and lands here, so a context
   *  hosting a `*`-consuming processor counts its wakes as doors (accepted: the loop that would
   *  mask needs an eviction between alarms, which a live facet prevents). */
  #publicDoorTouched = false;
  #notePublicDoor(): void {
    this.#publicDoorTouched = true;
    this.#stream.notePublicDoor();
  }

  /** EVERY facet materialized this incarnation — the set the quiesce alarm aborts so no LIVE facet
   *  pins this actor awake. In memory on purpose: facets die with the incarnation, and a fresh call
   *  re-materializes from the durable startup memo. */
  readonly #liveFacetNames = new Set<string>();
  /** Each facet's startup memo (`facet:<name>` in kv), read ONCE per incarnation: every push then
   *  hands the loader the SAME object, so its identity-keyed content hash (worker-loader.ts) runs once
   *  per source per incarnation, not once per push. */
  readonly #facetStartupMemoByName = new Map<string, FacetSpec>();
  /** The in-flight count the quiesce respects: aborting a facet mid-REDUCE is exactly the stall a
   *  reduce would have to repair from the log — never cause it. */
  #facetWorkInFlight = 0;

  async alarm(): Promise<void> {
    this.#stream.noteAlarmFired();
    // The cursor lane's due retries, and anything an eviction left mid-delivery — AWAITED so a
    // re-arm for a later retry lands before this actor hibernates. A cursor delivery pins nothing
    // local (a facet it calls into is counted by #facetWorkInFlight), so the quiesce below needs no
    // count of its own. The cursor lane arms this alarm itself while a delivery is owed; the quiet
    // clock arms it for facets and borrowed stubs.
    await this.#subscriptionDelivery.deliverEveryCursorSubscription();
    // The self-wake breaker (stream.ts SELF_WAKE_HALT_STREAK): an alarm pass with NO public door
    // touched this incarnation is a self-wake. Recorded once, when the streak first crosses. A
    // halted context FALLS THROUGH to the quiesce below: it will not wake itself again, so it must
    // not stay pinned (billed for duration) by what this wake materialized.
    if (!this.#publicDoorTouched) {
      const { streak, justHalted } = this.#stream.noteSelfWake();
      if (justHalted) {
        console.warn({
          event: "self-wake-halted",
          namespace: "iterate-context",
          message: `context self-woke ${streak} times with no public door — halting the alarm (runaway billing control) until a real request arrives`,
          name: this.#durableObjectAddress.name,
          streak,
        });
        try {
          this.#stream.append({
            type: "events.iterate.com/stream/self-wake-halted",
            payload: { streak },
          });
        } catch (error) {
          console.warn({
            event: "self-wake-halted.fact-failed",
            namespace: "iterate-context",
            message: "could not append the self-wake-halted fact (the halt still holds)",
            error: String(error),
          });
        }
      }
    }
    const quiet = Date.now() - this.#lastActivityMs >= IDLE_QUIESCE_AFTER_MS;
    if ((quiet || this.#stream.selfWakeHalted()) && this.#facetWorkInFlight === 0) {
      for (const facetName of this.#liveFacetNames)
        this.#abortFacetIfRunning(facetName, "idle quiesce");
      this.#liveFacetNames.clear(); // aborted facets re-materialize on their next call
      // Borrowed stubs and the library's live connections pin this actor the same way: returned
      // and released here, borrowed and reopened on use.
      this.#rpcStubs.returnBorrowedRpcStubs();
      this.#library.releaseConnections();
    } else if (
      this.#liveFacetNames.size > 0 ||
      this.#rpcStubs.hasBorrowedRpcStubs() ||
      this.#library.hasOpenConnections()
    ) {
      // Look again when the quiet period would end — never in the PAST (work in flight for over a
      // minute would otherwise re-fire this alarm in a tight, billed loop). With NOTHING to quiesce
      // there is no re-arm (the #recordActivityForQuietClock rule): re-arming regardless was the
      // every-minute `woken` loop the breaker was measured on.
      this.#stream.armAlarmNoLaterThan(
        Math.max(this.#lastActivityMs + IDLE_QUIESCE_AFTER_MS, Date.now() + 10_000),
      );
    }
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
  ): Promise<unknown> {
    // oxlint-disable-next-line iterate/simple-truthiness-check -- name arrives as a client-authored itx expression argument; the static string type is the API contract, not a runtime guarantee, so a non-string is rejected with a usage error
    if (typeof name !== "string")
      throw new Error(
        "itx.facets.get(name, spec?): name the facet; pass { source, className } to load and host it",
      );
    if (itxExpressionSteps.length === 0) throw new Error(`facet: name a method`);
    // A FACET ANSWERS RPC AND PLAIN HTTP — NEVER A WEBSOCKET. A socket terminates at the edge (a
    // session's /api pager socket on this DO, a project host's lent-stub upgrade leg), and the
    // facet behind it is reached by itx expression; so the idle quiesce (alarm) aborts an idle
    // facet with nothing to lose, and no socket is ever held by a facet the parent cannot see.
    // Refused BEFORE the memo: an upgrade aimed at a facet materializes nothing.
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
    const facetStartupMemo = this.#facetStartupMemoFor(name, spec);
    this.#facetWorkInFlight++;
    try {
      // THE LOADED IDENTITY, resolved — not loaded: `load` runs only for a facet that starts (below;
      // __workers-tests__/facet-class-loads-at-startup.test.ts). The one await is a dead id's
      // recovery (worker-loader.ts).
      const { loaderId, load } = await prepareConfinedWorker({
        env: this.env,
        deployId: this.#appConfig.deployId,
        itxEntrypoint: this.#itxEntrypoint,
        kind: "facet",
        owner: facetLoaderOwner(this.#durableObjectAddress.name, facetStartupMemo.className),
        source: facetStartupMemo.source,
        cacheKey: facetStartupMemo.cacheKey,
        invoke: (call) => this.invoke(call),
        where: `facet "${name}"`,
      });
      // A removal or a RECONFIGURE may have landed while that awaited: this name's memo is then gone
      // (#deleteFacet) or a newer object (#facetStartupMemoFor replaces a changed spec). Bail — a
      // stale call must neither resurrect a deleted facet as an orphan this actor never quiesces, nor
      // abort the newer facet to install old code. The memo object's identity IS the check: the memo
      // is per incarnation, and so is this await.
      if (this.#facetStartupMemoByName.get(name) !== facetStartupMemo)
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
      // THE CLASS. A facet this actor holds LIVE (#liveFacetNames) is running: `facets.get` reuses
      // its container and never runs the startup callback — no loader lookup, no class minted for
      // nothing, and a loader hiccup cannot fail the call. A COLD facet's class is minted here,
      // before `facets.get`: a loader that refuses is then this call's own rejection, with no
      // container left behind (a startup callback that throws leaves workerd's container broken
      // until an abort, and the runtime logs the throw as uncaught). The callback still mints for
      // the one gap between the two — a container the runtime dropped under a name still held live
      // (a constructor that threw is erased by workerd) — and a throw there is aborted in the catch
      // below, so the next call starts cold and clean.
      const mintClass = () =>
        load().getDurableObjectClass(facetStartupMemo.className, {
          props: { iterateContextName: this.#durableObjectAddress.name, name },
        });
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
      // The call walks the steps receiver-preservingly — a `.fetch(request)` included (plain HTTP;
      // the upgrade was refused above). The watchdog (FACET_CALL_WATCHDOG_MS) aborts a facet that
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
        }
        throw error;
      }
      // A Workers-RPC RESULT object carries a disposer that references the FACET until disposed or
      // GC'd — and GC is too late for the quiesce: an aborted facet stayed referenced through every
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
      this.#recordActivityForQuietClock(); // a finished call earns a fresh quiet period
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

  /** Abort a facet that is running; one that is not (already quiesced, never started) is nothing. */
  #abortFacetIfRunning(name: string, reason: string): void {
    try {
      this.ctx.facets.abort(name, reason);
    } catch {
      /* facet not running */
    }
  }

  /** Delete a facet, storage included (there is no delete verb: a removed hosting row ends here). A
   *  re-load into the same name is a clean rebuild, never a resume from orphaned state. */
  #deleteFacet(name: string): void {
    if (name === CoreContract.slug)
      throw new Error(`"${name}" is the core reduce — always on, never a facet`);
    this.ctx.facets.delete(name);
    this.ctx.storage.kv.delete(`facet:${name}`);
    this.ctx.storage.kv.delete(`facet:${name}:loader-id`);
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
    this.#notePublicDoor();
    this.#recordActivityForQuietClock();
    try {
      return await this.#callerStorage.run(caller, () =>
        this.#itxExpressionResolver.invoke(call, ...args),
      );
    } finally {
      // Note AGAIN after the call: it may have OPENED a library connection (the pre-call note ran
      // before it existed), and a connection is exactly what the quiet clock must arm for.
      this.#recordActivityForQuietClock();
    }
  }
  readonly #callerStorage = new AsyncLocalStorage<Caller>();

  // ── native fetch: the rpc-stub pager door, the fetch lane, egress ──

  async fetch(request: Request): Promise<Response> {
    this.#notePublicDoor();
    // The doors, in order — each answers or declines: the rpc-stub pager and the rpc-stub fetch
    // upgrade leg; THE FETCH LANE (`x-itx-expression` names an itx expression — JSON from a session's
    // terminal `fetch(request)`, dotted text from a project host (`itx.apps.<app>`, `itx.worker`) or
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
        const itxExpression = itxExpressionHeader.trimStart().startsWith("[")
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
        const principal = JSON.parse(
          headers.get(ITX_PRINCIPAL_HEADER) ?? "null",
        ) as Principal | null;
        const forwarded = new Request(request, { headers });
        const result = await this.#callerStorage.run({ principal }, () =>
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

  /** IN-MEMORY TRANSPORT FACTS for the hibernation/quiesce probes — a DO-only Workers-RPC verb,
   *  deliberately OFF the itx surface: socket facts, not event-derivable state. */
  rpcStubTransportState(): ReturnType<RpcStubDirectory["rpcStubTransportState"]> {
    return this.#rpcStubs.rpcStubTransportState();
  }

  /** EGRESS: a request that names a secret — `getSecret("/secrets/NAME")` in its URL or headers —
   *  is FORWARDED to that secret's Durable Object (secret-durable-object.ts), which substitutes, pins,
   *  dispatches, and refreshes on a 401; one request, one secret (a second name is a 502 — no
   *  cross-secret chaining). A request naming none goes straight to the terminal fetch. Either way
   *  the platform's own headers never leave: the principal stamp (actor + email) and the expression
   *  would ride whatever an app forwards outbound. The hop counter stays — the edge's re-entry guard
   *  reads it when an app fetches its own host. WS-safe: only the headers are rewritten, so a 101
   *  flows straight back either way. */
  #egress(request: Request): Promise<Response> {
    const headers = new Headers(request.headers);
    headers.delete(ITX_PRINCIPAL_HEADER);
    headers.delete(ITX_EXPRESSION_FETCH_HEADER);
    const outbound = new Request(request, { headers });
    const names = secretNamesReferenced(outbound);
    if (names.length === 0) return fetch(outbound);
    if (names.length > 1)
      return Promise.resolve(
        new Response(
          `itx.fetch: one request, one secret — this one names ${names.map((name) => JSON.stringify(name)).join(", ")}\n`,
          { status: 502 },
        ),
      );
    // The object is the RESOURCE OWNER's (iterate-context.ts `resourceScope`) — the one derivation
    // `itx.secrets` keys it by, so a user's placeholder reaches the user's own secret, never a shared one.
    const owner = resourceScope(
      this.#durableObjectAddress.projectId,
      this.#durableObjectAddress.path,
    );
    return this.env.SECRET.getByName(`${owner.id}:${names[0]}`).fetch(outbound);
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    // Fetch-upgrade frames only (eyeball ⇄ upgrade leg); a pager socket's inbound payloads carry
    // nothing this DO acts on.
    this.#rpcStubFetch.handleWebSocketMessage(ws, message);
  }
  webSocketClose(ws: WebSocket, code: number, reason: string): void {
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
    this.#rpcStubs.lendRpcStub({
      rpcStubKey: input.rpcStubKey,
      stub: input.stub as BorrowedRpcStub,
    });
  }
}
