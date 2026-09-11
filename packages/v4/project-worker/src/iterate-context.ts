// iterate-context.ts — the client-facing capnweb surface: A PROXY IN FRONT OF THE DURABLE OBJECT. This
// is the ONE place capnweb terminates (the `/api` worker); it reaches the IterateContextDurableObject
// only over Workers RPC (the hard rule).
//
// INVARIANT (owner): THE CLIENT IS JUST CAPNWEB. Every class in this file is a SERVER-side RpcTarget;
// what a client holds is a plain capnweb proxy of it. There is no client SDK and none may be introduced
// — a client's whole dependency is the capnweb package. Anything that would need client-side smarts
// belongs HERE, behind an RpcTarget method.
//
// The DO owns every contract. This class declares only what the edge must do itself, in the order
// the tutorial builds them:
//   • `cd`      — pure addressing, zero DO hops; returns an EDGE context so a later lend lands in
//                 THIS session;
//   • `invoke`  — the landing door of the prototype hop at the bottom (`itx.a.b(x)` reduces to ONE
//                 expression) plus the one fetch-lane fork; `invoke(call, ...args)` applies LIVE args
//                 (a Request, a callback) to the value the expression denotes; every built-in root
//                 (`itx.append(…)`, `itx.readEvents(…)`, `itx.waitForEvent(…)`, `itx.kv.get(…)`,
//                 `itx.rpcStubs.list()`, `itx.rewriteRules.list()`, …) and the reserved physical root
//                 `itx.builtins.…` ride it with ZERO code here;
//   • `provide` — THE ONE FRONT DOOR: make `match` mean `target`. A target that is a client's rpc stub
//                 (a function, an RpcTarget) must live in this stateless worker, never in the DO
//                 (DON'T-PIN, below), so the lend happens here — under the key = the canonical match —
//                 plus the pure-data rule `match ⇒ itx.builtins.rpcStubs.get('<match>')`; an expression
//                 target is that rule alone; `null` is a DENY (a mask over a platform row, `itx.kv`; a
//                 deletion elsewhere). A rule or subscription naming a lent key is REMOVED by the DO
//                 when the key's last pager closes — the physical fact decides, not this session's
//                 teardown — and removal restores the platform row beneath (a fake `itx.ai` gives the
//                 real one back);
//   • `subscribe` / `enableProcessor` / `disableProcessor` — each is visibly "build the event, append
//                 it": the DO has `append` and no configuration verbs. `subscribe` is declared here
//                 because its target may be a client's rpc stub. When it is (as when `provide` lends),
//                 the event RIDES THE PAGER UPGRADE and the DO appends it as it accepts the pager —
//                 one round trip, and the DO owns both ends of what names a lent stub;
// `provide` and `subscribe` hand back a DISPOSABLE handle (`using`): disposing un-does the act. capnweb
// also disposes every exported handle when the session ends, so a rule or subscription made through
// the verb is SESSION-SCOPED; one that must outlive the session is the raw event —
// `itx.append(rewriteRuleConfiguredEvent(match, target))` — the verb minus the handle.
//
// HOW A CLIENT REACHES ONE: `/api` → `UnauthenticatedSession.authenticate()` → `Session.projects.get(id)`
// → that project's ROOT `IterateContext` (session.ts). Contexts within a project are reached from a
// context with `cd(path)` (absolute by convention, relative resolves).
//
// DON'T-PIN: the client's capnweb stub lives HERE, in this stateless worker, which OWNS it for the
// session. `provide` opens an RPC-STUB PAGER WebSocket to the DO (context/rpc-stub-relay.ts +
// context/rpc-stub-directory.ts): a standing offer to lend the key back on demand. When the DO wants
// the client — a delivery, a request/response call — it PAGES this worker, which LENDS it a fresh
// Workers-RPC stub over `lendRpcStub`. The DO keeps that stub borrowed while traffic flows and returns
// it at its idle quiesce. So the DO holds no stub while idle and hibernates with any number of clients.

import { RpcTarget, type RpcStub } from "capnweb";
import type { IterateContextDurableObject } from "./iterate-context-durable-object.ts";
import { ITX_EXPRESSION_FETCH_HEADER } from "./fetch/rpc-stub-fetch.ts";
import {
  canonicalItxExpressionPrefix,
  toItxExpression,
  type ItxExpression,
  type ItxExpressionInput,
} from "./context/expression.ts";
import {
  rewriteRuleConfiguredEvent,
  rewriteRuleRemovedEvent,
} from "./context/itx-expression-rewriting.ts";
import { facetSpecOf, type FacetSpec } from "./context/worker-loader.ts";
import { installPrototypeInvokeFallback } from "./context/dotted-path-proxy.ts";
import type { BuiltInScope, RewriteRuleListEntry } from "./context/built-ins.ts";
import {
  DurableObjectNameCodec,
  resolveContextPath,
  type DurableObjectAddress,
} from "./context/durable-object-names.ts";
import {
  lendRpcStubOverPager,
  type ClientRpcStub,
  type IterateContextDurableObjectStub,
} from "./context/rpc-stub-relay.ts";
import type { ContextLeaseBook } from "./session.ts";
import type { StreamEvent, StreamEventInput } from "./stream/events.ts";
import { assertAppendRequestAdmission } from "./stream/resource-budget.ts";
import { subscriptionConfiguredEvent } from "./stream/subscriptions.ts";

export type IterateContextNamespace = DurableObjectNamespace<IterateContextDurableObject>;
export type WaitUntil = (p: Promise<unknown>) => void;
type SubscriptionTarget = RpcStub<
  (events: StreamEvent[], range: { after: number; through: number }) => unknown
>;

const MAX_INERT_RESULT_DEPTH = 32;
const MAX_INERT_RESULT_NODES = 20_000;

/** A native RPC promise owns the pipeline it started. Releasing one also releases its resolved
 * result, so only a bounded graph of own, enumerable data properties is safe to release here. This
 * deliberately rejects every capability-shaped or exotic value (RpcTarget/RpcStub, Request,
 * Response, streams, typed values, accessors, cycles, and anything too deep/large to inspect).
 * Workerd adds an own `Symbol.dispose` data property to objects that arrived through a native RPC
 * promise. Only that runtime marker is ignored, and only while releasing that known native promise.
 *
 * `build` and `check` return this shape, but the dispatch door is rewriteable: `itx.build` may be a
 * caller's live capability. Inspect the ACTUAL settled value rather than the expression that named
 * it, so a rewritten result keeps its outer native RPC promise and remains callable. */
function isBoundedPlainData(value: unknown, ignoreNativeRpcDisposeSymbol = false): boolean {
  const seen = new Set<object>();
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): boolean => {
    // Count every value, including primitives. The proof must be resource-bounded even when an
    // untrusted result is a very wide scalar array rather than a deep object graph.
    if (++nodes > MAX_INERT_RESULT_NODES) return false;
    if (
      candidate === null ||
      candidate === undefined ||
      typeof candidate === "boolean" ||
      typeof candidate === "number" ||
      typeof candidate === "string" ||
      typeof candidate === "bigint"
    )
      return true;
    if (typeof candidate !== "object" || depth > MAX_INERT_RESULT_DEPTH) return false;
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        // Do not materialize a descriptor map for a huge array. The length descriptor is data on a
        // real array; a Proxy that refuses this reflection is conservatively retained below.
        const length = Object.getOwnPropertyDescriptor(candidate, "length");
        if (
          !length ||
          !("value" in length) ||
          typeof length.value !== "number" ||
          !Number.isSafeInteger(length.value)
        )
          return false;
        if (length.value > MAX_INERT_RESULT_NODES - nodes) return false;
        for (let index = 0; index < length.value; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index));
          if (descriptor && (!("value" in descriptor) || !descriptor.enumerable)) return false;
          if (!visit(descriptor?.value, depth + 1)) return false;
        }
        return hasOnlySafeSymbols(candidate, ignoreNativeRpcDisposeSymbol);
      }
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) return false;
      // `for…in` streams the enumerable own keys. We read each descriptor, never its property,
      // so a getter or a capability proxy cannot be accidentally invoked by the proof.
      for (const key in candidate) {
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return false;
        if (!visit(descriptor.value, depth + 1)) return false;
      }
      return hasOnlySafeSymbols(candidate, ignoreNativeRpcDisposeSymbol);
    } catch {
      // A Proxy may throw while reflecting its shape. It is not proven inert, so retain it.
      return false;
    }
  };
  return visit(value, 0);
}

/** The native RPC runtime attaches exactly this own data marker to returned ordinary objects.
 * No other symbol is data: it might be an application protocol marker or a capability shape. */
function hasOnlySafeSymbols(value: object, ignoreNativeRpcDisposeSymbol: boolean): boolean {
  return Object.getOwnPropertySymbols(value).every((symbol) => {
    if (!ignoreNativeRpcDisposeSymbol || symbol !== Symbol.dispose) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, symbol);
    return descriptor !== undefined && "value" in descriptor;
  });
}

function isDisposablePromise<T>(value: Promise<T>): value is Promise<T> & Partial<Disposable> {
  return Symbol.dispose in value;
}

async function awaitAndReleaseInertRpcResult<T>(rpcPromise: Promise<T>): Promise<T> {
  const result = await rpcPromise;
  // The descriptor-only proof above is the authority to release this settled native pipeline. Do
  // not release unknown data just because the call happened to be awaited: it may be a live result.
  const nativeRpcPromise = isDisposablePromise(rpcPromise);
  if (isBoundedPlainData(result, nativeRpcPromise) && nativeRpcPromise)
    rpcPromise[Symbol.dispose]?.();
  return result;
}

/** What `provide` hands back: dispose it — or let the session end; capnweb disposes every exported
 *  handle then — and the rule at `match` is un-set: for a lent stub, by recalling the stub (the DO
 *  un-sets what named it when its last pager closes); for an expression or a deny, by appending the
 *  removal spelling (`itx.builtins.<match…>`, never `null`) when the row is still its own. The caller
 *  already holds the match it passed, so the handle carries nothing else. */
class RewriteRuleHandle extends RpcTarget {
  readonly #undo: () => void;
  constructor(undo: () => void) {
    super();
    this.#undo = undo;
  }
  [Symbol.dispose](): void {
    this.#undo();
  }
}

/** What `subscribe` hands back: dispose it — or let the session end — and the subscription is removed
 *  (a lent callback is recalled with it). `name` is a GETTER (capnweb exposes prototype members only)
 *  — the generated one when none was given. */
class SubscriptionHandle extends RpcTarget {
  readonly #name: string;
  readonly #undo: () => void;
  constructor(name: string, undo: () => void) {
    super();
    this.#name = name;
    this.#undo = undo;
  }
  get name(): string {
    return this.#name;
  }
  [Symbol.dispose](): void {
    this.#undo();
  }
}

/** WHAT RIDES THE HOP, TYPED: every built-in root (`append`, `readEvents`, `waitForEvent`, `kv`, `rpcStubs`,
 *  `facets`, `workers`, …) is a member of this class's TYPE by declaration merging — zero runtime; the
 *  prototype fallback at the bottom of this file is the runtime. So a reader of this file sees the
 *  whole surface, and `env.ITX.get().append(…)` typechecks in loaded code. `cd` is the edge's own
 *  (below) — it returns an EDGE context, not the built-in's handle. */
export interface IterateContext extends Omit<BuiltInScope, "cd"> {}

/** The iterate context (`itx`) at one `{ projectId, path }`, as a client holds it. */
export class IterateContext extends RpcTarget {
  readonly #contextNamespace: IterateContextNamespace;
  readonly #durableObjectAddress: DurableObjectAddress;
  #durableObject: IterateContextDurableObjectStub | undefined;
  readonly #leases: ContextLeaseBook;
  readonly #waitUntil: WaitUntil;

  constructor(
    contextNamespace: IterateContextNamespace,
    durableObjectAddress: DurableObjectAddress,
    leases: ContextLeaseBook,
    waitUntil: WaitUntil,
  ) {
    super();
    this.#contextNamespace = contextNamespace;
    this.#durableObjectAddress = durableObjectAddress;
    // Keep one stub while it is healthy: a stub serializes one context's calls in order. Native DO
    // exceptions can poison that stub, however, so #withDurableObject drops only the generation that
    // threw; the next independent operation obtains a replacement. It never retries the failed call.
    this.#durableObject = contextNamespace.getByName(durableObjectAddress.name);
    this.#leases = leases;
    this.#waitUntil = waitUntil;
  }

  /** Another context of THIS project. Absolute by convention (`cd("/agents/support")`); relative
   *  (`"agents/support"`, `"../inbox"`) resolves against this context's path — one resolver, shared
   *  with the built-in `itx.cd(...)` root. Returns an EDGE context, so `provide` on it lends in this
   *  same session. Pure addressing. */
  cd(path: string): IterateContext {
    const durableObjectAddress = DurableObjectNameCodec.parse(
      DurableObjectNameCodec.stringify({
        projectId: this.#durableObjectAddress.projectId,
        path: resolveContextPath(this.#durableObjectAddress.path, path),
      }),
    );
    return new IterateContext(
      this.#contextNamespace,
      durableObjectAddress,
      this.#leases,
      this.#waitUntil,
    );
  }

  /** THE dispatch door (built-ins + every rewrite rule) — the ONE way to call the itx surface. Takes an
   *  `ItxExpressionInput`: a dotted string (`"itx.append({...})"`) OR the parsed array
   *  (`["itx",["append",{...}]]`); both carry mid-path call args. The dotted sugar `itx.a.b(x)` reduces
   *  into `["itx","a",["b",x]]` (the prototype fallback at the bottom of this file) and lands here.
   *
   *  ONE routing fork: a call whose TERMINAL step is `fetch(request)` carrying a live Request rides
   *  the DO's FETCH CHANNEL with the expression in the `x-itx-expression` header, not `invoke` — the
   *  fetch channel is the only hop kind that carries a socket-bearing Response back (a 101 from a
   *  tunnel or a WS-serving worker; fetch/rpc-stub-fetch.ts doctrine, points 1 & 4). */
  async invoke(call: ItxExpressionInput, ...args: unknown[]): Promise<unknown> {
    let itxExpression = toItxExpression(call);
    // `invoke("itx.laptop.fetch", request)` is the terminal-fetch call spelled with its live arg —
    // fold it, so the fork below sees the one shape.
    if (args.length === 1 && args[0] instanceof Request && itxExpression.at(-1) === "fetch") {
      itxExpression = [...itxExpression.slice(0, -1), ["fetch", args[0]]];
      args = [];
    }
    const last = itxExpression.at(-1);
    if (
      Array.isArray(last) &&
      last[0] === "fetch" &&
      last.length === 2 &&
      last[1] instanceof Request
    ) {
      const headers = new Headers(last[1].headers);
      headers.set(ITX_EXPRESSION_FETCH_HEADER, JSON.stringify(itxExpression.slice(0, -1))); // the lane parses a JSON ItxExpression
      const request = new Request(last[1], { headers });
      return await this.#withDurableObject((durableObject) => durableObject.fetch(request));
    }
    const append = physicalAppendEvents(itxExpression);
    if (append) assertAppendRequestAdmission(append, this.#durableObjectAddress.path);
    return await this.#withDurableObject((durableObject) =>
      awaitAndReleaseInertRpcResult(
        durableObject.invoke(itxExpression, ...args) as Promise<unknown>,
      ),
    );
  }

  // ── THE ONE FRONT DOOR: make `match` mean `target` — (a) a lent rpc stub or (b) a pure rewrite ──

  /** PROVIDE: from now on a call starting with `match` runs as the same call with `match` replaced by
   *  `target` (context/itx-expression-rewriting.ts — `match` may pin literal args: `itx.ai.run('gpt-5')`).
   *  `target` is EITHER
   *    • a client's rpc stub (a function, an RpcTarget) — THE ONE PHYSICAL ACT: it is lent to the DO's
   *      `itx.rpcStubs` registry through a pager owned HERE (DON'T-PIN) under the key = the canonical
   *      `match`, and the pure-data rule `match ⇒ itx.builtins.rpcStubs.get('<match>')` is appended. The DO
   *      un-sets that rule when the stub's LAST pager closes. Re-providing the same match re-lends
   *      (reconnect — the pager is replaced);
   *    • an itx EXPRESSION — a pure rewrite: literally `append(rewriteRuleConfiguredEvent(match, target))`;
   *    • `null` — un-set the rule at `match` (and recall a stub THIS session lent under it).
   *  Either way the durable thing made is the rule, so the handle is a `RewriteRuleHandle`: disposing
   *  it, or the session ending, un-does the act. */
  async provide(
    match: ItxExpressionInput,
    target: ClientRpcStub | ItxExpressionInput | null,
  ): Promise<RewriteRuleHandle> {
    const matchString = canonicalItxExpressionPrefix(match);
    if (target === null || typeof target === "string" || Array.isArray(target)) {
      // Pure data: `null` is a deliberate DENY (a MASK where a platform row lies beneath — `itx.kv`
      // refuses, `itx.builtins.kv` still answers — a deletion elsewhere); an expression is a rewrite.
      // Appended FIRST, then whatever THIS session lent under the match is recalled: the DO's un-set
      // on the pager close finds a row that no longer names the stub and removes nothing, so it can
      // never take the fresh mask or rule with it.
      const event = rewriteRuleConfiguredEvent(matchString, target);
      this.#refuseAnOverrideNamingItsOwnContext(matchString, event);
      await this.#append(event);
      // A lease replaces any pager only after this row is in place. Its conditional undo runs only
      // while it remains current; a stale handle cannot remove a re-provided expression.
      const expectedTarget = (event.payload as { target: string | null }).target;
      const lease = this.#leases.lease(this.#durableObjectAddress.name, matchString, {
        undo: () => this.#removeRuleInBackground(matchString, expectedTarget),
      });
      return new RewriteRuleHandle(() => lease.dispose());
    }
    // Built BEFORE the lend so a match the codec refuses throws with nothing lent. The rule rides the
    // pager upgrade: the DO appends it in the turn it accepts the pager — ONE round trip, and the DO
    // owns BOTH ends of a lent stub's rule (set on attach, REMOVED on the key's last pager close — a
    // fake `itx.ai` gives the real one back). A refusal (STREAM_PAUSED) is the upgrade's answer: it
    // propagates from here with nothing lent. The target is the PHYSICAL registry, `itx.builtins.…`.
    const ruleEvent = rewriteRuleConfiguredEvent(matchString, [
      "itx",
      "builtins",
      "rpcStubs",
      ["get", matchString],
    ]);
    const pager = await this.#withDurableObject((durableObject) =>
      lendRpcStubOverPager(durableObject, target, matchString, [ruleEvent], this.#waitUntil),
    );
    // Registered with the session so a dying session recalls it even when the handle was never
    // disposed; re-providing the same match replaces the entry (the old pager was "replaced" anyway).
    // The rule is NOT un-set by this session: the DO un-sets whatever names the key when its LAST
    // pager closes (a reconnect replaces the pager, so a late-dying old session cannot clobber the
    // new one's rule).
    const lease = this.#leases.lease(this.#durableObjectAddress.name, matchString, { pager });
    return new RewriteRuleHandle(() => lease.dispose());
  }

  // ── subscriptions: ONE event, over (a) when the target is live ──

  /** SUBSCRIBE: have each committed batch — filtered by `consumes` — delivered to `target` as
   *  `(events, range)`. `target` is EITHER an itx EXPRESSION whose terminal is callable that way (a
   *  facet's `.processEventBatch`, a loaded entrypoint's method, a sibling context's `.append`) OR a
   *  LIVE callback, which is lent to the registry under the key `subscription:<name>` and targeted as
   *  `itx.builtins.rpcStubs.get('subscription:<name>')`; `null` removes the row. HOW it is served is not declared here: the
   *  context looks at what the target evaluates to — a facet or a lent stub owns its progress and gets
   *  a push (the client heals a gap with `readEvents`); anything else gets an at-least-once cursor the
   *  stream keeps. Same name REPLACES. Literally `append(subscriptionConfiguredEvent(…))` — the handle
   *  removes the row (and recalls the lent callback) when disposed or when the session ends. */
  async subscribe(input: {
    name?: string;
    target: ItxExpressionInput | SubscriptionTarget | null;
    consumes?: string[];
  }): Promise<SubscriptionHandle> {
    const name = input.name ?? `sub-${crypto.randomUUID().slice(0, 8)}`;
    const rpcStubKey = `subscription:${name}`;
    const consumes = input.consumes && { consumes: input.consumes };
    const inputTarget = input.target;
    if (inputTarget !== null && typeof inputTarget !== "string" && !Array.isArray(inputTarget)) {
      // A LIVE callback: the row (built first — a name the reduce rejects throws with nothing lent)
      // rides the pager upgrade and the DO appends it as it accepts the pager — one round trip, the
      // DO owning both ends of the row's life (set on attach, un-set on the key's last pager close). A
      // refusal (STREAM_PAUSED) is the upgrade's answer and propagates from here with nothing lent.
      const row = subscriptionConfiguredEvent({
        name,
        target: ["itx", "builtins", "rpcStubs", ["get", rpcStubKey]],
        ...consumes,
      });
      const pager = await this.#withDurableObject((durableObject) =>
        lendRpcStubOverPager(durableObject, inputTarget, rpcStubKey, [row], this.#waitUntil),
      );
      const lease = this.#leases.lease(this.#durableObjectAddress.name, rpcStubKey, { pager });
      // The row is un-set by the DO when the key's last pager closes (see provide): the handle
      // only recalls the lend.
      return new SubscriptionHandle(name, () => lease.dispose());
    }
    const target = inputTarget as ItxExpressionInput | null;
    const [committed] = (await this.#append(
      subscriptionConfiguredEvent({ name, target, ...consumes }),
    )) as StreamEvent[];
    // An expression target has no pager, so its current lease un-sets only the row it wrote. A
    // later same-name subscription owns the name; a stale handle does nothing.
    const lease = this.#leases.lease(
      this.#durableObjectAddress.name,
      rpcStubKey,
      target === null
        ? {}
        : { undo: () => this.#removeSubscriptionInBackground(name, committed.offset) },
    );
    return new SubscriptionHandle(name, () => lease.dispose());
  }

  // ── processors: durable configuration, two lines each over the subscription event ──

  /** Enable a processor: host `className` (the `StreamProcessorDurableObject` subclass exported by
   *  the loaded `source` — the host whose `processor` field holds the pure `StreamProcessor`) as the
   *  facet named `name`, and subscribe its `processEventBatch` to every commit. Literally the
   *  subscription event with the target `itx.builtins.facets.get(name, spec).processEventBatch` — a processor
   *  is a named facet that is pushed the log; `spec` is the `FacetSpec` `itx.facets.get` takes
   *  (`source`, `cacheKey?`, `className`). DURABLE (no handle): a processor outlives the session that
   *  enabled it; `disableProcessor` is the explicit inverse. `consumes` is the SUBSCRIPTION's filter
   *  (what is sent; absent = every durable event). */
  async enableProcessor(
    name: string,
    spec: FacetSpec & { consumes?: string[] },
  ): Promise<{ name: string }> {
    await this.#append(
      subscriptionConfiguredEvent({
        name,
        target: [
          "itx",
          "builtins",
          "facets",
          ["get", name, facetSpecOf(spec)],
          "processEventBatch",
        ],
        ...(spec.consumes && { consumes: spec.consumes }),
      }),
    );
    return { name };
  }

  /** Disable a processor: ONE event — `subscription-configured { name, target: null }`. The DO deletes
   *  the facet the removed row HOSTED (its `itx.facets.get(name, { source, className })` target),
   *  storage included, before the append returns — a re-enable is a clean rebuild from the log, never
   *  a resume from orphaned state. The raw event is the same disablement. */
  async disableProcessor(name: string): Promise<void> {
    await this.#append(subscriptionConfiguredEvent({ name, target: null }));
  }

  /** THE ONE WRITE: every verb above builds an event and appends it here — `itx.append(event)` through
   *  the same door a client's dotted `itx.append(...)` takes. (The cast: workers-types collapses a stub
   *  method's `unknown` result to `never`.) */
  #append(event: StreamEventInput): Promise<unknown> {
    // THE PLATFORM NEVER SPELLS A SHORT NAME: `itx.builtins.append` is the fixed point — a context's
    // own rows (a whole-context override, a mask at `itx.append`) redirect the user's calls, never this.
    return this.#withDurableObject(
      (durableObject) =>
        durableObject.invoke(["itx", "builtins", ["append", event]]) as Promise<unknown>,
    );
  }

  /** A DO stub remains the ordered transport for this context until one of its requests throws.
   * Cloudflare marks a stub broken after many exceptions, including exceptions from the DO itself;
   * discard exactly the captured generation so the next caller recreates it. The original operation
   * is deliberately not retried: the caller retains its exact error and decides idempotency. */
  async #withDurableObject<T>(
    operation: (durableObject: IterateContextDurableObjectStub) => Promise<T>,
  ): Promise<T> {
    const durableObject = (this.#durableObject ??= this.#contextNamespace.getByName(
      this.#durableObjectAddress.name,
    ));
    try {
      return await operation(durableObject);
    } catch (error) {
      // A late old-stub failure must never discard the replacement another request already created.
      if (this.#durableObject === durableObject) this.#durableObject = undefined;
      throw error;
    }
  }

  /** An undo's REMOVAL of a rule: un-set ONLY the row this handle wrote (its target still
   *  `expectedTarget` — a later provide at the same match, a live provider's, another session's, owns
   *  the row now, never a stale undo over it), spelled as the removal (back to the platform row
   *  beneath, if any), never as a mask. Fire-and-forget under waitUntil (a disposer cannot await), a
   *  refusal ignored. */
  #removeRuleInBackground(matchString: string, expectedTarget: string | null): void {
    this.#waitUntil(
      (async () => {
        const row = await this.#withDurableObject(
          (durableObject) =>
            durableObject.invoke([
              "itx",
              "builtins",
              "rewriteRules",
              ["get", matchString],
            ]) as Promise<RewriteRuleListEntry | null>,
        );
        if (row?.origin === "context" && row.target === expectedTarget)
          await this.#append(rewriteRuleRemovedEvent(matchString));
      })().catch(() => undefined),
    );
  }

  /** An undo's REMOVAL of a subscription row: un-set ONLY the row this handle wrote — its
   *  `configuredAtOffset` is the offset of the event the handle's call committed; a later same-name
   *  subscribe replaced it and owns the name now. Fire-and-forget under waitUntil, a refusal ignored. */
  #removeSubscriptionInBackground(name: string, configuredAtOffset: number): void {
    this.#waitUntil(
      (async () => {
        const row = await this.#withDurableObject(
          (durableObject) =>
            durableObject.invoke(["itx", "builtins", "subscriptions", ["get", name]]) as Promise<{
              configuredAtOffset: number;
            } | null>,
        );
        if (row?.configuredAtOffset === configuredAtOffset)
          await this.#append(subscriptionConfiguredEvent({ name, target: null }));
      })().catch(() => undefined),
    );
  }

  /** A whole-context override (a bare `itx` row) whose target is `cd` of THIS context is a loop no
   *  depth budget can see — every hop is a fresh resolve — so it is refused here, where the path is
   *  known. Two contexts overriding each other stays a trusted-client misconfiguration. */
  #refuseAnOverrideNamingItsOwnContext(matchString: string, event: StreamEventInput): void {
    if (matchString !== "itx") return;
    const target = (event.payload as { target: string | null }).target;
    if (target === null) return;
    const steps = toItxExpression(target);
    const cdStep = steps[1] === "builtins" ? steps[2] : steps[1];
    if (!Array.isArray(cdStep) || cdStep[0] !== "cd" || typeof cdStep[1] !== "string") return;
    const ownPath = this.#durableObjectAddress.path;
    if (resolveContextPath(ownPath, cdStep[1]) === ownPath)
      throw new Error(
        `a whole-context override may not name its own context: "itx ⇒ ${target}" at ${JSON.stringify(ownPath)} would route every call back into itself`,
      );
  }
}

/** The ordinary public physical append spellings can be admitted before they cross edge → DO. A
 * rewritten append remains protected by Stream's duplicate preflight after resolution. */
function physicalAppendEvents(expression: ItxExpression): StreamEventInput[] | undefined {
  const last = expression.at(-1);
  if (!Array.isArray(last) || last[0] !== "append") return;
  const prefix = expression.slice(0, -1);
  if (
    !(prefix.length === 1 && prefix[0] === "itx") &&
    !(prefix.length === 2 && prefix[0] === "itx" && prefix[1] === "builtins")
  )
    return;
  return last.slice(1) as StreamEventInput[];
}

// THE NATURAL DOTTED SURFACE. Insert the dynamic fallback into `IterateContext.prototype`'s chain so
// an unknown segment (`itx.slack`, `itx.kv`, `itx.append`) becomes an accumulated `invoke` dispatch,
// while the declared methods above always win. The receiver IS the invoker — the accumulated access
// reduces into ONE `invoke(expression)` call (`[...root, ...prefix, [method, ...args]]`). Runs once at
// module load, after the class body. See context/dotted-path-proxy.ts for the workerd brand-check
// reason this is a prototype hop and not a Proxy AROUND the instance.
installPrototypeInvokeFallback(IterateContext, ["itx"]);
