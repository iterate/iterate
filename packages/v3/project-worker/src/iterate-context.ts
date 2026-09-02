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
//                 expression) plus the one fetch-lane fork; every built-in root (`itx.append(…)`,
//                 `itx.read(…)`, `itx.waitForEvent(…)`, `itx.kv.get(…)`, `itx.rpcStubs.list()`,
//                 `itx.expressionRewriteRules.list()`, …) rides it with ZERO code here;
//   • `provide` — THE ONE PHYSICAL ACT: a client's rpc stub (a function, an RpcTarget) must live in this stateless
//                 worker, never in the DO (DON'T-PIN, below), so the lend happens here. A rule or
//                 subscription naming the lent key is un-set by the DO when the key's last pager
//                 closes — the physical fact decides, not this session's teardown;
//   • `rewrite` / `subscribe` / `enableProcessor` / `disableProcessor` — each is visibly "build the
//                 event, append it": the DO has `append` and no configuration verbs. `subscribe` is
//                 declared here because its target may be a client's rpc stub; `rewrite` for symmetry.
// `provide`, `rewrite` and `subscribe` hand back a DISPOSABLE handle (`using`): disposing un-does the act.
// capnweb also disposes every exported handle when the session ends, so a rule or subscription made
// through the verb is SESSION-SCOPED; one that must outlive the session is the raw event —
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

import { RpcTarget } from "capnweb";
import type { IterateContextDurableObject } from "./iterate-context-durable-object.ts";
import { ITX_EXPRESSION_FETCH_HEADER } from "./fetch/rpc-stub-fetch.ts";
import { toItxExpression, type ItxExpressionInput } from "./context/expression.ts";
import { rewriteRuleConfiguredEvent } from "./context/itx-expression-rewriting.ts";
import type { WorkerSource } from "./context/worker-loader.ts";
import { installPrototypeInvokeFallback } from "./context/dotted-path-proxy.ts";
import type { BuiltInScope } from "./context/built-ins.ts";
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
import type { SessionTeardown } from "./session.ts";
import type { StreamEventInput } from "./stream/events.ts";
import { subscriptionConfiguredEvent } from "./stream/subscriptions.ts";

export type IterateContextNamespace = DurableObjectNamespace<IterateContextDurableObject>;
export type WaitUntil = (p: Promise<unknown>) => void;

/** What `provide` hands back: dispose it — or let the session end; capnweb disposes every exported
 *  handle then — and the stub is recalled (the DO un-sets what named it when its last pager closes). */
export class ProvidedRpcStubHandle extends RpcTarget {
  readonly #undo: () => void;
  constructor(undo: () => void) {
    super();
    this.#undo = undo;
  }
  [Symbol.dispose](): void {
    this.#undo();
  }
}

/** What `rewrite` hands back: dispose it — or let the session end — and the rule at `match` is un-set.
 *  The caller already holds the match it passed, so the handle carries nothing else. */
export class RewriteRuleHandle extends RpcTarget {
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
export class SubscriptionHandle extends RpcTarget {
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

/** WHAT RIDES THE HOP, TYPED: every built-in root (`append`, `read`, `waitForEvent`, `kv`, `rpcStubs`,
 *  `facets`, `load`, …) is a member of this class's TYPE by declaration merging — zero runtime; the
 *  prototype fallback at the bottom of this file is the runtime. So a reader of this file sees the
 *  whole surface, and `env.ITX.get().append(…)` typechecks in loaded code. `cd` is the edge's own
 *  (below) — it returns an EDGE context, not the built-in's handle. */
export interface IterateContext extends Omit<BuiltInScope, "cd"> {}

/** The iterate context (`itx`) at one `{ projectId, path }`, as a client holds it. */
export class IterateContext extends RpcTarget {
  readonly #contextNamespace: IterateContextNamespace;
  readonly #durableObjectAddress: DurableObjectAddress;
  readonly #durableObject: IterateContextDurableObjectStub;
  readonly #sessionTeardown: SessionTeardown;
  readonly #waitUntil: WaitUntil;

  constructor(
    contextNamespace: IterateContextNamespace,
    durableObjectAddress: DurableObjectAddress,
    sessionTeardown: SessionTeardown,
    waitUntil: WaitUntil,
  ) {
    super();
    this.#contextNamespace = contextNamespace;
    this.#durableObjectAddress = durableObjectAddress;
    this.#durableObject = contextNamespace.getByName(durableObjectAddress.name);
    this.#sessionTeardown = sessionTeardown;
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
      this.#sessionTeardown,
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
  invoke(call: ItxExpressionInput): Promise<unknown> {
    const itxExpression = toItxExpression(call);
    const last = itxExpression.at(-1);
    if (
      Array.isArray(last) &&
      last[0] === "fetch" &&
      last.length === 2 &&
      last[1] instanceof Request
    ) {
      const headers = new Headers(last[1].headers);
      headers.set(ITX_EXPRESSION_FETCH_HEADER, JSON.stringify(itxExpression.slice(0, -1))); // the lane parses a JSON ItxExpression
      return this.#durableObject.fetch(new Request(last[1], { headers }));
    }
    return this.#durableObject.invoke(itxExpression);
  }

  // ── (a) rpc stubs: the one physical act ──

  /** PROVIDE a client's rpc stub (a function, an RpcTarget) under an OPAQUE `rpcStubKey`: lend it to
   *  the DO's `itx.rpcStubs` registry through a pager (owned HERE — DON'T-PIN). It is then callable as
   *  `itx.rpcStubs.get('<rpcStubKey>')(…)`. With `options.rewrite`, the rule `rewrite ⇒
   *  itx.rpcStubs.get('<rpcStubKey>')` is configured with it — `itx.<rewrite>.method(x)` reaches the
   *  stub like any other rewrite — and un-set when the stub disappears. Re-providing the same key
   *  re-lends (reconnect — the pager is replaced). Disposing the handle, or the session ending, recalls
   *  the stub. `options` is where an idle policy or a timeout goes later. */
  async provide(
    rpcStubKey: string,
    stub: ClientRpcStub,
    options: { rewrite?: ItxExpressionInput } = {},
  ): Promise<ProvidedRpcStubHandle> {
    const pager = await lendRpcStubOverPager(
      this.#durableObject,
      stub,
      rpcStubKey,
      this.#waitUntil,
    );
    const sessionTeardownKey = this.#sessionTeardownKey(rpcStubKey);
    // Registered with the session so a dying session recalls it even when the handle was never
    // disposed; re-providing the same key replaces the entry (the old pager was "replaced" anyway).
    // The rule is NOT un-set here: the DO un-sets whatever names the key when its LAST pager closes
    // (a reconnect replaces the pager, so a late-dying old session cannot clobber the new one's rule).
    this.#sessionTeardown.add(sessionTeardownKey, pager);
    if (options.rewrite !== undefined)
      try {
        await this.#append(
          rewriteRuleConfiguredEvent(options.rewrite, ["itx", "rpcStubs", ["get", rpcStubKey]]),
        );
      } catch (e) {
        // The DO refused the rule (STREAM_PAUSED / a validation throw): recall the lend, or a stub
        // nothing names would linger for the session. Let the refusal propagate.
        this.#sessionTeardown.dispose(sessionTeardownKey);
        throw e;
      }
    return new ProvidedRpcStubHandle(() => this.#sessionTeardown.dispose(sessionTeardownKey));
  }

  // ── (b) itx-expression rewrite rules: pure data, ONE event ──

  /** REWRITE: a call starting with `match` runs as the same call with `match` replaced by `target`
   *  (context/itx-expression-rewriting.ts — `match` may pin literal args: `itx.ai.run('gpt-5')`).
   *  `null` un-sets the rule at `match`. Literally `append(rewriteRuleConfiguredEvent(match,
   *  target))` — the returned handle un-sets the rule when disposed or when the session ends. */
  async rewrite(
    match: ItxExpressionInput,
    target: ItxExpressionInput | null,
  ): Promise<RewriteRuleHandle> {
    const event = rewriteRuleConfiguredEvent(match, target);
    await this.#append(event);
    const matchString = (event.payload as { match: string }).match;
    return new RewriteRuleHandle(() => {
      if (target !== null) this.#appendInBackground(rewriteRuleConfiguredEvent(matchString, null));
    });
  }

  // ── subscriptions: ONE event, over (a) when the target is live ──

  /** SUBSCRIBE: have each committed batch — filtered by `consumes` — delivered to `target` as
   *  `(events, range)`. `target` is EITHER an itx EXPRESSION whose terminal is callable that way (a
   *  facet's `.processEventBatch`, a loaded entrypoint's method, a sibling context's `.append`) OR a
   *  LIVE callback, which is lent to `itx.rpcStubs` under the key `subscription:<name>` and targeted as
   *  `itx.rpcStubs.get('…')`; `null` removes the row. HOW it is served is not declared here: the
   *  context looks at what the target evaluates to — a facet or a lent stub owns its progress and gets
   *  a push (the client heals a gap with `read`); anything else gets an at-least-once cursor the
   *  stream keeps. Same name REPLACES. Literally `append(subscriptionConfiguredEvent(…))` — the handle
   *  removes the row (and recalls the lent callback) when disposed or when the session ends. */
  async subscribe(input: {
    name?: string;
    target: ItxExpressionInput | ClientRpcStub | null;
    consumes?: string[];
  }): Promise<SubscriptionHandle> {
    const name = input.name ?? `sub-${crypto.randomUUID().slice(0, 8)}`;
    const rpcStubKey = `subscription:${name}`;
    const sessionTeardownKey = this.#sessionTeardownKey(rpcStubKey);
    let target = input.target as ItxExpressionInput | null;
    if (target !== null && typeof target !== "string" && !Array.isArray(target)) {
      const pager = await lendRpcStubOverPager(
        this.#durableObject,
        input.target as ClientRpcStub,
        rpcStubKey,
        this.#waitUntil,
      );
      this.#sessionTeardown.add(sessionTeardownKey, pager);
      target = ["itx", "rpcStubs", ["get", rpcStubKey]];
    }
    await this.#append(
      subscriptionConfiguredEvent({
        name,
        target,
        ...(input.consumes && { consumes: input.consumes }),
      }),
    );
    if (target === null) this.#sessionTeardown.dispose(sessionTeardownKey);
    const targetIsLentRpcStub = Array.isArray(target) && target[1] === "rpcStubs";
    return new SubscriptionHandle(name, () => {
      // A lent callback's row is un-set by the DO when its last pager closes (see provide); an
      // expression target has no pager, so the handle un-sets the row itself.
      if (targetIsLentRpcStub) this.#sessionTeardown.dispose(sessionTeardownKey);
      else if (target !== null)
        this.#appendInBackground(subscriptionConfiguredEvent({ name, target: null }));
    });
  }

  // ── processors: durable configuration, two lines each over the subscription event ──

  /** Enable a processor: host `className` (the `StreamProcessorDurableObject` subclass exported by
   *  the loaded `source` — the host whose `processor` field holds the pure `StreamProcessor`) as the
   *  facet named `name`, and subscribe its `processEventBatch` to every commit. Literally the
   *  subscription event with the target `itx.load(source).getDurableObjectClass(className).get(name)
   *  .processEventBatch` — a processor is a named facet that is pushed the log. DURABLE (no handle):
   *  a processor outlives the session that enabled it; `disableProcessor` is the explicit inverse.
   *  `consumes` is the SUBSCRIPTION's filter (what is sent; absent = every durable event). */
  async enableProcessor(
    name: string,
    ref: { source: WorkerSource; className: string; consumes?: string[] },
  ): Promise<{ name: string }> {
    await this.#append(
      subscriptionConfiguredEvent({
        name,
        target: [
          "itx",
          ["load", ref.source],
          ["getDurableObjectClass", ref.className],
          ["get", name],
          "processEventBatch",
        ],
        ...(ref.consumes && { consumes: ref.consumes }),
      }),
    );
    return { name };
  }

  /** Disable a processor: ONE event — `subscription-configured { name, target: null }`. The DO deletes
   *  the facet the removed row HOSTED (its `itx.load(…).getDurableObjectClass(…).get(…)` target),
   *  storage included, before the append returns — a re-enable is a clean rebuild from the log, never
   *  a resume from orphaned state. The raw event is the same disablement. */
  async disableProcessor(name: string): Promise<void> {
    await this.#append(subscriptionConfiguredEvent({ name, target: null }));
  }

  /** THE ONE WRITE: every verb above builds an event and appends it here — `itx.append(event)` through
   *  the same door a client's dotted `itx.append(...)` takes. (The cast: workers-types collapses a stub
   *  method's `unknown` result to `never`.) */
  #append(event: StreamEventInput): Promise<unknown> {
    return this.#durableObject.invoke(["itx", ["append", event]]) as Promise<unknown>;
  }

  /** An undo's append: fire-and-forget under waitUntil (a disposer cannot await), a refusal ignored
   *  (a paused stream keeps the row; the next explicit call will say so). */
  #appendInBackground(event: StreamEventInput): void {
    this.#waitUntil(this.#append(event).catch(() => undefined));
  }

  /** The SessionTeardown key for a lent stub: `"<iterateContextName> <rpcStubKey>"`. The teardown is
   *  SESSION-lived and shared by every IterateContext the session hands out (across projects), while
   *  a stub key is only unique PER CONTEXT. A space separator is unambiguous: a context name has no
   *  spaces. */
  #sessionTeardownKey(rpcStubKey: string): string {
    return `${this.#durableObjectAddress.name} ${rpcStubKey}`;
  }
}

// THE NATURAL DOTTED SURFACE. Insert the dynamic fallback into `IterateContext.prototype`'s chain so
// an unknown segment (`itx.slack`, `itx.kv`, `itx.append`) becomes an accumulated `invoke` dispatch,
// while the declared methods above always win. The receiver IS the invoker — the accumulated access
// reduces into ONE `invoke(expression)` call (`[...root, ...prefix, [method, ...args]]`). Runs once at
// module load, after the class body. See context/dotted-path-proxy.ts for the workerd brand-check
// reason this is a prototype hop and not a Proxy AROUND the instance.
installPrototypeInvokeFallback(IterateContext, ["itx"]);
