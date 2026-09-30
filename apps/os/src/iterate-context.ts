// iterate-context.ts — the client-facing capnweb surface: A PROXY IN FRONT OF THE DURABLE OBJECT. This
// is the ONE place capnweb terminates (the `/api` worker); it reaches the IterateContextDurableObject
// only over Workers RPC (the hard rule).
//
// INVARIANT (owner): THE CLIENT IS JUST CAPNWEB. Every class in this file is a SERVER-side RpcTarget;
// what a client holds is a plain capnweb proxy of it. There is no client SDK and none may be introduced
// — a client's whole dependency is the capnweb package. Anything that would need client-side smarts
// belongs HERE, behind an RpcTarget method.
//
// The DO owns every contract. This class declares only what the edge must do itself: `cd` (pure
// addressing), `invoke` (where the prototype hop at the bottom lands, plus the one terminal-fetch
// fork), `provide` and `subscribe` (declared here because their target may be a client's rpc stub,
// which must live in this stateless worker and never in the DO — the DON'T-PIN rule,
// context/rpc-stubs.ts) and the two processor verbs. Each verb builds ONE event and appends it;
// every built-in root rides the hop with ZERO code here. `provide` and `subscribe` hand back a
// DISPOSABLE handle, so what they make is SESSION-SCOPED (capnweb disposes every exported handle at
// session end); the raw event — `itx.append({ type: "…/rewrite-rule-configured", payload: { match, target } })` — is the verb
// minus the handle and outlives the session. A client reaches a root context through session.ts and
// the rest with `cd(path)`.
//   ItxEntrypoint        — a loaded worker's WHOLE WORLD: `env.ITX.get()` and `globalOutbound`, resolved here and sent straight to the context each call lives in

import { RpcPromise as CapnwebRpcPromise, RpcStub as CapnwebRpcStub, RpcTarget } from "capnweb";
import { z } from "zod";
import { codedError, ITERATE_CAUSE_HEADER, loopLimitOf, resolveContextPath } from "iterate/lib";
import * as cloudflareWorkers from "cloudflare:workers";
import {
  InvokeHandle,
  canonicalItxExpressionPrefix,
  normalizedItxExpression,
  type ItxExpression,
  type ItxExpressionInput,
  installPrototypeInvokeFallback,
} from "iterate/expression";
import type { FetchRouteInput, IterateContextApi } from "iterate/api";
import type { StreamEvent, StreamEventInput } from "iterate/stream/processor";
import { newChain, parseCause, type Cause } from "./cause.ts";
import {
  itxAnswerDetachedFromSession,
  materializeItxHandleReference,
  registerPipelinedRpcBrand,
  registerRpcSessionBrand,
} from "./context/dispatch.ts";
import type { Caller } from "./caller.ts";
import type { IterateContextDurableObject, Env } from "./iterate-context-durable-object.ts";
import {
  ITX_EXPRESSION_FETCH_HEADER,
  encodeFetchExpression,
  parseFetchExpression,
  itxExpressionEndingInFetch,
  stampCallerHeaders,
  terminalFetchOf,
} from "./context/rpc-stubs.ts";
import {
  lendRpcStubOverPager,
  type ClientRpcStub,
  type IterateContextDurableObjectStub,
} from "./context/rpc-stub-relay.ts";
import {
  normalizeRewriteRuleConfigured,
  type ItxExpressionResolver,
} from "./context/itx-expression-rewriting.ts";
import { FetchRouteConfiguredPayload } from "./fetch-routes.ts";
import type { BuiltInScope } from "./context/built-ins.ts";
import { statelessResolverFor } from "./context/stateless-context.ts";
import {
  DurableObjectNameCodec,
  GLOBAL_PROJECT_ID,
  type DurableObjectAddress,
} from "./context/paths.ts";
import { SessionTeardown } from "./session.ts";
import { contextStub } from "./context-stub.ts";
import { expressionFetchErrorAnswer } from "./unavailable.ts";

export type IterateContextNamespace = DurableObjectNamespace<IterateContextDurableObject>;
export type WaitUntil = (p: Promise<unknown>) => void;

/** What `provide` hands back: dispose it — or let the session end — and the act is un-done (a lent
 *  stub recalled, a rule or deny removed while the row is still its own). The caller already holds
 *  the match it passed. A lent stub's handle also answers `lendEnded()`: the lend can end while the
 *  session lives (its pager could not be re-dialed, or the DO closed it), and a lender that must
 *  stay reachable — `iterate tunnel` — lends again when it does. */
class RewriteRuleHandleRpcTarget extends RpcTarget {
  readonly #undo: () => void;
  readonly #lendEnded: Promise<string> | null;
  constructor(undo: () => void, lendEnded: Promise<string> | null = null) {
    super();
    this.#undo = undo;
    this.#lendEnded = lendEnded;
  }
  /** Resolves with why the lend ended, whatever ended it (this handle's dispose included). */
  lendEnded(): Promise<string> {
    if (!this.#lendEnded)
      throw codedError("INVALID_INPUT", "provide lent no stub here: a rule has no lend to end");
    return this.#lendEnded;
  }
  [Symbol.dispose](): void {
    this.#undo();
  }
}

/** What `subscribe` hands back: dispose it — or let the session end — and the subscription is removed
 *  (a lent callback is recalled with it). `name` is a GETTER (capnweb exposes prototype members only)
 *  — the generated one when none was given. */
class SubscriptionHandleRpcTarget extends RpcTarget {
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
 *  whole surface, and `itx.append(…)` on a `getItx()` scope typechecks in loaded code. `cd` is
 *  the edge's own (below) — it returns an EDGE context, not the built-in's handle — and `facets` is
 *  the published one, whose `get<Facet>` lets a caller type the facet it names (the record's own
 *  `get` answers the physical host's brand, which a caller never sees). */
export interface IterateContextRpcTarget extends Omit<BuiltInScope, "cd" | "facets"> {
  facets: IterateContextApi["facets"];
}

/** The iterate context (`itx`) at one `{ projectId, path }`, as a client holds it. */
export class IterateContextRpcTarget extends RpcTarget {
  readonly #contextNamespace: IterateContextNamespace;
  readonly #durableObjectAddress: DurableObjectAddress;
  readonly #sessionTeardown: SessionTeardown;
  readonly #waitUntil: WaitUntil;
  /** WHO holds this context: the session's verified principal, the grant it acts through and the
   *  platform origin it reached the platform on (session.ts) — or nobody (the anonymous session, a
   *  loaded worker's `env.ITX`). Every dispatch runs under it, so every event it appends carries
   *  `source.principal` and `source.grant`, and the DO can compose a public URL (`itx.url`, a signed
   *  file URL) without knowing the deployment's origin itself. */
  readonly #caller: Caller;
  /** A platform admin's handle on the global namespace (session.ts `global`): its `cd` walks it,
   *  as a project's walks the project. */
  readonly #globalPaths: boolean;
  /** THE STATELESS REACH (`ItxEntrypoint`'s, context/stateless-context.ts): a resolver of the
   *  context at an address for a caller. Absent for a session's handle, whose calls go to the
   *  context it names. */
  readonly #statelessResolverOf:
    | ((address: DurableObjectAddress, caller: Caller) => ItxExpressionResolver)
    | undefined;

  constructor(
    contextNamespace: IterateContextNamespace,
    durableObjectAddress: DurableObjectAddress,
    sessionTeardown: SessionTeardown,
    waitUntil: WaitUntil,
    caller: Caller,
    globalPaths = false,
    statelessResolverOf?: (address: DurableObjectAddress, caller: Caller) => ItxExpressionResolver,
  ) {
    super();
    this.#globalPaths = globalPaths;
    this.#contextNamespace = contextNamespace;
    this.#durableObjectAddress = durableObjectAddress;
    this.#sessionTeardown = sessionTeardown;
    this.#waitUntil = waitUntil;
    this.#caller = caller;
    this.#statelessResolverOf = statelessResolverOf;
  }

  /** The context DO's stub, minted PER CALL (a stub is a cheap handle onto one shared connection):
   *  "many exceptions leave the DurableObjectStub in a broken state, such that all attempts to send
   *  additional requests will just fail immediately with the original exception … create a new one"
   *  (Cloudflare's error-handling guide) — so no call after a reset replays the reset. */
  get #durableObject(): IterateContextDurableObjectStub {
    return this.#contextNamespace.getByName(this.#durableObjectAddress.name);
  }

  /** Dispatch on the DO under this context's caller — the one place the edge dispatches. A handle the
   *  DO names by expression (context/dispatch.ts) becomes a handle of THIS edge object: every dotted call on
   *  it is one whole expression back through `invoke`, so what the client holds is an object of this
   *  stateless worker, and no session onto the actor outlives a call.
   *
   *  The call rides `contextStub` (context-stub.ts), which owns its retry and failure policy. */
  async #invokeOnDurableObject(
    itxExpression: ItxExpression,
    args: unknown[] = [],
  ): Promise<unknown> {
    const result = await contextStub(
      this.#contextNamespace,
      this.#durableObjectAddress,
      "itx",
    ).invoke(itxExpression, args, this.#caller);
    return materializeItxHandleReference(result, (expression) => this.invoke(expression));
  }

  /** Another context of THIS project. Absolute by convention (`cd("/agents/support")`); relative
   *  (`"agents/support"`, `"../inbox"`) resolves against this context's path — one resolver, shared
   *  with the built-in `itx.cd(...)` root. Returns an EDGE context, so `provide` on it lends in this
   *  same session. Pure addressing — and, the projectId being kept, a project's `cd` can never spell
   *  the global namespace. THE GLOBAL NAMESPACE IS NOT NAVIGABLE: a global context is reached by
   *  IDENTITY only (`session.user`, `session.organizations.get`), so its `cd` is refused — and the
   *  DO's built-in `cd` refuses it too. This is the whole path mask: with no way to name another
   *  user's path, there is no policy to get wrong. The one exception is the operator's handle
   *  (`#globalPaths`), which walks `/`, `/users/<id>…`, `/organizations/<id>…` and the deployment's
   *  own secrets, `/secrets/<name>`. */
  cd(path: string): IterateContextRpcTarget {
    if (this.#durableObjectAddress.projectId === GLOBAL_PROJECT_ID) {
      if (!this.#globalPaths)
        throw codedError(
          "FORBIDDEN",
          "a global context is reached by identity (session.user, session.organizations), never by path",
        );
      const resolved = resolveContextPath(this.#durableObjectAddress.path, path);
      if (!/^\/(?:(?:users|organizations|secrets)(?:\/.*)?)?$/.test(resolved))
        throw codedError(
          "INVALID_INPUT",
          `cd(${JSON.stringify(path)}): a global context is /, /users…, /organizations… or /secrets…`,
        );
    }
    // LOADED CODE's `cd` is an expression through THIS context's table (`itx.cd ⇒ null` is a wall,
    // and the resolver's app wall says where it may go) — the dotted surface of the handle it gets
    // back accumulates onto one `invoke`, which the stateless resolver sends straight to the context
    // the call lives in.
    if (this.#caller.app)
      return new InvokeHandle(
        (steps) =>
          // The proxy hands relative steps; a caller's own `.invoke("itx.whoami()")` is a whole call.
          this.invoke([
            "itx",
            ["cd", path],
            ...(typeof steps === "string" || steps[0] === "itx"
              ? normalizedItxExpression(steps as ItxExpressionInput).slice(1)
              : steps),
          ]),
        // The handle's dotted surface reduces onto that one `invoke` (the prototype fallback), so
        // it answers every member the edge context declares; InvokeHandle's own type has none.
      ) as unknown as IterateContextRpcTarget;
    const durableObjectAddress = DurableObjectNameCodec.address({
      projectId: this.#durableObjectAddress.projectId,
      path: resolveContextPath(this.#durableObjectAddress.path, path),
    });
    return new IterateContextRpcTarget(
      this.#contextNamespace,
      durableObjectAddress,
      this.#sessionTeardown,
      this.#waitUntil,
      this.#caller,
      this.#globalPaths,
      this.#statelessResolverOf,
    );
  }

  /** THE dispatch (built-ins + every rewrite rule) — the ONE way to call the itx surface. Takes an
   *  `ItxExpressionInput`: a dotted string (`"itx.append({...})"`) OR the parsed array
   *  (`["itx",["append",{...}]]`); both carry mid-path call args. The dotted sugar `itx.a.b(x)` reduces
   *  into `["itx","a",["b",x]]` (the prototype fallback at the bottom of this file) and lands here.
   *
   *  ONE routing fork: a call whose TERMINAL step is `fetch(request)` carrying a live Request rides
   *  the DO's FETCH CHANNEL with the expression in the `x-itx-expression` header, not `invoke` — the
   *  fetch channel is the only hop kind that carries a socket-bearing Response back (a 101 from a
   *  tunnel or a WS-serving worker; context/rpc-stubs.ts doctrine, points 1 & 4).
   *
   *  THE STATELESS REACH (`ItxEntrypoint`'s): one call through its resolver
   *  (context/stateless-context.ts), whose own dispatch picks the fetch channel for a terminal
   *  fetch. */
  async invoke(call: ItxExpressionInput, ...args: unknown[]): Promise<unknown> {
    const answer = await this.#dispatch(call, args);
    if (!(answer instanceof Response)) return answer;
    // a fetch refused past the loop limit answers 508, marked (cause.ts): `itx.fetch` throws it
    const refused = await loopLimitOf(answer);
    if (refused) throw refused;
    if (!answer.body) return answer;
    // A PLATFORM WORKAROUND: a Durable Object's body that workerd pumps natively into a Workers-RPC
    // answer can reach the caller with its chunks out of order, while a body this isolate fetched
    // itself arrives whole (prd, measured 2026-09-29). Through a JS stream, workerd reads it chunk
    // by chunk, in order. Pinned by iterate-context.test.ts; drop it once workerd keeps the order.
    return new Response(answer.body.pipeThrough(new TransformStream()), answer);
  }

  async #dispatch(call: ItxExpressionInput, args: unknown[]): Promise<unknown> {
    const resolver = this.#statelessResolverOf?.(this.#durableObjectAddress, this.#caller);
    const itxExpression = normalizedItxExpression(call);
    const terminalFetch = terminalFetchOf(itxExpression, args);
    if (resolver && terminalFetch)
      return statelessExpressionFetch(
        resolver,
        () => terminalFetch.steps,
        terminalFetch.request,
        encodeFetchExpression(terminalFetch.steps),
      );
    if (resolver) {
      const result = await resolver.invoke(itxExpression, ...args);
      // As a context's own `invoke` answers (context/dispatch.ts): a live answer becomes the
      // expression that names it — a handle of THIS edge object, one whole call per verb — and
      // data a hop below answered with is copied and released.
      return materializeItxHandleReference(
        itxAnswerDetachedFromSession(result, itxExpression, args),
        (expression) => this.invoke(expression),
      );
    }
    if (terminalFetch) {
      const headers = new Headers(terminalFetch.request.headers);
      stampCallerHeaders(headers, this.#caller); // the stamp is this session's, never the Request's own
      headers.set(ITX_EXPRESSION_FETCH_HEADER, encodeFetchExpression(terminalFetch.steps));
      return this.#durableObject.fetch(new Request(terminalFetch.request, { headers }));
    }
    return this.#invokeOnDurableObject(itxExpression, args);
  }

  // ── PROVIDE, THE ONE WAY IN: make `match` mean `target` — (a) a lent rpc stub or (b) a pure rewrite ──

  /** PROVIDE: from now on a call starting with `match` runs as the same call with `match` replaced by
   *  `target` (context/itx-expression-rewriting.ts — `match` may pin literal args: `itx.ai.run('gpt-5')`).
   *  `target` is EITHER
   *    • a client's rpc stub (a function, an RpcTarget) — THE ONE PHYSICAL ACT: it is lent to the DO's
   *      `itx.rpcStubs` registry through a pager owned HERE (DON'T-PIN) under the key = the canonical
   *      `match`, and the pure-data rule `match ⇒ itx.builtins.rpcStubs.get('<match>')` is appended. The DO
   *      un-sets that rule when the stub's LAST pager closes. Re-providing the same match re-lends
   *      (reconnect — the pager is replaced);
   *    • an itx EXPRESSION — a pure rewrite: literally `append({ type: "…/rewrite-rule-configured", payload: { match, target } })`;
   *    • `null` — deny `match`: kept as a MASK where an implicit row lies beneath it (a bare `itx`
   *      denies all), a deletion otherwise (and a stub THIS session lent under it is recalled).
   *  `description` is the one line a model reads for the name; it rides the rule's row.
   *  `fetchRoute` (a lent stub on the project's root only) is a fetch route to the stub — `iterate
   *  tunnel`'s — that rides the pager beside the rule: set on every attach, so a re-dial after a
   *  context reset sets it again, and gone with the stub's last pager like the rule.
   *  Either way the durable thing made is the rule, so the handle is a `RewriteRuleHandleRpcTarget`: disposing
   *  it, or the session ending, un-does the act. */
  async provide(
    match: ItxExpressionInput,
    target: ClientRpcStub | ItxExpressionInput | null,
    options: {
      description?: string;
      fetchRoute?: Omit<FetchRouteInput, "target"> & { fetchRouteName: string };
    } = {},
  ): Promise<RewriteRuleHandleRpcTarget> {
    // LOADED CODE may lend its OWN object (a live stub answers with the code's own authority and
    // dies with its invocation); a pure rewrite or a deny is a ROW, and a row from loaded code is
    // `itx.append`'s business — through its context's table, where a jail's wall stands.
    if (this.#caller.app && (!target || typeof target === "string" || Array.isArray(target)))
      throw codedError(
        "FORBIDDEN",
        "loaded code writes a row with itx.append({ type: 'events.iterate.com/itx/rewrite-rule-configured', payload: { match, target, description } }); provide lends a live stub only",
      );
    const description = options.description ? { description: options.description } : {};
    const matchString = canonicalItxExpressionPrefix(match);
    const sessionTeardownKey = this.#sessionTeardownKey(matchString);
    const isRow = !target || typeof target === "string" || Array.isArray(target);
    if (
      options.fetchRoute &&
      (isRow || this.#caller.app || this.#durableObjectAddress.path !== "/")
    )
      throw codedError(
        "INVALID_INPUT",
        "provide's fetchRoute rides a lent stub on the project's root \"/\"; set any other route with itx.fetchRoutes.set",
      );
    if (isRow) {
      // Appended FIRST, then whatever THIS session lent under the match is recalled: the DO's un-set
      // on the pager close finds a row that no longer names the stub and removes nothing, so it can
      // never take the fresh mask or rule with it.
      // Validate + normalize here so the handle knows the STORED target (its undo's compare-and-set);
      // the appended event is literal and the DO's boundary re-normalizes it idempotently.
      const { target: expectedTarget } = normalizeRewriteRuleConfigured({
        match: matchString,
        target,
        ...description,
      });
      const event: StreamEventInput = {
        type: "events.iterate.com/itx/rewrite-rule-configured",
        payload: { match: matchString, target: expectedTarget, ...description },
      };
      await this.#append(event);
      this.#sessionTeardown.dispose(sessionTeardownKey);
      return new RewriteRuleHandleRpcTarget(() =>
        this.#removeRuleInBackground(matchString, expectedTarget),
      );
    }
    // Built BEFORE the lend so a match the codec refuses throws with nothing lent; the rule rides the
    // pager upgrade and the DO appends it as it accepts the pager (context/rpc-stubs.ts).
    const ruleEvent: StreamEventInput = {
      type: "events.iterate.com/itx/rewrite-rule-configured",
      payload: {
        match: matchString,
        target: ["itx", "builtins", "rpcStubs", ["get", matchString]],
        ...description,
      },
    };
    const fetchRouteEvents = options.fetchRoute
      ? [fetchRouteEventTo(normalizedItxExpression(matchString), options.fetchRoute)]
      : [];
    // LOADED CODE's row goes through its own table FIRST (a jail's mask refuses it, and nothing is
    // lent); the platform's rides the pager and the DO appends it as it accepts the pager.
    if (this.#caller.app) await this.#append(ruleEvent);
    const pager = await lendRpcStubOverPager(
      () => this.#durableObject,
      target,
      matchString,
      this.#caller.app ? [] : [ruleEvent, ...fetchRouteEvents],
      this.#waitUntil,
    );
    // Registered with the session so a dying session recalls it even when the handle was never
    // disposed (`SessionTeardown`: a re-provide replaces the entry). The rule is NOT un-set by this
    // session — the DO un-sets what names the key when its LAST pager closes.
    const lease = this.#sessionTeardown.add(sessionTeardownKey, pager);
    return new RewriteRuleHandleRpcTarget(() => lease.dispose(), pager.lendEnded); // the lease IS the handle: a stale one is inert
  }

  // ── subscriptions: ONE event, over (a) when the target is live ──

  /** SUBSCRIBE: have each committed batch — filtered by `consumes` — delivered to `target` as
   *  `(events, range)`. `target` is EITHER an itx EXPRESSION whose terminal is callable that way (a
   *  facet's `.processEventBatch`, a loaded entrypoint's method, a sibling context's `.append`) OR a
   *  LIVE callback, which is lent to the registry under the key `subscription:<name>` and targeted as
   *  `itx.builtins.rpcStubs.get('subscription:<name>')`; `null` removes the row. HOW it is served is not declared here: the
   *  context looks at what the target evaluates to — a facet or a lent stub owns its progress and gets
   *  a push (the client heals a gap with `readEvents`); anything else gets an at-least-once cursor the
   *  stream keeps. Same name REPLACES. Literally `append({ type: "…/subscription-configured", payload: … })` — the handle
   *  removes the row (and recalls the lent callback) when disposed or when the session ends. */
  async subscribe(input: {
    name?: string;
    // A pure itx EXPRESSION, a lent RPC stub, or a LIVE callback `(events, range) => void` (lent to
    // the registry as `subscription:<name>` — the client form live state uses); null removes the row.
    target:
      | ItxExpressionInput
      | ClientRpcStub
      | ((events: unknown[], range: unknown) => void)
      | null;
    consumes?: string[];
    /** Where the cursor starts (0 = the whole log); absent = from now. A push target ignores it. */
    afterOffset?: number;
    /** `false`: fan-out delivery (stream/subscription-delivery.ts). A push target ignores it. */
    ordered?: false;
  }): Promise<SubscriptionHandleRpcTarget> {
    // LOADED CODE may lend a live callback (its own, fed its own context's events); an expression
    // target is a ROW the delivery loop runs as the kernel — that is `itx.append`'s business, through
    // the code's own table — and a removal likewise.
    if (
      this.#caller.app &&
      (!input.target || typeof input.target === "string" || Array.isArray(input.target))
    )
      throw codedError(
        "FORBIDDEN",
        "loaded code writes a subscription row with itx.append({ type: 'events.iterate.com/itx/subscription-configured', payload: { name, target, consumes } }); subscribe lends a live callback only",
      );
    // oxlint-disable-next-line iterate/simple-truthiness-check -- only an ABSENT name gets a minted one; an empty-string name is a caller bug that must reach the reduce and be refused there (parseSubscriptionName), never silently become a fresh row per call
    const name = input.name ?? `sub-${crypto.randomUUID().slice(0, 8)}`;
    const rpcStubKey = `subscription:${name}`;
    const sessionTeardownKey = this.#sessionTeardownKey(rpcStubKey);
    const delivery = {
      consumes: input.consumes,
      afterOffset: input.afterOffset,
      ordered: input.ordered,
    };
    if (input.target && typeof input.target !== "string" && !Array.isArray(input.target)) {
      // A LIVE callback: the row rides the pager upgrade exactly as `provide`'s rule does (built
      // first, so a name the reduce rejects throws with nothing lent).
      const row: StreamEventInput = {
        type: "events.iterate.com/itx/subscription-configured",
        payload: {
          name,
          target: ["itx", "builtins", "rpcStubs", ["get", rpcStubKey]],
          ...delivery,
        },
      };
      if (this.#caller.app) await this.#append(row); // loaded code's row: its table first, as in `provide`
      const pager = await lendRpcStubOverPager(
        () => this.#durableObject,
        input.target as ClientRpcStub, // neither a string nor an array, so a live object or a plain callback
        rpcStubKey,
        this.#caller.app ? [] : [row],
        this.#waitUntil,
      );
      const lease = this.#sessionTeardown.add(sessionTeardownKey, pager);
      // The handle only recalls its own lend (the lease is the handle; a stale one is inert); the DO
      // un-sets the row on the key's last pager close.
      return new SubscriptionHandleRpcTarget(name, () => lease.dispose());
    }
    // An expression (or a removal): appended FIRST, then this session's lend under the name is
    // recalled — the same order as `provide`, for the same reason.
    const target = input.target as ItxExpressionInput | null; // the live-object branch returned above, so this is an expression or null
    const [committed] = (await this.#append({
      type: "events.iterate.com/itx/subscription-configured",
      payload: { name, target, ...delivery },
    })) as StreamEvent[]; // `append` answers the committed events; `invoke` is untyped over RPC
    this.#sessionTeardown.dispose(sessionTeardownKey);
    return new SubscriptionHandleRpcTarget(name, () => {
      // no pager to recall: the handle un-sets the row itself — only the one this call wrote
      if (target) this.#removeSubscriptionInBackground(name, committed.offset);
    });
  }

  // ── processors: durable configuration, two lines each over the subscription event ──

  /** THE ONE WRITE: every verb above builds an event and appends it here. The platform's is spelled
   *  `itx.builtins.append`, so a context's own rows redirect the user's calls, never this. LOADED
   *  CODE's goes through ITS table under the context root `append` — implicit everywhere, so a child
   *  writes; a jail's bare null (or a mask at `itx.append`) refuses a live lend's row, a live
   *  subscription's and an undo exactly as it refuses `itx.append` — and the built-in walls the row's
   *  target (context/built-ins.ts `append`). */
  #append(event: StreamEventInput): Promise<unknown> {
    return this.#invokeOnDurableObject(
      this.#caller.app ? ["itx", ["append", event]] : ["itx", "builtins", ["append", event]],
    );
  }

  /** An undo's REMOVAL of a rule: un-set ONLY the row this handle wrote — `null` WITH the target it
   *  wrote (`ifTarget`), which the core reduce applies as a compare-and-set DELETE only while the
   *  row's target is still that (a later provide at the same match owns the row now); never a mask,
   *  never a "restore" (at a child that spelling would be a grant: stream/core-processor.ts
   *  `CoreState.itxExpressionRewriteRules`). Fire-and-forget under
   *  waitUntil (a disposer cannot await), a refusal ignored. */
  #removeRuleInBackground(matchString: string, expectedTarget: ItxExpression | null): void {
    this.#waitUntil(
      this.#append({
        type: "events.iterate.com/itx/rewrite-rule-configured",
        payload: { match: matchString, target: null, ifTarget: expectedTarget },
      }).catch(() => undefined),
    );
  }

  /** An undo's REMOVAL of a subscription row: un-set ONLY the row this handle wrote — its identity is
   *  the offset of the event the handle's call committed (`ifConfiguredAtOffset`); a later same-name
   *  subscribe owns the name and the reduce ignores the stale removal. Fire-and-forget, as above. */
  #removeSubscriptionInBackground(name: string, configuredAtOffset: number): void {
    this.#waitUntil(
      this.#append({
        type: "events.iterate.com/itx/subscription-configured",
        payload: { name, target: null, ifConfiguredAtOffset: configuredAtOffset },
      }).catch(() => undefined),
    );
  }

  /** The SessionTeardown key for a lent stub. The teardown is SESSION-lived and shared by every
   *  IterateContextRpcTarget the session hands out, while a stub key is only unique PER CONTEXT — so the key is
   *  the JSON pair, unambiguous whatever either half holds (a match may pin a string arg). */
  #sessionTeardownKey(rpcStubKey: string): string {
    return JSON.stringify([this.#durableObjectAddress.name, rpcStubKey]);
  }
}

// THE NATURAL DOTTED SURFACE: an unknown segment (`itx.slack`, `itx.kv`, `itx.append`) reduces into
// ONE `invoke(expression)` dispatch through the prototype hop (context/expression.ts says why a hop
// and not a Proxy AROUND the instance), the declared methods above always winning.
installPrototypeInvokeFallback(IterateContextRpcTarget, ["itx"]);

// The native workerd brands the step walk threads unawaited (context/dispatch.ts `PIPELINED_RPC_BRANDS` —
// it cannot import cloudflare:workers itself). A call step yields an RpcPromise; a PROPERTY step on
// one yields an RpcProperty — both pipeline, so both register. The cast bridges a workers-types gap:
// the runtime exports these and `RpcStub` (verified by probe) but the .d.ts doesn't.
const {
  RpcStub: NativeRpcStub,
  RpcPromise: NativeRpcPromise,
  RpcProperty: NativeRpcProperty,
} = cloudflareWorkers as unknown as Record<
  "RpcStub" | "RpcPromise" | "RpcProperty",
  abstract new () => unknown
>;
registerPipelinedRpcBrand(NativeRpcPromise);
registerPipelinedRpcBrand(NativeRpcProperty);
// All three HOLD A SESSION until disposed (context/dispatch.ts `RPC_SESSION_BRANDS`): what a walk steps past
// is released once its answer is in, and a stub never leaves a context's `invoke` live.
registerRpcSessionBrand(NativeRpcStub);
registerRpcSessionBrand(NativeRpcPromise);
registerRpcSessionBrand(NativeRpcProperty);
// capnweb's own promises pipeline the same way, and the library's `itx.connectToCapnweb` puts them
// in the walk (library.ts): a remote chain `.a().b(x)` must stay unawaited between steps or
// a one-shot batch session dies after its first message. A capnweb RpcStub is not a promise; it
// registers so a stub-valued step is never awaited either (awaiting one is a no-op anyway).
registerPipelinedRpcBrand(CapnwebRpcPromise as unknown as abstract new () => unknown);
registerPipelinedRpcBrand(CapnwebRpcStub as unknown as abstract new () => unknown);

// ── ItxEntrypoint ── a loaded worker's WHOLE WORLD. Every confined dynamic worker's `env.ITX` and
// `globalOutbound` are one stub of THIS entrypoint, minted via `ctx.exports.ItxEntrypoint({ props:
// { iterateContextName } })` — never a raw `env.ITERATE_CONTEXT.getByName` DO stub — so the context it forwards
// to is a PROP of the stub, not a binding the loaded code could reach around.
//
// TWO methods, nothing else — `get()` (the itx scope) and `fetch` (`globalOutbound`) — each call
// resolved and dispatched HERE by the stateless resolver (context/stateless-context.ts) through
// `env.ITERATE_CONTEXT`, this worker's own binding to its namespace.

/** The itx scope as `env.ITX.get()` types it — the Workers-RPC stub of a context, every dotted step
 *  pipelined. The platform's own facets extend the SDK's host with THIS scope, so they spell every
 *  root; an app's facet has the declared `IterateContextApi` (iterate/api). */
export type ItxEntrypointScope = ReturnType<Service<ItxEntrypoint>["get"]>;
export class ItxEntrypoint extends cloudflareWorkers.WorkerEntrypoint<
  Env,
  { iterateContextName: string; platform?: true; platformOrigin: string | null }
> {
  /** THE handoff: the genuine itx scope — the same `IterateContextRpcTarget` class a capnweb client
   *  gets from `projects.get(id)` (capnweb's RpcTarget IS the native `cloudflare:workers` RpcTarget
   *  on workerd), under `Caller.app` unless minted `platform: true`, so loaded code writes plain
   *  dotted access and mid-chain handles pipeline natively inside the app wall. A fresh
   *  SessionTeardown per call: this hop lends nothing session-long (a loaded worker's callbacks ride
   *  as Workers-RPC stubs through the call args, never the pager). Re-resolved per call — never a
   *  stub held across calls (the back-channel rule). */
  get(cause?: unknown): IterateContextRpcTarget {
    // `cause`: the SDK's word for why the loaded code runs (cause.ts); none begins a chain.
    // LOADED code's handle runs as app code; a class of THIS worker mints its stub with
    // `platform: true` from its own exports (sdk/index.ts) and gets the full handle. A loaded isolate's
    // `ctx.exports` are its own module's, so the prop cannot be forged from inside one. Either speaks
    // for the project (no principal) at the origin the context was minted with (platform-origin
    // persisted on the DO): every hop from here — this context, a `cd` to a sibling — carries it, so
    // a sibling never reached from the edge still composes URLs. The platform's handle `cd`s as an
    // edge context does, so it carries its own context as `Caller.path`: what it appends elsewhere
    // (an entity's certificate on `/`) is stamped with where it came from, not where it landed.
    const address = DurableObjectNameCodec.parse(this.ctx.props.iterateContextName);
    return new IterateContextRpcTarget(
      this.env.ITERATE_CONTEXT,
      address,
      new SessionTeardown(),
      (p) => this.ctx.waitUntil(p),
      this.#caller(address, parseCause(cause)),
      false,
      (at, caller) =>
        statelessResolverFor({
          env: this.env,
          namespace: this.env.ITERATE_CONTEXT,
          address: at,
          caller,
          ctx: this.ctx,
        }),
    );
  }

  /** globalOutbound: every RAW Request a loaded worker sends — a plain `fetch(url)` (egress) or a
   *  fetch it addressed itself with `x-itx-expression` — is one terminal-fetch call through the
   *  stateless resolver, run as the context's own expression fetch would run it: the headers it
   *  strips stripped, a failure answered as it answers one (`expressionFetchErrorAnswer`). */
  override async fetch(request: Request): Promise<Response> {
    const address = DurableObjectNameCodec.parse(this.ctx.props.iterateContextName);
    // why, as the loaded code's `fetch` said it (cause.ts)
    const caller = this.#caller(address, parseCause(request.headers.get(ITERATE_CAUSE_HEADER)));
    // A raw `fetch(url)` IS `itx.fetch(request)` at its context: loaded code's through the table (no
    // `itx.fetch` row below the owner root, no egress), the platform's (a first-party facet's) its
    // own egress.
    const expression =
      request.headers.get(ITX_EXPRESSION_FETCH_HEADER) ??
      (caller.app ? "itx.fetch" : "itx.builtins.fetch");
    return statelessExpressionFetch(
      statelessResolverFor({
        env: this.env,
        namespace: this.env.ITERATE_CONTEXT,
        address,
        caller,
        ctx: this.ctx,
      }),
      () => parseFetchExpression(expression),
      request,
      expression,
    );
  }

  /** Who this entrypoint's calls are: loaded code (`Caller.app`), or — minted `platform: true` by a
   *  class of THIS worker — the platform at its own context (`Caller.path`). Either speaks for the
   *  project, at the origin the context was minted with, for the cause the code runs under, or one
   *  of its own. */
  #caller(address: DurableObjectAddress, cause: Cause | undefined): Caller {
    return {
      principal: null,
      platformOrigin: this.ctx.props.platformOrigin,
      cause: cause || newChain("loaded code"),
      ...(this.ctx.props.platform ? { path: address.path } : { app: true as const }),
    };
  }
}

/** A TERMINAL FETCH THROUGH THE STATELESS RESOLVER, its entry points' (`invoke`,
 *  `ItxEntrypoint.fetch`, and the edge's fetch route: worker.ts `serveProjectHost`): the Request
 *  stripped of what the context's own expression fetch strips —
 *  every caller stamp, the expression, the routing slug — since loaded code may have forged any of
 *  them, and a call that lands in a context carries the resolver's own caller
 *  (built-ins.ts `callContext`); a failure answered as a Response, as the context answers one.
 *  `steps` is read inside, so an expression that does not parse is answered too. Not in the
 *  resolver itself: the context's fetch channel hands the edge's principal on to the app. */
export async function statelessExpressionFetch(
  resolver: ItxExpressionResolver,
  steps: () => ItxExpression,
  request: Request,
  label: string,
): Promise<Response> {
  const headers = new Headers(request.headers);
  stampCallerHeaders(headers, null);
  try {
    const result = await resolver.invoke(
      itxExpressionEndingInFetch(steps()),
      new Request(request, { headers }),
    );
    return result instanceof Response
      ? result
      : new Response(`expression fetch: ${JSON.stringify(result)}\n`);
  } catch (error) {
    return expressionFetchErrorAnswer(error, label);
  }
}

/** THE PUBLISHED API IS DECLARED, NOT GENERATED (iterate/api): an edge context IS one — its own
 *  verbs and every root merged in above — or this fails to typecheck, naming the root or verb that
 *  is missing or mistyped. Not `implements`: the class's own verbs take richer arguments than the
 *  published ones (`provide`'s and `subscribe`'s lent stubs, which the published API types
 *  `unknown`), and an `implements` class spells the contract's (lint: iterate/mechanical-class-impl). */
function publishedContextApiOf(context: IterateContextRpcTarget): IterateContextApi {
  return context;
}
void publishedContextApiOf;

/** The `itx/fetch-route-configured` a `provide(match, stub, { fetchRoute })` rides its pager with,
 *  its target the stub's match — refused here, before anything is lent, as `itx.fetchRoutes.set`
 *  refuses it. */
function fetchRouteEventTo(
  target: ItxExpression,
  route: Omit<FetchRouteInput, "target"> & { fetchRouteName: string },
): StreamEventInput {
  const parsed = FetchRouteConfiguredPayload.safeParse({
    fetchRouteName: route.fetchRouteName,
    requestMatcher: route.requestMatcher,
    target,
    authRequirement: route.authRequirement || null,
    priority: route.priority || 0,
  });
  if (!parsed.success)
    throw codedError(
      "INVALID_INPUT",
      `provide's fetchRoute ${JSON.stringify(route.fetchRouteName)}: ${z.prettifyError(parsed.error)}`,
    );
  return { type: "events.iterate.com/itx/fetch-route-configured", payload: parsed.data };
}
