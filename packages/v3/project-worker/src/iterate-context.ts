// iterate-context.ts — the client-facing capnweb surface + the stateless RELAY. This is the ONE place capnweb
// terminates (the `/api` worker); it reaches the IterateContextDurableObject only over Workers RPC (the hard rule).
//
// INVARIANT (owner): THE CLIENT IS JUST CAPNWEB. Every class in this file is a SERVER-side
// RpcTarget; what a client holds is a plain capnweb proxy of it. There is no client SDK and
// none may be introduced — a client's whole dependency is the capnweb package. Anything that
// would need client-side smarts belongs HERE, behind an RpcTarget method.
//
// The DO owns every contract; the edge does the two jobs only the edge can do, because only the
// edge holds the client's capnweb session:
//   • REDUCE — the prototype hop at the bottom turns dotted access `itx.a.b(x)` into ONE
//     `invokeCapability` expression, forwarded to the DO over Workers RPC. The built-in roots ride
//     it too (`itx.append(...)`, `itx.read(...)`, `itx.fetch(request)`, `itx.rpcStubs.list()`,
//     `itx.subscriptions.list()`, …): a name this class does not declare is a DO built-in or a mount.
//   • LEND — a LIVE capnweb value (a function, an RpcTarget) handed to `provide` or `subscribe` is
//     held here for the session and lent to the DO over a relay (DON'T-PIN, below); the DO records
//     only a mount or a subscription row naming it (`itx.rpcStubs.get('<key>')`).
// The declared methods are the doors that need one of those two: `cd` (an EDGE context, so a
// provide on it lends in this session), `invokeCapability`, `waitForEvent` (no built-in root),
// `provide`/`revoke`, `subscribe`/`unsubscribe`, `enableProcessor`/`disableProcessor`.
//
// HOW A CLIENT REACHES ONE: `/api` → `UnauthenticatedSession.authenticate()` → `Session.projects.get(id)`
// → that project's ROOT `IterateContext` (session.ts). Contexts within a project are reached from a
// context with `cd(path)` (absolute by convention, relative resolves).
//
// DON'T-PIN: the client's capnweb callback stub lives HERE, in this stateless worker (the relay), which
// OWNS it for the session. The relay opens a STUB PAGER WebSocket to the DO (context/rpc-stub-relay.ts +
// context/rpc-stub-directory.ts); the DO records only the stub's transport id on it. When the DO wants the
// client — event-batch delivery, state changes, request/response calls, all the same lane — it PAGES this
// worker, which LENDS it a fresh Workers-RPC stub over `rpcStubLend`. The DO keeps that stub borrowed while
// traffic flows and returns it at its idle quiesce (a page borrows it again). So the DO holds no stub while
// idle and hibernates with any number of clients.

import { RpcTarget } from "capnweb";
import type { IterateContextDurableObject } from "./iterate-context-durable-object.ts";
import { CAPABILITY_FETCH_HEADER } from "./fetch/fetch-capabilities.ts";
import type { StreamEvent } from "./stream/events.ts";
import type { WaitForEventFilter } from "./stream/stream.ts";
import {
  canonicalItxExpressionPrefix,
  toItxExpression,
  type ItxExpressionInput,
} from "./context/expression.ts";
import type { WorkerSource } from "./context/worker-loader.ts";
import { installPrototypeInvokeCapabilityFallback } from "./context/dotted-path-proxy.ts";
import {
  DurableObjectNameCodec,
  resolveContextPath,
  type DurableObjectAddress,
} from "./context/durable-object-names.ts";
import {
  lendStubOverRelay,
  type IterateContextStub,
  type LentProviderStub,
  type ProviderStub,
} from "./context/rpc-stub-relay.ts";
import type { SessionTeardown } from "./session.ts";

export type ContextNamespace = DurableObjectNamespace<IterateContextDurableObject>;
export type WaitUntil = (p: Promise<unknown>) => void;

/** The iterate context (`itx`) at one `{ projectId, path }`. Dotted capability calls + the
 *  built-in collections forward to the DO over Workers RPC. capnweb terminates upstream in `/api`,
 *  so a client stub `itx.a.b(x)` never touches the DO's transport — it lands here and becomes a
 *  `DO.invoke(["itx", "a", ["b", x]])` call ItxExpression. */
export class IterateContext extends RpcTarget {
  readonly #contexts: ContextNamespace;
  readonly #address: DurableObjectAddress;
  readonly #context: IterateContextStub;
  readonly #teardown: SessionTeardown;
  readonly #waitUntil: WaitUntil;

  constructor(
    contexts: ContextNamespace,
    address: DurableObjectAddress,
    teardown: SessionTeardown,
    waitUntil: WaitUntil,
  ) {
    super();
    this.#contexts = contexts;
    this.#address = address;
    this.#context = contexts.getByName(address.name);
    this.#teardown = teardown;
    this.#waitUntil = waitUntil;
  }

  /** The SessionTeardown key for a live relay: `"<contextName> <capabilityPath>"`. The teardown is
   *  SESSION-lived and shared by every IterateContext the session hands out (across projects),
   *  while a capability path is only unique PER CONTEXT — keying by capability path alone let two
   *  contexts providing at the same path recall each other's stub. A space separator is
   *  unambiguous: a context name has no spaces and a capability path is dotted IDENT segments. */
  #teardownKey(capabilityPath: string): string {
    return `${this.#address.name} ${capabilityPath}`;
  }

  /** LEND a live capnweb value to the DO under `key` (a canonical capability path — the DO refuses
   *  any other spelling at attach, so an invalid key never burns a transport): the DON'T-PIN relay.
   *  Re-lending the same key REPLACES the transport (reconnect). Nothing is mounted — `provide` and
   *  `subscribe` append the row that names the stub as `itx.rpcStubs.get('<key>')`. */
  async #lendStub(key: string, target: ProviderStub): Promise<void> {
    const relay = await lendStubOverRelay(
      this.#context,
      target as LentProviderStub,
      key,
      this.#waitUntil,
    );
    this.#teardown.add(this.#teardownKey(key), relay);
  }

  /** RECALL what this session lent under `key`: the relay is disposed, the pager closes and the DO
   *  drops the stub. A no-op for a key this session never lent. Mounts naming it are untouched. */
  #recallStub(key: string): void {
    this.#teardown.dispose(this.#teardownKey(key));
  }

  /** Another context of THIS project. Absolute by convention (`cd("/agents/support")`); relative
   *  (`"agents/support"`, `"../inbox"`) resolves against this context's path — one resolver, shared
   *  with the built-in `itx.cd(...)` root. Returns an EDGE context, so `provide(path, fn)` on it
   *  lends in this same session. Pure addressing. */
  cd(path: string): IterateContext {
    const address = DurableObjectNameCodec.parse(
      DurableObjectNameCodec.stringify({
        projectId: this.#address.projectId,
        path: resolveContextPath(this.#address.path, path),
      }),
    );
    return new IterateContext(this.#contexts, address, this.#teardown, this.#waitUntil);
  }

  /** THE dispatch door (built-ins + provided capabilities) — the ONE way to call the itx surface.
   *  Takes an `ItxExpressionInput`: a dotted string (`"itx.append({...})"`) OR the parsed array
   *  (`["itx",["append",{...}]]`); both carry mid-path call args, and both work here. The dotted
   *  sugar `itx.a.b(x)` reduces into `["itx","a",["b",x]]` (see the prototype fallback at the bottom
   *  of this file) and lands right here.
   *
   *  ONE routing rule: a call whose TERMINAL step is `fetch(request)` carrying a live Request rides
   *  the DO's FETCH CHANNEL with the capability in the `x-itx-cap` header, not `invoke` — the fetch
   *  channel is the only hop kind that carries a socket-bearing Response back (a 101 from a tunnel
   *  or a WS-serving worker; fetch/fetch-capabilities.ts doctrine, points 1 & 4). So
   *  `itx.todos.web.fetch(request)` just works, upgrades included, and so does the root
   *  `itx.fetch(request)` (egress: the built-in `fetch` root) — there is no second door. */
  invokeCapability(call: ItxExpressionInput): Promise<unknown> {
    const expr = toItxExpression(call);
    const last = expr.at(-1);
    if (
      Array.isArray(last) &&
      last[0] === "fetch" &&
      last.length === 2 &&
      last[1] instanceof Request
    ) {
      const headers = new Headers(last[1].headers);
      headers.set(CAPABILITY_FETCH_HEADER, JSON.stringify(expr.slice(0, -1))); // the lane parses a JSON ItxExpression
      return this.#context.fetch(new Request(last[1], { headers }));
    }
    return this.#context.invoke(expr);
  }

  /** Wait for the next event matching `filter` — or the first committed durable match after an
   *  explicit `afterOffset` (the default is the head at call time: "the next occurrence"). The
   *  wait lives on the DO (Stream.waitForEvent owns the whole contract — type filter,
   *  30s/120s timeout → WAIT_TIMEOUT); this method just proxies, and the client's own open call
   *  is what keeps the wait alive. */
  waitForEvent(filter?: WaitForEventFilter): Promise<StreamEvent> {
    return this.#context.waitForEvent(filter);
  }

  /** THE ONE PROVIDE DOOR — mount a capability at `path`. `target` is EITHER:
   *    • an itx EXPRESSION (a dotted string or the parsed array — what the event stores; full
   *      shadow-stack semantics), OR
   *    • a LIVE capnweb value (a function or an RpcTarget): lend the value to `itx.rpcStubs` under
   *      the path (owned HERE, relay-side — DON'T-PIN), then mount the pure-data target
   *      `itx.rpcStubs.get('<path>')`. `itx.<path>.method(x)` resolves that mount like any other.
   *      Re-providing the same path re-lends (reconnect — the transport is replaced) and, the mount
   *      being identical, appends NOTHING (the door is idempotent). If the provider vanishes the
   *      mount STAYS: calls answer CONNECTION_OFFLINE until `revoke`.
   *  Anything else is a loud TypeError. Returns the mount's identity for `revoke`. */
  async provide(
    path: string,
    target: ItxExpressionInput | ProviderStub,
  ): Promise<{ providedAtOffset: number }> {
    if (typeof target === "string" || Array.isArray(target))
      return this.#context.provideCapability({ path, target });
    assertLiveValue(target, "provide(path, target)");
    // Lend FIRST, mount SECOND (the event records a capability that can already serve). The
    // registry key IS the canonical mount path — one canonicalizer, one spelling everywhere.
    const key = canonicalItxExpressionPrefix(path);
    await this.#lendStub(key, target);
    try {
      return await this.#context.provideCapability({
        path: key,
        target: ["itx", "rpcStubs", ["get", key]],
      });
    } catch (e) {
      // The DO refused the mount (STREAM_PAUSED / a validation throw): the relay just opened would
      // otherwise linger for the whole session — the session's stub, its pager socket, and a DO
      // transport that serves nothing. Recall it and let the refusal propagate.
      this.#recallStub(key);
      throw e;
    }
  }

  /** Pop a mount off the shadow stack (what it shadowed is restored) — by capability path (the
   *  newest winner at that exact path) or by identity (`{ providedAtOffset }`). The by-PATH
   *  spelling is the inverse of `provide(path, fn)`: it also RECALLS the stub THIS session lent
   *  under that path, if any (a local fact — no DO round trip, no other session's stub is touched).
   *  The by-offset spelling revokes the mount only; a stub this session lent stays addressable
   *  as `itx.rpcStubs.get('…')` until the session ends. */
  async revoke(input: string | { providedAtOffset: number }): Promise<void> {
    if (typeof input === "string") {
      const path = canonicalItxExpressionPrefix(input);
      await this.#context.revokeCapability({ path });
      this.#recallStub(path);
      return;
    }
    await this.#context.revokeCapability(input);
  }

  // ── SUBSCRIPTIONS: sugar over the subscriptions layer's one event (subscriptions.ts) ──

  /** Subscribe: have each committed batch — filtered by `consumes` — delivered to `target` as
   *  `(events, range)`. `target` is EITHER an itx EXPRESSION whose terminal is callable that way (a
   *  facet's `.processEventBatch`, a loaded entrypoint's method, a sibling context's `.append`) OR a
   *  LIVE capnweb callback, which is lent to `itx.rpcStubs` under `itx.subscriptions.<name>` and
   *  targeted as `itx.rpcStubs.get('…')`. HOW it is served is not declared here: the context looks
   *  at what the target evaluates to — a facet or a live stub owns its progress and gets a push (the
   *  client heals a gap with `read`); anything else gets an at-least-once cursor the stream keeps.
   *  Same name REPLACES; an identical subscribe appends NOTHING (a reconnect is zero events). An
   *  unnamed subscription is SESSION-scoped: it is removed when this session ends. */
  async subscribe(input: {
    name?: string;
    target: ItxExpressionInput | ProviderStub;
    consumes?: string[];
  }): Promise<{ name: string }> {
    const anonymous = input.name === undefined;
    const name = input.name ?? `sub-${crypto.randomUUID().slice(0, 8)}`;
    let target: ItxExpressionInput;
    if (typeof input.target === "string" || Array.isArray(input.target)) target = input.target;
    else {
      assertLiveValue(input.target, "subscribe({ target })");
      const key = `itx.subscriptions.${name}`;
      await this.#lendStub(key, input.target);
      target = ["itx", "rpcStubs", ["get", key]];
    }
    await this.#context.configureSubscription({
      name,
      target,
      ...(input.consumes && { consumes: input.consumes }),
    });
    if (anonymous)
      // Dies with the session: the removal rides waitUntil so the socket's close can complete.
      this.#teardown.add(this.#teardownKey(`subscription:${name}`), {
        dispose: () =>
          this.#waitUntil(this.#context.removeSubscription(name).catch(() => undefined)),
      });
    return { name };
  }

  /** Remove a subscription (appends `subscription-removed`; a cursor target's cursor goes with it)
   *  and recall the callback this session lent under it, if any. */
  async unsubscribe(name: string): Promise<void> {
    await this.#context.removeSubscription(name);
    this.#recallStub(`itx.subscriptions.${name}`);
    this.#teardown.dispose(this.#teardownKey(`subscription:${name}`));
  }

  // ── PROCESSORS: sugar over subscribe + the facet built-ins ──

  /** Enable a processor: host `className` (the `StreamProcessorDurableObject` subclass exported by
   *  the loaded `source` — the host whose `processor` field holds the pure `StreamProcessor`) as the
   *  facet named `name`, and subscribe its `processEventBatch` to every commit. Literally `subscribe({ name, target: itx.load(source).getDurableObjectClass(className)
   *  .get(name).processEventBatch, consumes })` — a processor is a named facet that is pushed the
   *  log. `consumes` is the SUBSCRIPTION's filter (what is sent; absent = every durable event); the
   *  processor's contract is the REDUCE's (what it reduces) — so a processor that reduces ephemerals
   *  names them here too, exactly as a live subscriber would. */
  enableProcessor(
    name: string,
    ref: { source: WorkerSource; className: string; consumes?: string[] },
  ): Promise<{ name: string }> {
    return this.subscribe({
      name,
      target: [
        "itx",
        ["load", ref.source],
        ["getDurableObjectClass", ref.className],
        ["get", name],
        "processEventBatch",
      ],
      ...(ref.consumes && { consumes: ref.consumes }),
    });
  }

  /** Disable a processor: unsubscribe it and DELETE its facet, storage included — a re-enable is a
   *  clean rebuild from the log, never a resume from orphaned state. */
  async disableProcessor(name: string): Promise<void> {
    await this.unsubscribe(name);
    await this.#context.invoke(["itx", "facets", ["delete", name]]);
  }
}

/** The one shape check for a live capnweb value: a function, an RpcTarget, or a stub (has dup). */
function assertLiveValue(target: unknown, where: string): void {
  if (
    typeof target !== "function" &&
    !(target instanceof RpcTarget) &&
    typeof (target as { dup?: unknown } | null)?.dup !== "function"
  )
    throw new TypeError(
      `${where}: target must be an itx expression (string | array) or a LIVE capnweb value (function | RpcTarget)`,
    );
}

// THE NATURAL DOTTED SURFACE. Insert the dynamic-capability fallback into `IterateContext.prototype`'s chain
// so an unknown segment (`itx.slack`, `itx.kv`, `itx.append`) becomes an accumulated invokeCapability dispatch,
// while the declared methods above (invokeCapability / provide / subscribe / …) always win.
// The receiver IS the invoker — the accumulated access reduces into ONE `invokeCapability(expression)`
// call (`[...root, ...prefix, [method, ...args]]`), and `IterateContext.invokeCapability` is exactly
// the door the reduce dispatches onto. Runs once at module load, after the class body. See
// context/dotted-path-proxy.ts for the workerd brand-check reason this is a prototype hop and not a
// Proxy AROUND the instance.
installPrototypeInvokeCapabilityFallback(IterateContext, ["itx"]);
