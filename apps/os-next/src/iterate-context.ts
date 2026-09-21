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
// addressing), `invoke` (the landing door of the prototype hop at the bottom, plus the one fetch-lane
// fork), `provide` and `subscribe` (declared here because their target may be a client's rpc stub,
// which must live in this stateless worker and never in the DO — the DON'T-PIN rule,
// context/rpc-stubs.ts) and the two processor verbs. Each verb builds ONE event and appends it;
// every built-in root rides the hop with ZERO code here. `provide` and `subscribe` hand back a
// DISPOSABLE handle, so what they make is SESSION-SCOPED (capnweb disposes every exported handle at
// session end); the raw event — `itx.append({ type: "…/rewrite-rule-configured", payload: { match, target } })` — is the verb
// minus the handle and outlives the session. A client reaches a root context through session.ts and
// the rest with `cd(path)`.
//   durable object names — `DurableObjectNameCodec` / `resolveContextPath`: the ONE place a context DO name is formatted and parsed
//   ItxEntrypoint        — a loaded worker's WHOLE WORLD: `env.ITX.get()` and `globalOutbound`, both addressing the DO

import { RpcTarget } from "capnweb";
import { codedError, resolveContextPath } from "iterate/next/lib";
import { WorkerEntrypoint } from "cloudflare:workers";
import {
  InvokeHandle,
  canonicalItxExpressionPrefix,
  normalizedItxExpression,
  type ItxExpression,
  type ItxExpressionInput,
  print,
  installPrototypeInvokeFallback,
} from "iterate/next/expression";
import type { IterateContextApi, RewriteRuleConfigured } from "iterate/next/api";
import {
  ITX_APP_HEADER,
  ITX_GRANT_HEADER,
  ITX_PRINCIPAL_HEADER,
  type Caller,
} from "iterate/next/principal";
import type { StreamEvent, StreamEventInput } from "iterate/next/stream/processor";
import type { IterateContextDurableObject, Env } from "./iterate-context-durable-object.ts";
import {
  ITX_EXPRESSION_FETCH_HEADER,
  terminalFetchOf,
  lendRpcStubOverPager,
  type ClientRpcStub,
  type IterateContextDurableObjectStub,
} from "./context/rpc-stubs.ts";
import { normalizeRewriteRuleConfigured } from "./context/itx-expression-rewriting.ts";
import type { BuiltInScope } from "./context/built-ins.ts";
import { GLOBAL_PROJECT_ID, PROJECT_ID } from "./context/paths.ts";
import { SessionTeardown } from "./session.ts";

export type IterateContextNamespace = DurableObjectNamespace<IterateContextDurableObject>;
export type WaitUntil = (p: Promise<unknown>) => void;

/** What `provide` hands back: dispose it — or let the session end — and the act is un-done (a lent
 *  stub recalled, a rule or deny removed while the row is still its own). The caller already holds
 *  the match it passed, so the handle carries nothing else. */
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
export interface IterateContextRpcTarget extends Omit<BuiltInScope, "cd"> {}

/** The iterate context (`itx`) at one `{ projectId, path }`, as a client holds it. */
/** The header the edge (and a session's terminal fetch) stamps a fetch-lane Request with — the
 *  platform origin the caller reached the platform on (`Caller.platformOrigin` on the wire) — read and
 *  stripped by the context DO's fetch lane. Inbound `x-itx-*` headers never survive the edge, and
 *  `ItxEntrypoint.fetch` strips it from a loaded worker's Request, so an outsider's is gone before
 *  this is set. */
export const ITX_PLATFORM_ORIGIN_HEADER = "x-itx-platform-origin";

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

  constructor(
    contextNamespace: IterateContextNamespace,
    durableObjectAddress: DurableObjectAddress,
    sessionTeardown: SessionTeardown,
    waitUntil: WaitUntil,
    caller: Caller = { principal: null },
  ) {
    super();
    this.#contextNamespace = contextNamespace;
    this.#durableObjectAddress = durableObjectAddress;
    this.#sessionTeardown = sessionTeardown;
    this.#waitUntil = waitUntil;
    this.#caller = caller;
  }

  /** The context DO's stub, minted PER CALL (a stub is a cheap handle onto one shared connection):
   *  "many exceptions leave the DurableObjectStub in a broken state, such that all attempts to send
   *  additional requests will just fail immediately with the original exception … create a new one"
   *  (Cloudflare's error-handling guide) — so no call after a reset replays the reset. */
  get #durableObject(): IterateContextDurableObjectStub {
    return this.#contextNamespace.getByName(this.#durableObjectAddress.name);
  }

  /** Dispatch on the DO under this context's caller — the one place the edge dispatches. */
  #invokeOnDurableObject(itxExpression: ItxExpression, args: unknown[] = []): Promise<unknown> {
    // The stub's `invoke` is typed as workerd's RPC wrapper over the DO method; the call denotes
    // whatever expression the caller spelled, so `unknown` is the honest contract here.
    return this.#durableObject.invoke(itxExpression, args, this.#caller) as Promise<unknown>;
  }

  /** Another context of THIS project. Absolute by convention (`cd("/agents/support")`); relative
   *  (`"agents/support"`, `"../inbox"`) resolves against this context's path — one resolver, shared
   *  with the built-in `itx.cd(...)` root. Returns an EDGE context, so `provide` on it lends in this
   *  same session. Pure addressing — and, the projectId being kept, a project's `cd` can never spell
   *  the global namespace. THE GLOBAL NAMESPACE IS NOT NAVIGABLE: a global context is reached by
   *  IDENTITY only (`session.user`, `session.organizations.get`), so its `cd` is refused for everyone
   *  — the admin included; the one path hop the platform needs there is the kernel's own, inside the
   *  DO (built-ins.ts `cd`). This is the whole path mask: with no way to name another user's path,
   *  there is no policy to get wrong. */
  cd(path: string): IterateContextRpcTarget {
    if (this.#durableObjectAddress.projectId === GLOBAL_PROJECT_ID)
      throw codedError(
        "FORBIDDEN",
        "a global context is reached by identity (session.user, session.organizations), never by path",
      );
    // LOADED CODE's `cd` is an expression through THIS context's table (`itx.cd ⇒ null` is a wall,
    // and the resolver's app wall keeps it to self and descendants) — the dotted surface of the handle
    // it gets back accumulates onto one `invoke`, exactly as the built-in `cd` root answers.
    if (this.#caller.app)
      return new InvokeHandle((steps) =>
        // The proxy hands relative steps; a caller's own `.invoke("itx.whoami()")` is a whole call.
        this.invoke([
          "itx",
          ["cd", path],
          ...(typeof steps === "string" || steps[0] === "itx"
            ? normalizedItxExpression(steps as ItxExpressionInput).slice(1)
            : steps),
        ]),
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
   *  tunnel or a WS-serving worker; context/rpc-stubs.ts doctrine, points 1 & 4). */
  invoke(call: ItxExpressionInput, ...args: unknown[]): Promise<unknown> {
    const itxExpression = normalizedItxExpression(call);
    const terminalFetch = terminalFetchOf(itxExpression, args);
    if (terminalFetch) {
      const headers = new Headers(terminalFetch.request.headers);
      headers.set(ITX_EXPRESSION_FETCH_HEADER, JSON.stringify(terminalFetch.steps)); // the lane parses a JSON ItxExpression
      headers.delete(ITX_PRINCIPAL_HEADER); // the stamp is this session's, never the Request's own
      headers.delete(ITX_GRANT_HEADER);
      headers.delete(ITX_PLATFORM_ORIGIN_HEADER); // likewise the platform origin: this holder's, never the Request's
      if (this.#caller.principal)
        headers.set(ITX_PRINCIPAL_HEADER, JSON.stringify(this.#caller.principal));
      if (this.#caller.grant) headers.set(ITX_GRANT_HEADER, this.#caller.grant);
      headers.delete(ITX_APP_HEADER); // likewise this handle's, never the Request's own
      if (this.#caller.app) headers.set(ITX_APP_HEADER, "1");
      if (this.#caller.platformOrigin)
        headers.set(ITX_PLATFORM_ORIGIN_HEADER, this.#caller.platformOrigin);
      return this.#durableObject.fetch(new Request(terminalFetch.request, { headers }));
    }
    return this.#invokeOnDurableObject(itxExpression, args);
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
   *    • an itx EXPRESSION — a pure rewrite: literally `append({ type: "…/rewrite-rule-configured", payload: { match, target } })`;
   *    • `null` — deny `match`: kept as a MASK where an implicit row lies beneath it (a bare `itx`
   *      denies all), a deletion otherwise (and a stub THIS session lent under it is recalled).
   *  The object form is the event's payload (`RewriteRuleConfigured`) and may carry `description`,
   *  the one line a model reads for the name; `(match, target)` is its shorthand.
   *  Either way the durable thing made is the rule, so the handle is a `RewriteRuleHandle`: disposing
   *  it, or the session ending, un-does the act. */
  provide(input: RewriteRuleConfigured): Promise<RewriteRuleHandle>;
  provide(
    match: ItxExpressionInput,
    target: ClientRpcStub | ItxExpressionInput | null,
  ): Promise<RewriteRuleHandle>;
  async provide(
    matchOrInput:
      | ItxExpressionInput
      | (Omit<RewriteRuleConfigured, "target"> & {
          target: ClientRpcStub | ItxExpressionInput | null;
        }),
    maybeTarget?: ClientRpcStub | ItxExpressionInput | null,
  ): Promise<RewriteRuleHandle> {
    // The object form IS the event's payload (`RewriteRuleConfigured`, its target widened to a live
    // stub); `(match, target)` is its shorthand. An expression is a string or an array, so the check
    // narrows to the object form.
    const input =
      typeof matchOrInput === "string" || Array.isArray(matchOrInput)
        ? { match: matchOrInput, target: maybeTarget || null }
        : matchOrInput;
    const { match, target } = input;
    // LOADED CODE may lend its OWN object (a live stub answers with the code's own authority and
    // dies with its invocation); a pure rewrite or a deny is a ROW, and a row from loaded code is
    // `itx.append`'s business — through its context's table, where a jail's wall stands.
    if (this.#caller.app && (!target || typeof target === "string" || Array.isArray(target)))
      throw codedError(
        "FORBIDDEN",
        "loaded code writes a row with itx.append({ type: 'events.iterate.com/itx/rewrite-rule-configured', payload: { match, target, description } }); provide lends a live stub only",
      );
    const description = input.description ? { description: input.description } : {};
    const matchString = canonicalItxExpressionPrefix(match);
    const sessionTeardownKey = this.#sessionTeardownKey(matchString);
    if (!target || typeof target === "string" || Array.isArray(target)) {
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
      return new RewriteRuleHandle(() => this.#removeRuleInBackground(matchString, expectedTarget));
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
    // LOADED CODE's row goes through its own table FIRST (a jail's mask refuses it, and nothing is
    // lent); the platform's rides the pager and the DO appends it as it accepts the pager.
    if (this.#caller.app) await this.#append(ruleEvent);
    const pager = await lendRpcStubOverPager(
      () => this.#durableObject,
      target,
      matchString,
      this.#caller.app ? [] : [ruleEvent],
      this.#waitUntil,
    );
    // Registered with the session so a dying session recalls it even when the handle was never
    // disposed (`SessionTeardown`: a re-provide replaces the entry). The rule is NOT un-set by this
    // session — the DO un-sets what names the key when its LAST pager closes.
    const lease = this.#sessionTeardown.add(sessionTeardownKey, pager);
    return new RewriteRuleHandle(() => lease.dispose()); // the lease IS the handle: a stale one is inert
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
    /** Where the cursor lane starts (0 = the whole log); absent = from now. A push target ignores it. */
    afterOffset?: number;
  }): Promise<SubscriptionHandle> {
    // LOADED CODE may lend a live callback (its own, fed its own context's events); an expression
    // target is a ROW the delivery loop runs as the kernel — that is `itx.append`'s business, through
    // the code's own table — and a removal likewise.
    if (
      this.#caller.app &&
      (!input.target || typeof input.target === "string" || Array.isArray(input.target))
    )
      throw codedError(
        "FORBIDDEN",
        "loaded code writes a subscription row with itx.append({ type: 'events.iterate.com/stream/subscription-configured', payload: { name, target, consumes } }); subscribe lends a live callback only",
      );
    // oxlint-disable-next-line iterate/simple-truthiness-check -- only an ABSENT name gets a minted one; an empty-string name is a caller bug that must reach the reduce and be refused there (parseSubscriptionName), never silently become a fresh row per call
    const name = input.name ?? `sub-${crypto.randomUUID().slice(0, 8)}`;
    const rpcStubKey = `subscription:${name}`;
    const sessionTeardownKey = this.#sessionTeardownKey(rpcStubKey);
    const consumes = {
      consumes: input.consumes,
      afterOffset: input.afterOffset,
    };
    if (input.target && typeof input.target !== "string" && !Array.isArray(input.target)) {
      // A LIVE callback: the row rides the pager upgrade exactly as `provide`'s rule does (built
      // first, so a name the reduce rejects throws with nothing lent).
      const row: StreamEventInput = {
        type: "events.iterate.com/stream/subscription-configured",
        payload: {
          name,
          target: ["itx", "builtins", "rpcStubs", ["get", rpcStubKey]],
          ...consumes,
        },
      };
      if (this.#caller.app) await this.#append(row); // loaded code's row: its table first, as in `provide`
      const pager = await lendRpcStubOverPager(
        () => this.#durableObject,
        input.target as ClientRpcStub,
        rpcStubKey,
        this.#caller.app ? [] : [row],
        this.#waitUntil,
      );
      const lease = this.#sessionTeardown.add(sessionTeardownKey, pager);
      // The handle only recalls its own lend (the lease is the handle; a stale one is inert); the DO
      // un-sets the row on the key's last pager close.
      return new SubscriptionHandle(name, () => lease.dispose());
    }
    // An expression (or a removal): appended FIRST, then this session's lend under the name is
    // recalled — the same order as `provide`, for the same reason.
    const target = input.target as ItxExpressionInput | null;
    const [committed] = (await this.#append({
      type: "events.iterate.com/stream/subscription-configured",
      payload: { name, target, ...consumes },
    })) as StreamEvent[];
    this.#sessionTeardown.dispose(sessionTeardownKey);
    return new SubscriptionHandle(name, () => {
      // no pager to recall: the handle un-sets the row itself — only the one this call wrote
      if (target) this.#removeSubscriptionInBackground(name, committed.offset);
    });
  }

  // ── processors: durable configuration, two lines each over the subscription event ──

  /** THE ONE WRITE: every verb above builds an event and appends it here. The platform's is spelled
   *  `itx.builtins.append`, so a context's own rows redirect the user's calls, never this. LOADED
   *  CODE's goes through ITS table under the context root `append` — implicit everywhere, so a child
   *  writes; a jail's bare null (or a mask at `itx.append`) refuses a live lend's row, a live
   *  subscription's and an undo exactly as it refuses `itx.append` — and the door walls the row's
   *  target (context/built-ins.ts `append`). */
  #append(event: StreamEventInput): Promise<unknown> {
    return this.#invokeOnDurableObject(
      this.#caller.app ? ["itx", ["append", event]] : ["itx", "builtins", ["append", event]],
    );
  }

  /** An undo's REMOVAL of a rule: un-set ONLY the row this handle wrote — `null` WITH the target it
   *  wrote (`ifTarget`), which the core reduce applies as a compare-and-set DELETE only while the
   *  row's target is still that (a later provide at the same match owns the row now); never a mask,
   *  never a "restore" (rule 8: at a child that spelling would be a grant). Fire-and-forget under
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
        type: "events.iterate.com/stream/subscription-configured",
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

// ── durable object names ── the ONE place a context DO name is formatted and parsed
// (mirrors apps/os domains/durable-object-names.ts, minimal: no query props, no global host
// yet). A context is addressed by a faux URL `{projectId}.iterate{path}`:
//
//   prj_demo.iterate/                     → project root
//   prj_demo.iterate/agents/support-bot   → an agent context
//
// The projectId is always the host prefix, so a name alone says which project the context
// belongs to — the basis of isolation.

const DURABLE_OBJECT_HOST_SUFFIX = ".iterate";
// The projectId is the kv/secret prefix AND a loader-cacheKey component — a ":" (or worse) in it
// collapses the isolation wall (prj_x + key "a:b" would address the same cell as project prj_x:a
// + key "b"). Gate it at the ONE place every name is parsed.

/** A parsed DO address. `name` is its own canonical string form — parse once, carry both
 *  halves together (no separate re-stringify field at call sites). */
export type DurableObjectAddress = { projectId: string; path: string; name: string };

export const DurableObjectNameCodec = {
  /** Formats the project-scoped Durable Object name `{projectId}.iterate{path}` — the path in the
   *  CANONICAL form `cd` resolves to (`resolveContextPath`), so `/a`, `/a/`, `/a/./` and `a` are ONE
   *  name and no door (the `?context=` query included) can mint a twin DO for a logical context. */
  stringify({ projectId, path }: { projectId: string; path: string }): string {
    return `${projectId}${DURABLE_OBJECT_HOST_SUFFIX}${resolveContextPath("/", path)}`;
  },
  /** The canonical, validated address `{ projectId, path, name }` for a context, built from parts a
   *  caller already holds — path canonicalized, projectId validated, the DO `name` carried. The
   *  DIRECT form of `parse(stringify({ projectId, path }))`, with no string to round-trip through. */
  address({ projectId, path }: { projectId: string; path: string }): DurableObjectAddress {
    if (!PROJECT_ID.test(projectId))
      throw codedError(
        "INVALID_CONTEXT",
        `invalid projectId ${JSON.stringify(projectId)}: only [A-Za-z0-9_-] (a ":" would breach the kv/secret isolation wall)`,
      );
    const parts = { projectId, path: resolveContextPath("/", path) };
    return { ...parts, name: DurableObjectNameCodec.stringify(parts) };
  },
  /** Parses a Durable Object name. A bare name (no `.iterate`) is that project's root — what
   *  `projects.get("prj_x")` hands in. */
  parse(name: string): DurableObjectAddress {
    const i = name.indexOf(DURABLE_OBJECT_HOST_SUFFIX);
    return i === -1
      ? DurableObjectNameCodec.address({ projectId: name, path: "/" })
      : DurableObjectNameCodec.address({
          projectId: name.slice(0, i),
          path: name.slice(i + DURABLE_OBJECT_HOST_SUFFIX.length),
        });
  },
};

// ── ItxEntrypoint ── a loaded worker's WHOLE WORLD. Every confined dynamic worker's `env.ITX` and
// `globalOutbound` are one stub of THIS entrypoint, minted via `ctx.exports.ItxEntrypoint({ props:
// { iterateContextName } })` — never a raw `env.ITERATE_CONTEXT.getByName` DO stub — so the context it forwards
// to is a PROP of the stub, not a binding the loaded code could reach around.
//
// TWO doors, nothing else — `get()` (the itx scope) and `fetch` (`globalOutbound`) — both addressing
// the DO through `env.ITERATE_CONTEXT`, this worker's own binding to its namespace.

/** The itx scope as `env.ITX.get()` types it — the Workers-RPC stub of a context, every dotted step
 *  pipelined. The platform's own facets extend the SDK's host with THIS scope, so they spell every
 *  root; an app's facet has the declared `IterateContextApi` (iterate/next/api). */
export type ItxEntrypointScope = ReturnType<Service<ItxEntrypoint>["get"]>;
export class ItxEntrypoint extends WorkerEntrypoint<
  Env,
  { iterateContextName: string; platform?: true; platformOrigin: string | null }
> {
  /** THE handoff: the genuine itx scope — the same `IterateContextRpcTarget` class a capnweb client
   *  gets from `projects.get(id)` (capnweb's RpcTarget IS the native `cloudflare:workers` RpcTarget
   *  on workerd), under `Caller.app` unless minted `platform: true`, so loaded code writes plain
   *  dotted access and mid-chain handles pipeline natively while the fixed point and a `cd` above
   *  its context are refused. A
   *  fresh SessionTeardown per call: this hop lends nothing session-long (a loaded worker's callbacks
   *  ride as Workers-RPC stubs through the call args, never the pager). Re-resolved per call — never
   *  a stub held across calls (the back-channel rule). */
  get(): IterateContextRpcTarget {
    // LOADED code's handle runs as app code; a class of THIS worker mints its stub with
    // `platform: true` from its own exports (sdk/index.ts) and gets the full handle. A loaded isolate's
    // `ctx.exports` are its own module's, so the prop cannot be forged from inside one. Either speaks
    // for the project (no principal) at the origin the context was minted with (platform-origin
    // persisted on the DO): every hop from here — this context, a `cd` to a sibling — carries it, so
    // a sibling never reached from the edge still composes URLs.
    return new IterateContextRpcTarget(
      this.env.ITERATE_CONTEXT,
      DurableObjectNameCodec.parse(this.ctx.props.iterateContextName),
      new SessionTeardown(),
      (p) => this.ctx.waitUntil(p),
      {
        principal: null,
        platformOrigin: this.ctx.props.platformOrigin,
        ...(!this.ctx.props.platform && { app: true as const }),
      },
    );
  }

  /** globalOutbound: every RAW Request a loaded worker sends — a plain `fetch(url)` (egress) or a
   *  fetch-lane call it addressed itself with `x-itx-expression` — goes to the context DO's fetch
   *  door unchanged, because THAT door is where raw Requests are sorted. Not
   *  `get().invoke(["itx",["fetch",…]])`: the edge's terminal-fetch fork would overwrite a lane header
   *  the loaded worker already set. */
  override fetch(request: Request): Promise<Response> {
    // A loaded worker speaks for the project, never for a person: the principal and grant headers
    // are the edge's stamp (worker.ts, iterate-context.ts), stripped here so loaded code cannot forge one.
    const headers = new Headers(request.headers);
    headers.delete(ITX_PRINCIPAL_HEADER);
    headers.delete(ITX_GRANT_HEADER);
    headers.delete(ITX_APP_HEADER);
    headers.delete(ITX_PLATFORM_ORIGIN_HEADER);
    if (!this.ctx.props.platform) {
      // A raw `fetch(url)` from loaded code IS `itx.fetch(request)` at its context — through the
      // table (no `itx.fetch` row below the owner root, no egress); a self-addressed `env.ITX.fetch`
      // keeps its expression and runs as app code like any other.
      headers.set(ITX_APP_HEADER, "1");
      if (!headers.has(ITX_EXPRESSION_FETCH_HEADER))
        headers.set(ITX_EXPRESSION_FETCH_HEADER, "itx.fetch");
    }
    return this.env.ITERATE_CONTEXT.getByName(this.ctx.props.iterateContextName).fetch(
      new Request(request, { headers }),
    );
  }
}

/** Mint the loopback stub for one context — `ctx.exports.ItxEntrypoint({ props })` on the DO's own
 *  state (workers-types puts the worker's export table on it). `Cloudflare.Exports` is `{}` without a
 *  generated `GlobalProps`, hence the cast. */
export function itxEntrypointFor(
  ctx: DurableObjectState,
  iterateContextName: string,
  platformOrigin: string | null,
): Fetcher {
  const { exports } = ctx as unknown as {
    exports: {
      ItxEntrypoint(opts: {
        props: { iterateContextName: string; platformOrigin: string | null };
      }): Fetcher;
    };
  };
  return exports.ItxEntrypoint({ props: { iterateContextName, platformOrigin } });
}

// THE PUBLISHED API IS DECLARED, NOT GENERATED (iterate/next/api): a context satisfies it, checked here.
const _iterateContextApi: IterateContextApi = null as unknown as IterateContextRpcTarget;
void _iterateContextApi;
