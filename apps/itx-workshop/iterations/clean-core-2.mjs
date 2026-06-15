// clean-core-2.mjs — FOUR ways to restore the "deep shadowing" clean-core gave up.
//
// Runnable companion to `clean-core-2.md`. Run `node clean-core-2.mjs`: each version
// is validated against the SAME capstone, so the doc's scorecard is not opinion.
//
// THE PROBLEM. clean-core dropped origin tracking, which made shadowing *chain-local*:
// an inherited capability that internally calls `fetch` resolves it against the chain
// it was PROVIDED on (the project's), never the chain that INVOKED it (the agent's).
// So an agent that shadows `fetch` to log/attenuate egress cannot see the egress of a
// capability it merely invoked. This file explores four ways to get that back.
//
// THE CAPSTONE (identical for every version — only the MECHANISM differs):
//
//   project.provide("fetch", realFetch)
//   project.provide("petstore", <a cap whose list() internally calls fetch("/pets")>)
//   const agent = project.extend("agent");  agent shadows "fetch" to log -> super
//
//   agent.invoke(["petstore","list"])    MUST log "agent.fetch /pets" + return base body
//   project.invoke(["petstore","list"])  MUST NOT log (project's own fetch)
//
// The four versions are written as SMALL DELTAS over one shared `BaseItx` (which is
// clean-core verbatim: chain-local, no interposition), so the size of each delta is
// the honest measure of "thin layer on top" vs "woven throughout".

import { AsyncLocalStorage } from "node:async_hooks";

// ===========================================================================
// Shared primitives — verbatim from clean-core.mjs
// ===========================================================================

const RESERVED_SEGMENTS = new Set([
  "__proto__",
  "prototype",
  "constructor",
  "then",
  "catch",
  "finally",
]);

function assertSafeSegment(holder, segment) {
  if (typeof segment !== "string") throw new Error(`segment must be a string`);
  if (RESERVED_SEGMENTS.has(segment)) throw new Error(`reserved segment "${segment}"`);
  if (!Object.hasOwn(holder, segment)) throw new Error(`"${segment}" is not an own property`);
}

// Walk `path` on `target` and call it with `args`, preserving the receiver.
function followPath(target, path, args) {
  if (path.length === 0) {
    if (typeof target !== "function") throw new Error("capability is not callable");
    return target(...args);
  }
  let holder = target;
  for (let i = 0; i < path.length - 1; i++) {
    assertSafeSegment(holder, path[i]);
    holder = holder[path[i]];
    if (holder == null) throw new Error(`path segment "${path[i]}" resolved to ${holder}`);
  }
  const method = path[path.length - 1];
  assertSafeSegment(holder, method);
  const fn = holder[method];
  if (typeof fn !== "function") throw new Error(`"${method}" is not a function`);
  return fn.apply(holder, args);
}

const WORKERS = new Map();
const registerWorker = (name, make) => WORKERS.set(name, make);
const isAddress = (v) =>
  v != null && typeof v === "object" && typeof v.worker === "string" && "entrypoint" in v;
function dial(address) {
  const make = WORKERS.get(address.worker);
  if (!make) throw new Error(`cannot dial unknown worker "${address.worker}"`);
  return make(address.entrypoint, address.props);
}

const MISS = { miss: true };

// A capability FACTORY marker. Versions A and D let a cap be provided as a factory of
// itself; B and C do not use it. A raw object/function is NOT a factory, so SDK mounts
// are never mistaken for one.
const FACTORY = Symbol("itx.factory");
const factory = (make) => ({ [FACTORY]: make });
const isFactory = (v) => v != null && typeof v === "object" && typeof v[FACTORY] === "function";

// ===========================================================================
// BaseItx — clean-core verbatim. Chain-local, NO interposition. The baseline
// every version below is a delta against.
// ===========================================================================

class BaseItx {
  constructor(name, parent = null) {
    this.name = name;
    this.parent = parent;
    this.providers = new Map();
    this.liveStubs = new Map();
    this.log = [];
  }
  extend(childName) {
    return new this.constructor(childName, this);
  }
  provide(name, target) {
    if (isFactory(target)) {
      this.providers.set(name, { kind: "factory", address: null });
      this.liveStubs.set(name, target[FACTORY]); // stash the maker
      this.log.push({ type: "capability-provided", name, address: null });
    } else if (isAddress(target)) {
      this.providers.set(name, { kind: "sturdy", address: target });
      this.liveStubs.delete(name);
      this.log.push({ type: "capability-provided", name, address: target });
    } else {
      this.providers.set(name, { kind: "live", address: null });
      this.liveStubs.set(name, target);
      this.log.push({ type: "capability-provided", name, address: null });
    }
  }
  revoke(name) {
    this.providers.delete(name);
    this.liveStubs.delete(name);
  }
  resolve(path) {
    for (let len = path.length; len >= 1; len--) {
      const name = path.slice(0, len).join(".");
      const entry = this.providers.get(name);
      if (entry) return { ctx: this, entry, name, matchedLen: len };
    }
    if (this.parent) return this.parent.resolve(path);
    return MISS;
  }
  // overridable borrow seam
  _borrow(ctx, entry, name /*, originCtx */) {
    if (entry.kind === "factory")
      throw new Error(`${this.name}: this version cannot build factories`);
    if (entry.kind === "live") {
      const stub = ctx.liveStubs.get(name);
      if (!stub) throw new Error(`capability "${name}" is offline`);
      return stub;
    }
    return dial(entry.address);
  }
  invoke(path, args = []) {
    const r = this.resolve(path);
    if (r === MISS) throw new Error(`no capability at "${path.join(".")}"`);
    const target = this._borrow(r.ctx, r.entry, r.name);
    return followPath(target, path.slice(r.matchedLen), args);
  }
  superRef(path) {
    if (!this.parent) throw new Error("no parent to super into");
    const parent = this.parent;
    return (...args) => parent.invoke(path, args);
  }
}

// ===========================================================================
// Version A — Borrow-time FACTORY INJECTION (hands the cap the whole calling itx)
// DELTA: invoke threads the calling ctx (defaults to `this`, never reset by the
// parent climb because the climb lives inside resolve()); _borrow applies a factory
// with that ctx. ~6 lines. No wire field. Methods stay clean (factory arg, not a
// per-method arg), so raw SDK mounts are untouched.
// ===========================================================================

class A_Itx extends BaseItx {
  _borrow(ctx, entry, name, callerCtx) {
    if (entry.kind === "factory") {
      const make = ctx.liveStubs.get(name);
      if (!make) throw new Error(`capability "${name}" is offline`);
      return make(callerCtx); // build the surface bound to the CALLER's itx
    }
    return super._borrow(ctx, entry, name);
  }
  invoke(path, args = [], callerCtx = this) {
    const r = this.resolve(path);
    if (r === MISS) throw new Error(`no capability at "${path.join(".")}"`);
    const target = this._borrow(r.ctx, r.entry, r.name, callerCtx);
    return followPath(target, path.slice(r.matchedLen), args);
  }
}

// ===========================================================================
// Version B — EXPLICIT THREADING (the yardstick). itx rides every call as the first
// positional arg. DELTA: invoke threads callerItx; a threaded followPath splices it
// in. Thinnest possible — and it SILENTLY CORRUPTS any raw SDK mount, which is the
// whole reason A/C/D exist.
// ===========================================================================

function followPathThreaded(target, path, args, callerItx) {
  if (path.length === 0) {
    if (typeof target !== "function") throw new Error("capability is not callable");
    return target(callerItx, ...args); // itx spliced first
  }
  let holder = target;
  for (let i = 0; i < path.length - 1; i++) {
    assertSafeSegment(holder, path[i]);
    holder = holder[path[i]];
    if (holder == null) throw new Error(`path segment "${path[i]}" resolved to ${holder}`);
  }
  const method = path[path.length - 1];
  assertSafeSegment(holder, method);
  const fn = holder[method];
  if (typeof fn !== "function") throw new Error(`"${method}" is not a function`);
  return fn.apply(holder, [callerItx, ...args]); // itx spliced first
}

class B_Itx extends BaseItx {
  invoke(path, args = [], callerItx = this) {
    const r = this.resolve(path);
    if (r === MISS) throw new Error(`no capability at "${path.join(".")}"`);
    const target = this._borrow(r.ctx, r.entry, r.name);
    return followPathThreaded(target, path.slice(r.matchedLen), args, callerItx);
  }
  superRef(path, callerItx = this) {
    if (!this.parent) throw new Error("no parent to super into");
    const parent = this.parent;
    return (...args) => parent.invoke(path, args, callerItx);
  }
}

// ===========================================================================
// Version C — AMBIENT DYNAMIC SCOPE. A "current context" rides an AsyncLocalStorage.
// DELTA: invoke wraps its body in CURRENT.run(this, ...). Zero ceremony for the cap
// author ("just call fetch"). But: ambient authority (any code on the call reads it),
// and the scope EVAPORATES across an isolate/DO boundary — silently.
// ===========================================================================

const CURRENT = new AsyncLocalStorage();
function currentItx() {
  const c = CURRENT.getStore();
  if (!c) throw new Error("called outside any invoke() — no current context");
  return c;
}
function ambientFetch(url) {
  return currentItx().invoke(["fetch"], [url]); // the implicit egress door
}

class C_Itx extends BaseItx {
  invoke(path, args = []) {
    return CURRENT.run(this, () => super.invoke(path, args));
  }
}

// ===========================================================================
// Version D — MEMBRANE ON BORROW (rebind ONLY fetch). DELTA: a cap is a factory of
// `(env) => surface`; _borrow builds it with an env exposing ONLY an attenuated fetch
// re-rooted at the borrowing chain. Least-authority (the cap sees `fetch`, nothing
// else), and it is exactly what prod's wireIsolateEnv does. Cost: woven through
// provide-shape + borrow + an env contract.
// ===========================================================================

class D_Itx extends BaseItx {
  _membraneEnv(originCtx) {
    // The ONLY authority the cap receives: fetch, re-rooted at the caller, late-bound.
    return { fetch: (...args) => originCtx.invoke(["fetch"], args) };
  }
  _borrow(ctx, entry, name, originCtx) {
    if (entry.kind === "factory") {
      const make = ctx.liveStubs.get(name);
      if (!make) throw new Error(`capability "${name}" is offline`);
      return make(this._membraneEnv(originCtx));
    }
    return super._borrow(ctx, entry, name);
  }
  invoke(path, args = [], originCtx = this) {
    const r = this.resolve(path);
    if (r === MISS) throw new Error(`no capability at "${path.join(".")}"`);
    const target = this._borrow(r.ctx, r.entry, r.name, originCtx);
    return followPath(target, path.slice(r.matchedLen), args);
  }
}

// ===========================================================================
// CHECKS
// ===========================================================================

function assert(cond, msg) {
  if (!cond) throw new Error(`CHECK FAILED: ${msg}`);
}
function assertThrows(fn, msg) {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  assert(threw, msg);
}
const results = [];
function check(name, fn) {
  fn();
  results.push(name);
  console.log(`  ✓ ${name}`);
}
function section(title) {
  console.log(`\n${title}`);
}

// --- Version A: factory injection -----------------------------------------
section("Version A — borrow-time factory injection (whole itx)");
check("A: agent-initiated call into inherited petstore hits the agent's fetch shadow", () => {
  const log = [];
  const project = new A_Itx("project");
  project.provide("fetch", (url) => `200 ${url}`);
  project.provide(
    "petstore",
    factory((itx) => ({ list: () => itx.invoke(["fetch"], ["/pets"]) })),
  );
  const agent = project.extend("agent");
  const superFetch = agent.superRef(["fetch"]);
  agent.provide("fetch", (url) => {
    log.push(`agent.fetch ${url}`);
    return superFetch(url);
  });

  assert(agent.invoke(["petstore", "list"]) === "200 /pets", "agent gets base body");
  assert(log.length === 1 && log[0] === "agent.fetch /pets", "agent shadow fired (deep)");
  assert(project.invoke(["petstore", "list"]) === "200 /pets", "project gets base body");
  assert(log.length === 1, "project's own call did NOT hit the agent shadow");
});
check("A: a raw SDK mount (not a factory) is invoked untouched — no itx in its args", () => {
  const itx = new A_Itx("root");
  itx.provide("slack", { chat: { postMessage: (opts) => `posted to ${opts.channel}` } });
  assert(
    itx.invoke(["slack", "chat", "postMessage"], [{ channel: "#general" }]) ===
      "posted to #general",
    "clean",
  );
});
check("A: late binding holds through the factory (base swap is seen)", () => {
  const log = [];
  const project = new A_Itx("project");
  project.provide("fetch", (url) => `200 ${url}`);
  project.provide(
    "petstore",
    factory((itx) => ({ list: () => itx.invoke(["fetch"], ["/pets"]) })),
  );
  const agent = project.extend("agent");
  const superFetch = agent.superRef(["fetch"]);
  agent.provide("fetch", (url) => {
    log.push(url);
    return superFetch(url);
  });
  assert(agent.invoke(["petstore", "list"]) === "200 /pets", "v1");
  project.revoke("fetch");
  project.provide("fetch", (url) => `201 ${url}`);
  assert(agent.invoke(["petstore", "list"]) === "201 /pets", "v2 after base swap");
});

// --- Version B: explicit threading (the yardstick) ------------------------
section("Version B — explicit threading (the yardstick: works, but corrupts SDKs)");
check("B: deep shadowing works (petstore.list takes itx first, re-enters caller chain)", () => {
  const log = [];
  const project = new B_Itx("project");
  project.provide("fetch", (_itx, url) => `200 ${url}`);
  project.provide("petstore", { list: (itx) => itx.invoke(["fetch"], ["/pets"]) });
  const agent = project.extend("agent");
  const superFetch = agent.superRef(["fetch"]);
  agent.provide("fetch", (_itx, url) => {
    log.push(`agent.fetch ${url}`);
    return superFetch(url);
  });

  assert(agent.invoke(["petstore", "list"]) === "200 /pets", "deep shadow body");
  assert(log.length === 1 && log[0] === "agent.fetch /pets", "agent shadow fired");
  assert(
    project.invoke(["petstore", "list"]) === "200 /pets" && log.length === 1,
    "project not logged",
  );
});
check("B: CRUX — a raw SDK mount is SILENTLY CORRUPTED (itx lands in arg 0)", () => {
  const itx = new B_Itx("root");
  // A real @slack/web-api client: postMessage(opts) reads opts.channel. Mounted raw.
  itx.provide("slack", { chat: { postMessage: (opts) => `posted to ${opts?.channel}` } });
  const result = itx.invoke(["slack", "chat", "postMessage"], [{ channel: "#general" }]);
  // itx was spliced first, so `opts` === the Itx context; opts.channel is undefined.
  assert(
    result === "posted to undefined",
    "SDK call corrupted exactly as predicted (no error thrown)",
  );
});

// --- Version C: ambient dynamic scope -------------------------------------
section("Version C — ambient dynamic scope (thin + clean call sites, but a trap)");
check("C: in-process — petstore.list() with bare ambientFetch hits the agent shadow", () => {
  const log = [];
  const project = new C_Itx("project");
  project.provide("fetch", (url) => `200 ${url}`);
  project.provide("petstore", { list: () => ambientFetch("/pets") }); // zero ceremony
  const agent = project.extend("agent");
  const superFetch = agent.superRef(["fetch"]);
  agent.provide("fetch", (url) => {
    log.push(`agent.fetch ${url}`);
    return superFetch(url);
  });

  assert(agent.invoke(["petstore", "list"]) === "200 /pets", "deep shadow body");
  assert(log.length === 1 && log[0] === "agent.fetch /pets", "agent shadow fired");
  assert(
    project.invoke(["petstore", "list"]) === "200 /pets" && log.length === 1,
    "project not logged",
  );
});
check("C: OCAP SMELL — a project-provided cap reads an agent-PRIVATE cap (exfiltration)", () => {
  const project = new C_Itx("project");
  project.provide("fetch", (url) => `200 ${url}`);
  // petstore is provided by the PROJECT and was never handed the agent's secrets…
  project.provide("petstore", { steal: () => currentItx().invoke(["agentSecret"], []) });
  const agent = project.extend("agent");
  agent.provide("agentSecret", () => "AGENT-KEY"); // private to the agent

  // …yet because the AGENT invoked it, ambient authority lets it reach the agent's key.
  assert(agent.invoke(["petstore", "steal"]) === "AGENT-KEY", "ambient authority leaked the key");
});
check("C: BOUNDARY — a dialed (separate-isolate) cap does NOT see the caller's scope", () => {
  // Model the wire crossing: the dialed cap's body runs with the scope CLEARED.
  registerWorker("remote-petstore", () => ({
    list: () => CURRENT.run(undefined, () => ambientFetch("/pets")), // scope erased at the boundary
  }));
  const log = [];
  const project = new C_Itx("project");
  project.provide("fetch", (url) => `200 ${url}`);
  project.provide("petstore", { worker: "remote-petstore", entrypoint: "default", props: {} });
  const agent = project.extend("agent");
  const superFetch = agent.superRef(["fetch"]);
  agent.provide("fetch", (url) => {
    log.push(url);
    return superFetch(url);
  });

  assertThrows(() => agent.invoke(["petstore", "list"]), "ambient door fails across the boundary");
  assert(log.length === 0, "the agent's shadow was never consulted — silent miss in real life");
});

// --- Version D: membrane on borrow ----------------------------------------
section("Version D — membrane on borrow (rebind only fetch; least authority; = prod)");
check("D: deep shadowing — inherited cap's env.fetch hits the agent shadow", () => {
  const log = [];
  const project = new D_Itx("project");
  project.provide("fetch", (url) => `200 ${url}`);
  project.provide(
    "petstore",
    factory((env) => ({ list: () => env.fetch("/pets") })),
  );
  const agent = project.extend("agent");
  const superFetch = agent.superRef(["fetch"]);
  agent.provide("fetch", (url) => {
    log.push(`agent.fetch ${url}`);
    return superFetch(url);
  });

  assert(agent.invoke(["petstore", "list"]) === "200 /pets", "deep shadow body");
  assert(log.length === 1 && log[0] === "agent.fetch /pets", "agent shadow fired");
  assert(
    project.invoke(["petstore", "list"]) === "200 /pets" && log.length === 1,
    "project not logged",
  );
});
check("D: OCAP — the membrane exposes ONLY fetch (no invoke, no db, no caller handle)", () => {
  const project = new D_Itx("project");
  project.provide("fetch", (url) => `200 ${url}`);
  project.provide("db", { query: () => "rows" });
  project.provide(
    "probe",
    factory((env) => ({ keys: () => Object.keys(env) })),
  );
  const agent = project.extend("agent");
  assert(
    JSON.stringify(agent.invoke(["probe", "keys"])) === JSON.stringify(["fetch"]),
    "env = {fetch} only",
  );
});
check("D: two children get DISJOINT membranes (rebound per borrowing chain)", () => {
  const project = new D_Itx("project");
  project.provide("fetch", (url) => `200 ${url}`);
  project.provide(
    "petstore",
    factory((env) => ({ list: () => env.fetch("/pets") })),
  );
  const a = project.extend("a");
  const b = project.extend("b");
  const logA = [],
    logB = [];
  a.provide("fetch", (url) => {
    logA.push(url);
    return a.superRef(["fetch"])(url);
  });
  b.provide("fetch", (url) => {
    logB.push(url);
    return b.superRef(["fetch"])(url);
  });
  a.invoke(["petstore", "list"]);
  assert(logA.length === 1 && logB.length === 0, "only a's membrane fired");
});

// --- run ------------------------------------------------------------------
console.log(`\n${results.length} checks passed across 4 versions.`);

export { BaseItx, A_Itx, B_Itx, C_Itx, D_Itx, factory };
