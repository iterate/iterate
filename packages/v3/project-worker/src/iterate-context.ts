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
// context/rpc-stubs.ts), the two processor verbs, and the two PROJECT doors a session carries on the
// root context it vends — `mintToken` (a project token as this session's principal) and
// `rotateApiKey` (the project's own secret) — which touch no DO at all. Each verb builds ONE event and appends it;
// every built-in root rides the hop with ZERO code here. `provide` and `subscribe` hand back a
// DISPOSABLE handle, so what they make is SESSION-SCOPED (capnweb disposes every exported handle at
// session end); the raw event — `itx.append(rewriteRuleConfiguredEvent(match, target))` — is the verb
// minus the handle and outlives the session. A client reaches a root context through session.ts and
// the rest with `cd(path)`.
//   durable object names — `DurableObjectNameCodec` / `resolveContextPath`: the ONE place a context DO name is formatted and parsed
//   ItxEntrypoint        — a loaded worker's WHOLE WORLD: `env.ITX.get()` and `globalOutbound`, both addressing the DO

import { RpcTarget } from "capnweb";
import { WorkerEntrypoint } from "cloudflare:workers";
import type { IterateContextDurableObject, Env } from "./iterate-context-durable-object.ts";
import {
  ITX_EXPRESSION_FETCH_HEADER,
  terminalFetchOf,
  lendRpcStubOverPager,
  type ClientRpcStub,
  type IterateContextDurableObjectStub,
} from "./context/rpc-stubs.ts";
import {
  canonicalItxExpressionPrefix,
  normalizedItxExpression,
  type ItxExpression,
  type ItxExpressionInput,
  print,
  installPrototypeInvokeFallback,
} from "./context/expression.ts";
import {
  rewriteRuleConfiguredEvent,
  rewriteRuleRemovedEvent,
} from "./context/itx-expression-rewriting.ts";
import {
  assertFacetSourceWithinCeiling,
  facetSpecOf,
  type FacetSpec,
} from "./context/worker-loader.ts";
import type { BuiltInScope } from "./context/built-ins.ts";
import { SessionTeardown, type ProjectDoorsInput } from "./session.ts";
import {
  ITX_PRINCIPAL_HEADER,
  rotateProjectApiKey,
  signProjectToken,
  type Principal,
} from "./principal.ts";
import type { StreamEvent, StreamEventInput } from "./stream/processor.ts";
import { subscriptionConfiguredEvent } from "./stream/core-processor.ts";
import { codedError } from "./lib.ts";

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
export interface IterateContext extends Omit<BuiltInScope, "cd"> {}

/** The iterate context (`itx`) at one `{ projectId, path }`, as a client holds it. */
export class IterateContext extends RpcTarget {
  readonly #contextNamespace: IterateContextNamespace;
  readonly #durableObjectAddress: DurableObjectAddress;
  readonly #sessionTeardown: SessionTeardown;
  readonly #waitUntil: WaitUntil;
  /** WHO holds this context: the session's verified principal (session.ts), or null (the anonymous
   *  session, a loaded worker's `env.ITX`). Every dispatch runs under it, so every event it appends
   *  carries `source.principal`. */
  readonly #principal: Principal | null;
  /** What the two project doors sign and write with — `mintToken` signs with the configuration's
   *  token secret, `rotateApiKey` writes the key hash to `SECRETS_KV` — or null for a handle that
   *  carries neither door: one no session vended (a loaded worker's `env.ITX`), or a project-token
   *  session's (a delegation, minutes long, never a minter of tokens or keys — session.ts). */
  readonly #projectDoors: ProjectDoorsInput | null;

  constructor(
    contextNamespace: IterateContextNamespace,
    durableObjectAddress: DurableObjectAddress,
    sessionTeardown: SessionTeardown,
    waitUntil: WaitUntil,
    principal: Principal | null = null,
    projectDoors: ProjectDoorsInput | null = null,
  ) {
    super();
    this.#contextNamespace = contextNamespace;
    this.#durableObjectAddress = durableObjectAddress;
    this.#sessionTeardown = sessionTeardown;
    this.#waitUntil = waitUntil;
    this.#principal = principal;
    this.#projectDoors = projectDoors;
  }

  /** The context DO's stub, minted PER CALL (a stub is a cheap handle onto one shared connection):
   *  "many exceptions leave the DurableObjectStub in a broken state, such that all attempts to send
   *  additional requests will just fail immediately with the original exception … create a new one"
   *  (Cloudflare's error-handling guide) — so no call after a reset replays the reset. */
  get #durableObject(): IterateContextDurableObjectStub {
    return this.#contextNamespace.getByName(this.#durableObjectAddress.name);
  }

  /** Dispatch on the DO under this context's principal — the one place the edge chooses the door. */
  #invokeOnDurableObject(itxExpression: ItxExpression, args: unknown[] = []): Promise<unknown> {
    return (
      this.#principal
        ? this.#durableObject.invokeAs(this.#principal, itxExpression, ...args)
        : this.#durableObject.invoke(itxExpression, ...args)
    ) as Promise<unknown>;
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
      this.#principal,
      this.#projectDoors,
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
      if (this.#principal) headers.set(ITX_PRINCIPAL_HEADER, JSON.stringify(this.#principal));
      return this.#durableObject.fetch(new Request(terminalFetch.request, { headers }));
    }
    return this.#invokeOnDurableObject(itxExpression, args);
  }

  // ── the project doors: what the session that vended this context may do FOR THE PROJECT, no DO touched ──

  /** A PROJECT TOKEN for this project as this context's principal — `ProjectTokenClaims`
   *  (principal.ts) signed with `APP_CONFIG_PROJECT_TOKEN_SECRET`: what `/.itx/session?token=` on a
   *  project host turns into its cookie (the console links a project host through it), what a script
   *  presents as `Authorization: Bearer`, what `authenticate({ type: "project-token" })` takes.
   *  The door is a member's, the admin's, or the project-secret session's for its own project (then
   *  the token's actor is `project:<projectId>`) — the session that vended this handle carries it
   *  (session.ts). `ttlSeconds` defaults to 15 minutes; 24 hours is the most. A handle without the
   *  project doors — a loaded worker's `env.ITX`, a project-token session's — is FORBIDDEN. */
  async mintToken({ ttlSeconds = 15 * 60 }: { ttlSeconds?: number } = {}): Promise<string> {
    if (!this.#projectDoors || !this.#principal)
      throw codedError(
        "FORBIDDEN",
        "mintToken(): this handle carries no project doors — a loaded worker's env.ITX speaks for the project, never for a person, and a project-token session is a delegation that mints no further token",
      );
    if (!(Number.isFinite(ttlSeconds) && ttlSeconds > 0 && ttlSeconds <= 24 * 60 * 60))
      throw new Error(
        `mintToken({ ttlSeconds }): a token lives between 1 second and 24 hours, got ${JSON.stringify(ttlSeconds)}`,
      );
    return signProjectToken(
      { projectId: this.#durableObjectAddress.projectId, ...this.#principal },
      ttlSeconds * 1000,
      this.#projectDoors.appConfig.projectTokenSecret,
    );
  }

  /** The project's API KEY — its own long-lived secret (`authenticate({ type: "project-secret" })`;
   *  the bearer a device or a headless app presents on a project host), minted fresh and answered
   *  ONCE: only its SHA-256 hash is stored (principal.ts `rotateProjectApiKey`), so a reveal IS a
   *  rotation and the previous key stops verifying at once (a project has no key until the first
   *  call). The same door as `mintToken`'s; the key is the PROJECT's, so any context of it (`cd`)
   *  rotates the same key. A handle without the project doors is FORBIDDEN. */
  async rotateApiKey(): Promise<string> {
    if (!this.#projectDoors)
      throw codedError(
        "FORBIDDEN",
        "rotateApiKey(): this handle carries no project doors — a loaded worker's env.ITX cannot rotate the project's key, and a project-token session is a delegation that reaches no key",
      );
    return rotateProjectApiKey(this.#durableObjectAddress.projectId, this.#projectDoors.secretsKv);
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
   *    • `null` — MASK `match` when a platform row lies beneath it, delete the row otherwise (and
   *      recall a stub THIS session lent under it).
   *  Either way the durable thing made is the rule, so the handle is a `RewriteRuleHandle`: disposing
   *  it, or the session ending, un-does the act. */
  async provide(
    match: ItxExpressionInput,
    target: ClientRpcStub | ItxExpressionInput | null,
  ): Promise<RewriteRuleHandle> {
    const matchString = canonicalItxExpressionPrefix(match);
    const sessionTeardownKey = this.#sessionTeardownKey(matchString);
    if (target === null || typeof target === "string" || Array.isArray(target)) {
      // Appended FIRST, then whatever THIS session lent under the match is recalled: the DO's un-set
      // on the pager close finds a row that no longer names the stub and removes nothing, so it can
      // never take the fresh mask or rule with it.
      const event = rewriteRuleConfiguredEvent(matchString, target);
      this.#refuseAnOverrideNamingItsOwnContext(matchString, event);
      await this.#append(event);
      this.#sessionTeardown.dispose(sessionTeardownKey);
      const expectedTarget = (event.payload as { target: ItxExpression | null }).target;
      return new RewriteRuleHandle(() => this.#removeRuleInBackground(matchString, expectedTarget));
    }
    // Built BEFORE the lend so a match the codec refuses throws with nothing lent; the rule rides the
    // pager upgrade and the DO appends it as it accepts the pager (context/rpc-stubs.ts).
    const ruleEvent = rewriteRuleConfiguredEvent(matchString, [
      "itx",
      "builtins",
      "rpcStubs",
      ["get", matchString],
    ]);
    const pager = await lendRpcStubOverPager(
      this.#durableObject,
      target,
      matchString,
      [ruleEvent],
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
   *  stream keeps. Same name REPLACES. Literally `append(subscriptionConfiguredEvent(…))` — the handle
   *  removes the row (and recalls the lent callback) when disposed or when the session ends. */
  async subscribe(input: {
    name?: string;
    target: ItxExpressionInput | ClientRpcStub | null;
    consumes?: string[];
    /** Where the cursor lane starts (0 = the whole log); absent = from now. A push target ignores it. */
    afterOffset?: number;
  }): Promise<SubscriptionHandle> {
    const name = input.name ?? `sub-${crypto.randomUUID().slice(0, 8)}`;
    const rpcStubKey = `subscription:${name}`;
    const sessionTeardownKey = this.#sessionTeardownKey(rpcStubKey);
    const consumes = {
      ...(input.consumes && { consumes: input.consumes }),
      ...(input.afterOffset !== undefined && { afterOffset: input.afterOffset }),
    };
    if (input.target !== null && typeof input.target !== "string" && !Array.isArray(input.target)) {
      // A LIVE callback: the row rides the pager upgrade exactly as `provide`'s rule does (built
      // first, so a name the reduce rejects throws with nothing lent).
      const row = subscriptionConfiguredEvent({
        name,
        target: ["itx", "builtins", "rpcStubs", ["get", rpcStubKey]],
        ...consumes,
      });
      const pager = await lendRpcStubOverPager(
        this.#durableObject,
        input.target as ClientRpcStub,
        rpcStubKey,
        [row],
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
    const [committed] = (await this.#append(
      subscriptionConfiguredEvent({ name, target, ...consumes }),
    )) as StreamEvent[];
    this.#sessionTeardown.dispose(sessionTeardownKey);
    return new SubscriptionHandle(name, () => {
      // no pager to recall: the handle un-sets the row itself — only the one this call wrote
      if (target !== null) this.#removeSubscriptionInBackground(name, committed.offset);
    });
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
    assertFacetSourceWithinCeiling(spec, `enableProcessor("${name}")`); // refused HERE: nothing appended
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

  /** THE ONE WRITE: every verb above builds an event and appends it here, spelled `itx.builtins.append`
   *  — the platform never spells a short name (context/itx-expression-rewriting.ts), so a context's own
   *  rows redirect the user's calls, never this. */
  #append(event: StreamEventInput): Promise<unknown> {
    return this.#invokeOnDurableObject(["itx", "builtins", ["append", event]]);
  }

  /** An undo's REMOVAL of a rule: un-set ONLY the row this handle wrote — the removal carries the
   *  target it wrote (`ifTarget`) and the core reduce applies it only while the row's target is still
   *  that (a later provide at the same match owns the row now); spelled as the removal (back to the
   *  platform row beneath, if any), never as a mask. Fire-and-forget under waitUntil (a disposer
   *  cannot await), a refusal ignored. */
  #removeRuleInBackground(matchString: string, expectedTarget: ItxExpression | null): void {
    this.#waitUntil(
      this.#append(rewriteRuleRemovedEvent(matchString, expectedTarget)).catch(() => undefined),
    );
  }

  /** An undo's REMOVAL of a subscription row: un-set ONLY the row this handle wrote — its identity is
   *  the offset of the event the handle's call committed (`ifConfiguredAtOffset`); a later same-name
   *  subscribe owns the name and the reduce ignores the stale removal. Fire-and-forget, as above. */
  #removeSubscriptionInBackground(name: string, configuredAtOffset: number): void {
    this.#waitUntil(
      this.#append(
        subscriptionConfiguredEvent({
          name,
          target: null,
          ifConfiguredAtOffset: configuredAtOffset,
        }),
      ).catch(() => undefined),
    );
  }

  /** A whole-context override (a bare `itx` row) whose target is `cd` of THIS context is a loop no
   *  depth budget can see — every hop is a fresh resolve — so it is refused here, where the path is
   *  known. Two contexts overriding each other stays a trusted-client misconfiguration. */
  #refuseAnOverrideNamingItsOwnContext(matchString: string, event: StreamEventInput): void {
    if (matchString !== "itx") return;
    const steps = (event.payload as { target: ItxExpression | null }).target; // the PARSED form
    if (steps === null) return;
    const cdStep = steps[1] === "builtins" ? steps[2] : steps[1];
    if (!Array.isArray(cdStep) || cdStep[0] !== "cd" || typeof cdStep[1] !== "string") return;
    const ownPath = this.#durableObjectAddress.path;
    if (resolveContextPath(ownPath, cdStep[1]) === ownPath)
      throw new Error(
        `a whole-context override may not name its own context: "itx ⇒ ${print(steps, { holes: true })}" at ${JSON.stringify(ownPath)} would route every call back into itself`,
      );
  }

  /** The SessionTeardown key for a lent stub. The teardown is SESSION-lived and shared by every
   *  IterateContext the session hands out, while a stub key is only unique PER CONTEXT — so the key is
   *  the JSON pair, unambiguous whatever either half holds (a match may pin a string arg). */
  #sessionTeardownKey(rpcStubKey: string): string {
    return JSON.stringify([this.#durableObjectAddress.name, rpcStubKey]);
  }
}

// THE NATURAL DOTTED SURFACE: an unknown segment (`itx.slack`, `itx.kv`, `itx.append`) reduces into
// ONE `invoke(expression)` dispatch through the prototype hop (context/expression.ts says why a hop
// and not a Proxy AROUND the instance), the declared methods above always winning.
installPrototypeInvokeFallback(IterateContext, ["itx"]);

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
const PROJECT_ID = /^[A-Za-z0-9_-]+$/;

/** A parsed DO address. `name` is its own canonical string form — parse once, carry both
 *  halves together (no separate re-stringify field at call sites). */
export type DurableObjectAddress = { projectId: string; path: string; name: string };

/** Resolve a `cd` target against a context's own path — the one resolver both `cd` doors (the
 *  edge method and the built-in root) share. Absolute ("/agents/x") stands alone; relative
 *  ("agents/x", "../inbox", ".") joins onto `base`. `.` and `..` resolve; the root cannot be
 *  escaped ("/.." is "/"). The result is canonical: leading slash, no trailing slash but for "/". */
export function resolveContextPath(basePath: string, contextPath: string): string {
  const segments: string[] = [];
  for (const seg of `${contextPath.startsWith("/") ? "" : basePath}/${contextPath}`.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") segments.pop();
    else segments.push(seg);
  }
  return `/${segments.join("/")}`;
}

export const DurableObjectNameCodec = {
  /** Formats the project-scoped Durable Object name `{projectId}.iterate{path}` — the path in the
   *  CANONICAL form `cd` resolves to (`resolveContextPath`), so `/a`, `/a/`, `/a/./` and `a` are ONE
   *  name and no door (the `?context=` query included) can mint a twin DO for a logical context. */
  stringify({ projectId, path }: { projectId: string; path: string }): string {
    return `${projectId}${DURABLE_OBJECT_HOST_SUFFIX}${resolveContextPath("/", path)}`;
  },
  /** Parses a Durable Object name. A bare name (no `.iterate`) is that project's root — what
   *  `projects.get("prj_x")` and the `/expression` lane's `?context=prj_x` hand in. */
  parse(name: string): DurableObjectAddress {
    const i = name.indexOf(DURABLE_OBJECT_HOST_SUFFIX);
    const parts =
      i === -1
        ? { projectId: name, path: "/" }
        : {
            projectId: name.slice(0, i),
            path: resolveContextPath("/", name.slice(i + DURABLE_OBJECT_HOST_SUFFIX.length)),
          };
    if (!PROJECT_ID.test(parts.projectId))
      throw codedError(
        "INVALID_CONTEXT",
        `invalid projectId ${JSON.stringify(parts.projectId)}: only [A-Za-z0-9_-] (a ":" would breach the kv/secret isolation wall)`,
      );
    return { ...parts, name: DurableObjectNameCodec.stringify(parts) };
  },
};

// ── ItxEntrypoint ── a loaded worker's WHOLE WORLD. Every confined dynamic worker's `env.ITX` and
// `globalOutbound` are one stub of THIS entrypoint, minted via `ctx.exports.ItxEntrypoint({ props:
// { iterateContextName } })` — never a raw `env.ITERATE_CONTEXT.getByName` DO stub — so the context it forwards
// to is a PROP of the stub, not a binding the loaded code could reach around.
//
// TWO doors, nothing else — `get()` (the itx scope) and `fetch` (`globalOutbound`) — both addressing
// the DO through `env.ITERATE_CONTEXT`, this worker's own binding to its namespace.

export class ItxEntrypoint extends WorkerEntrypoint<Env, { iterateContextName: string }> {
  /** THE handoff: the genuine itx scope — the SAME `IterateContext` RpcTarget a capnweb client gets
   *  from `projects.get(id)` (capnweb's RpcTarget IS the native `cloudflare:workers` RpcTarget on
   *  workerd), so loaded code writes plain dotted access and mid-chain handles pipeline natively. A
   *  fresh SessionTeardown per call: this hop lends nothing session-long (a loaded worker's callbacks
   *  ride as Workers-RPC stubs through the call args, never the pager). Re-resolved per call — never
   *  a stub held across calls (the back-channel rule). */
  get(): IterateContext {
    return new IterateContext(
      this.env.ITERATE_CONTEXT,
      DurableObjectNameCodec.parse(this.ctx.props.iterateContextName),
      new SessionTeardown(),
      (p) => this.ctx.waitUntil(p),
    );
  }

  /** globalOutbound: every RAW Request a loaded worker sends — a plain `fetch(url)` (egress) or a
   *  fetch-lane call it addressed itself with `x-itx-expression` — goes to the context DO's fetch
   *  door unchanged, because THAT door is where raw Requests are sorted. Not
   *  `get().invoke(["itx",["fetch",…]])`: the edge's terminal-fetch fork would overwrite a lane header
   *  the loaded worker already set. */
  override fetch(request: Request): Promise<Response> {
    // A loaded worker speaks for the project, never for a person: the principal header is the
    // edge's stamp (worker.ts, iterate-context.ts), stripped here so loaded code cannot forge one.
    const headers = new Headers(request.headers);
    headers.delete(ITX_PRINCIPAL_HEADER);
    return this.env.ITERATE_CONTEXT.getByName(this.ctx.props.iterateContextName).fetch(
      new Request(request, { headers }),
    );
  }
}

/** Mint the loopback stub for one context — `ctx.exports.ItxEntrypoint({ props })` on the DO's own
 *  state (workers-types puts the worker's export table on it). `Cloudflare.Exports` is `{}` without a
 *  generated `GlobalProps`, hence the cast. */
export function itxEntrypointFor(ctx: DurableObjectState, iterateContextName: string): Fetcher {
  const { exports } = ctx as unknown as {
    exports: { ItxEntrypoint(opts: { props: { iterateContextName: string } }): Fetcher };
  };
  return exports.ItxEntrypoint({ props: { iterateContextName } });
}
